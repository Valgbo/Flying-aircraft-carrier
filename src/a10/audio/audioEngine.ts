/**
 * The A-10's audio engine: one Web Audio graph (mixer.ts and the voices) driven once per frame
 * from the simulation's state and events. It knows nothing about React or the page lifecycle
 * (AudioManager.tsx owns the AudioContext) and runs on any BaseAudioContext, so the audio
 * sandbox renders exactly this graph offline and measures it.
 *
 * Per frame:
 *  1. the sim→audio clock maps this frame's sim interval onto the audio clock (lookahead 30 ms);
 *  2. events are scheduled at their exact times: gun start/stop (and the ducking), warnings,
 *     switch clicks; world sounds (impacts aggregated per kind and area, explosions, releases,
 *     launches) go into the DELAY QUEUE in sim time;
 *  3. continuous voices follow the state: gun rate and spin, engines, airframe, warnings, and the
 *     outside voices at the retarded time read from the aircraft's history;
 *  4. queued sounds whose arrival at the moving listener is near are handed to the audio clock.
 */
import type { WarningId } from '../core/flight/types';
import type { Sim, SimEvent } from '../core/types';
import type { StoreBody, StoreType } from '../core/weapons/types';
import type { FrameInfo } from '../view/frame';
import type { ListenerPose } from '../view/listener';
import { AirframeVoices } from './airframe';
import {
  createPlannedBlast,
  cueOf,
  impactKindOf,
  launchKindOf,
  planBlasts,
  releaseClunks,
  type PlannedBlast,
} from './classify';
import { CockpitVoices } from './cockpit';
import { EngineVoices, type EngineInput } from './engines';
import { GunVoices } from './gun';
import { AudioKit } from './kit';
import { AudioListener } from './listener';
import { BUS_IDS, masterGain, type BusId, type BusTrims } from './mappings';
import { Mixer, type LevelReading } from './mixer';
import {
  DelayQueue,
  ImpactAggregator,
  SimAudioClock,
  SourceHistory,
  createSourceSample,
  soundSpeed,
} from './propagation';
import { WorldVoices, type WorldSound } from './world';

/** How far ahead (sim seconds) a queued world sound is handed to the audio clock. */
const RELEASE_HORIZON = 0.1;

export interface EngineOptions {
  meters?: boolean;
  destination?: AudioNode;
  trims?: BusTrims;
}

export interface AudioSnapshot {
  time: number;
  inCockpit: boolean;
  clockOffset: number;
  ducked: boolean;
  gun: GunVoices['state'] & { firing: boolean };
  engines: EngineVoices['state'];
  airframe: AirframeVoices['state'];
  warnings: string[];
  queued: number;
  pool: { played: number; stolen: number; busy: number; refused: number };
  world: WorldVoices['state'];
  nodes: number;
  limiterReduction: number;
}

export class A10AudioEngine {
  readonly ctx: BaseAudioContext;
  readonly mixer: Mixer;
  readonly kit: AudioKit;
  readonly clock = new SimAudioClock();
  readonly queue = new DelayQueue<WorldSound>();
  readonly history = new SourceHistory();
  readonly listener = new AudioListener();
  readonly gun: GunVoices;
  readonly engines: EngineVoices;
  readonly airframe: AirframeVoices;
  readonly cockpit: CockpitVoices;
  readonly world: WorldVoices;
  private readonly impacts = new ImpactAggregator();
  private readonly sample = createSourceSample();
  private readonly ret = createSourceSample();
  private readonly engineInput: EngineInput[] = [
    { n1: 0, n2: 0, running: false },
    { n1: 0, n2: 0, running: false },
  ];
  /** The frame's explosions as they will be heard (classify.ts planBlasts), pooled. */
  private readonly blasts: PlannedBlast[] = Array.from({ length: 48 }, createPlannedBlast);
  private sim: Sim | null = null;
  private started = false;
  private stopped = false;
  private lastTime = 0;
  /** Sim time between the last two camera poses (the previous frame's). */
  private poseSimDt = 0;

  constructor(ctx: BaseAudioContext, opts: EngineOptions = {}) {
    this.ctx = ctx;
    this.mixer = new Mixer(ctx, {
      meters: opts.meters,
      destination: opts.destination,
      trims: opts.trims,
    });
    this.kit = new AudioKit(ctx, this.mixer);
    this.gun = new GunVoices(this.kit);
    this.engines = new EngineVoices(this.kit);
    this.airframe = new AirframeVoices(this.kit);
    this.cockpit = new CockpitVoices(this.kit);
    this.world = new WorldVoices(this.kit);
  }

  /** Start the continuous sources. The mix stays silent until `setMix` opens the gate. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.kit.start();
  }

  /** Fade out fast and stop every source shortly after; `dispose` once that has passed. */
  stop(): void {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    const now = this.ctx.currentTime;
    this.mixer.stop(now);
    this.kit.stop(now + 0.25);
  }

  dispose(): void {
    this.kit.dispose();
    this.mixer.dispose();
  }

