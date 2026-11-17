/**
 * Live 30 mm rounds: motion and impacts (PLAN_A10.md §6.1 rule 1 and §6.3).
 *
 * Each step every live round is flown with the shared integrator (ballistics.ts) from the later
 * of the step start and its muzzle time to the step end, through the mean wind at the round
 * (sampled when it leaves the muzzle and every WIND_EVERY steps after).
 * The step's segment is tested against the vehicles (targets module) and the ground; the nearer
 * hit wins:
 *  - vehicle: resolveRoundHit decides (penetrated / stopped / ricochet / burst / passedThrough).
 *    A ricochet carries on with the velocity it returns; otherwise the round ends.
 *  - ground: water ends it ('water'); a shallow impact on hard ground (road, concrete, rock,
 *    dirt, a dry field) makes it skip, keeping 50–70 % of its speed at a flatter angle with some
 *    sideways scatter (at most two skips); otherwise it digs in ('ground').
 *  - HEI rounds burst on any impact: a 'detonation' (kind 'hei') and applyBlast at the point.
 * Every hit emits 'roundImpact' (HEI included: views draw the burst from it). Rounds leave the
 * pool after GAU8 ROUND_BEHAVIOUR.maxLifetime or when they leave the map.
 */
import { Vector3 } from 'three';
import { GAU8, ROUND_BEHAVIOUR } from '../../data/gun';
import { applyBlast, resolveRoundHit, segmentHitVehicle } from '../targets';
import type { RoundHitResult, VehicleHit } from '../targets/types';
import type { Sim } from '../types';
import { windAt } from '../world';
import type { SurfaceKind, Terrain, TerrainHit } from '../world/types';
import { integrateRound } from './ballistics';
import { countBurstHit } from './gun';
import { freeRound, ROUND_FLAG_HIT_VEHICLE } from './pool';
import { RoundType, type RoundPool } from './types';

/** Vehicles stand no higher than this above the highest ground, m (vehicle test cull). */
const VEHICLE_HEIGHT = 12;
/** A deflected round restarts this far off the surface, m. */
const SURFACE_OFFSET = 0.01;
/** Segments (impacts) followed within one step before the rest of the step is dropped. */
const MAX_SEGMENTS = 8;
/**
 * Steps between wind samples at a round (staggered over the pool). In 4 steps a round moves
 * ≈30 m; the mean wind changes far less than that over its path.
 */
const WIND_EVERY = 4;

const _p = new Vector3();
const _v = new Vector3();
const _p0 = new Vector3();
const _v0 = new Vector3();
const _wind = new Vector3();
const _vHit = new Vector3();
const _point = new Vector3();
const _n = new Vector3();
const _t = new Vector3();
const _side = new Vector3();
const _ground: TerrainHit = {
  point: new Vector3(),
  normal: new Vector3(),
  distance: 0,
  t: 0,
  surface: 'grass',
};
const _vehicle: VehicleHit = {
  vehicleId: 0,
  t: 0,
  point: new Vector3(),
  normal: new Vector3(),
  thicknessMm: 0,
  part: 'hull',
  face: 'front',
  plate: 0,
};
const _result: RoundHitResult = {
  outcome: 'stopped',
  obliquity: 0,
  effectiveThicknessMm: 0,
  penetrationMm: 0,
  damaged: [],
  ricochetVelocity: new Vector3(),
};

const NONE = 0;
const GROUND = 1;
const VEHICLE = 2;

/** Integrate rounds and store bodies; detect and resolve impacts. */
export function stepProjectiles(sim: Sim, dt: number): void {
  const pool = sim.projectiles.rounds;
  if (pool.live === 0) return;
  const t1 = sim.time + dt;
  for (let i = 0; i < pool.capacity; i++) {
    if (pool.alive[i] !== 0) stepRound(sim, pool, i, t1);
  }
}

