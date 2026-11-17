/**
 * Executing releases (ARCHITECTURE §12.1: the avionics decides, the weapons module executes).
 *
 * A ReleaseRequest is executed in stepStores at its exact time inside the step: the aircraft's
 * pose at that instant is interpolated between `prev*` (the start of the flight step) and the
 * new state, as the gun's rounds are (pose.ts). The store starts at its station's suspension
 * point (A10_GEOMETRY.stations) with
 *     v = v_aircraft + R·(ω × r_station + v_ejection),
 * where v_ejection is the model's (registered with the fire-control computer, so the CCIP pipper
 * and the live store start alike): a cartridge ejector's push along the pylon's downward normal,
 * a rocket's speed at the end of its tube along the tube, nothing for a Maverick's rail (its
 * motor carries it off). A rocket also gets its launch dispersion (sim.rng.weapons): a random
 * turn of its initial relative velocity, which its thrust then follows.
 *
 * Then the store leaves its station (a rocket pod counts down `rockets`; the pod stays; with the
 * relaxed preset's unlimited stores it stays), the stores totals are recomputed (the flight
 * model reads them every step), 'storeReleased' (and
 * 'motorIgnition' for rockets and missiles) is emitted, the guided module takes over a Maverick
 * or GBU-12 (onLaunch), and a WeaponRecord is opened. A request whose station no longer holds
 * its store is dropped with a 'message'. Jettison drops a whole station as one body: the rack or
 * launcher with what it still carries (pods and the AIM-9 rails stay), never armed.
 */
import { Quaternion, Vector3 } from 'three';
import { A10_GEOMETRY } from '../../data/geometry';
import { MK66, STORE_FLIGHT, STORES } from '../../data/munitions';
import type { ReleaseConditions } from '../debrief/types';
import type { AircraftState } from '../flight/types';
import type { Sim, Vec3Like } from '../types';
import { motorThrust, onLaunch } from './guided';
import { interpolatePose } from './pose';
import { openRecord } from './records';
import {
  assemblySpec,
  ejectionSpeed,
  ejectionVelocity,
  modelFor,
  stationPitch,
} from './storeModels';
import { acquireBody } from './bodies';
import { stationMass, updateStoresTotals } from './totals';
import type {
  ReleaseRequest,
  StationState,
  StoreBody,
  StoreBodyKind,
  StoreFlightSpec,
  StoreType,
} from './types';

const _pos = new Vector3();
const _vel = new Vector3();
const _q = new Quaternion();
const _r = new Vector3();
const _u = new Vector3();
const _e = new Vector3();
const _x = new Vector3(1, 0, 0);
const _pitch = new Quaternion();
const _dir = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _aim = new Vector3();
const _conditions: ReleaseConditions = {
  time: 0,
  dive: 0,
  speed: 0,
  agl: 0,
  slantRange: 0,
  gLoad: 1,
  bank: 0,
};

/** The body kind of a released store. */
export function bodyKindOf(type: StoreType): StoreBodyKind {
  switch (STORES[type]?.kind) {
    case 'rocketPod':
      return 'rocket';
    case 'missile':
      return 'missile';
    case 'guidedBomb':
      return 'laserBomb';
    case 'dispenser':
      return 'dispenser';
    default:
      return 'bomb';
  }
}

/**
 * Where a store released NOW from `station` starts (world position and velocity): the station's
 * suspension point and v_aircraft + R·(ω × r + the model's ejection) — exactly how the live
 * release starts it (without a rocket's random dispersion) and how the fire-control computer
 * should (avionics releaseState). Allocation-free.
 */
export function releaseStateOf(
  ac: AircraftState,
  station: number,
  ejection: Vec3Like,
  outPos: Vector3,
  outVel: Vector3,
): void {
  const s = A10_GEOMETRY.stations[station] ?? A10_GEOMETRY.stations[6]!;
  _r.set(s.x, s.y, s.z);
  _u.crossVectors(ac.angularVelocity, _r);
  _u.x += ejection.x;
  _u.y += ejection.y;
  _u.z += ejection.z;
  outVel.copy(_u).applyQuaternion(ac.orientation).add(ac.velocity);
  outPos.copy(_r).applyQuaternion(ac.orientation).add(ac.position);
}

/** Store kinds the avionics can release one at a time (pods, racks and AIM-9s only jettison). */
function releasable(type: StoreType): boolean {
  const k = STORES[type]?.kind;
  return k === 'bomb' || k === 'guidedBomb' || k === 'missile' || k === 'dispenser';
}

function stationOf(sim: Sim, station: number): StationState | null {
  const list = sim.stores.stations;
  const s = list[station - 1];
  if (s && s.station === station) return s;
  return list.find((x) => x.station === station) ?? null;
}

function refuse(sim: Sim, t: number, text: string): void {
  sim.events.push({ type: 'message', t, text, level: 'warn' });
}

