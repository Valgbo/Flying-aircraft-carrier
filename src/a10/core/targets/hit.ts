/**
 * Segment tests against vehicle armour.
 *
 * Narrowphase: each armour part is a convex polyhedron (the intersection of its plates' half-
 * spaces), so a segment is clipped against it with the Cyrus–Beck method: the entry parameter is
 * the largest "entering" plane crossing, the exit the smallest "leaving" one, and the plate that
 * gave the entry is the plate struck. Turret parts are tested in the turret frame.
 *
 * A struck point below the natural ground (a dug-in hull, a corner of a hull on a slope) is not a
 * hit: the round meets the earth first, and the terrain test of the weapons module finds that.
 */
import { Vector3 } from 'three';
import { VEHICLE_MODELS } from '../../data/vehicles';
import type { Sim } from '../types';
import { forEachNear } from './grid';
import {
  hullDirToWorld,
  hullDirToTurret,
  hullToTurret,
  turretDirToHull,
  vehiclePose,
  worldDirToHull,
  worldToHull,
  type Pose,
  type V3,
} from './pose';
import type { ArmourPart, ArmourPlate, Vehicle, VehicleClassModel, VehicleHit } from './types';

/** A struck point may lie this far below the ground before the earth is taken to stop it, m. */
const EARTH_TOLERANCE = 0.03;

/**
 * What the last clipPart found: the entry plate and the exit parameter. A scratch object, not two
 * module variables: a number stored in a module variable is boxed on every store.
 */
const clip: { plate: ArmourPlate | null; exit: number } = { plate: null, exit: 0 };

/**
 * Clip p0 + t·d, t ∈ [tMin, tMax], against a convex part (all in the part's frame). Returns the
 * entry parameter, or Infinity if the segment misses or starts inside the part. Leaves the
 * entry plate in `clip.plate` and the exit parameter in `clip.exit`.
 */
export function clipPart(
  part: ArmourPart,
  x0: number,
  y0: number,
  z0: number,
  dx: number,
  dy: number,
  dz: number,
  tMin: number,
  tMax: number,
): number {
  // bounding-box slabs first (cheap reject)
  let tIn = tMin;
  let tOut = tMax;
  const mn = part.min;
  const mx = part.max;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? x0 : a === 1 ? y0 : z0;
    const d = a === 0 ? dx : a === 1 ? dy : dz;
    const lo = mn[a] - 1e-6;
    const hi = mx[a] + 1e-6;
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return Infinity;
      continue;
    }
    let t0 = (lo - o) / d;
    let t1 = (hi - o) / d;
    if (t0 > t1) {
      const s = t0;
      t0 = t1;
      t1 = s;
    }
    if (t0 > tIn) tIn = t0;
    if (t1 < tOut) tOut = t1;
    if (tIn > tOut) return Infinity;
  }
  tIn = tMin;
  tOut = tMax;
  let enter: ArmourPlate | null = null;
  const plates = part.plates;
  for (let i = 0; i < plates.length; i++) {
    const p = plates[i];
    const num = p.d - (p.nx * x0 + p.ny * y0 + p.nz * z0);
    const den = p.nx * dx + p.ny * dy + p.nz * dz;
    if (den > -1e-12 && den < 1e-12) {
      if (num < 0) return Infinity;
      continue;
    }
    const t = num / den;
    if (den < 0) {
      if (t > tIn) {
        tIn = t;
        enter = p;
      }
    } else if (t < tOut) tOut = t;
    if (tIn > tOut) return Infinity;
  }
  if (!enter) return Infinity;
  clip.plate = enter;
  clip.exit = tOut;
  return tIn;
}

/** Result of a test against one vehicle (module scratch). */
export interface PartHit {
  t: number;
  part: number;
  plate: ArmourPlate | null;
  exit: number;
}

const _a: V3 = { x: 0, y: 0, z: 0 };
const _d: V3 = { x: 0, y: 0, z: 0 };
const _ta: V3 = { x: 0, y: 0, z: 0 };
const _td: V3 = { x: 0, y: 0, z: 0 };
const _w: V3 = { x: 0, y: 0, z: 0 };

