/**
 * Store bodies in flight (PLAN_A10.md §6.1 rule 1, §6.5–§6.7; ARCHITECTURE §12.2): every step
 * each body is flown with its free-flight model (storeModels.ts integrateStore — the function
 * the fire-control computer predicts with) from the later of the step start and its release
 * time to the step end, through the mean wind at the body. Guided bodies (Maverick, GBU-12) add
 * the guided module's commanded acceleration and motor thrust (ARCHITECTURE §12.3).
 *
 * The step's path is tested against the ground (terrain.segmentHit) and the vehicles
 * (segmentHitVehicle); the nearer hit is the impact. The fuze decides:
 *  - not armed (released too low, a jettisoned store, CBU-97 submunitions not modelled): a dud,
 *    'detonation' kind 'dud' with no charge and no blast;
 *  - armed: 'detonation' (kind bomb / rocket / missile / whitePhosphorus) and the warhead's blast
 *    and fragments through targets.applyBlast with the weapon's name and the body id; a direct
 *    hit bursts at the hit point (a Maverick's shaped charge through applyWarheadHit). An
 *    instantaneous fuze on the ground bursts with the charge's centre still above the surface
 *    (`chargeOffset` back along the path); a delayed fuze bursts after the bomb has buried
 *    itself, with part of the blast and few fragments (FUZE).
 * The body's WeaponRecord is completed (records.ts) and the body leaves `bodies` in that step.
 *
 * Attitude (drawn only): the body's axis turns into the relative wind with a first-order lag
 * (weathercocking). Bodies are pooled: nothing is allocated per step.
 */
import { Quaternion, Vector3 } from 'three';
import { BSU49, FUZE, STORE_BODY, WARHEADS } from '../../data/munitions';
import { applyBlast, applyWarheadHit, segmentHitVehicle, type WarheadStrike } from '../targets';
import type { VehicleHit } from '../targets/types';
import type { Sim } from '../types';
import { densityAt, windAt } from '../world';
import type { SurfaceKind, Terrain, TerrainHit } from '../world/types';
import { guidanceAccel } from './guided';
import { closeRecord, fragmentEnvelope } from './records';
import { integrateStore, specBurnLeft, specMassAt, type BodyForcing } from './storeModels';
import type { ProjectileState, StoreBody } from './types';

/** Vehicles stand no higher than this above the highest ground, m (vehicle test cull). */
const VEHICLE_HEIGHT = 12;
/** A burst is kept at least this far above the ground, m. */
const BURST_CLEARANCE = 0.1;

// ---- the pool ------------------------------------------------------------------------------------

/** A body in its pooled (not flying) state. */
export function createBody(): StoreBody {
  return {
    id: 0,
    type: 'MK-82',
    kind: 'bomb',
    alive: false,
    station: 0,
    releaseTime: 0,
    position: new Vector3(),
    velocity: new Vector3(),
    orientation: new Quaternion(),
    motorTime: 0,
    armed: false,
    data: {},
    delivery: 'CCIP',
    aim: new Vector3(),
    aimValid: false,
    highDrag: false,
    armingTime: 0,
    laserCode: 0,
    guidance: { mode: 'NONE', vehicleId: -1, point: new Vector3(), valid: false },
    record: -1,
    prevPosition: new Vector3(),
    prevOrientation: new Quaternion(),
    flight: null,
    fuze: 'NOSE',
    runIn: 0,
    carried: [],
    rockets: 0,
    mass: 0,
  };
}

/** Bodies made ready at the start of a flight. */
export function createBodyPool(size: number = STORE_BODY.poolSize): StoreBody[] {
  const pool: StoreBody[] = [];
  for (let i = 0; i < size; i++) pool.push(createBody());
  return pool;
}

/**
 * A body for a new release, from the pool (a new one only when more fly at once than ever
 * before), appended to `bodies` with a new id. The caller fills its state.
 */
export function acquireBody(ps: ProjectileState): StoreBody {
  const b = ps.bodyPool.pop() ?? createBody();
  b.id = ps.nextBodyId++;
  b.alive = true;
  b.record = -1;
  b.motorTime = 0;
  b.armed = false;
  b.highDrag = false;
  b.carried.length = 0;
  b.rockets = 0;
  b.data = {};
  const g = b.guidance;
  g.mode = 'NONE';
  g.vehicleId = -1;
  g.point.set(0, 0, 0);
  g.valid = false;
  ps.bodies.push(b);
  return b;
}

