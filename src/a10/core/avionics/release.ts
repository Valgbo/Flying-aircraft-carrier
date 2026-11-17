/**
 * Store fire control (PLAN_A10.md §6.5–6.7; wave 1: the structure). `predictStoreImpact` flies
 * any store's ballistic model — the weapons module's own integrator for it, registered with
 * `registerStoreBallistics` in wave 2 — against the same ground model as the gun. CCIP: the
 * impact of a release now from the selected profile's station. CCRP (wave 2): the release point
 * that puts the impact on the SPI. Until a store's model is registered its solution stays
 * invalid (the HUD says CCIP / CCRP INVALID).
 */
import { Vector3 } from 'three';
import { A10_GEOMETRY } from '../../data/geometry';
import { SIM_DT } from '../constants';
import type { AircraftState } from '../flight/types';
import { worldToBody } from '../frames';
import type { Sim } from '../types';
import { windAt } from '../world';
import { FIRE_CONTROL } from './data';
import type { FireControlGround } from './ground';
import { eyeWorld, hudAnglesOfPoint } from './gunsight';
import {
  createImpactPrediction,
  predictImpact,
  type BallisticModel,
  type ImpactPrediction,
} from './predict';
import { selectedProfile } from './profiles';
import type { ReleaseSolution, WeaponProfile } from './types';

/** A store as the computer flies it: its model and how it leaves the aircraft. */
export interface StoreBallistics extends BallisticModel {
  /** Ejection velocity relative to the aircraft at release, body frame, m/s (rack push). */
  ejection: { x: number; y: number; z: number };
  /** Predictor step, s (default: the live bodies' step, SIM_DT). */
  dt?: number;
}

const storeModels = new Map<string, StoreBallistics>();

/** Register (or with null remove) the ballistic model of a store type. */
export function registerStoreBallistics(store: string, model: StoreBallistics | null): void {
  if (model) storeModels.set(store, model);
  else storeModels.delete(store);
}

export function storeBallistics(store: string): StoreBallistics | null {
  return storeModels.get(store) ?? null;
}

/**
 * Fly a released store with its model against the computer's ground; the generic CCIP / CCRP
 * predictor. Same rules as the gun: wind held at the value measured at the aircraft.
 */
export function predictStoreImpact(
  model: StoreBallistics,
  origin: Vector3,
  velocity: Vector3,
  wind: Vector3,
  ground: FireControlGround,
  out: ImpactPrediction,
  maxTime: number = FIRE_CONTROL.storeMaxTimeOfFall,
): boolean {
  return predictImpact(model, origin, velocity, wind, ground, maxTime, model.dt ?? SIM_DT, out);
}

const _r = new Vector3();
const _u = new Vector3();

/** Position and velocity (world) of a store leaving `station` now. */
export function releaseState(
  ac: AircraftState,
  station: number,
  model: StoreBallistics,
  pos: Vector3,
  vel: Vector3,
): void {
  const s = A10_GEOMETRY.stations[station] ?? A10_GEOMETRY.stations[6];
  _r.set(s?.x ?? 0, s?.y ?? 0, s?.z ?? 0);
  _u.crossVectors(ac.angularVelocity, _r);
  _u.x += model.ejection.x;
  _u.y += model.ejection.y;
  _u.z += model.ejection.z;
  vel.copy(_u).applyQuaternion(ac.orientation).add(ac.velocity);
  pos.copy(_r).applyQuaternion(ac.orientation).add(ac.position);
}

/** First station (release order) carrying the profile's store, or 0. */
export function stationFor(sim: Sim, p: WeaponProfile): number {
  for (const st of sim.stores.stations)
    for (const s of st.stores) if (s === p.store) return st.station;
  return 0;
}

/** Bottom edge of the HUD combiner glass (its two lower corners share y and z), body frame. */
const GLASS_BOTTOM_Y = Math.max(A10_GEOMETRY.hudCorners[2].y, A10_GEOMETRY.hudCorners[3].y);
const GLASS_BOTTOM_Z = A10_GEOMETRY.hudCorners[2].z;
const _e = new Vector3();
const _d = new Vector3();

/** The direction from the design eye to `point` passes below the bottom of the HUD glass. */
export function belowGlass(ac: AircraftState, point: Vector3): boolean {
  eyeWorld(ac, _e);
  worldToBody(ac.orientation, _d.subVectors(point, _e), _d);
  const ez = A10_GEOMETRY.eye.z;
  if (_d.z >= -1e-9) return true;
  const s = (GLASS_BOTTOM_Z - ez) / _d.z;
  return A10_GEOMETRY.eye.y + s * _d.y < GLASS_BOTTOM_Y;
}

export function createReleaseSolution(): ReleaseSolution {
  return {
    valid: false,
    impact: new Vector3(),
    az: 0,
    el: 0,
    timeToRelease: 0,
    timeOfFall: 0,
    belowMinimum: false,
    belowGlass: false,
    releaseNow: false,
  };
}

function invalidate(rel: ReleaseSolution): void {
  rel.valid = false;
  rel.releaseNow = false;
  rel.belowMinimum = false;
  rel.belowGlass = false;
  rel.timeToRelease = 0;
}

const _origin = new Vector3();
const _vel = new Vector3();
const _wind = new Vector3();
const _pred = createImpactPrediction();
const _angles = { az: 0, el: 0 };

/** The release solution of the selected profile for the present sight. Allocation-free. */
export function computeReleaseSolution(sim: Sim, ground: FireControlGround): void {
  const av = sim.avionics;
  const rel = av.release;
  const p = av.sight === 'CCIP' || av.sight === 'CCRP' ? selectedProfile(sim) : null;
  const model = p ? storeBallistics(p.store) : null;
  if (!p || !model || av.sight !== 'CCIP') {
    // CCRP release-point solving is wave 2.
    invalidate(rel);
    return;
  }
  const ac = sim.aircraft;
  releaseState(ac, stationFor(sim, p), model, _origin, _vel);
  windAt(sim.world, ac.position, _wind);
  if (!predictStoreImpact(model, _origin, _vel, _wind, ground, _pred)) {
    invalidate(rel);
    return;
  }
  rel.valid = true;
  rel.impact.copy(_pred.point);
  hudAnglesOfPoint(ac, rel.impact, _angles);
  rel.az = _angles.az;
  rel.el = _angles.el;
  rel.timeToRelease = 0;
  rel.timeOfFall = _pred.time;
  rel.belowMinimum = ac.position.y - rel.impact.y < p.minAltitude;
  rel.belowGlass = belowGlass(ac, rel.impact);
  // Consent release (hold the button and fly through the cue) is wave 2.
  rel.releaseNow = false;
}