/** Fly round i to t1 (from the step start, or its muzzle time if it left during this step). */
function stepRound(sim: Sim, pool: RoundPool, i: number, t1: number): void {
  const terrain = sim.world.terrain;
  const isa = sim.world.isaDeviation;
  const type = pool.type[i] as RoundType;
  const fresh = pool.fireTime[i] >= sim.time;
  let t = fresh ? pool.fireTime[i] : sim.time;
  _p.set(pool.px[i], pool.py[i], pool.pz[i]);
  _v.set(pool.vx[i], pool.vy[i], pool.vz[i]);
  if (fresh || (sim.stepCount + i) % WIND_EVERY === 0) {
    windAt(sim.world, _p, _wind);
    pool.wx[i] = _wind.x;
    pool.wy[i] = _wind.y;
    pool.wz[i] = _wind.z;
  } else {
    _wind.set(pool.wx[i], pool.wy[i], pool.wz[i]);
  }

  for (let segment = 0; segment < MAX_SEGMENTS && t1 - t > 1e-9; segment++) {
    const h = t1 - t;
    _p0.copy(_p);
    _v0.copy(_v);
    integrateRound(type, _p, _v, _wind, h, isa);
    const hit = firstHit(sim, terrain, _p0, _p);
    if (hit === NONE) break;
    const f = hit === GROUND ? _ground.t : _vehicle.t;
    const tHit = t + f * h;
    _vHit.copy(_v0).lerp(_v, f);
    const goesOn =
      hit === GROUND
        ? groundImpact(sim, pool, i, type, tHit)
        : vehicleImpact(sim, pool, i, type, tHit);
    if (!goesOn) {
      freeRound(pool, i);
      return;
    }
    t = tHit;
  }

  const half = terrain.size / 2;
  if (
    t1 - pool.fireTime[i] >= ROUND_BEHAVIOUR.maxLifetime ||
    _p.x < -half ||
    _p.x > half ||
    _p.z < -half ||
    _p.z > half
  ) {
    freeRound(pool, i);
    return;
  }
  pool.px[i] = _p.x;
  pool.py[i] = _p.y;
  pool.pz[i] = _p.z;
  pool.vx[i] = _v.x;
  pool.vy[i] = _v.y;
  pool.vz[i] = _v.z;
}

/** Nearer of the ground and vehicle hits along a → b (fills _ground / _vehicle). */
function firstHit(sim: Sim, terrain: Terrain, a: Vector3, b: Vector3): number {
  const low = a.y < b.y ? a.y : b.y;
  let kind = NONE;
  let best = 2;
  if (low <= terrain.maxHeight && terrain.segmentHit(a, b, _ground)) {
    kind = GROUND;
    best = _ground.t;
  }
  if (
    sim.targets.vehicles.length > 0 &&
    low <= terrain.maxHeight + VEHICLE_HEIGHT &&
    segmentHitVehicle(sim, a, b, _vehicle) &&
    _vehicle.t <= best
  ) {
    kind = VEHICLE;
  }
  return kind;
}

/** Hard ground that a shallow round skips off. */
function isHard(terrain: Terrain, surface: SurfaceKind, x: number, z: number): boolean {
  switch (surface) {
    case 'road':
    case 'concrete':
    case 'rock':
      return true;
    case 'dirt':
    case 'field': {
      const moisture = terrain.moistureAt ? terrain.moistureAt(x, z) : 0;
      return moisture < ROUND_BEHAVIOUR.dryMoisture;
    }
    default:
      return false;
  }
}

/** Ground impact of round i at tHit (point and normal in _ground). Returns true if it skips on. */
function groundImpact(
  sim: Sim,
  pool: RoundPool,
  i: number,
  type: RoundType,
  tHit: number,
): boolean {
  const terrain = sim.world.terrain;
  const surface = _ground.surface;
  _point.copy(_ground.point);
  _n.copy(_ground.normal);
  if (surface === 'water') {
    impactEvent(sim, type, tHit, _point, _vHit, _n, null, 'water');
    if (type === RoundType.HEI) heiBurst(sim, tHit, 0, surface);
    return false;
  }
  const speed = _vHit.length();
  const into = speed > 0 ? -_vHit.dot(_n) / speed : 1;
  // Impact angle above the ground plane.
  const angle = Math.asin(into > 1 ? 1 : into < 0 ? 0 : into);
  if (
    type !== RoundType.HEI &&
    pool.bounces[i] < ROUND_BEHAVIOUR.maxSkips &&
    angle < ROUND_BEHAVIOUR.skipNeverAngle &&
    isHard(terrain, surface, _point.x, _point.z) &&
    skips(sim, angle)
  ) {
    impactEvent(sim, type, tHit, _point, _vHit, _n, null, 'skip');
    skipVelocity(sim, angle, speed);
    pool.bounces[i]++;
    _p.copy(_point).addScaledVector(_n, SURFACE_OFFSET);
    return true;
  }
  impactEvent(sim, type, tHit, _point, _vHit, _n, null, 'ground');
  if (type === RoundType.HEI) heiBurst(sim, tHit, 0, surface);
  return false;
}