/**
 * First armour plate of `v` crossed by the world segment a + t·d, t ∈ (tMin, tMax]. `skipPart`
 * excludes one part (the spaced layer a round has just gone through). Fills `out` and returns
 * true on a hit. Turret parts are skipped once the turret has been thrown.
 */
export function rayVehicle(
  sim: Sim,
  v: Vehicle,
  pose: Pose,
  ax: number,
  ay: number,
  az: number,
  dx: number,
  dy: number,
  dz: number,
  tMin: number,
  tMax: number,
  skipPart: number,
  out: PartHit,
): boolean {
  const model = VEHICLE_MODELS[v.kind];
  worldToHull(pose, ax, ay, az, _a);
  worldDirToHull(pose, dx, dy, dz, _d);
  const parts = model.parts;
  const noTurret = v.thrownTurret !== null;
  let best = Infinity;
  for (let i = 0; i < parts.length; i++) {
    if (i === skipPart) continue;
    const part = parts[i];
    let t: number;
    if (part.turret) {
      if (noTurret) continue;
      hullToTurret(pose, _a.x, _a.y, _a.z, _ta);
      hullDirToTurret(pose, _d.x, _d.y, _d.z, _td);
      t = clipPart(part, _ta.x, _ta.y, _ta.z, _td.x, _td.y, _td.z, tMin, Math.min(tMax, best));
    } else {
      t = clipPart(part, _a.x, _a.y, _a.z, _d.x, _d.y, _d.z, tMin, Math.min(tMax, best));
    }
    if (t >= best || t <= tMin) continue;
    // the earth stops what strikes below the natural ground
    const wx = ax + dx * t;
    const wy = ay + dy * t;
    const wz = az + dz * t;
    if (wy < sim.world.terrain.heightAt(wx, wz) - EARTH_TOLERANCE) continue;
    best = t;
    out.t = t;
    out.part = i;
    out.plate = clip.plate;
    out.exit = clip.exit;
  }
  return best < Infinity;
}

/** World outward normal of a plate of a part (turret plates turned with the turret). */
export function plateNormalWorld(
  pose: Pose,
  part: ArmourPart,
  plate: ArmourPlate,
  out: { x: number; y: number; z: number },
): void {
  if (part.turret) {
    turretDirToHull(pose, plate.nx, plate.ny, plate.nz, _w);
    hullDirToWorld(pose, _w.x, _w.y, _w.z, out);
  } else hullDirToWorld(pose, plate.nx, plate.ny, plate.nz, out);
}

// ---- segmentHitVehicle -------------------------------------------------------------------------

const _ph: PartHit = { t: 0, part: -1, plate: null, exit: 0 };
const _n: V3 = { x: 0, y: 0, z: 0 };

// query state for the module-level visitor (no closure per call; fields of one scratch object,
// so storing a number does not box it)
const q: {
  sim: Sim | null;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  len2: number;
  best: number;
  vehicle: number;
  part: number;
  plate: ArmourPlate | null;
} = {
  sim: null,
  x: 0.5,
  y: 0.5,
  z: 0.5,
  dx: 0.5,
  dy: 0.5,
  dz: 0.5,
  len2: 0.5,
  best: Infinity,
  vehicle: -1,
  part: -1,
  plate: null,
};

function visitSegment(i: number): boolean {
  const sim = q.sim as Sim;
  const v = sim.targets.vehicles[i];
  const model: VehicleClassModel = VEHICLE_MODELS[v.kind];
  // bounding sphere (centre above the ground point; margin for pitch and roll)
  const cx = v.position.x;
  const cy = v.position.y + model.sphereY;
  const cz = v.position.z;
  const r = model.sphereR + 0.5;
  const ox = q.x - cx;
  const oy = q.y - cy;
  const oz = q.z - cz;
  let s = -(ox * q.dx + oy * q.dy + oz * q.dz) / q.len2;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  const ex = ox + q.dx * s;
  const ey = oy + q.dy * s;
  const ez = oz + q.dz * s;
  if (ex * ex + ey * ey + ez * ez > r * r) return true;
  const pose = vehiclePose(v, model.turretZ);
  if (rayVehicle(sim, v, pose, q.x, q.y, q.z, q.dx, q.dy, q.dz, 0, Math.min(1, q.best), -1, _ph)) {
    if (
      _ph.t < q.best ||
      (_ph.t === q.best && q.vehicle >= 0 && v.id < sim.targets.vehicles[q.vehicle].id)
    ) {
      q.best = _ph.t;
      q.vehicle = i;
      q.part = _ph.part;
      q.plate = _ph.plate;
    }
  }
  return true;
}