/** Remove element k of an array in place (no allocation, order kept). */
function removeAt<T>(list: T[], k: number): void {
  for (let i = k; i < list.length - 1; i++) list[i] = list[i + 1];
  list.length--;
}

/**
 * Execute one request inside the step that starts at t0 (length dt): at its time, or at the
 * step start if it is overdue. Returns false when it was dropped.
 */
export function executeRelease(sim: Sim, req: ReleaseRequest, t0: number, dt: number): boolean {
  const t = Math.min(t0 + dt, Math.max(t0, req.time));
  const f = dt > 0 ? (t - t0) / dt : 1;
  const st = stationOf(sim, req.station);
  if (!st) {
    refuse(sim, t, `NO STATION ${req.station}`);
    return false;
  }
  if (req.delivery === 'JETTISON') {
    if (st.rack !== req.store && !st.stores.includes(req.store)) {
      refuse(sim, t, `STA ${req.station} ${req.store} GONE`);
      return false;
    }
    return jettisonStation(sim, st, t, f, dt) > 0;
  }
  const data = STORES[req.store];
  const model = data ? modelFor(req.store, req.highDrag) : null;
  if (!data || !model) {
    refuse(sim, t, `${req.store} NOT RELEASABLE`);
    return false;
  }
  // Realism aid "unlimited stores" (PLAN §2, relaxed): the store flies but stays on its station.
  const keep = sim.options.realism.unlimitedAmmo;
  if (data.kind === 'rocketPod') {
    const left = st.rockets ?? data.rockets ?? 0;
    if (!st.stores.includes(req.store) || left <= 0) {
      refuse(sim, t, `STA ${req.station} NO ROCKETS`);
      return false;
    }
    if (!keep) st.rockets = left - 1;
  } else {
    const k = st.stores.indexOf(req.store);
    if (k < 0) {
      refuse(sim, t, `STA ${req.station} NO ${req.store}`);
      return false;
    }
    if (!releasable(req.store)) {
      refuse(sim, t, `${req.store} NOT RELEASABLE`);
      return false;
    }
    if (!keep) removeAt(st.stores, k);
  }
  updateStoresTotals(sim.stores);

  interpolatePose(sim.aircraft, f, dt, _pos, _vel, _q);
  _e.set(model.ejection.x, model.ejection.y, model.ejection.z);
  const kind = bodyKindOf(req.store);
  const b = spawn(sim, req.store, kind, req.station, t, model.spec, _e, kind === 'rocket');
  b.delivery = req.delivery;
  b.aim.set(req.aim.x, req.aim.y, req.aim.z);
  b.aimValid = req.aimValid;
  b.armingTime = sim.options.realism.fuzeEffects ? Math.max(0, req.armingTime) : 0;
  b.armed = b.armingTime <= 0;
  b.fuze = req.fuze;
  b.laserCode = req.laserCode;
  b.guidance.vehicleId = req.lockVehicle;

  sim.events.push({
    type: 'storeReleased',
    t,
    station: req.station,
    store: req.store,
    bodyId: b.id,
  });
  if (kind === 'rocket' || kind === 'missile')
    sim.events.push({ type: 'motorIgnition', t, bodyId: b.id });
  if (kind === 'missile' || kind === 'laserBomb') {
    onLaunch(sim, b, req);
    if (kind === 'missile') b.motorTime = burnTimeOf(b);
  }
  b.record = openRecord(sim, {
    store: req.store,
    weapon: STORE_FLIGHT[req.store]?.name ?? req.store,
    station: req.station,
    delivery: req.delivery,
    aim: b.aim,
    aimValid: req.aimValid,
    bodyId: b.id,
    conditions: conditions(sim, t, req.aim, req.aimValid),
  });
  return true;
}

/**
 * Spawn a body at the station's suspension point of the pose in _pos/_vel/_q, with the ejection
 * `ejection` (body frame) added, its attitude along the pylon. `disperse`: a rocket's launch
 * dispersion.
 */
function spawn(
  sim: Sim,
  type: StoreType,
  kind: StoreBodyKind,
  station: number,
  t: number,
  spec: StoreFlightSpec,
  ejection: Vector3,
  disperse: boolean,
): StoreBody {
  const ac = sim.aircraft;
  const s = A10_GEOMETRY.stations[station] ?? A10_GEOMETRY.stations[6]!;
  _r.set(s.x, s.y, s.z);
  _u.crossVectors(ac.angularVelocity, _r).add(ejection);
  const b = acquireBody(sim.projectiles);
  b.type = type;
  b.kind = kind;
  b.station = station;
  b.releaseTime = t;
  b.flight = spec;
  b.mass = spec.mass;
  b.position.copy(_r).applyQuaternion(_q).add(_pos);
  b.velocity.copy(_u).applyQuaternion(_q).add(_vel);
  if (disperse) launchDispersion(sim, b);
  _pitch.setFromAxisAngle(_x, stationPitch(station));
  b.orientation.copy(_q).multiply(_pitch);
  b.prevPosition.copy(b.position);
  b.prevOrientation.copy(b.orientation);
  b.motorTime = spec.motor ? Math.max(0, spec.motor.burnTime - spec.motorOffset) : 0;
  b.runIn = Math.atan2(_vel.x, -_vel.z);
  if (b.runIn < 0) b.runIn += 2 * Math.PI;
  b.delivery = 'CCIP';
  b.aim.set(0, 0, 0);
  b.aimValid = false;
  b.armingTime = 0;
  b.fuze = 'NOSE';
  b.laserCode = 0;
  return b;
}

