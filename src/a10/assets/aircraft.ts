/**
 * Aircraft instances: the converted FlightGear A-10 with every moving part driven from the
 * simulation. OWNED BY THE AIRCRAFT (ASSETS) MODULE.
 *
 *   const inst = createAircraftInstance({ forCockpit: false });   // after loadAircraftModels()
 *   scene.add(inst.root);                                          // root = BODY frame
 *   updateAircraftInstance(inst, sim);                             // every frame
 *   disposeAircraftInstance(inst);
 *
 * Pivots come from a10-meta.json (`exterior.pivots`): rotate/spin set the pivot's quaternion
 * from its axis, translate moves it along its axis from its rest position. Per-frame code does
 * not allocate.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  MeshStandardMaterial,
  Object3D,
  Points,
  Quaternion,
  ShaderMaterial,
  SRGBColorSpace,
  RepeatWrapping,
  Texture,
  TextureLoader,
  Vector2,
  Vector3,
  type Mesh,
} from 'three';
import { SIM_DT } from '../core/constants';
import type { Sim } from '../core/types';
import type { StationState, StoreBody } from '../core/weapons/types';
import { A10, A10_FCS } from '../data/aircraft';
import { frameInfo } from '../view/frame';
import type { ExteriorInput, PivotMeta } from './meta';
import {
  getAircraftTemplates,
  podTubesOf,
  storeModelId,
  type AircraftTemplates,
  type PodTubes,
} from './models';
import { a10Asset } from './urls';

// ---------------------------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------------------------
const INPUT_NAMES: ExteriorInput[] = [
  'aileron',
  'elevator',
  'rudder',
  'speedBrake',
  'flaps',
  'slats',
  'canopy',
  'gearNose',
  'gearLeft',
  'gearRight',
  'compressionNose',
  'compressionLeft',
  'compressionRight',
  'wheelNose',
  'wheelLeft',
  'wheelRight',
  'n1Left',
  'n1Right',
  'barrelAngle',
];
const IN = Object.fromEntries(INPUT_NAMES.map((n, i) => [n, i])) as Record<ExteriorInput, number>;

/** Everything the exterior shows, in the simulation's units. */
export interface AircraftVisualState {
  /** −1..1, + roll right. */
  aileron: number;
  /** −1..1, + trailing edge up (nose-up command). */
  elevator: number;
  /** −1..1, + nose right. */
  rudder: number;
  /** 0..1 (1 = full split, A10.speedBrakeMax). */
  speedBrake: number;
  /** Flap angle, rad. */
  flaps: number;
  /** 0..1. */
  slats: number;
  /** 0 closed … 1 open. */
  canopy: number;
  /** Gear position 0 up … 1 down (already animated). */
  gear: number;
  /** Fan speed, fraction of maximum, left and right. */
  n1: [number, number];
  /** Gun barrel cluster angle, rad. */
  barrelAngle: number;
  /** Stores on the stations (null: leave the stations as they are). */
  stations: readonly StationState[] | null;
  /**
   * Store bodies in flight: a store whose release the draw time has not reached yet stays on its
   * pylon, so it leaves at the very frame its body starts to be drawn (null: no such hand-off).
   */
  bodies: readonly StoreBody[] | null;
  /** Sim time this frame is drawn at (view/frame drawPose: one step behind `time`). */
  drawTime: number;
  /** 0 night … 1 day: navigation and anti-collision lights show below about 0.5. */
  daylight: number;
  /** Seconds, for the strobes. */
  time: number;
}

export function createVisualState(): AircraftVisualState {
  return {
    aileron: 0,
    elevator: 0,
    rudder: 0,
    speedBrake: 0,
    flaps: 0,
    slats: 0,
    canopy: 0,
    gear: 0,
    n1: [0, 0],
    barrelAngle: 0,
    stations: null,
    bodies: null,
    drawTime: 0,
    daylight: 1,
    time: 0,
  };
}

/**
 * Full gear travel time, s: only used when the simulation does not give the gear position
 * (`aircraft.gearPosition`, which the flight model animates over the same time).
 */
export const GEAR_TRAVEL_TIME = A10_FCS.gearTravelTime;
/** The speed-brake drive in the meta file assumes an 80° split; the flight data may differ. */
const META_SPEED_BRAKE_SPLIT = (80 * Math.PI) / 180;
/**
 * The fans: drawn at a rate that reads as spinning at 60 frames per second instead of the real
 * 7,365 rpm, which would alias into a slow or backward crawl.
 */
const FAN_VISUAL_RATE = 38; // rad/s at full N1