function recycle(ps: ProjectileState, b: StoreBody): void {
  b.alive = false;
  b.flight = null;
  ps.bodyPool.push(b);
}

// ---- the step ------------------------------------------------------------------------------------

const _p0 = new Vector3();
const _v0 = new Vector3();
const _wind = new Vector3();
const _vHit = new Vector3();
const _point = new Vector3();
const _normal = new Vector3();
const _burst = new Vector3();
const _acNow = new Vector3();
const _air = new Vector3();
const _axis = new Vector3();
const _turn = new Quaternion();
const _part = new Quaternion();
const _identity = new Quaternion();
const _forcing: BodyForcing = {
  accel: new Vector3(),
  motorBody: null,
  mass: 1,
  axis: new Vector3(0, 0, -1),
};
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
/** A direct hit's shaped charge: its case fragments reach the other vehicles, its jet runs along
 *  the body's velocity at impact (_vHit). */
const _strike: WarheadStrike = {
  kind: 'shapedCharge',
  penetrationMm: 0,
  chargeKg: 0,
  caseKg: 0,
  direction: _vHit,
};

const NONE = 0;
const GROUND = 1;
const VEHICLE = 2;

/** Fly every store body to the end of the step; impacts detonate and remove them. */
export function stepBodies(sim: Sim, dt: number): void {
  const ps = sim.projectiles;
  const bodies = ps.bodies;
  if (bodies.length === 0) return;
  const t0 = sim.time;
  const t1 = t0 + dt;
  let kept = 0;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    // A body without a flight model is not this module's (a view test's stand-in): left alone.
    if (!b.flight) bodies[kept++] = b;
    else if (b.alive && stepBody(sim, b, t0, t1, dt)) bodies[kept++] = b;
    else recycle(ps, b);
  }
  // Shrink in place (order kept, nothing allocated).
  bodies.length = kept;
}

