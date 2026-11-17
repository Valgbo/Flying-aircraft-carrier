/**
 * Stores in flight (STORES-VIEW module, wave 2; docs/a10/ARCHITECTURE.md §12.2, §12.7): every
 * store body of `sim.projectiles.bodies` drawn with its model —
 *
 * - at its pose interpolated between the last two simulation steps by `frameInfo.alpha`, like the
 *   aircraft (drawPose), so a store and its aircraft never judder against each other; a body is
 *   drawn from the frame whose draw time reaches its release, the frame its store leaves the
 *   pylon (assets/aircraft.ts), and is blended over a quarter of a second from where it hung
 *   (assets `storeMount`) into its own path, so the hand-off is seamless whatever point the
 *   weapons module releases it from;
 * - a Mk 82 AIR's BSU-49 ballute when `body.highDrag` turns on, filling out;
 * - a rocket or missile motor while it burns (`body.motorTime`): the flame jet at the nozzle and
 *   the smoke trail left in the air, puff by puff along the exact path flown during the frame;
 *   the flash and the cloud at the launcher on `motorIgnition`;
 * - a jettisoned rack with the stores it still carries, a jettisoned pod with its rockets;
 * - gone on its `detonation` (by bodyId) or when its body leaves the list.
 *
 * Lives in the effects runtime (view/effects/fx.ts): `onSimFrame` with the frame's events, then
 * `update` once per frame BEFORE the particle system moves, so the trail puffs of the frame are
 * born at their exact times. Allocation-free per frame once the models of a flight exist (models
 * and per-body view states are pooled; bodies are found by id: the weapons module reuses them).
 */
import { Group, Mesh, Quaternion, Vector3, type Object3D } from 'three';
import {
  createLoadedRack,
  createStoreInstance,
  getAircraftTemplates,
  podRocketMount,
  podTubesOf,
  storeModelId,
  storeMount,
  type AircraftTemplates,
} from '../../assets';
import { SIM_DT } from '../../core/constants';
import type { Sim, SimEvent } from '../../core/types';
import type { StoreBody } from '../../core/weapons/types';
import { STORES } from '../../data/munitions';
import { fxRandom as R } from '../effects/noise';
import { PK } from '../effects/particleKinds';
import type { FxContext } from '../effects/recipes';
import { drawPose, frameInfo, type FrameInfo } from '../frame';
import { BALLUTE_FILL, HANDOFF_BLEND, HANDOFF_MAX, MOTOR_LOOK, type MotorLook } from './look';

/** Stations are numbered 1 … 11. */
const STATIONS = 11;

/** What hangs on a station, followed through the frame's releases (for the hand-off). */
interface StationLoad {
  rack: string | null;
  /** The load when it was complete (release order), and what is left of it. */
  initial: string[];
  left: string[];
  /** Rockets left in a pod. */
  rockets: number;
}

/** The view state of one body in flight (pooled). */
interface DrawnBody {
  id: number;
  body: StoreBody | null;
  /** Model key ('' none yet) and the drawn model, which may be pooled by key. */
  key: string;
  obj: Group | null;
  pooled: boolean;
  /** The ballute part and its scale at rest. */
  chute: Object3D | null;
  chuteScale: Vector3;
  chuteSince: number;
  /** Body length (m): the nozzle is half of it behind the centre. */
  length: number;
  /** Drawn at least once; its detonation arrived. */
  drawn: boolean;
  dead: boolean;
  /** Where it hung, BODY frame (known: hasMount), and the blend offset from there. */
  mount: Vector3;
  hasMount: boolean;
  offset: Vector3;
  offsetTime: number;
  /** The nozzle's world position last frame. */
  nozzle: Vector3;
  nozzleValid: boolean;
  trailAcc: number;
  stamp: number;
}

export interface StoresViewStats {
  /** Bodies followed, and drawn this frame. */
  bodies: number;
  drawn: number;
  /** Trail puffs and launch puffs spawned so far. */
  puffs: number;
}