/**
 * First vehicle plate crossed by the segment p0→p1 (world): the nearest entry over every
 * vehicle near the segment (broadphase: spatial hash, then bounding spheres).
 */
export function segmentHitVehicle(sim: Sim, p0: Vector3, p1: Vector3, out: VehicleHit): boolean {
  const t = sim.targets;
  if (t.vehicles.length === 0) return false;
  q.sim = sim;
  q.x = p0.x;
  q.y = p0.y;
  q.z = p0.z;
  q.dx = p1.x - p0.x;
  q.dy = p1.y - p0.y;
  q.dz = p1.z - p0.z;
  q.len2 = q.dx * q.dx + q.dy * q.dy + q.dz * q.dz;
  if (q.len2 < 1e-12) return false;
  q.best = Infinity;
  q.vehicle = -1;
  q.part = -1;
  q.plate = null;
  forEachNear(
    t,
    Math.min(p0.x, p1.x),
    Math.min(p0.z, p1.z),
    Math.max(p0.x, p1.x),
    Math.max(p0.z, p1.z),
    visitSegment,
  );
  q.sim = null;
  return finishHit(sim, p0, out);
}

/** Fill `out` from the query state (the nearest entry found). */
function finishHit(sim: Sim, p0: Vector3, out: VehicleHit): boolean {
  const t = sim.targets;
  // (the visitor sets these; TypeScript cannot see that through the callback)
  const plate = q.plate as ArmourPlate | null;
  const vi = q.vehicle as number;
  if (vi < 0 || !plate) return false;
  const v = t.vehicles[vi];
  const model = VEHICLE_MODELS[v.kind];
  const part = model.parts[q.part];
  plateNormalWorld(vehiclePose(v, model.turretZ), part, plate, _n);
  out.vehicleId = v.id;
  out.t = q.best;
  out.point.set(p0.x + q.dx * q.best, p0.y + q.dy * q.best, p0.z + q.dz * q.best);
  out.normal.set(_n.x, _n.y, _n.z);
  out.thicknessMm = plate.thicknessMm;
  out.part = part.part;
  out.face = plate.face;
  out.plate = plate.index;
  out.partIndex = q.part;
  return true;
}

/**
 * segmentHitVehicle without the broadphase: every vehicle is tested (a reference for tests and
 * tools; the same narrowphase and result).
 */
export function segmentHitVehicleAll(sim: Sim, p0: Vector3, p1: Vector3, out: VehicleHit): boolean {
  const t = sim.targets;
  q.sim = sim;
  q.x = p0.x;
  q.y = p0.y;
  q.z = p0.z;
  q.dx = p1.x - p0.x;
  q.dy = p1.y - p0.y;
  q.dz = p1.z - p0.z;
  q.len2 = q.dx * q.dx + q.dy * q.dy + q.dz * q.dz;
  if (q.len2 < 1e-12 || t.vehicles.length === 0) return false;
  q.best = Infinity;
  q.vehicle = -1;
  q.part = -1;
  q.plate = null;
  for (let i = 0; i < t.vehicles.length; i++) visitSegment(i);
  q.sim = null;
  return finishHit(sim, p0, out);
}

/** Index of the part that holds plate `plateIndex` of a class model. */
export function partOfPlate(model: VehicleClassModel, plateIndex: number): number {
  for (let i = 0; i < model.parts.length; i++) {
    const plates = model.parts[i].plates;
    if (
      plates.length &&
      plateIndex >= plates[0].index &&
      plateIndex <= plates[plates.length - 1].index
    )
      return i;
  }
  return 0;
}