// ---------------------------------------------------------------------------------------------
// instance
// ---------------------------------------------------------------------------------------------
interface PivotBinding {
  obj: Object3D;
  type: 0 | 1 | 2; // rotate, translate, spin
  axis: Vector3;
  rest: Vector3;
  input: number; // index into the input array, −1 constant
  gain: number;
  offset: number;
  table: Float64Array | null;
  min: number;
  max: number;
  /**
   * Nose-wheel steering (FlightGear turns it with the rudder): the real system works only with
   * weight on the wheels, and our aircraft always flies, so the wheel stays centred.
   */
  steer: boolean;
  angle: number;
}

interface StationVisual {
  station: number;
  group: Group;
  /** Rack type and the store list at the last rebuild. */
  rackType: string | null;
  initial: string[];
  /** Stores of `initial` hidden (released or jettisoned). */
  released: number;
  /** One object per store of `initial`, in release order. */
  mounted: Object3D[];
  /** A rocket pod's rockets (tube by tube), or null. */
  pod: { mesh: Mesh; tubes: PodTubes } | null;
  /** Rockets of the pod hidden (fired). */
  fired: number;
}

export interface AircraftInstance {
  root: Group;
  forCockpit: boolean;
  /** The templates it was made from (its stations are built from them too). */
  templates: AircraftTemplates;
  /** The airframe (exterior file clone). */
  airframe: Group;
  /** Gear position shown, 0 up … 1 down. */
  gear: number;
  state: AircraftVisualState;
  pivots: PivotBinding[];
  gearUp: Group;
  gearPivots: Object3D[];
  toggles: { obj: Object3D; rule: 'lock0' | 'lock1' }[];
  stations: StationVisual[];
  storesGroup: Group;
  lights: Points | null;
  /**
   * The pilot, the seat and the cockpit tub seen through the canopy (outside views only); hidden
   * from far away by updateAircraftDetail.
   */
  interior: Group;
  shadows: boolean;
  lastTime: number;
  inputs: Float64Array;
}

export interface AircraftInstanceOptions {
  /**
   * For the cockpit pass: the outer canopy glass and the pilot are hidden and the inner glass is
   * shown. Otherwise (outside views) the pilot, the seat and the cockpit tub are added.
   */
  forCockpit: boolean;
  /** Draw stores on the stations (default true). */
  stores?: boolean;
  /** Night lights (default true). */
  lights?: boolean;
  /** Templates to use (default: the loaded ones). */
  templates?: AircraftTemplates;
}

function requireTemplates(): AircraftTemplates {
  const t = getAircraftTemplates();
  if (!t) throw new Error('createAircraftInstance: the aircraft models are not loaded yet');
  return t;
}

function bindPivot(
  root: Object3D,
  p: PivotMeta,
  inputs: Record<string, number>,
): PivotBinding | null {
  const obj = root.getObjectByName(p.node);
  if (!obj) return null;
  const d = p.drive;
  const input = d.input !== null && d.input in inputs ? inputs[d.input] : -1;
  return {
    obj,
    type: p.type === 'rotate' ? 0 : p.type === 'translate' ? 1 : 2,
    axis: new Vector3(p.axis[0], p.axis[1], p.axis[2]).normalize(),
    rest: obj.position.clone(),
    input,
    gain: d.gain ?? 0,
    offset: d.offset ?? 0,
    table: d.table ? Float64Array.from(d.table.flat()) : null,
    min: d.min ?? -Infinity,
    max: d.max ?? Infinity,
    steer: p.node.endsWith('__steer'),
    angle: 0,
  };
}

