/**
 * Vehicle state: creation, lookup, the kill-state rules (PLAN §9: intact → damaged → destroyed →
 * catastrophic), the events and debrief records that go with each change, fires, ammunition
 * explosions and the turret thrown by a catastrophic kill.
 */
import { Euler, Quaternion, Vector3 } from 'three';
import {
  AMMO_EFFECTS,
  KILL_RULES,
  SECONDARY_CHARGE,
  THERMAL,
  VEHICLE_MODELS,
  VEHICLE_SHAPES,
} from '../../data/vehicles';
import { quaternionFromAttitude } from '../frames';
import type { Sim } from '../types';
import { createPose, hullToWorld, poseOf, type V3 } from './pose';
import type {
  ComponentId,
  Vehicle,
  VehicleCondition,
  VehicleGroup,
  VehicleInternal,
  VehicleKind,
} from './types';

export const COMPONENT_IDS: readonly ComponentId[] = [
  'engine',
  'fuel',
  'ammo',
  'gun',
  'runningGear',
  'optics',
  'crew',
  'cargo',
];

/** Order in which a hit's damaged components are reported (most telling first). */
const REPORT_ORDER: readonly ComponentId[] = [
  'ammo',
  'fuel',
  'crew',
  'engine',
  'gun',
  'runningGear',
  'optics',
  'cargo',
];

const RANK: Record<VehicleCondition, number> = {
  intact: 0,
  damaged: 1,
  destroyed: 2,
  catastrophic: 3,
};

export const isAlive = (v: Vehicle): boolean =>
  v.condition === 'intact' || v.condition === 'damaged';

export const isTruck = (k: VehicleKind): boolean =>
  k === 'truckCargo' || k === 'truckFuel' || k === 'truckAmmo';

/** Which component kinds each class has at all. */
const HAS: Record<VehicleKind, Record<ComponentId, boolean>> = {} as Record<
  VehicleKind,
  Record<ComponentId, boolean>
>;
for (const kind of Object.keys(VEHICLE_MODELS) as VehicleKind[]) {
  const has = {} as Record<ComponentId, boolean>;
  for (const id of COMPONENT_IDS) has[id] = false;
  for (const b of VEHICLE_MODELS[kind].components) has[b.id] = true;
  HAS[kind] = has;
}

/** Classes that run on wheels (the running-gear mean rule applies to them only). */
const WHEELED = {} as Record<VehicleKind, boolean>;
for (const kind of Object.keys(VEHICLE_SHAPES) as VehicleKind[]) {
  WHEELED[kind] = VEHICLE_SHAPES[kind].running.type === 'wheels';
}

export function hasComponent(kind: VehicleKind, id: ComponentId): boolean {
  return HAS[kind][id];
}

function createInternal(kind: VehicleKind): VehicleInternal {
  return {
    boxHealth: new Float32Array(VEHICLE_MODELS[kind].components.length).fill(1),
    fireIn: 0,
    fireInTarget: 0,
    fireInLoad: 0,
    fireOut: 0,
    fireOutTarget: 0,
    fireOutLoad: 0,
    explodeTime: -1,
    cookOffDecided: false,
    popTime: -1,
    popsLeft: 0,
    lastWeapon: '',
    burstTime: -1,
    burstX: 0,
    burstY: 0,
    burstZ: 0,
    leg: 0,
    s: 0,
    cruise: 0,
    goalX: 0,
    goalZ: 0,
    hasGoal: false,
    waitUntil: 0,
    digDepth: 0,
    scanPhase: 0,
    groundPitch: 0,
    groundRoll: 0,
    slopeTimer: 0,
    pose: createPose(),
    poseKey: new Float64Array(7).fill(NaN),
  };
}

/** Pitch and roll of a hull resting on the ground at (x, z) with this heading (rad). */
export function groundAttitude(
  sim: Sim,
  kind: VehicleKind,
  x: number,
  z: number,
  heading: number,
  out: { pitch: number; roll: number },
): void {
  const s = VEHICLE_SHAPES[kind];
  const h = sim.world.terrain;
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  const lx = Math.max(0.5, s.hullLength * 0.4);
  const wx = Math.max(0.5, s.hullWidth * 0.4);
  const hf = h.heightAt(x + fx * lx, z + fz * lx);
  const hr = h.heightAt(x - fx * lx, z - fz * lx);
  // right = (cos h, 0, sin h) in world x/z
  const hR = h.heightAt(x + -fz * wx, z + fx * wx);
  const hL = h.heightAt(x + fz * wx, z - fx * wx);
  out.pitch = Math.atan2(hf - hr, 2 * lx);
  out.roll = Math.atan2(hL - hR, 2 * wx);
}