  /** The recordings arrived (or more of them): let the voices pick them up. */
  attachSamples(): void {
    this.gun.attachSamples();
    this.engines.attachSamples();
    this.airframe.attachSamples();
  }

  /** Volume (0..1 slider) and mute from the settings; `audible` false gates the whole mix. */
  setMix(
    volume: number,
    muted: boolean,
    audible: boolean,
    when = this.ctx.currentTime,
    immediate = false,
  ): void {
    this.mixer.setMaster(masterGain(volume, muted), audible, when, immediate);
  }

  setTrims(trims: Partial<BusTrims>): void {
    this.mixer.setTrims(trims);
  }

  get nodeCount(): number {
    return this.mixer.nodeCount + this.kit.nodes.length + this.kit.liveNodes;
  }

  /**
   * Once per frame, after the sim stepped (an `onSimFrame` listener). The camera pose was
   * published at the end of the previous frame, so its movement spans the previous frame's
   * sim time.
   */
  frame(events: readonly SimEvent[], sim: Sim, info: FrameInfo, pose: ListenerPose): void {
    if (sim !== this.sim) this.listener.reset();
    this.listener.update(pose, this.poseSimDt);
    this.poseSimDt = info.simDt;
    this.step(events, sim, info.simDt);
  }

  /** The frame update with the listener already set (the sandbox drives this directly). */
  step(events: readonly SimEvent[], sim: Sim, simDt: number): void {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    if (sim !== this.sim) this.resetFor(sim, now);
    this.clock.update(sim.time, simDt, now);
    const toAudio = (t: number) => this.clock.toAudio(t, now);
    const ac = sim.aircraft;
    const listener = this.listener;
    // the speed of sound between the aircraft and the listener (world sounds use their own path)
    const c = soundSpeed(listener.y, ac.position.y);

    // the aircraft's history, for the outside voices
    const s = this.sample;
    s.t = sim.time;
    s.x = ac.position.x;
    s.y = ac.position.y;
    s.z = ac.position.z;
    s.vx = ac.velocity.x;
    s.vy = ac.velocity.y;
    s.vz = ac.velocity.z;
    s.gunRate = sim.gun.firing ? sim.gun.rate : 0;
    s.gunSpin = sim.gun.spin;
    s.n1a = ac.engines[0].n1;
    s.n1b = ac.engines[1].n1;
    s.n2a = ac.engines[0].n2;
    s.n2b = ac.engines[1].n2;
    this.history.push(s);

    // ---- events, at their exact times ----
    let gunEvent = false;
    // explosions, each heard once (a store's burst and what it destroys or sets off with it)
    const nBlasts = planBlasts(events, this.blasts);
    for (let i = 0; i < nBlasts; i++) {
      const b = this.blasts[i];
      const sound: WorldSound = b.thump
        ? { kind: 'impact', impact: 'ground', count: 1, strength: 6 }
        : { kind: 'blast', size: b.size, scale: b.scale };
      this.queue.push(b.t, b.x, b.y, b.z, sound);
    }
    for (const e of events) {
      switch (e.type) {
        case 'gunStart': {
          gunEvent = true;
          const when = toAudio(e.t);
          this.gun.start(when, 0);
          if (listener.inCockpit) this.mixer.duck(when);
          break;
        }
        case 'gunStop': {
          gunEvent = true;
          const when = toAudio(e.t);
          this.gun.stop(when);
          this.mixer.release(when);
          break;
        }
        case 'roundImpact':
          this.impacts.add(impactKindOf(e), e.t, e.position.x, e.position.y, e.position.z, 1);
          break;
        case 'storeReleased': {
          // the ejector's clunk; a rocket or a Maverick leaves on its motor (its launch sound)
          if (!releaseClunks(e.store, hasIgnition(events, e.bodyId))) break;
          if (listener.inCockpit) this.airframe.release(toAudio(e.t));
          else
            this.queue.push(e.t, ac.position.x, ac.position.y, ac.position.z, { kind: 'release' });
          break;
        }
        case 'motorIgnition': {
          const body = findBody(sim, e.bodyId);
          const p = body ? body.position : ac.position;
          const weapon = launchKindOf(body?.kind, releasedStore(events, e.bodyId));
          this.queue.push(e.t, p.x, p.y, p.z, { kind: 'launch', weapon });
          break;
        }
        case 'lock':
        case 'laser': {
          const cue = cueOf(e);
          if (cue) this.cockpit.cue(cue, toAudio(e.t));
          break;
        }
        case 'warning':
          this.cockpit.warning(e.warning as WarningId, e.on, toAudio(e.t));
          break;
        case 'switch':
          this.cockpit.click(e.name, toAudio(e.t));
          break;
        case 'crash':
          this.queue.push(e.t, e.position.x, e.position.y, e.position.z, {
            kind: 'blast',
            size: 'huge',
            scale: 1.2,
          });
          break;
        default:
          break;
      }
    }
    this.impacts.flush((g) =>
      this.queue.push(g.t, g.x, g.y, g.z, {
        kind: 'impact',
        impact: g.kind,
        count: g.count,
        strength: g.strength,
      }),
    );

    // the gun's state without events (a weapons model that only sets `firing`)
    const frameStart = toAudio(sim.time - simDt);
    if (!gunEvent && sim.gun.firing !== this.gun.firing) {
      if (sim.gun.firing) {
        this.gun.start(frameStart, sim.gun.rate);
        if (listener.inCockpit) this.mixer.duck(frameStart);
      } else {
        this.gun.stop(frameStart);
        this.mixer.release(frameStart);
      }
    }
    // the ducking follows the view
    if (this.gun.firing && listener.inCockpit) this.mixer.duck(frameStart);
    else if (this.mixer.isDucked && (!this.gun.firing || !listener.inCockpit))
      this.mixer.release(frameStart);

    // ---- continuous voices ----
    const when = toAudio(sim.time);
    const delay = this.history.retarded(sim.time, listener, c, this.ret);
    this.gun.update(
      when,
      sim.gun.firing ? sim.gun.rate : 0,
      sim.gun.spin,
      listener,
      this.ret,
      delay,
      c,
    );
    for (let i = 0; i < 2; i++) {
      this.engineInput[i].n1 = ac.engines[i].n1;
      this.engineInput[i].n2 = ac.engines[i].n2;
      this.engineInput[i].running = ac.engines[i].running;
    }
    this.engines.update(when, this.engineInput, listener, this.ret, c, !ac.crashed);
    const listenerSpeed = Math.hypot(listener.vx, listener.vy, listener.vz);
    this.airframe.update(
      when,
      {
        ias: ac.crashed ? 0 : ac.ias,
        alpha: ac.alpha,
        gLoad: ac.gLoad,
        speedBrake: ac.surfaces.speedBrake,
        gearDown: ac.gearDown,
      },
      listener.inCockpit,
      listenerSpeed,
    );
    this.cockpit.sync(ac.warnings, when);
    this.cockpit.update(now, this.clock.lookahead + simDt + 0.02);
    this.world.updateFires(sim.targets.vehicles, listener, when);
    this.world.updateMotors(sim.projectiles.bodies, listener, c, when);
    this.world.scanRounds(sim.projectiles.rounds, listener, c, sim.time, toAudio);

    // ---- world sounds arriving now ----
    this.queue.release(sim.time, RELEASE_HORIZON, listener, (item, arrival) => {
      this.world.play(item.payload, item.x, item.y, item.z, toAudio(arrival), listener);
    });
    this.lastTime = sim.time;
  }

