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
  ShaderMaterial,
  SRGBColorSpace,
  RepeatWrapping,
  Texture,
  TextureLoader,
  Vector2,
  Vector3,
  type Mesh,
} from 'three';
import type { Sim } from '../core/types';
import type { StationState } from '../core/weapons/types';
import { A10 } from '../data/aircraft';
import type { ExteriorInput, PivotMeta } from './meta';
import { getAircraftTemplates, storeModelId, type AircraftTemplates } from './models';
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
    daylight: 1,
    time: 0,
  };
}

/** Full gear travel time, s (each strut). */
export const GEAR_TRAVEL_TIME = 6;
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
  /** Nose-wheel steering: only while the nose gear is out. */
  steer: boolean;
  angle: number;
}

interface StationVisual {
  station: number;
  group: Group;
  /** Rack type and the store list at the last rebuild. */
  rackType: string | null;
  initial: string[];
  released: number;
  /** One object per store of `initial`, in release order. */
  mounted: Object3D[];
}

export interface AircraftInstance {
  root: Group;
  forCockpit: boolean;
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

function bindPivot(root: Object3D, p: PivotMeta, inputs: Record<string, number>): PivotBinding | null {
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

  if (!opts.forCockpit) {
    // the pilot, the seat and a low-detail cockpit tub (FlightGear's far LOD) behind the canopy
    const pilot = t.pilot.clone(true);
    root.add(pilot);
    const tub = t.cockpit.getObjectByName('A-10-detail-cpt');
    if (tub) {
      const c = tub.clone(true);
      for (const l of meta.cockpit.lods) {
        const o = c.getObjectByName(l.node);
        if (o) o.visible = l.min >= 1; // the far stand-in panel, not the near detail
      }
      root.add(c);
    }
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
      stations.push({ station: s, group: g, rackType: null, initial: [], released: 0, mounted: [] });
    }

  const inst: AircraftInstance = {
    root,
    forCockpit: opts.forCockpit,
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
  const target = ac.gearDown ? 1 : 0;
  const step = dt / GEAR_TRAVEL_TIME;
  st.gear = inst.gear < target ? Math.min(target, inst.gear + step) : Math.max(target, inst.gear - step);
  st.n1[0] = ac.engines?.[0]?.n1 ?? 0;
  st.n1[1] = ac.engines?.[1]?.n1 ?? 0;
  st.barrelAngle = sim.gun?.barrelAngle ?? 0;
  st.stations = sim.stores?.stations ?? null;
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
export function applyAircraftVisualState(inst: AircraftInstance, st: AircraftVisualState, dt: number): void {
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
    if (p.steer) y *= st.gear >= 1 ? 1 : 0;
    if (p.type === 0) p.obj.quaternion.setFromAxisAngle(p.axis, y);
    else p.obj.position.copy(p.rest).addScaledVector(p.axis, y);
  }

  // fully retracted: one merged mesh per material instead of forty gear parts
  const up = st.gear <= 0;
  inst.gearUp.visible = up;
  for (const g of inst.gearPivots) g.visible = !up;
  for (const tg of inst.toggles) tg.obj.visible = tg.rule === 'lock0' ? st.gear <= 0 : st.gear > 0;

  if (st.stations) syncStations(inst, st.stations);
  if (inst.lights) updateLights(inst.lights, st.daylight, st.time);
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

function sameTail(initial: string[], stores: readonly string[]): number {
  // returns k when stores equals initial.slice(k), else −1 (no allocation)
  const k = initial.length - stores.length;
  if (k < 0) return -1;
  for (let i = 0; i < stores.length; i++) if (initial[k + i] !== stores[i]) return -1;
  return k;
}

function syncStations(inst: AircraftInstance, stations: readonly StationState[]): void {
  for (const sv of inst.stations) {
    let st: StationState | null = null;
    for (let i = 0; i < stations.length; i++) if (stations[i].station === sv.station) st = stations[i];
    const rack = st?.rack ?? null;
    const stores = st?.stores ?? EMPTY;
    if (rack === sv.rackType) {
      const k = sameTail(sv.initial, stores);
      if (k >= 0) {
        if (k !== sv.released) {
          sv.released = k;
          for (let i = 0; i < sv.mounted.length; i++) sv.mounted[i].visible = i >= k;
        }
        continue;
      }
    }
    buildStation(inst, sv, rack, stores);
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

function buildStation(inst: AircraftInstance, sv: StationVisual, rack: string | null, stores: readonly string[]): void {
  const t = getAircraftTemplates();
  sv.group.clear();
  sv.mounted = [];
  sv.rackType = rack;
  sv.initial = stores.slice();
  sv.released = 0;
  if (!t || (!rack && stores.length === 0)) return;
  let list = stores.slice();
  let rackType = rack;
  if (!rackType && list.length && RACK_TYPES.has(list[0])) rackType = list.shift() ?? null;
  // implicit launchers and racks for stores that cannot hang on a bare pylon
  const first = list[0] ?? '';
  if (!rackType && first) {
    if (/^AGM-65/.test(first)) rackType = list.length > 1 ? 'LAU-88' : 'LAU-117';
    else if (first === 'AIM-9M') rackType = 'LAU-114';
    else if (list.length > 1) rackType = 'TER-9A';
  }
  const ids = list.map((x) => storeModelId(x));
  if (rackType) {
    const rid = storeModelId(rackType);
    const rackObj = rid ? cloneStore(t, rid) : null;
    if (!rid || !rackObj) return;
    const pl = placementOf(t, sv.station, rid);
    rackObj.position.set(pl.position[0], pl.position[1], pl.position[2]);
    rackObj.quaternion.set(pl.quaternion[0], pl.quaternion[1], pl.quaternion[2], pl.quaternion[3]);
    sv.group.add(rackObj);
    const mounts = t.meta.racks[rid]?.mounts ?? [];
    const order = mounts.length === 3 ? FILL_ORDER_3 : mounts.map((_, i) => i);
    for (let i = 0; i < ids.length && i < order.length; i++) {
      const m = mounts[order[i]];
      const id = rid === 'lau114' ? m.model : ids[i];
      const obj = id ? cloneStore(t, id) : null;
      if (!obj) continue;
      obj.position.set(m.position[0], m.position[1], m.position[2]);
      obj.quaternion.set(m.quaternion[0], m.quaternion[1], m.quaternion[2], m.quaternion[3]);
      rackObj.add(obj);
      sv.mounted.push(obj);
    }
  } else if (ids[0]) {
    const obj = cloneStore(t, ids[0]);
    if (!obj) return;
    const pl = placementOf(t, sv.station, ids[0]);
    obj.position.set(pl.position[0], pl.position[1], pl.position[2]);
    obj.quaternion.set(pl.quaternion[0], pl.quaternion[1], pl.quaternion[2], pl.quaternion[3]);
    sv.group.add(obj);
    sv.mounted.push(obj);
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
    phase: Float32Array.from(ls.map((l, i) => (l.id.startsWith('strobe') ? 0 : l.id === 'tail' ? 0.1 : 0.5 + i * 0.01))),
  };
  p.userData.lights = info;
  p.onBeforeRender = (renderer, _s, camera) => {
    renderer.getDrawingBufferSize(_size);
    const proj = (camera as unknown as { projectionMatrix: { elements: number[] } }).projectionMatrix.elements[5];
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