/** Whether a round meeting hard ground at `angle` skips: always below 6°, never above 10°. */
function skips(sim: Sim, angle: number): boolean {
  const lo = ROUND_BEHAVIOUR.skipAlwaysAngle;
  const hi = ROUND_BEHAVIOUR.skipNeverAngle;
  if (angle <= lo) return true;
  return sim.rng.gun.next() < (hi - angle) / (hi - lo);
}

/**
 * New velocity (into _v) of a round skipping off the ground (normal _n): it keeps 50–70 % of
 * its speed and leaves flatter than it came in, turned a little sideways.
 */
function skipVelocity(sim: Sim, angle: number, speed: number): void {
  const rng = sim.rng.gun;
  const b = ROUND_BEHAVIOUR;
  // Direction along the ground.
  _t.copy(_vHit).addScaledVector(_n, -_vHit.dot(_n));
  if (_t.lengthSq() < 1e-12) _t.set(1, 0, 0).addScaledVector(_n, -_n.x);
  _t.normalize();
  // Sideways scatter about the normal.
  const yaw = rng.normal() * b.skipScatter;
  _side.crossVectors(_n, _t);
  _t.multiplyScalar(Math.cos(yaw)).addScaledVector(_side, Math.sin(yaw));
  const out = angle * rng.range(b.skipDepartureMin, b.skipDepartureMax);
  const keep = rng.range(b.skipSpeedMin, b.skipSpeedMax);
  _v.copy(_t)
    .multiplyScalar(Math.cos(out))
    .addScaledVector(_n, Math.sin(out))
    .multiplyScalar(keep * speed);
}

/** Vehicle impact of round i at tHit (hit in _vehicle). Returns true if it ricochets on. */
function vehicleImpact(
  sim: Sim,
  pool: RoundPool,
  i: number,
  type: RoundType,
  tHit: number,
): boolean {
  const hit = _vehicle;
  resolveRoundHit(sim, hit, type, _vHit, _result);
  _point.copy(hit.point);
  _n.copy(hit.normal);
  impactEvent(sim, type, tHit, _point, _vHit, _n, hit, _result.outcome);
  if ((pool.flags[i] & ROUND_FLAG_HIT_VEHICLE) === 0) {
    pool.flags[i] |= ROUND_FLAG_HIT_VEHICLE;
    countBurstHit(sim, pool.burst[i]);
  }
  if (type === RoundType.HEI) {
    heiBurst(sim, tHit, hit.vehicleId, sim.world.terrain.surfaceAt(_point.x, _point.z));
    return false;
  }
  if (_result.outcome === 'ricochet' && pool.ricochets[i] < ROUND_BEHAVIOUR.maxRicochets) {
    pool.ricochets[i]++;
    _v.copy(_result.ricochetVelocity);
    _p.copy(_point).addScaledVector(_n, SURFACE_OFFSET);
    return true;
  }
  return false;
}

/** Emit a roundImpact (plain copies of the vectors). */
function impactEvent(
  sim: Sim,
  type: RoundType,
  t: number,
  point: Vector3,
  velocity: Vector3,
  normal: Vector3,
  vehicle: VehicleHit | null,
  outcome: RoundHitResult['outcome'] | 'ground' | 'skip' | 'water',
): void {
  sim.events.push({
    type: 'roundImpact',
    t,
    round: type,
    position: { x: point.x, y: point.y, z: point.z },
    velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
    normal: { x: normal.x, y: normal.y, z: normal.z },
    target: vehicle
      ? { kind: 'vehicle', vehicleId: vehicle.vehicleId, part: vehicle.part }
      : { kind: 'ground', surface: _ground.surface },
    outcome,
  });
}

/** An HEI round bursts at _point: the detonation event and its blast and fragments. */
function heiBurst(sim: Sim, t: number, vehicleId: number, surface: SurfaceKind): void {
  sim.events.push({
    type: 'detonation',
    t,
    position: { x: _point.x, y: _point.y, z: _point.z },
    charge: GAU8.heiCharge,
    kind: 'hei',
    vehicleId,
    surface,
  });
  applyBlast(sim, _point, GAU8.heiCharge, GAU8.heiFragmentMass);
}