/** Create a drawable aircraft (the models must be loaded: see loadAircraftModels / AircraftView). */
export function createAircraftInstance(opts: AircraftInstanceOptions): AircraftInstance {
  const t = opts.templates ?? requireTemplates();
  const meta = t.meta;
  const root = new Group();
  root.name = opts.forCockpit ? 'a10-aircraft-cockpit' : 'a10-aircraft';
  const airframe = t.exterior.clone(true);
  root.add(airframe);

  // glass: outer from outside, inner from the seat (FlightGear blends both, twice)
  for (const tg of meta.exterior.toggles) {
    const o = airframe.getObjectByName(tg.node);
    if (!o) continue;
    if (tg.semantic?.view === 'outside') o.visible = !opts.forCockpit;
    else if (tg.semantic?.view === 'inside') o.visible = opts.forCockpit;
    else if (tg.semantic?.station !== undefined) o.visible = false; // external fuel tanks
  }
  const toggles: AircraftInstance['toggles'] = [];
  for (const [name, rule] of [
    ['UC-NFD-lock-0', 'lock0'],
    ['UC-NFD-lock-1', 'lock1'],
  ] as const) {
    const o = airframe.getObjectByName(name);
    if (o) toggles.push({ obj: o, rule });
  }

  const interior = new Group();
  interior.name = 'interior';
  if (!opts.forCockpit) {
    // the pilot, the seat and a low-detail cockpit tub (FlightGear's far LOD) behind the canopy
    interior.add(t.pilot.clone(true));
    const tub = t.cockpit.getObjectByName('A-10-detail-cpt');
    if (tub) {
      const c = tub.clone(true);
      for (const l of meta.cockpit.lods) {
        const o = c.getObjectByName(l.node);
        if (o) o.visible = l.min >= 1; // the far stand-in panel, not the near detail
      }
      interior.add(c);
    }
    root.add(interior);
  }

  const inputs = IN as unknown as Record<string, number>;
  const pivots: PivotBinding[] = [];
  for (const p of meta.exterior.pivots) {
    const b = bindPivot(airframe, p, inputs);
    if (b) pivots.push(b);
  }
  const gearUp = t.gearUp.clone(true);
  gearUp.visible = true;
  airframe.add(gearUp);
  const gearPivots = t.gearPivots
    .map((n) => airframe.getObjectByName(n))
    .filter((o): o is Object3D => !!o)
    // outermost only: hiding them hides the rest
    .filter((o, _i, all) => !all.some((a) => a !== o && isAncestor(a, o)));

  const storesGroup = new Group();
  storesGroup.name = 'stations';
  root.add(storesGroup);
  const stations: StationVisual[] = [];
  if (opts.stores !== false)
    for (let s = 1; s <= 11; s++) {
      const g = new Group();
      g.name = `station-${s}`;
      storesGroup.add(g);
      stations.push({
        station: s,
        group: g,
        rackType: null,
        initial: [],
        released: 0,
        mounted: [],
        pod: null,
        fired: 0,
      });
    }

  const inst: AircraftInstance = {
    root,
    forCockpit: opts.forCockpit,
    templates: t,
    airframe,
    gear: 0,
    state: createVisualState(),
    pivots,
    gearUp,
    gearPivots,
    toggles,
    stations,
    storesGroup,
    lights: opts.lights === false ? null : createLights(t),
    interior,
    shadows: false,
    lastTime: -1,
    inputs: new Float64Array(INPUT_NAMES.length),
  };
  if (inst.lights) root.add(inst.lights);
  applyAircraftVisualState(inst, inst.state, 0);
  return inst;
}

function isAncestor(a: Object3D, o: Object3D): boolean {
  for (let p = o.parent; p; p = p.parent) if (p === a) return true;
  return false;
}