const _att = { pitch: 0, roll: 0 };

/**
 * A new vehicle on the ground at (x, z), intact, engine running for powered classes (the
 * scenario switches engines off for parked groups), registered in the spatial index.
 */
export function createVehicle(
  sim: Sim,
  kind: VehicleKind,
  x: number,
  z: number,
  heading: number,
  groupId: number,
): Vehicle {
  const t = sim.targets;
  const components = {} as Record<ComponentId, number>;
  for (const c of COMPONENT_IDS) components[c] = 1;
  const powered = kind !== 'hulk' && kind !== 'panel';
  groundAttitude(sim, kind, x, z, heading, _att);
  const v: Vehicle = {
    id: t.nextVehicleId++,
    kind,
    position: new Vector3(x, sim.world.terrain.heightAt(x, z), z),
    heading,
    speed: 0,
    turretYaw: 0,
    pitch: _att.pitch,
    roll: _att.roll,
    condition: 'intact',
    mobilityKill: false,
    firepowerKill: false,
    fire: 0,
    engineOn: powered,
    heat: powered
      ? {
          engine: THERMAL.engineIdle,
          exhaust: THERMAL.exhaustIdle,
          running: 0,
          hull: THERMAL.hullSun + THERMAL.hullEngineShare * THERMAL.engineIdle,
        }
      : { engine: 0, exhaust: 0, running: 0, hull: THERMAL.hullSun },
    components,
    groupId,
    conditionTime: sim.time,
    thrownTurret: null,
    dugIn: false,
    hits: 0,
    lastHitTime: -1,
    internal: createInternal(kind),
  };
  v.internal.groundPitch = v.pitch;
  v.internal.groundRoll = v.roll;
  // turrets scan out of step with each other (golden-angle phases)
  v.internal.scanPhase = (v.id * 2.399963) % (Math.PI * 2);
  t.vehicles.push(v);
  t.internal.dirty = true;
  return v;
}

/** Switch a vehicle's engine off and let it be cold (parked for hours). */
export function setEngineCold(v: Vehicle): void {
  v.engineOn = false;
  v.heat.engine = 2;
  v.heat.exhaust = 1;
  v.heat.running = 0;
  v.heat.hull = THERMAL.hullSun;
}

let lastIndex = 0;

/** Vehicle by id (the last one found is tried first: bursts hit one vehicle many times). */
export function findVehicle(sim: Sim, id: number): Vehicle | null {
  const list = sim.targets.vehicles;
  const c = list[lastIndex];
  if (c && c.id === id) return c;
  const n = list[lastIndex + 1];
  if (n && n.id === id) {
    lastIndex++;
    return n;
  }
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      lastIndex = i;
      return list[i];
    }
  }
  return null;
}

export function findGroup(sim: Sim, id: number): VehicleGroup | null {
  const g = sim.targets.groups;
  for (let i = 0; i < g.length; i++) if (g[i].id === id) return g[i];
  return null;
}

/** Recompute the per-component health from the health of its boxes (weighted mean). */
export function updateComponentHealth(v: Vehicle): void {
  const boxes = VEHICLE_MODELS[v.kind].components;
  if (!boxes.length) return;
  const rt = v.internal;
  for (let k = 0; k < COMPONENT_IDS.length; k++) {
    const id = COMPONENT_IDS[k];
    let w = 0;
    let h = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].id !== id) continue;
      w += boxes[i].weight;
      h += boxes[i].weight * rt.boxHealth[i];
    }
    v.components[id] = w > 0 ? h / w : 1;
  }
}

/** The group a vehicle belongs to was attacked: remember when (the behaviour reacts). */
export function alertGroup(sim: Sim, groupId: number): void {
  const g = findGroup(sim, groupId);
  if (g && g.alertTime < 0) g.alertTime = sim.time;
}

/** Append a hit record for the debrief (PLAN §9: plate, angle, speed, result). */
export function recordHit(
  sim: Sim,
  v: Vehicle,
  sourceId: number,
  weapon: string,
  plate: number,
  face: string,
  part: string,
  speed: number,
  obliquity: number,
  effectiveThicknessMm: number,
  penetrationMm: number,
  outcome: 'penetrated' | 'stopped' | 'ricochet' | 'burst' | 'passedThrough' | 'blast' | 'fragment',
  damaged: readonly ComponentId[],
): void {
  sim.debrief.hits.push({
    time: sim.time,
    sourceId,
    weapon,
    vehicleId: v.id,
    vehicleKind: v.kind,
    plate,
    face,
    part,
    speed,
    obliquity,
    effectiveThicknessMm,
    penetrationMm,
    outcome,
    damaged: damaged.slice(),
    condition: v.condition,
  });
}

