/**
 * Sounds in the world (PLAN_A10.md §6.2, §13): 30 mm impacts, explosions, burning vehicles,
 * store releases, rocket and missile launches and motors, and the crack of supersonic rounds
 * passing the listener. Each one-shot travels to the listener (propagation.ts: it waits in sim
 * time, arrives late by distance / c and darker with range); this file turns an arrived sound
 * into audio.
 *
 * Node budget: one-shots play through a fixed pool of chains (level → air absorption → pan);
 * per sound only the AudioBufferSourceNode is created, and the frame's impacts are aggregated
 * per kind and area (65 rounds a second are a handful of sources, never 65 graphs).
 */
import { SmoothParam } from '../../engine';
import type { RoundPool, StoreBody } from '../core/weapons/types';
import type { Vehicle } from '../core/targets/types';
import type { AudioKit } from './kit';
import type { AudioListener } from './listener';
import {
  absorptionCutoff,
  crackDelay,
  crackGain,
  distanceGain,
  dopplerFactor,
  type ImpactKind,
  type MovingPoint,
} from './propagation';
import type { BlastSize } from './synth';
import { getSample } from './samples';

/** What can be queued in the world (the payload of the DelayQueue). */
export type WorldSound =
  | { kind: 'impact'; impact: ImpactKind; count: number; strength: number }
  | { kind: 'blast'; size: BlastSize; scale: number }
  | { kind: 'release' }
  | { kind: 'launch' };

/**
 * Reference level (linear) of each sound at its reference distance (m), and its spreading loss
 * as an exponent of distance (1 = spherical, −6 dB per doubling; blasts are softened to 0.8 so a
 * bomb two kilometres away is still a clear boom).
 */
export const WORLD_REFERENCE: Record<string, { level: number; distance: number; rolloff: number }> =
  {
    armour: { level: 0.45, distance: 10, rolloff: 1 },
    hei: { level: 0.6, distance: 10, rolloff: 1 },
    ground: { level: 0.4, distance: 10, rolloff: 1 },
    water: { level: 0.3, distance: 10, rolloff: 1 },
    ricochet: { level: 0.3, distance: 10, rolloff: 1 },
    small: { level: 0.6, distance: 10, rolloff: 1 },
    medium: { level: 1, distance: 30, rolloff: 0.85 },
    large: { level: 1, distance: 100, rolloff: 0.8 },
    huge: { level: 1, distance: 150, rolloff: 0.8 },
    release: { level: 0.4, distance: 10, rolloff: 1 },
    launch: { level: 0.7, distance: 15, rolloff: 0.9 },
  };

/** Below this a sound is not worth a source (−66 dB). */
const CULL = 5e-4;
const FIRE_LEVEL = 0.35;
const FIRE_REF = 20;
const FIRE_RANGE = 700;
const MOTOR_LEVEL = 0.6;
const MOTOR_REF = 20;
const CRACK_LEVEL = 0.35;
/** Rounds passing farther than this make no crack worth hearing, m. */
const CRACK_RANGE = 150;
const MAX_CRACKS_PER_FRAME = 3;

interface Chain {
  input: GainNode;
  cutoff: AudioParam;
  pan: AudioParam;
  busyUntil: number;
}

/** A fixed pool of level → low-pass → pan chains on one bus. */
export class VoicePool {
  private readonly chains: Chain[] = [];
  played = 0;
  stolen = 0;

  constructor(
    private readonly kit: AudioKit,
    bus: AudioNode,
    size: number,
  ) {
    for (let i = 0; i < size; i++) {
      const input = kit.gain(0);
      const lp = kit.filter('lowpass', 18000, 0.6);
      const pan = kit.panner(0);
      input.connect(lp).connect(pan).connect(bus);
      this.chains.push({ input, cutoff: lp.frequency, pan: pan.pan, busyUntil: 0 });
    }
  }

  get busy(): number {
    const now = this.kit.ctx.currentTime;
    return this.chains.filter((c) => c.busyUntil > now).length;
  }