const _p = new Vector3();
const _q = new Quaternion();
const _acP = new Vector3();
const _acQ = new Quaternion();
const _m = new Vector3();
const _mq = new Quaternion();
const _axis = new Vector3();
const _noz = new Vector3();
const _seg = new Vector3();

/** Extra fields the weapons module may give a body (read defensively: not in the contract). */
interface BodyExtras {
  prevPosition?: Vector3;
  prevOrientation?: Quaternion;
  carried?: readonly string[];
  rockets?: number;
}

/**
 * The pose a body is drawn at: between the start and the end of the last step by the frame's
 * draw time (`prevPosition`/`prevOrientation` when the weapons module keeps them, else back along
 * its velocity). False while the draw time has not reached its release (it is still on its pylon).
 */
export function bodyDrawPose(
  b: StoreBody,
  simTime: number,
  drawTime: number,
  outPosition: Vector3,
  outOrientation: Quaternion,
): boolean {
  if (drawTime < b.releaseTime - 1e-9) return false;
  const x = b as StoreBody & BodyExtras;
  const pp = x.prevPosition;
  const pq = x.prevOrientation;
  if (pp && pq) {
    // prev* = the start of the last step, or the release point for a body released in it
    const start = Math.max(simTime - SIM_DT, b.releaseTime);
    const span = simTime - start;
    const u = span > 1e-9 ? Math.min(1, Math.max(0, (drawTime - start) / span)) : 1;
    outPosition.lerpVectors(pp, b.position, u);
    outOrientation.slerpQuaternions(pq, b.orientation, u);
  } else {
    const back = Math.max(0, Math.min(simTime - drawTime, simTime - b.releaseTime));
    outPosition.copy(b.position).addScaledVector(b.velocity, -back);
    outOrientation.copy(b.orientation);
  }
  return true;
}