/** Sort a hit's damaged list in report order (no allocation). */
export function sortDamaged(list: ComponentId[]): void {
  for (let i = 1; i < list.length; i++) {
    const c = list[i];
    const r = REPORT_ORDER.indexOf(c);
    let j = i - 1;
    while (j >= 0 && REPORT_ORDER.indexOf(list[j]) > r) {
      list[j + 1] = list[j];
      j--;
    }
    list[j + 1] = c;
  }
}

/** 'vehicleDamaged' for a hit that hurt at least one component. */
export function emitDamaged(sim: Sim, v: Vehicle, component: ComponentId | null): void {
  sim.events.push({
    type: 'vehicleDamaged',
    t: sim.time,
    vehicleId: v.id,
    vehicleKind: v.kind,
    condition: v.condition,
    component,
  });
}

/**
 * Raise a vehicle's condition (never lowers it). Destroyed and catastrophic kills count once,
 * add the kill record and emit 'vehicleDestroyed'; a later cook-off (destroyed → catastrophic)
 * updates the kill record and emits 'vehicleDestroyed' again with catastrophic = true.
 */
export function setCondition(sim: Sim, v: Vehicle, cond: VehicleCondition, weapon: string): void {
  if (RANK[cond] <= RANK[v.condition]) return;
  const old = v.condition;
  const t = sim.targets;
  v.condition = cond;
  v.conditionTime = sim.time;
  if (cond === 'damaged') {
    t.damaged++;
    return;
  }
  if (old === 'damaged') t.damaged--;
  v.engineOn = false;
  const catastrophic = cond === 'catastrophic';
  if (old === 'intact' || old === 'damaged') {
    t.killed++;
    sim.debrief.kills.push({
      time: sim.time,
      vehicleId: v.id,
      kind: v.kind,
      weapon: weapon || v.internal.lastWeapon || 'unknown',
      catastrophic,
    });
  } else {
    const kills = sim.debrief.kills;
    for (let i = 0; i < kills.length; i++)
      if (kills[i].vehicleId === v.id) kills[i].catastrophic = true;
  }
  sim.events.push({
    type: 'vehicleDestroyed',
    t: sim.time,
    vehicleId: v.id,
    vehicleKind: v.kind,
    catastrophic,
    position: { x: v.position.x, y: v.position.y, z: v.position.z },
  });
}

/** Apply the class kill rules to the component health and fires; raise the condition. */
export function evaluateCondition(sim: Sim, v: Vehicle, weapon: string): void {
  if (v.condition === 'catastrophic') return;
  const boxes = VEHICLE_MODELS[v.kind].components;
  if (!boxes.length) return; // hulks and panels stay intact
  const rt = v.internal;
  let mobility = v.mobilityKill;
  let firepower = v.firepowerKill;
  let engineDead = false;
  let failures = 0;
  for (let i = 0; i < boxes.length; i++) {
    if (rt.boxHealth[i] > KILL_RULES.boxDead) continue;
    const b = boxes[i];
    if (b.effect === 'mobility') mobility = true;
    else if (b.effect === 'firepower') firepower = true;
    if (b.id === 'engine') engineDead = true;
    else failures++;
  }
  // Wheels: tyres and axles wear down together (eight-wheelers, trucks). A tracked vehicle is
  // immobilised only by a broken track (its box dead), not by the mean of two damaged ones.
  if (
    WHEELED[v.kind] &&
    HAS[v.kind].runningGear &&
    v.components.runningGear <= KILL_RULES.runningGearKill
  )
    mobility = true;
  if (engineDead) v.engineOn = false;
  v.mobilityKill = mobility;
  v.firepowerKill = firepower && HAS[v.kind].gun;
  let destroyed = rt.fireIn >= KILL_RULES.fireKill;
  if (HAS[v.kind].crew && v.components.crew <= KILL_RULES.crewKill) destroyed = true;
  if (isTruck(v.kind) && engineDead && failures >= KILL_RULES.truckFailures) destroyed = true;
  const target: VehicleCondition = destroyed
    ? 'destroyed'
    : v.mobilityKill || v.firepowerKill
      ? 'damaged'
      : 'intact';
  setCondition(sim, v, target, weapon);
}

/** Light (or feed) a fire inside the hull, crew or cargo space. */
export function igniteInside(v: Vehicle, intensity: number, load: number): void {
  const rt = v.internal;
  rt.fireInTarget = Math.max(rt.fireInTarget, intensity);
  rt.fireInLoad = Math.min(1500, rt.fireInLoad + load);
  if (rt.fireIn < 0.05) rt.fireIn = 0.05;
}