/**
 * A rocket's launch dispersion: its relative velocity as it leaves the tube is turned by a small
 * random angle (σ = MK66.dispersion per axis); the thrust, which follows the relative wind, keeps
 * the new direction.
 */
function launchDispersion(sim: Sim, b: StoreBody): void {
  const ac = sim.aircraft;
  _dir.copy(b.velocity).sub(ac.wind);
  const speed = _dir.length();
  if (speed < 1e-6) return;
  _dir.multiplyScalar(1 / speed);
  // Two directions across the path.
  _a.set(0, 1, 0).cross(_dir);
  if (_a.lengthSq() < 1e-12) _a.set(1, 0, 0);
  _a.normalize();
  _b.crossVectors(_dir, _a);
  const rng = sim.rng.weapons;
  const sigma = MK66.dispersion * speed;
  b.velocity.addScaledVector(_a, rng.normal() * sigma).addScaledVector(_b, rng.normal() * sigma);
}

/** A missile's motor burn time from the guided module's thrust curve, s (0 without a motor). */
function burnTimeOf(b: StoreBody): number {
  const step = 0.05;
  let last = 0;
  for (let t = 0; t <= 120; t += step) if (motorThrust(b, t) > 0) last = t + step;
  return last;
}

/** The release conditions at time t (pose in _pos/_vel). */
function conditions(sim: Sim, t: number, aim: Vec3Like, aimValid: boolean): ReleaseConditions {
  const ac = sim.aircraft;
  const c = _conditions;
  const v = _vel.length();
  c.time = t;
  c.dive = v > 1e-6 ? -Math.asin(Math.max(-1, Math.min(1, _vel.y / v))) : 0;
  c.speed = ac.tas;
  c.agl = _pos.y - sim.world.terrain.heightAt(_pos.x, _pos.z);
  c.slantRange = aimValid ? _pos.distanceTo(_aim.set(aim.x, aim.y, aim.z)) : 0;
  c.gLoad = ac.gLoad;
  c.bank = ac.bank;
  return c;
}

/**
 * Jettison one station at time t (fraction f of the flight step of length dt; f = 1: the present
 * state): the rack, launcher or pod with what it still carries leaves as ONE body, pushed off by
 * the pylon's ejector, never armed (it lands as a dud). Pods and the AIM-9 rails stay. Returns 1
 * when something left, 0 otherwise.
 */
export function jettisonStation(
  sim: Sim,
  st: StationState,
  t: number,
  f: number,
  dt: number,
): number {
  const first = st.rack ?? st.stores[0];
  if (!first || !STORES[first]?.jettisonable) return 0;
  for (const s of st.stores) if (!STORES[s]?.jettisonable) return 0;
  const mass = stationMass(st);
  const items: StoreType[] = st.rack ? [st.rack, ...st.stores] : [...st.stores];
  // A lone weapon falls with its own airframe; a rack, launcher or pod tumbles as one body.
  const single = !st.rack && st.stores.length === 1 && STORES[first].kind !== 'rocketPod';
  const weapon = single ? modelFor(first, false) : null;
  const spec = weapon ? weapon.spec : assemblySpec(items, mass);
  interpolatePose(sim.aircraft, f, dt, _pos, _vel, _q);
  ejectionVelocity('ejector', ejectionSpeed(mass), stationPitch(st.station), _e);
  const kind = weapon ? bodyKindOf(first) : 'bomb';
  const b = spawn(sim, first, kind, st.station, t, spec, _e, false);
  b.mass = mass;
  b.delivery = 'JETTISON';
  b.armingTime = Infinity;
  b.armed = false;
  b.motorTime = 0;
  if (st.rack) for (const s of st.stores) b.carried.push(s);
  const pod = STORES[first]?.rockets !== undefined ? first : null;
  if (pod) b.rockets = st.rockets ?? STORES[pod].rockets ?? 0;
  sim.events.push({
    type: 'storeReleased',
    t,
    station: st.station,
    store: first,
    bodyId: b.id,
  });
  b.record = openRecord(sim, {
    store: first,
    weapon: first,
    station: st.station,
    delivery: 'JETTISON',
    aim: b.aim,
    aimValid: false,
    bodyId: b.id,
    conditions: conditions(sim, t, b.aim, false),
  });
  st.rack = null;
  st.stores.length = 0;
  delete st.rockets;
  updateStoresTotals(sim.stores);
  return 1;
}