  /** Play `buffer` at `when`: a free chain, or the one that frees up first. */
  play(
    buffer: AudioBuffer,
    when: number,
    level: number,
    cutoff: number,
    pan: number,
    rate = 1,
  ): void {
    const chain = this.take(level, when, cutoff, pan);
    if (!chain) return;
    this.kit.playOnce(buffer, chain.input, when, rate);
    chain.busyUntil = Math.max(chain.busyUntil, when + buffer.duration / rate);
  }

  /**
   * Several sources through one chain (one level, absorption and pan), `spacing` s apart,
   * alternating between `buffers`.
   */
  playGroup(
    buffers: readonly AudioBuffer[],
    first: number,
    when: number,
    spacing: number,
    level: number,
    cutoff: number,
    pan: number,
    rates: readonly number[],
  ): void {
    const chain = this.take(level, when, cutoff, pan);
    if (!chain) return;
    rates.forEach((rate, k) => {
      const buffer = buffers[(first + k) % buffers.length];
      const at = when + k * spacing;
      this.kit.playOnce(buffer, chain.input, at, rate);
      chain.busyUntil = Math.max(chain.busyUntil, at + buffer.duration / rate);
    });
  }

  private take(level: number, when: number, cutoff: number, pan: number): Chain | null {
    if (!(level > CULL)) return null;
    const now = this.kit.ctx.currentTime;
    let chain = this.chains[0];
    for (const c of this.chains) {
      if (c.busyUntil <= now) {
        chain = c;
        break;
      }
      if (c.busyUntil < chain.busyUntil) chain = c;
    }
    if (chain.busyUntil > now) this.stolen++;
    // a stolen chain glides to its new settings instead of jumping (no click)
    chain.input.gain.setTargetAtTime(level, when, 0.002);
    chain.cutoff.setTargetAtTime(Math.min(18000, cutoff), when, 0.002);
    chain.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), when, 0.002);
    this.played++;
    return chain;
  }
}

/** A looping source that follows one world object (a fire, a motor). */
class Follower {
  id = -1;
  private readonly level: SmoothParam;
  private readonly cutoff: SmoothParam;
  private readonly pan: SmoothParam;
  private readonly rate: SmoothParam;

  constructor(kit: AudioKit, buffer: AudioBuffer, rate: number) {
    const src = kit.loop(buffer, rate);
    const lp = kit.filter('lowpass', 18000, 0.6);
    const g = kit.gain(0);
    const p = kit.panner(0);
    src.connect(lp).connect(g).connect(p).connect(kit.mixer.buses.world);
    this.level = new SmoothParam(g.gain, 0.15, 0);
    this.cutoff = new SmoothParam(lp.frequency, 0.15, 18000);
    this.pan = new SmoothParam(p.pan, 0.1, 0);
    this.rate = new SmoothParam(src.playbackRate, 0.05, rate);
  }

  set(level: number, cutoff: number, pan: number, when: number, rate?: number): void {
    this.level.set(level, when);
    this.cutoff.set(cutoff, when);
    this.pan.set(pan, when);
    if (rate !== undefined) this.rate.set(rate, when);
  }

  silence(when: number): void {
    this.id = -1;
    this.level.set(0, when);
  }
}

const _src: MovingPoint = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };

export class WorldVoices {
  /** Impacts, cracks, releases, launches: short sounds. */
  readonly pool: VoicePool;
  /** Explosions: long, never stolen by the gun's impacts. */
  readonly blastPool: VoicePool;
  private readonly fires: Follower[] = [];
  private readonly motors: Follower[] = [];
  /** Per round-pool slot: the round's id and its distance ahead of the listener last frame. */
  private crackIds: Uint32Array | null = null;
  private crackAlong: Float32Array | null = null;
  private variant = 0;
  readonly state = { fires: 0, motors: 0, cracks: 0 };

  constructor(private readonly kit: AudioKit) {
    this.pool = new VoicePool(kit, kit.mixer.buses.world, 20);
    this.blastPool = new VoicePool(kit, kit.mixer.buses.world, 8);
    for (let i = 0; i < 3; i++)
      this.fires.push(new Follower(kit, kit.synth.crackle, 0.9 + 0.1 * i));
    for (let i = 0; i < 2; i++) this.motors.push(new Follower(kit, kit.synth.motor, 1));
  }