function smoothstep01(x: number): number {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

function isRack(type: string): boolean {
  return STORES[type as keyof typeof STORES]?.kind === 'rack';
}

function isPod(type: string): boolean {
  return STORES[type as keyof typeof STORES]?.rockets !== undefined;
}

export class StoresPresenter {
  readonly root = new Group();
  readonly stats: StoresViewStats = { bodies: 0, drawn: 0, puffs: 0 };
  /** Templates to draw with (default: the loaded ones; tests set placeholders). */
  templates: AircraftTemplates | null = null;

  private sim: Sim | null = null;
  private frame = 0;
  private readonly active: DrawnBody[] = [];
  private readonly spare: DrawnBody[] = [];
  private readonly models = new Map<string, Group[]>();
  private readonly loads: StationLoad[] = [];

  constructor() {
    this.root.name = 'a10-stores-in-flight';
    for (let s = 0; s <= STATIONS; s++)
      this.loads.push({ rack: null, initial: [], left: [], rockets: 0 });
  }

  private tpl(): AircraftTemplates | null {
    return this.templates ?? getAircraftTemplates();
  }

  /** Forget everything (a new flight). */
  reset(): void {
    for (let i = this.active.length - 1; i >= 0; i--) this.release(i);
    for (const l of this.loads) {
      l.rack = null;
      l.initial.length = 0;
      l.left.length = 0;
      l.rockets = 0;
    }
  }

  private bind(sim: Sim): void {
    if (sim === this.sim) return;
    this.reset();
    this.sim = sim;
    this.syncLoads(sim);
  }

  /** The drawn body with this id, or null. */
  find(id: number): DrawnBody | null {
    for (let i = 0; i < this.active.length; i++) if (this.active[i].id === id) return this.active[i];
    return null;
  }

  /** How many bodies are followed (tests, sandboxes). */
  get count(): number {
    return this.active.length;
  }

  /** The drawn model of a body (tests, sandboxes), or null. */
  modelOf(id: number): Group | null {
    return this.find(id)?.obj ?? null;
  }

  private add(id: number): DrawnBody {
    const d =
      this.spare.pop() ??
      ({
        id: 0,
        body: null,
        key: '',
        obj: null,
        pooled: false,
        chute: null,
        chuteScale: new Vector3(1, 1, 1),
        chuteSince: -1,
        length: 1,
        drawn: false,
        dead: false,
        mount: new Vector3(),
        hasMount: false,
        offset: new Vector3(),
        offsetTime: 0,
        nozzle: new Vector3(),
        nozzleValid: false,
        trailAcc: 0,
        stamp: 0,
      } satisfies DrawnBody);
    d.id = id;
    d.body = null;
    d.key = '';
    d.obj = null;
    d.pooled = false;
    d.chute = null;
    d.chuteSince = -1;
    d.length = 1;
    d.drawn = false;
    d.dead = false;
    d.hasMount = false;
    d.offset.set(0, 0, 0);
    d.nozzleValid = false;
    d.trailAcc = R.next();
    d.stamp = this.frame;
    this.active.push(d);
    return d;
  }

  private release(i: number): void {
    const d = this.active[i];
    this.detach(d);
    const last = this.active.length - 1;
    this.active[i] = this.active[last];
    this.active.length = last;
    d.body = null;
    this.spare.push(d);
  }

  /** Put a body's model back in its pool (or drop it). */
  private detach(d: DrawnBody): void {
    const obj = d.obj;
    if (!obj) return;
    obj.visible = false;
    if (d.chute) {
      d.chute.scale.copy(d.chuteScale);
      d.chute.visible = false;
    }
    if (d.pooled) {
      let list = this.models.get(d.key);
      if (!list) this.models.set(d.key, (list = []));
      list.push(obj);
    } else this.root.remove(obj);
    d.obj = null;
    d.chute = null;
  }

  // ---- events --------------------------------------------------------------------------------

  /** Wire to `onSimFrame` (through the effects runtime): releases, ignitions, detonations. */
  onSimFrame(events: readonly SimEvent[], sim: Sim, info: FrameInfo, ctx: FxContext): void {
    this.bind(sim);
    const frameStart = sim.time - info.simDt;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'storeReleased') this.released(e, sim);
      else if (e.type === 'motorIgnition') {
        const b = findBody(sim, e.bodyId);
        if (b) {
          ctx.ps.delay = Math.max(0, Math.min(info.simDt, e.t - frameStart));
          this.launch(b, sim, e.t, ctx);
          ctx.ps.delay = 0;
        }
      } else if (e.type === 'detonation' && e.bodyId) {
        const d = this.find(e.bodyId);
        if (d) {
          d.dead = true;
          if (d.obj) d.obj.visible = false;
        }
      }
    }
    this.syncLoads(sim);
  }

  /** A store left a station: remember where it hung, for the hand-off blend. */
  private released(e: Extract<SimEvent, { type: 'storeReleased' }>, sim: Sim): void {
    const b = e.bodyId > 0 ? findBody(sim, e.bodyId) : null;
    if (!b) return;
    const d = this.find(b.id) ?? this.add(b.id);
    d.body = b;
    const s = e.station;
    const t = this.tpl();
    if (!t || !(s >= 1 && s <= STATIONS)) return;
    const load = this.loads[s];
    if (b.kind === 'rocket') {
      // one rocket out of the pod: the tube that fires next (FlightGear's order)
      const pod = load.left[0];
      const tubes = pod ? (STORES[pod as keyof typeof STORES]?.rockets ?? 0) : 0;
      const tube = tubes - load.rockets;
      if (pod && load.rockets > 0 && podRocketMount(t, s, pod, tube, d.mount, _mq)) {
        d.hasMount = true;
      }
      load.rockets = Math.max(0, load.rockets - 1);
    } else if (isRack(e.store) || (load.rack !== null && e.store === load.rack)) {
      d.hasMount = storeMount(t, s, load.rack ?? e.store, load.initial, -1, d.mount, _mq);
    } else if (load.left[0] === e.store) {
      const index = load.initial.length - load.left.length;
      d.hasMount = storeMount(t, s, load.rack, load.initial, index, d.mount, _mq);
      load.left.shift();
    }
  }

  /** Keep each station's load in step with the simulation (after the frame's releases). */
  private syncLoads(sim: Sim): void {
    const stations = sim.stores.stations;
    for (let i = 0; i < stations.length; i++) {
      const st = stations[i];
      if (!(st.station >= 1 && st.station <= STATIONS)) continue;
      const l = this.loads[st.station];
      // a new load (start, rearm): it is complete now
      let tail = st.rack === l.rack && st.stores.length <= l.initial.length;
      if (tail) {
        const k = l.initial.length - st.stores.length;
        for (let j = 0; j < st.stores.length && tail; j++)
          if (l.initial[k + j] !== st.stores[j]) tail = false;
      }
      if (!tail) {
        l.rack = st.rack;
        l.initial.length = 0;
        for (let j = 0; j < st.stores.length; j++) l.initial.push(st.stores[j]);
      }
      l.left.length = 0;
      for (let j = 0; j < st.stores.length; j++) l.left.push(st.stores[j]);
      l.rockets = st.rockets ?? 0;
    }
  }

  /** The flash and the cloud of a motor lighting on its rail or in its tube. */
  private launch(b: StoreBody, sim: Sim, t: number, ctx: FxContext): void {
    if (b.kind !== 'rocket' && b.kind !== 'missile') return;
    const look = MOTOR_LOOK[b.kind === 'rocket' ? 'rocket' : 'missile'];
    const ps = ctx.ps;
    // where it lit: its release point (prev of a body released in the last step) or back along
    // its path to the ignition time
    const x = b as StoreBody & BodyExtras;
    if (x.prevPosition && b.releaseTime > sim.time - SIM_DT) _p.copy(x.prevPosition);
    else _p.copy(b.position).addScaledVector(b.velocity, -Math.max(0, sim.time - t));
    _axis.set(0, 0, -1).applyQuaternion(b.orientation);
    ps.groundY = ctx.groundAt(_p.x, _p.z);
    const f = ps.spawn(PK.flash, _p.x, _p.y, _p.z, 0, 0, 0, look.launchFlash * 0.5, look.launchFlash, 0.08);
    ps.emissive(f, 1.1);
    const v = sim.aircraft.velocity;
    const n = Math.max(1, Math.round(look.launchPuffs * Math.min(1.2, ctx.detail)));
    for (let k = 0; k < n; k++) {
      // the exhaust blasts back out of the launcher; the cloud stops in the air within metres
      const back = R.range(4, 18);
      const keep = R.range(0.55, 0.85);
      const i = ps.spawn(
        PK.launchSmoke,
        _p.x - _axis.x * R.range(0.5, 2) + R.signed(0.4),
        _p.y - _axis.y * R.range(0.5, 2) + R.signed(0.4),
        _p.z - _axis.z * R.range(0.5, 2) + R.signed(0.4),
        v.x * keep - _axis.x * back + R.signed(3),
        v.y * keep - _axis.y * back + R.signed(3),
        v.z * keep - _axis.z * back + R.signed(3),
        look.launchS0 * R.range(0.8, 1.2),
        look.launchS1 * R.range(0.75, 1.25),
        look.launchLife * R.range(0.75, 1.25),
      );
      ps.color(i, look.smokeColour[0], look.smokeColour[1], look.smokeColour[2], 0.85);
      this.stats.puffs++;
    }
  }

  // ---- every frame ---------------------------------------------------------------------------

  /**
   * Draw every body in flight for this frame and emit its motor's flame and smoke. Call after the
   * camera has moved and before the particle system advances (`dt` = simulated seconds).
   */
  update(sim: Sim | null, dt: number, ctx: FxContext): void {
    if (!sim) {
      if (this.sim) {
        this.reset();
        this.sim = null;
      }
      return;
    }
    this.bind(sim);
    this.frame++;
    const t = this.tpl();
    const drawTime = sim.time - (1 - frameInfo.alpha) * SIM_DT;
    drawPose(sim, _acP, _acQ);
    const bodies = sim.projectiles.bodies;
    let drawn = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b.alive) continue;
      const d = this.find(b.id) ?? this.add(b.id);
      d.stamp = this.frame;
      d.body = b;
      if (d.dead || !bodyDrawPose(b, sim.time, drawTime, _p, _q)) {
        if (d.obj) d.obj.visible = false;
        continue;
      }
      if (!d.obj && t) this.attach(d, b, t);
      if (!d.drawn) {
        d.drawn = true;
        d.offsetTime = drawTime;
        d.offset.set(0, 0, 0);
        if (d.hasMount) {
          // where it hung, at this frame's aircraft pose: blend from there into its path
          _m.copy(d.mount).applyQuaternion(_acQ).add(_acP);
          d.offset.subVectors(_m, _p);
          if (d.offset.lengthSq() > HANDOFF_MAX * HANDOFF_MAX) d.offset.set(0, 0, 0);
        }
      }
      const age = drawTime - d.offsetTime;
      if (age < HANDOFF_BLEND) _p.addScaledVector(d.offset, 1 - smoothstep01(age / HANDOFF_BLEND));
      if (d.obj) {
        d.obj.position.copy(_p);
        d.obj.quaternion.copy(_q);
        d.obj.visible = true;
        drawn++;
      }
      this.ballute(d, b, drawTime);
      this.motor(d, b, dt, ctx);
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].stamp !== this.frame) this.release(i);
    }
    this.stats.bodies = this.active.length;
    this.stats.drawn = drawn;
  }

  /** Give a body its model (from the pool when one is free). */
  private attach(d: DrawnBody, b: StoreBody, t: AircraftTemplates): void {
    const x = b as StoreBody & BodyExtras;
    const carried = Array.isArray(x.carried) ? x.carried : null;
    let obj: Group | null = null;
    if (b.kind !== 'rocket' && carried && carried.length > 0 && isRack(b.type)) {
      // a jettisoned rack with what it still carries: built for it, not pooled
      const load = b.station >= 1 && b.station <= STATIONS ? this.loads[b.station] : null;
      const first = load ? Math.max(0, load.initial.length - carried.length) : 0;
      obj = createLoadedRack(t, b.type, carried, first);
      d.key = '';
      d.pooled = false;
      if (obj) this.root.add(obj);
    } else {
      const key = b.kind === 'rocket' ? 'hydra70' : (storeModelId(b.type, t.meta) ?? '');
      if (!key) return;
      d.key = key;
      d.pooled = true;
      obj = this.models.get(key)?.pop() ?? null;
      if (!obj) {
        obj = createStoreInstance(key, 'centre', t);
        if (obj) this.root.add(obj);
      }
    }
    if (!obj) return;
    d.obj = obj;
    const meta = d.key ? t.meta.stores[d.key] : t.meta.stores[storeModelId(b.type, t.meta) ?? ''];
    d.length = meta?.length ?? 2;
    // the Mk 82 AIR's ballute, hidden until the simulation opens it
    d.chute = null;
    for (const tg of meta?.toggles ?? []) {
      if (!/chute/i.test(tg.node)) continue;
      const c = obj.getObjectByName(tg.node);
      if (c) {
        d.chute = c;
        d.chuteScale.copy(c.scale);
        c.visible = false;
      }
    }
    // a jettisoned rocket pod: the rockets still in it
    if (d.key && isPod(b.type)) {
      const left = typeof x.rockets === 'number' ? x.rockets : null;
      obj.traverse((o) => {
        const tubes = (o as Mesh).isMesh ? podTubesOf(o as Mesh) : null;
        if (!tubes) return;
        const n = tubes.axes.length;
        const fired = left === null ? 0 : Math.min(n, Math.max(0, n - left));
        (o as Mesh).geometry = tubes.stages[fired];
        o.visible = fired < n;
      });
    }
  }

  /** The Mk 82 AIR ballute: shown, filling out, while `highDrag` is on. */
  private ballute(d: DrawnBody, b: StoreBody, drawTime: number): void {
    const c = d.chute;
    if (!c) return;
    if (!b.highDrag) {
      c.visible = false;
      d.chuteSince = -1;
      return;
    }
    if (d.chuteSince < 0) d.chuteSince = drawTime;
    const fill = smoothstep01((drawTime - d.chuteSince) / BALLUTE_FILL);
    c.visible = true;
    const s = 0.25 + 0.75 * fill;
    c.scale.set(d.chuteScale.x * s, d.chuteScale.y * s, d.chuteScale.z * (0.4 + 0.6 * fill));
  }

  /** A burning motor: the flame jet and the smoke trail along this frame's path. */
  private motor(d: DrawnBody, b: StoreBody, dt: number, ctx: FxContext): void {
    if (b.kind !== 'rocket' && b.kind !== 'missile') return;
    if (!(b.motorTime > 0)) {
      d.nozzleValid = false;
      return;
    }
    const look: MotorLook = MOTOR_LOOK[b.kind === 'rocket' ? 'rocket' : 'missile'];
    const ps = ctx.ps;
    _axis.set(0, 0, -1).applyQuaternion(_q);
    _noz.copy(_p).addScaledVector(_axis, -0.5 * d.length);
    if (!d.nozzleValid) {
      d.nozzle.copy(_noz);
      d.nozzleValid = true;
    }
    ps.groundY = ctx.groundAt(_noz.x, _noz.z);
    if (dt > 0) {
      // the flame: a few glowing sprites riding with the nozzle, drawn this frame only (born at
      // the end of the frame, gone before the next but one)
      ps.delay = dt;
      const v = b.velocity;
      for (let k = 0; k < 3; k++) {
        const back = (k * look.flameLength) / 2;
        const size = look.flameSize * (1 - 0.28 * k);
        const i = ps.spawn(
          PK.motorFlame,
          _noz.x - _axis.x * back,
          _noz.y - _axis.y * back,
          _noz.z - _axis.z * back,
          v.x,
          v.y,
          v.z,
          size,
          size,
          Math.max(0.03, dt * 1.6),
        );
        ps.emissive(i, R.range(0.85, 1.1) * (1 - 0.22 * k));
      }
      const g = ps.spawn(PK.glint, _noz.x, _noz.y, _noz.z, v.x, v.y, v.z, look.glowSize, look.glowSize, Math.max(0.03, dt * 1.6));
      ps.emissive(g, 0.12);
      ps.color(g, 1, 0.82, 0.55);
      // the trail: puffs spread along the path flown this frame, each born when the nozzle passed
      _seg.subVectors(_noz, d.nozzle);
      const len = _seg.length();
      const c = ctx.camera;
      const far = Math.hypot(_noz.x - c.x, _noz.y - c.y, _noz.z - c.z);
      const spacing = (look.smokeSpacing * Math.max(1, far / 250)) / Math.max(0.45, ctx.detail);
      d.trailAcc += len / spacing;
      const n = Math.min(64, Math.floor(d.trailAcc));
      d.trailAcc -= n;
      for (let k = 0; k < n; k++) {
        const u = (k + R.next()) / n;
        ps.delay = u * dt;
        const out = R.range(3, 10);
        const i = ps.spawn(
          PK.motorSmoke,
          d.nozzle.x + _seg.x * u,
          d.nozzle.y + _seg.y * u,
          d.nozzle.z + _seg.z * u,
          -_axis.x * out + R.signed(1.2),
          -_axis.y * out + R.signed(1.2),
          -_axis.z * out + R.signed(1.2),
          look.smokeS0 * R.range(0.8, 1.2),
          look.smokeS1 * R.range(0.8, 1.3),
          look.smokeLife * R.range(0.8, 1.25),
        );
        ps.color(i, look.smokeColour[0], look.smokeColour[1], look.smokeColour[2], look.smokeAlpha);
        this.stats.puffs++;
      }
      ps.delay = 0;
    }
    d.nozzle.copy(_noz);
  }

  dispose(): void {
    this.reset();
    this.root.clear();
    this.models.clear();
  }
}

function findBody(sim: Sim, id: number): StoreBody | null {
  const list = sim.projectiles.bodies;
  for (let i = 0; i < list.length; i++) if (list[i].id === id && list[i].alive) return list[i];
  return null;
}