/** Release the instance's own GPU objects (shared model data stays loaded). */
export function disposeAircraftInstance(inst: AircraftInstance): void {
  inst.root.removeFromParent();
  if (inst.lights) {
    inst.lights.geometry.dispose();
    (inst.lights.material as ShaderMaterial).dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// per frame
// ---------------------------------------------------------------------------------------------
/** Read the simulation into the instance (call every frame; uses sim.time for its own timing). */
export function updateAircraftInstance(inst: AircraftInstance, sim: Sim, daylight = 1): void {
  const ac = sim.aircraft;
  const dt = inst.lastTime < 0 ? 0 : Math.max(0, Math.min(0.25, sim.time - inst.lastTime));
  inst.lastTime = sim.time;
  const st = inst.state;
  const s = ac.surfaces;
  st.aileron = s?.aileron ?? 0;
  st.elevator = s?.elevator ?? 0;
  st.rudder = s?.rudder ?? 0;
  st.speedBrake = s?.speedBrake ?? 0;
  st.flaps = s?.flaps ?? 0;
  st.slats = s?.slats ?? 0;
  st.canopy = 0;
  // the flight model moves the gear (the same position in every view and on the gear lights)
  const gp = ac.gearPosition;
  if (Number.isFinite(gp)) st.gear = Math.min(1, Math.max(0, gp));
  else {
    const target = ac.gearDown ? 1 : 0;
    const step = dt / GEAR_TRAVEL_TIME;
    st.gear =
      inst.gear < target ? Math.min(target, inst.gear + step) : Math.max(target, inst.gear - step);
  }
  st.n1[0] = ac.engines?.[0]?.n1 ?? 0;
  st.n1[1] = ac.engines?.[1]?.n1 ?? 0;
  st.barrelAngle = sim.gun?.barrelAngle ?? 0;
  st.stations = sim.stores?.stations ?? null;
  st.bodies = sim.projectiles?.bodies ?? null;
  // the frame is drawn one step behind the simulation, at drawPose (view/frame.ts)
  st.drawTime = sim.time - (1 - frameInfo.alpha) * SIM_DT;
  st.daylight = daylight;
  st.time = sim.time;
  applyAircraftVisualState(inst, st, dt);
}

function lookup(t: Float64Array, x: number): number {
  const n = t.length / 2;
  if (x <= t[0]) return t[1];
  for (let i = 1; i < n; i++) {
    const x1 = t[i * 2];
    if (x <= x1) {
      const x0 = t[i * 2 - 2];
      const y0 = t[i * 2 - 1];
      const y1 = t[i * 2 + 1];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return t[t.length - 1];
}

/** Pose every part for a visual state (the sandbox drives this directly). dt in seconds. */
export function applyAircraftVisualState(
  inst: AircraftInstance,
  st: AircraftVisualState,
  dt: number,
): void {
  const v = inst.inputs;
  v[IN.aileron] = st.aileron;
  v[IN.elevator] = st.elevator;
  v[IN.rudder] = st.rudder;
  v[IN.speedBrake] = st.speedBrake * (A10.speedBrakeMax / META_SPEED_BRAKE_SPLIT);
  v[IN.flaps] = st.flaps;
  v[IN.slats] = st.slats;
  v[IN.canopy] = st.canopy;
  v[IN.gearNose] = v[IN.gearLeft] = v[IN.gearRight] = st.gear;
  v[IN.compressionNose] = v[IN.compressionLeft] = v[IN.compressionRight] = 0;
  v[IN.wheelNose] = v[IN.wheelLeft] = v[IN.wheelRight] = 0;
  v[IN.n1Left] = st.n1[0];
  v[IN.n1Right] = st.n1[1];
  v[IN.barrelAngle] = st.barrelAngle;
  inst.gear = st.gear;

  for (const p of inst.pivots) {
    const x = p.input >= 0 ? v[p.input] : 0;
    if (p.type === 2) {
      // spin: gain is rad/s per unit of input
      const fan = p.input === IN.n1Left || p.input === IN.n1Right;
      const rate = fan ? FAN_VISUAL_RATE * x : p.gain * x;
      p.angle = (p.angle + rate * dt) % (Math.PI * 2);
      p.obj.quaternion.setFromAxisAngle(p.axis, p.angle);
      continue;
    }
    let y = p.table ? lookup(p.table, x) : p.gain * x + p.offset;
    if (y < p.min) y = p.min;
    if (y > p.max) y = p.max;
    if (p.steer) y = 0;
    if (p.type === 0) p.obj.quaternion.setFromAxisAngle(p.axis, y);
    else p.obj.position.copy(p.rest).addScaledVector(p.axis, y);
  }

  // fully retracted: one merged mesh per material instead of forty gear parts
  const up = st.gear <= 0;
  inst.gearUp.visible = up;
  for (const g of inst.gearPivots) g.visible = !up;
  for (const tg of inst.toggles) tg.obj.visible = tg.rule === 'lock0' ? st.gear <= 0 : st.gear > 0;

  if (st.stations) syncStations(inst, st.stations, st.bodies, st.drawTime);
  if (inst.lights) updateLights(inst.lights, st.daylight, st.time);
}

/**
 * Below this size on screen (pixels per metre at the aircraft) the pilot and the cockpit behind
 * the canopy are not drawn (PLAN §14: no cockpit in distant outside views). At 1080 lines and a
 * 62° field of view that is 100 m away, where the canopy is 9 pixels wide.
 */
export const INTERIOR_MIN_PIXELS_PER_METRE = 9;

/**
 * Level of detail for outside views (call every frame after placing the instance): hides the
 * pilot and the cockpit tub when they would be a few pixels on screen (22 draw calls and
 * 15,000 triangles less). `viewportHeight` in pixels, `fovDeg` the camera's vertical field of view.
 */
export function updateAircraftDetail(
  inst: AircraftInstance,
  cameraPosition: Vector3,
  fovDeg: number,
  viewportHeight: number,
): void {
  if (inst.forCockpit) return;
  const d = Math.max(0.1, cameraPosition.distanceTo(inst.root.position));
  const pixelsPerMetre = viewportHeight / (2 * d * Math.tan((fovDeg * Math.PI) / 360));
  inst.interior.visible = pixelsPerMetre >= INTERIOR_MIN_PIXELS_PER_METRE;
}

/** Cast and receive shadows (the High preset only; call when the preset changes). */
export function setAircraftShadows(inst: AircraftInstance, on: boolean): void {
  if (inst.shadows === on) return;
  inst.shadows = on;
  inst.root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    m.castShadow = on && !/Fan/.test(m.parent?.name ?? '');
    m.receiveShadow = on;
  });
}

// ---------------------------------------------------------------------------------------------
// stores on the stations
// ---------------------------------------------------------------------------------------------
const RACK_TYPES = new Set(['TER-9A', 'LAU-88', 'LAU-117', 'LAU-114']);
/** FlightGear fills triple racks left, right, then centre. */
const FILL_ORDER_3 = [0, 2, 1];
/** Station numbers index these per-frame counters (1 … 11). */
const STATION_SLOTS = 16;
/** Per station: store bodies (rockets apart) released after the draw time, still drawn on it. */
const _pending = new Int16Array(STATION_SLOTS);
/** Per station: rockets released after the draw time, still drawn in their tubes. */
const _rocketPending = new Int16Array(STATION_SLOTS);

function sameTail(initial: string[], stores: readonly string[]): number {
  // returns k when stores equals initial.slice(k), else −1 (no allocation)
  const k = initial.length - stores.length;
  if (k < 0) return -1;
  for (let i = 0; i < stores.length; i++) if (initial[k + i] !== stores[i]) return -1;
  return k;
}

/**
 * Count the store bodies that left each station after `drawTime` (the time this frame is drawn
 * at, one step behind the simulation): they are drawn on their pylon until the draw time reaches
 * their release, at the moment the flying store view starts drawing them in flight.
 */
function countPending(bodies: readonly StoreBody[] | null, drawTime: number): void {
  _pending.fill(0);
  _rocketPending.fill(0);
  if (!bodies) return;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (!b.alive || !(b.releaseTime > drawTime)) continue;
    const s = b.station;
    if (!(s >= 1 && s < STATION_SLOTS)) continue;
    if (b.kind === 'rocket') _rocketPending[s]++;
    else _pending[s]++;
  }
}

function syncStations(
  inst: AircraftInstance,
  stations: readonly StationState[],
  bodies: readonly StoreBody[] | null,
  drawTime: number,
): void {
  countPending(bodies, drawTime);
  for (const sv of inst.stations) {
    let st: StationState | null = null;
    for (let i = 0; i < stations.length; i++)
      if (stations[i].station === sv.station) st = stations[i];
    const rack = st?.rack ?? null;
    const stores = st?.stores ?? EMPTY;
    const pending = sv.station < STATION_SLOTS ? _pending[sv.station] : 0;
    if (rack !== sv.rackType) {
      // a jettisoned rack goes with its stores when the draw time reaches the jettison
      if (pending > 0 && rack === null && stores.length === 0) continue;
      buildStation(inst, sv, rack, stores);
    } else {
      const k = sameTail(sv.initial, stores);
      if (k < 0) buildStation(inst, sv, rack, stores);
      else {
        const hide = Math.max(0, k - pending);
        if (hide !== sv.released) {
          sv.released = hide;
          for (let i = 0; i < sv.mounted.length; i++) sv.mounted[i].visible = i >= hide;
        }
      }
    }
    // a rocket pod stays; its rockets leave their tubes one by one
    const pod = sv.pod;
    if (pod) {
      const tubes = pod.tubes.axes.length;
      const left = st?.rockets;
      const fired =
        left === undefined
          ? 0
          : Math.min(tubes, Math.max(0, tubes - left - _rocketPending[sv.station]));
      if (fired !== sv.fired) {
        sv.fired = fired;
        pod.mesh.geometry = pod.tubes.stages[fired];
        pod.mesh.visible = fired < tubes;
      }
    }
  }
}
const EMPTY: string[] = [];

function placementOf(t: AircraftTemplates, station: number, modelId: string) {
  const s = t.meta.stations[station - 1];
  const p = s.placements[modelId] ?? (modelId === 'gbu12' ? s.placements.mk82 : undefined);
  if (p) return p;
  const half = s.pitch / 2;
  return {
    position: s.suspension,
    quaternion: [Math.sin(half), 0, 0, Math.cos(half)] as [number, number, number, number],
    source: 'pylon suspension point',
  };
}

function cloneStore(t: AircraftTemplates, id: string): Object3D | null {
  const tpl = t.stores.get(id);
  if (!tpl) return null;
  const c = tpl.clone(true);
  c.matrixAutoUpdate = true;
  return c;
}

/** What a station carries as drawn: the rack or launcher (explicit or implied) and its stores. */
interface StationLayout {
  /** Rack model id, or null for a store on the bare pylon. */
  rackId: string | null;
  /** Store model ids in release order. */
  ids: (string | null)[];
  /** The rack's mount used by each store (index into meta.racks[rackId].mounts). */
  mountOf: number[];
}

const _layout: StationLayout = { rackId: null, ids: [], mountOf: [] };

/**
 * The drawn layout of a station loaded with `rack` and `stores` (release order): the launcher a
 * store needs when the load names none (a Maverick: LAU-117 or LAU-88; AIM-9s: LAU-114; several
 * bombs: TER-9A), and the rack mount of each store (FlightGear fills a triple rack left, right,
 * then centre). Returns false when nothing can be drawn there.
 */
function stationLayout(
  t: AircraftTemplates,
  rack: string | null,
  stores: readonly string[],
  out: StationLayout,
): boolean {
  out.rackId = null;
  out.ids.length = 0;
  out.mountOf.length = 0;
  let first = 0;
  let rackType = rack;
  if (!rackType && stores.length && RACK_TYPES.has(stores[0])) {
    rackType = stores[0];
    first = 1;
  }
  const lead = stores[first] ?? '';
  if (!rackType && lead) {
    const n = stores.length - first;
    if (/^AGM-65/.test(lead)) rackType = n > 1 ? 'LAU-88' : 'LAU-117';
    else if (lead === 'AIM-9M') rackType = 'LAU-114';
    else if (n > 1) rackType = 'TER-9A';
  }
  for (let i = first; i < stores.length; i++) out.ids.push(storeModelId(stores[i], t.meta));
  if (!rackType) return out.ids.length > 0 && out.ids[0] !== null;
  const rid = storeModelId(rackType, t.meta);
  if (!rid || !t.stores.has(rid)) return false;
  out.rackId = rid;
  const mounts = t.meta.racks[rid]?.mounts ?? [];
  for (let i = 0; i < out.ids.length; i++) {
    out.mountOf.push(i < mounts.length ? (mounts.length === 3 ? FILL_ORDER_3[i] : i) : -1);
  }
  return true;
}

const _mp = new Vector3();
const _mq = new Quaternion();

/**
 * Where a store hangs, in the aircraft's BODY frame (the same placement the stations draw): the
 * `index`-th store, in release order, of a station loaded with `rack` (null: none or implied) and
 * `stores`. `index` −1 is the rack or launcher itself. `outPosition` is the store's reference
 * point: its centre (`meta.stores[id].centre`, where a store in flight is drawn from) or, with
 * `origin` 'lugs', its suspension lugs. Returns false when that store is not drawn there.
 */
export function storeMount(
  t: AircraftTemplates,
  station: number,
  rack: string | null,
  stores: readonly string[],
  index: number,
  outPosition: Vector3,
  outQuaternion: Quaternion,
  origin: 'centre' | 'lugs' = 'centre',
): boolean {
  if (!(station >= 1 && station <= t.meta.stations.length)) return false;
  if (!stationLayout(t, rack, stores, _layout)) return false;
  let id: string | null;
  if (_layout.rackId) {
    const pl = placementOf(t, station, _layout.rackId);
    outPosition.set(pl.position[0], pl.position[1], pl.position[2]);
    outQuaternion.set(pl.quaternion[0], pl.quaternion[1], pl.quaternion[2], pl.quaternion[3]);
    if (index < 0) id = _layout.rackId;
    else {
      const mi = _layout.mountOf[index] ?? -1;
      const mount = t.meta.racks[_layout.rackId]?.mounts[mi];
      if (!mount) return false;
      id = _layout.rackId === 'lau114' ? mount.model : (_layout.ids[index] ?? null);
      _mp.set(mount.position[0], mount.position[1], mount.position[2]);
      outPosition.add(_mp.applyQuaternion(outQuaternion));
      _mq.set(mount.quaternion[0], mount.quaternion[1], mount.quaternion[2], mount.quaternion[3]);
      outQuaternion.multiply(_mq);
    }
  } else {
    if (index !== 0) return false;
    id = _layout.ids[0];
    if (!id) return false;
    const pl = placementOf(t, station, id);
    outPosition.set(pl.position[0], pl.position[1], pl.position[2]);
    outQuaternion.set(pl.quaternion[0], pl.quaternion[1], pl.quaternion[2], pl.quaternion[3]);
  }
  if (!id || !t.meta.stores[id]) return false;
  if (origin === 'centre') {
    const c = t.meta.stores[id].centre;
    outPosition.add(_mp.set(c[0], c[1], c[2]).applyQuaternion(outQuaternion));
  }
  return true;
}

/**
 * Where the rocket of a pod's tube is, in the BODY frame: its centre on the tube's axis with its
 * nose in the tube mouth, and its orientation (the pod's). `tube` counts in firing order (0 = the
 * first to leave). False when the pod's tubes are not known.
 */
export function podRocketMount(
  t: AircraftTemplates,
  station: number,
  pod: string,
  tube: number,
  outPosition: Vector3,
  outQuaternion: Quaternion,
): boolean {
  const id = storeModelId(pod, t.meta);
  const tpl = id ? t.stores.get(id) : null;
  if (!id || !tpl || !storeMount(t, station, null, [pod], 0, outPosition, outQuaternion, 'lugs'))
    return false;
  let tubes: PodTubes | null = null;
  tpl.traverse((o) => {
    if (!tubes && (o as Mesh).isMesh) tubes = podTubesOf(o as Mesh);
  });
  const info = tubes as PodTubes | null;
  const axis = info?.axes[tube];
  if (!info || !axis) return false;
  const rocket = t.meta.stores.hydra70;
  const half = rocket ? rocket.length / 2 : 0.88;
  _mp.set(axis.x, axis.y, info.noseZ + half).applyQuaternion(outQuaternion);
  outPosition.add(_mp);
  return true;
}

/**
 * A rack or launcher with the stores it still carries, drawn on its own (a jettisoned rack in
 * flight): BODY-aligned axes, origin at the rack's centre (`meta.stores[id].centre`, where a body
 * in flight is drawn from). `first` is the release-order index of the first carried store in the
 * rack's load, so each sits on the mount it hung from. Null when the rack has no model.
 */
export function createLoadedRack(
  t: AircraftTemplates,
  rack: string,
  carried: readonly string[],
  first = 0,
): Group | null {
  const list: string[] = [];
  for (let i = 0; i < first; i++) list.push(carried[0] ?? '');
  for (const c of carried) list.push(c);
  if (!stationLayout(t, rack, list, _layout) || !_layout.rackId) return null;
  const rid = _layout.rackId;
  const rackObj = cloneStore(t, rid);
  if (!rackObj) return null;
  const mounts = t.meta.racks[rid]?.mounts ?? [];
  for (let i = first; i < _layout.ids.length; i++) {
    const m = mounts[_layout.mountOf[i]];
    const id = m ? (rid === 'lau114' ? m.model : _layout.ids[i]) : null;
    const obj = id ? cloneStore(t, id) : null;
    if (!m || !obj) continue;
    obj.position.set(m.position[0], m.position[1], m.position[2]);
    obj.quaternion.set(m.quaternion[0], m.quaternion[1], m.quaternion[2], m.quaternion[3]);
    rackObj.add(obj);
  }
  const c = t.meta.stores[rid]?.centre ?? [0, 0, 0];
  rackObj.position.set(-c[0], -c[1], -c[2]);
  const g = new Group();
  g.name = `rack-${rid}`;
  g.add(rackObj);
  return g;
}

function buildStation(
  inst: AircraftInstance,
  sv: StationVisual,
  rack: string | null,
  stores: readonly string[],
): void {
  const t = inst.templates;
  sv.group.clear();
  sv.mounted = [];
  sv.rackType = rack;
  sv.initial = stores.slice();
  sv.released = 0;
  sv.pod = null;
  sv.fired = 0;
  if (!t || (!rack && stores.length === 0)) return;
  if (!stationLayout(t, rack, stores, _layout)) return;
  if (_layout.rackId) {
    const rid = _layout.rackId;
    const rackObj = cloneStore(t, rid);
    if (!rackObj) return;
    const pl = placementOf(t, sv.station, rid);
    rackObj.position.set(pl.position[0], pl.position[1], pl.position[2]);
    rackObj.quaternion.set(pl.quaternion[0], pl.quaternion[1], pl.quaternion[2], pl.quaternion[3]);
    sv.group.add(rackObj);
    const mounts = t.meta.racks[rid]?.mounts ?? [];
    for (let i = 0; i < _layout.ids.length; i++) {
      const m = mounts[_layout.mountOf[i]];
      if (!m) continue;
      const id = rid === 'lau114' ? m.model : _layout.ids[i];
      const obj = id ? cloneStore(t, id) : null;
      if (!obj) continue;
      obj.position.set(m.position[0], m.position[1], m.position[2]);
      obj.quaternion.set(m.quaternion[0], m.quaternion[1], m.quaternion[2], m.quaternion[3]);
      rackObj.add(obj);
      sv.mounted.push(obj);
    }
  } else if (_layout.ids[0]) {
    const obj = cloneStore(t, _layout.ids[0]);
    if (!obj) return;
    const pl = placementOf(t, sv.station, _layout.ids[0]);
    obj.position.set(pl.position[0], pl.position[1], pl.position[2]);
    obj.quaternion.set(pl.quaternion[0], pl.quaternion[1], pl.quaternion[2], pl.quaternion[3]);
    sv.group.add(obj);
    sv.mounted.push(obj);
    // a rocket pod: its rockets, tube by tube
    obj.traverse((o) => {
      const tubes = !sv.pod && (o as Mesh).isMesh ? podTubesOf(o as Mesh) : null;
      if (tubes) sv.pod = { mesh: o as Mesh, tubes };
    });
  }
  if (inst.shadows) {
    inst.shadows = false;
    setAircraftShadows(inst, true);
  }
}

// ---------------------------------------------------------------------------------------------
// navigation and anti-collision lights (one draw call; glow points sized in pixels)
// ---------------------------------------------------------------------------------------------
const LIGHT_VERT = /* glsl */ `
attribute vec3 color;
attribute float intensity;
uniform float uPixels;
varying vec3 vColor;
varying float vIntensity;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(-mv.z, 0.1);
  gl_PointSize = intensity > 0.001 ? clamp(uPixels * 1.6 / d, 5.0, 64.0) : 0.0;
  vColor = color;
  vIntensity = intensity;
}`;
const LIGHT_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vIntensity;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  // a hot core and a wide halo
  float a = (0.35 * exp(-r2 * 3.0) + exp(-r2 * 30.0)) * vIntensity;
  gl_FragColor = vec4(vColor * a * 5.0, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const _size = new Vector2();
interface LightInfo {
  kind: string[];
  phase: Float32Array;
}

function createLights(t: AircraftTemplates): Points {
  const ls = t.meta.lights.filter((l) => l.kind !== 'landing');
  const pos = new Float32Array(ls.length * 3);
  const col = new Float32Array(ls.length * 3);
  ls.forEach((l, i) => {
    pos.set(l.position, i * 3);
    // the top beacon is red
    col.set(l.id === 'top' ? [1, 0.1, 0.05] : l.colour, i * 3);
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setAttribute('intensity', new BufferAttribute(new Float32Array(ls.length), 1));
  g.computeBoundingSphere();
  const m = new ShaderMaterial({
    vertexShader: LIGHT_VERT,
    fragmentShader: LIGHT_FRAG,
    uniforms: { uPixels: { value: 600 } },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const p = new Points(g, m);
  p.name = 'lights';
  p.frustumCulled = false;
  p.renderOrder = 10;
  const info: LightInfo = {
    kind: ls.map((l) => l.id),
    phase: Float32Array.from(
      ls.map((l, i) => (l.id.startsWith('strobe') ? 0 : l.id === 'tail' ? 0.1 : 0.5 + i * 0.01)),
    ),
  };
  p.userData.lights = info;
  p.onBeforeRender = (renderer, _s, camera) => {
    renderer.getDrawingBufferSize(_size);
    const proj = (camera as unknown as { projectionMatrix: { elements: number[] } })
      .projectionMatrix.elements[5];
    (m.uniforms.uPixels as { value: number }).value = 0.5 * _size.y * proj * 0.35;
  };
  return p;
}

function updateLights(p: Points, daylight: number, time: number): void {
  const night = Math.min(1, Math.max(0, (0.55 - daylight) / 0.3));
  const attr = p.geometry.getAttribute('intensity') as BufferAttribute;
  const a = attr.array as Float32Array;
  const info = p.userData.lights as LightInfo;
  for (let i = 0; i < a.length; i++) {
    const k = info.kind[i];
    if (k === 'navLeft' || k === 'navRight') a[i] = night;
    else {
      // anti-collision: a short double flash every 1.2 s (wing tips and tail), the beacon slower
      const period = k === 'top' ? 1.0 : 1.2;
      const ph = (time + info.phase[i]) % period;
      const on = k === 'top' ? ph < 0.12 : ph < 0.05 || (ph > 0.18 && ph < 0.23);
      a[i] = on ? night * 1.6 : 0;
    }
  }
  attr.needsUpdate = true;
  p.visible = night > 0;
}

// ---------------------------------------------------------------------------------------------
// liveries (shared by every instance: the textures are shared)
// ---------------------------------------------------------------------------------------------
const liveryCache = new Map<string, Promise<Texture>>();
let currentLivery = 'default';

/** The paint scheme shown (meta.liveries id). */
export function getAircraftLivery(): string {
  return currentLivery;
}

/** Paint scheme ids from meta.liveries ('default', 'usaf-low-vis', 'acc'). */
export async function setAircraftLivery(id: string): Promise<void> {
  const t = getAircraftTemplates();
  if (!t || id === currentLivery) return;
  const l = t.meta.liveries.find((x) => x.id === id);
  if (!l) return;
  let p = liveryCache.get(l.main);
  if (!p) {
    p = new TextureLoader().loadAsync(a10Asset(l.main)).then((tex) => {
      tex.flipY = false;
      tex.colorSpace = SRGBColorSpace;
      tex.wrapS = tex.wrapT = RepeatWrapping;
      return tex;
    });
    liveryCache.set(l.main, p);
  }
  const tex = await p;
  currentLivery = id;
  const slot = t.meta.liverySlots.main;
  // three.js keeps a texture's GPU object when only its source changes, so every material gets
  // a new texture (same UV transform) instead
  const roots = [t.exterior, t.gearUp];
  for (const r of roots)
    r.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as MeshStandardMaterial;
      if (m.userData.texture !== slot || !m.map || m.map.source === tex.source) return;
      const old = m.map;
      const next = tex.clone();
      next.offset.copy(old.offset);
      next.repeat.copy(old.repeat);
      next.rotation = old.rotation;
      next.center.copy(old.center);
      next.channel = old.channel;
      m.map = next;
      if (m.emissiveMap === old) m.emissiveMap = next;
      m.needsUpdate = true;
    });
}