  /** A queued sound has arrived: play it at audio time `when`, from where it was made. */
  play(
    sound: WorldSound,
    x: number,
    y: number,
    z: number,
    when: number,
    listener: AudioListener,
  ): void {
    const d = listener.distanceTo(x, y, z);
    const cutoff = absorptionCutoff(d);
    const pan = listener.panOf(x, y, z);
    this.variant = (this.variant + 1) % 997;
    switch (sound.kind) {
      case 'impact': {
        const ref = WORLD_REFERENCE[sound.impact];
        const buffers = this.kit.synth.impacts[sound.impact];
        // a group of rounds keeps its crackle: up to three sources, 14 ms apart, into one chain;
        // together they carry the group's energy
        const sources = Math.min(3, Math.max(1, sound.count));
        const level =
          ref.level *
          distanceGain(d, ref.distance, ref.rolloff) *
          Math.min(3, Math.sqrt(sound.strength / sources));
        const rates: number[] = [];
        for (let k = 0; k < sources; k++) {
          this.variant = (this.variant + 1) % 997;
          rates.push(0.92 + 0.16 * ((this.variant * 0.618) % 1));
        }
        this.pool.playGroup(buffers, this.variant, when, 0.014, level, cutoff, pan, rates);
        break;
      }
      case 'blast': {
        const ref = WORLD_REFERENCE[sound.size];
        const level = ref.level * sound.scale * distanceGain(d, ref.distance, ref.rolloff);
        // bigger charges are lower: up to ±12 % around the rendered size
        const rate = Math.max(0.85, Math.min(1.15, 1 / Math.pow(sound.scale, 0.15)));
        this.blastPool.play(this.kit.synth.blasts[sound.size], when, level, cutoff, pan, rate);
        break;
      }
      case 'release': {
        const buffer = getSample('bombRelease');
        const ref = WORLD_REFERENCE.release;
        if (buffer) {
          this.pool.play(
            buffer,
            when,
            ref.level * distanceGain(d, ref.distance, ref.rolloff),
            cutoff,
            pan,
          );
        }
        break;
      }
      case 'launch': {
        const ref = WORLD_REFERENCE.launch;
        const level = ref.level * distanceGain(d, ref.distance, ref.rolloff);
        this.pool.play(this.kit.synth.whoosh, when, level, cutoff, pan);
        break;
      }
    }
  }

  /** Burning vehicles near the listener crackle (the three nearest within 700 m). */
  updateFires(vehicles: readonly Vehicle[], listener: AudioListener, when: number): void {
    const near: { v: Vehicle; d: number }[] = [];
    for (const v of vehicles) {
      if (!(v.fire > 0.02)) continue;
      const d = listener.distanceTo(v.position.x, v.position.y + 1.5, v.position.z);
      if (d < FIRE_RANGE) near.push({ v, d });
    }
    near.sort((a, b) => a.d - b.d);
    near.length = Math.min(near.length, this.fires.length);
    this.state.fires = near.length;
    // keep each fire on the voice it already has
    for (const f of this.fires) {
      if (f.id >= 0 && !near.some((n) => n.v.id === f.id)) f.silence(when);
    }
    for (const n of near) {
      let voice = this.fires.find((f) => f.id === n.v.id);
      if (!voice) voice = this.fires.find((f) => f.id < 0);
      if (!voice) continue;
      voice.id = n.v.id;
      const p = n.v.position;
      voice.set(
        FIRE_LEVEL * n.v.fire * distanceGain(n.d, FIRE_REF),
        absorptionCutoff(n.d),
        listener.panOf(p.x, p.y + 1.5, p.z),
        when,
      );
    }
  }