/** Fly one body to t1. Returns false when it has left (impact, off the map, too old). */
function stepBody(sim: Sim, b: StoreBody, t0: number, t1: number, dt: number): boolean {
  const spec = b.flight!;
  const start = b.releaseTime > t0 ? b.releaseTime : t0;
  const h = t1 - start;
  const tSince = start - b.releaseTime;
  b.prevPosition.copy(b.position);
  b.prevOrientation.copy(b.orientation);
  if (h <= 0) return true;

  windAt(sim.world, b.position, _wind);
  let forcing: BodyForcing | null = null;
  if ((b.kind === 'missile' || b.kind === 'laserBomb') && b.delivery !== 'JETTISON') {
    forcing = _forcing;
    guidanceAccel(sim, b, h, forcing.accel);
    forcing.motorBody = b;
    forcing.mass = b.mass;
    forcing.axis.set(0, 0, -1).applyQuaternion(b.orientation);
  }
  _p0.copy(b.position);
  _v0.copy(b.velocity);
  integrateStore(spec, b.position, b.velocity, _wind, h, tSince, sim.world.isaDeviation, forcing);

  const terrain = sim.world.terrain;
  const hit = firstHit(sim, terrain, _p0, b.position);
  if (hit !== NONE) {
    const f = hit === GROUND ? _ground.t : _vehicle.t;
    const tHit = start + f * h;
    _vHit.copy(_v0).lerp(b.velocity, f);
    if (hit === GROUND) {
      _point.copy(_ground.point);
      _normal.copy(_ground.normal);
      detonate(sim, b, tHit, t0, dt, _ground.surface, null);
    } else {
      _point.copy(_vehicle.point);
      _normal.copy(_vehicle.normal);
      detonate(sim, b, tHit, t0, dt, terrain.surfaceAt(_point.x, _point.z), _vehicle);
    }
    return false;
  }

  const tNow = t1 - b.releaseTime;
  const half = terrain.size / 2;
  const p = b.position;
  if (tNow >= STORE_BODY.maxLifetime || p.x < -half || p.x > half || p.z < -half || p.z > half) {
    closeRecord(sim, b, t1, null, false, false);
    return false;
  }
  // State the views and the guided module read.
  b.mass = forcing ? b.mass : specMassAt(spec, tNow);
  if (spec.motor) b.motorTime = specBurnLeft(spec, tNow);
  else if (b.motorTime > 0) b.motorTime = Math.max(0, b.motorTime - h);
  b.armed = tNow >= b.armingTime;
  if (spec.balluteArea > 0 && tNow >= spec.balluteStart) b.highDrag = true;
  weathercock(b, b.highDrag ? BSU49.weathercockTime : spec.weathercockTime, h);
  return true;
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

/**
 * The body's axis (−Z) turns into the relative wind with time constant `tau` (s): the drawn
 * attitude of a finned store weathercocking. The roll is kept (shortest-arc turn).
 */
function weathercock(b: StoreBody, tau: number, h: number): void {
  _air.copy(b.velocity).sub(_wind);
  const s = _air.length();
  if (s < 0.5 || !(tau > 0)) return;
  _air.multiplyScalar(1 / s);
  _axis.set(0, 0, -1).applyQuaternion(b.orientation);
  _turn.setFromUnitVectors(_axis, _air);
  _part.slerpQuaternions(_identity, _turn, 1 - Math.exp(-h / tau));
  b.orientation.premultiply(_part).normalize();
}

/**
 * The fuze of body b at its impact (point in _point, velocity in _vHit, at tHit): a dud or a
 * detonation with its blast, then the record.
 */
function detonate(
  sim: Sim,
  b: StoreBody,
  tHit: number,
  t0: number,
  dt: number,
  surface: SurfaceKind,
  vehicle: VehicleHit | null,
): void {
  const warhead = b.delivery === 'JETTISON' ? undefined : WARHEADS[b.type];
  const armed =
    warhead !== undefined && warhead.kind !== 'dud' && tHit - b.releaseTime >= b.armingTime;
  const vehicleId = vehicle ? vehicle.vehicleId : 0;
  b.alive = false;
  if (!warhead || !armed) {
    sim.events.push({
      type: 'detonation',
      t: tHit,
      position: { x: _point.x, y: _point.y, z: _point.z },
      charge: 0,
      kind: 'dud',
      vehicleId,
      surface,
      bodyId: b.id,
    });
    closeRecord(sim, b, tHit, _point, true, false);
    return;
  }

  // Where and how big the burst is.
  let charge = warhead.charge;
  let caseKg = warhead.caseMass;
  const delayed = warhead.fuze === 'delay' || (warhead.fuze === 'profile' && b.fuze === 'TAIL');
  _burst.copy(_point);
  if (!vehicle) {
    if (delayed) {
      if (surface === 'water') {
        charge *= FUZE.underwaterBlast;
        caseKg = 0;
      } else {
        charge *= FUZE.buriedBlast;
        caseKg *= FUZE.buriedFragments;
      }
    } else {
      // The fuze in the nose functions on contact: the charge is still behind it, above ground.
      const speed = _vHit.length();
      if (speed > 1e-6) _burst.addScaledVector(_vHit, -warhead.chargeOffset / speed);
      const floor = sim.world.terrain.heightAt(_burst.x, _burst.z) + BURST_CLEARANCE;
      if (_burst.y < floor) _burst.y = floor;
    }
  }
  sim.events.push({
    type: 'detonation',
    t: tHit,
    position: { x: _burst.x, y: _burst.y, z: _burst.z },
    charge,
    kind: warhead.kind,
    vehicleId,
    surface,
    bodyId: b.id,
  });
  const name = recordName(sim, b);
  if (vehicle && warhead.penetrationMm > 0) {
    _strike.penetrationMm = warhead.penetrationMm;
    _strike.chargeKg = charge;
    _strike.caseKg = caseKg;
    applyWarheadHit(sim, vehicle, _strike, name, b.id);
  } else {
    applyBlast(sim, _burst, charge, caseKg, name, b.id);
  }

  // Safe escape: the aircraft's distance from the burst at that instant.
  let warning = false;
  if (sim.options.realism.fuzeEffects && caseKg > 0) {
    const ac = sim.aircraft;
    _acNow.copy(ac.prevPosition).lerp(ac.position, Math.min(1, Math.max(0, (tHit - t0) / dt)));
    const envelope = fragmentEnvelope(charge, caseKg, densityAt(_burst.y, sim.world.isaDeviation));
    warning = _acNow.distanceTo(_burst) < envelope;
  }
  closeRecord(sim, b, tHit, _point, false, warning);
}

/** The weapon name of a body's record (hit and kill attribution), else its store type. */
function recordName(sim: Sim, b: StoreBody): string {
  const r = b.record >= 0 ? sim.debrief.weapons[b.record] : undefined;
  return r && r.bodyId === b.id ? r.weapon : b.type;
}