  /** A new flight (or the first): forget everything about the old one. */
  private resetFor(sim: Sim, now: number): void {
    this.sim = sim;
    this.queue.clear();
    this.history.clear();
    this.clock.reset();
    this.gun.reset(now);
    this.cockpit.reset(now);
    this.world.reset(now);
    this.mixer.release(now);
    this.lastTime = sim.time;
  }

  /** Current levels of every metered point (needs `meters`). */
  levels(): Record<BusId | 'preLimiter' | 'output', LevelReading> {
    const out = {} as Record<BusId | 'preLimiter' | 'output', LevelReading>;
    for (const id of [...BUS_IDS, 'preLimiter', 'output'] as const) {
      out[id] = this.mixer.level(id, { rms: 0, peak: 0 });
    }
    return out;
  }

  /** What the engine is doing (allocates: debug read-outs and tests only). */
  snapshot(): AudioSnapshot {
    return {
      time: this.lastTime,
      inCockpit: this.listener.inCockpit,
      clockOffset: this.clock.offset,
      ducked: this.mixer.isDucked,
      gun: { ...this.gun.state, firing: this.gun.firing },
      engines: {
        levels: [...this.engines.state.levels],
        n1: [...this.engines.state.n1],
        doppler: this.engines.state.doppler,
      },
      airframe: { ...this.airframe.state },
      warnings: this.cockpit.activeWarnings(),
      queued: this.queue.length,
      pool: {
        played: this.world.pool.played + this.world.blastPool.played,
        stolen: this.world.pool.stolen + this.world.blastPool.stolen,
        busy: this.world.busy,
        refused: this.queue.refused,
      },
      world: { ...this.world.state },
      nodes: this.nodeCount,
      limiterReduction: this.mixer.limiterReduction,
    };
  }
}

function findBody(sim: Sim, id: number): StoreBody | null {
  const list = sim.projectiles.bodies;
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/** Whether the frame has a motor lighting for this body (a rail or tube launch). */
function hasIgnition(events: readonly SimEvent[], bodyId: number): boolean {
  if (!(bodyId > 0)) return false;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'motorIgnition' && e.bodyId === bodyId) return true;
  }
  return false;
}

/** The store type released with this body in the frame, if its release is in it. */
function releasedStore(events: readonly SimEvent[], bodyId: number): StoreType | undefined {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'storeReleased' && e.bodyId === bodyId) return e.store;
  }
  return undefined;
}