  /** Rocket and missile motors still burning (the two nearest), with their Doppler shift. */
  updateMotors(
    bodies: readonly StoreBody[],
    listener: AudioListener,
    c: number,
    when: number,
  ): void {
    const burning: { b: StoreBody; d: number }[] = [];
    for (const b of bodies) {
      if (!b.alive || !(b.motorTime > 0)) continue;
      burning.push({ b, d: listener.distanceTo(b.position.x, b.position.y, b.position.z) });
    }
    burning.sort((a, b) => a.d - b.d);
    burning.length = Math.min(burning.length, this.motors.length);
    this.state.motors = burning.length;
    for (const m of this.motors) {
      if (m.id >= 0 && !burning.some((n) => n.b.id === m.id)) m.silence(when);
    }
    for (const n of burning) {
      let voice = this.motors.find((m) => m.id === n.b.id);
      if (!voice) voice = this.motors.find((m) => m.id < 0);
      if (!voice) continue;
      voice.id = n.b.id;
      const p = n.b.position;
      _src.x = p.x;
      _src.y = p.y;
      _src.z = p.z;
      _src.vx = n.b.velocity.x;
      _src.vy = n.b.velocity.y;
      _src.vz = n.b.velocity.z;
      voice.set(
        MOTOR_LEVEL * distanceGain(n.d, MOTOR_REF),
        absorptionCutoff(n.d),
        listener.panOf(p.x, p.y, p.z),
        when,
        dopplerFactor(_src, listener, c),
      );
    }
  }

  /**
   * Supersonic rounds passing the listener crack: a round whose distance ahead of the listener
   * (along its path) changed sign this frame has just gone by. The crack arrives b·cos μ / c
   * after the round was abeam (crackDelay). Nothing cracks for a listener behind the gun
   * (in the cockpit the rounds only move away).
   */
  scanRounds(
    rounds: RoundPool,
    listener: AudioListener,
    c: number,
    simTime: number,
    toAudio: (simTime: number) => number,
  ): void {
    if (!this.crackIds || this.crackIds.length !== rounds.capacity) {
      this.crackIds = new Uint32Array(rounds.capacity);
      this.crackAlong = new Float32Array(rounds.capacity);
    }
    const ids = this.crackIds;
    const along = this.crackAlong!;
    if (listener.inCockpit) {
      ids.fill(0);
      return;
    }
    let cracks = 0;
    for (let i = 0; i < rounds.capacity; i++) {
      if (!rounds.alive[i]) continue;
      const vx = rounds.vx[i];
      const vy = rounds.vy[i];
      const vz = rounds.vz[i];
      const speed = Math.hypot(vx, vy, vz);
      if (!(speed > 1)) continue;
      const rx = listener.x - rounds.px[i];
      const ry = listener.y - rounds.py[i];
      const rz = listener.z - rounds.pz[i];
      const a = (rx * vx + ry * vy + rz * vz) / speed;
      const fresh = ids[i] !== rounds.id[i];
      const before = along[i];
      ids[i] = rounds.id[i];
      along[i] = a;
      if (fresh || !(before > 0) || a > 0 || cracks >= MAX_CRACKS_PER_FRAME) continue;
      // passed during this frame
      const px = rx - (a * vx) / speed;
      const py = ry - (a * vy) / speed;
      const pz = rz - (a * vz) / speed;
      const miss = Math.hypot(px, py, pz);
      if (miss > CRACK_RANGE) continue;
      const delay = crackDelay(miss, speed, c);
      if (!Number.isFinite(delay)) continue;
      const abeam = simTime + a / speed; // a ≤ 0: the round was abeam a little earlier
      const level = CRACK_LEVEL * crackGain(miss);
      // the shock comes from the abeam point on the round's path
      const pan = listener.panOf(listener.x - px, listener.y - py, listener.z - pz);
      this.pool.play(
        this.kit.synth.crack,
        toAudio(abeam + delay),
        level,
        18000,
        pan,
        0.9 + 0.2 * Math.random(),
      );
      cracks++;
    }
    this.state.cracks += cracks;
  }

  /** Chains of both pools sounding now. */
  get busy(): number {
    return this.pool.busy + this.blastPool.busy;
  }

  reset(when: number): void {
    for (const f of this.fires) f.silence(when);
    for (const m of this.motors) m.silence(when);
    this.crackIds?.fill(0);
  }
}