/** Light (or feed) a fire outside the hull (fender cells, drums, a truck's own tank). */
export function igniteOutside(v: Vehicle, intensity: number, load: number): void {
  const rt = v.internal;
  rt.fireOutTarget = Math.max(rt.fireOutTarget, intensity);
  rt.fireOutLoad = Math.min(600, rt.fireOutLoad + load);
  if (rt.fireOut < 0.05) rt.fireOut = 0.05;
}

/** Arm an ammunition (or tanker) explosion `delay` seconds from now (the earliest one wins). */
export function scheduleExplosion(sim: Sim, v: Vehicle, delay: number): void {
  const at = sim.time + Math.max(0, delay);
  const rt = v.internal;
  if (rt.explodeTime < 0 || at < rt.explodeTime) rt.explodeTime = at;
}

const _pose = createPose();
const _p: V3 = { x: 0, y: 0, z: 0 };
const _qh = new Quaternion();
const _qy = new Quaternion();
const _e = new Euler(0, 0, 0, 'XYZ');
const _up = new Vector3(0, 1, 0);

/** Throw the turret of a catastrophic kill: up, a little sideways, tumbling. */
function throwTurret(sim: Sim, v: Vehicle): void {
  const s = VEHICLE_SHAPES[v.kind];
  if (!s.turret || v.thrownTurret) return;
  const r = sim.rng.damage;
  const model = VEHICLE_MODELS[v.kind];
  poseOf(v, model.turretZ, _pose);
  const top = s.hullClearance + s.hullHeight;
  hullToWorld(_pose, 0, top + 0.45 * s.turret.height, s.turret.offsetZ, _p);
  // world orientation of the turret = hull orientation · turret yaw about the hull's up axis
  quaternionFromAttitude(v.heading, v.pitch, v.roll, _qh);
  _qy.setFromAxisAngle(_up, -v.turretYaw);
  _qh.multiply(_qy);
  _e.setFromQuaternion(_qh, 'XYZ');
  // heavier turrets fly lower: a T-72 turret (≈12 t) is lifted ≈5–15 m by its ammunition
  const heavy = v.kind === 'mbt';
  const up = heavy ? r.range(9, 17) : r.range(12, 22);
  const side = r.range(1.5, 5);
  const dir = r.range(0, Math.PI * 2);
  v.thrownTurret = {
    position: new Vector3(_p.x, _p.y, _p.z),
    velocity: new Vector3(Math.cos(dir) * side, up, Math.sin(dir) * side),
    spin: new Vector3(r.normal() * 1.4, r.normal() * 1.8, r.normal() * 1.4),
    angle: new Vector3(_e.x, _e.y, _e.z),
  };
}

/**
 * The ammunition (or a tanker's load) goes up: catastrophic kill, turret thrown, big fire, the
 * 'secondary' detonation event with the vehicle id (and 'vehicleDestroyed' through setCondition,
 * in the same step, so effects and audio show and play it once).
 */
export function explode(sim: Sim, v: Vehicle, weapon: string): void {
  if (v.condition === 'catastrophic') return;
  const rt = v.internal;
  const fx = AMMO_EFFECTS[v.kind];
  rt.explodeTime = -1;
  throwTurret(sim, v);
  igniteInside(v, 1, 600);
  rt.fireIn = Math.max(rt.fireIn, 0.8);
  const boxes = VEHICLE_MODELS[v.kind].components;
  for (let i = 0; i < boxes.length; i++) {
    const id = boxes[i].id;
    if (id === 'ammo' || id === 'crew' || (v.kind === 'truckFuel' && id === 'fuel'))
      rt.boxHealth[i] = 0;
  }
  updateComponentHealth(v);
  v.mobilityKill = true;
  if (HAS[v.kind].gun) v.firepowerKill = true;
  setCondition(sim, v, 'catastrophic', weapon || rt.lastWeapon);
  const charge = fx ? fx.charge : SECONDARY_CHARGE[v.kind];
  sim.events.push({
    type: 'detonation',
    t: sim.time,
    position: { x: v.position.x, y: v.position.y + 1.2, z: v.position.z },
    charge,
    kind: 'secondary',
    vehicleId: v.id,
    surface: sim.world.terrain.surfaceAt(v.position.x, v.position.z),
  });
  if (fx && fx.pops[1] > 0) {
    const r = sim.rng.damage;
    rt.popsLeft = r.int(fx.pops[0], fx.pops[1]);
    rt.popTime = sim.time + r.range(0.5, 4);
  }
}
