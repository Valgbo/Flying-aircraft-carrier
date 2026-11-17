/**
 * Store fire control (PLAN_A10.md §6.1 rule 2, §6.5–6.7, §7; ARCHITECTURE §12.1, §12.2, §12.7).
 *
 * The computer flies the selected profile's store with the weapons module's own ballistic model
 * (registry.ts: key = the store, or `${store}/HD` for a high-drag profile), from the station the
 * next release leaves (stations.ts), with the wind MEASURED AT THE AIRCRAFT held along the whole
 * fall, against the altitude-source ground model (ground.ts) — the same rules as the gun sight.
 *
 *  CCIP     where a store released NOW lands (the pipper). Below the HUD glass the pipper cannot
 *           be seen, so the HUD shows the delay cue: the bomb fall line where it crosses the
 *           bottom of the glass (`delayCue*`). A pickle press then designates the ground point
 *           under the delay cue, and the computer releases when the impact reaches it (consent
 *           release, delivery.ts), steering and counting down exactly as in CCRP.
 *  CCRP     the release time τ that puts the impact on the target (the SPI), flying on along the
 *           PRESENT flight path (constant velocity and attitude): the store's state at release is
 *           the present one moved by v·τ. With û the ground track, the along-track error
 *           E(τ) = (target − impact(τ))·û falls as τ grows (the impact advances: at the ground
 *           speed in level flight, slower in a dive); a secant iteration solves E(τ) = 0, warm-
 *           started from the last step, so a step usually costs one prediction. Then:
 *             azimuthError = atan2(cross-track miss, along-track distance to the target): the
 *                            change of ground track that moves the impact onto the target;
 *             cueEl        = the pull-up (flight-path angle) that would put a release NOW on the
 *                            target: E(0) / (dRange/dγ), with E(0) ≈ |dE/dτ|·τ and the range
 *                            gain of a loft measured by a lofted prediction every few steps —
 *                            0 exactly at the release point, so the cue meets the velocity vector
 *                            when the store leaves (and a loft releases early, as it should).
 *  Both     belowMinimum: the (planned) release is lower above the impact than the profile's
 *           minimum altitude, or falls for less than the fuze's arming time (`fuzeNoArm`: a dud).
 *
 * A store without a registered model has no solution (the HUD says CCIP / CCRP INVALID).
 */
import { registerStoreBallistics, storeBallistics, type StoreBallistics } from './registry';
import { Vector3 } from 'three';
import { A10_GEOMETRY } from '../../data/geometry';
import { FIRE_CONTROL, HIGH_DRAG_STORES, RELEASE } from '../../data/avionics';
import { SIM_DT } from '../constants';
import type { AircraftState } from '../flight/types';
import { hudAnglesFromBodyDir, worldToBody } from '../frames';
import type { Sim } from '../types';
import { windAt } from '../world';
import type { TerrainHit } from '../world/types';
import { createTerrainHit, type FireControlGround } from './ground';
import { eyeWorld, hudAnglesOfPoint } from './gunsight';
import { createImpactPrediction, predictImpact, type ImpactPrediction } from './predict';
import { selectedProfile } from './profiles';
import { nextStation } from './stations';
import type { ReleaseSolution, WeaponProfile } from './types';

export { registerStoreBallistics, storeBallistics, type StoreBallistics };

// ---------------------------------------------------------------------------------------------
// Models and release states
// ---------------------------------------------------------------------------------------------

const hdKeys: Record<string, string> = {};

/** The registry key of a profile's ballistics: the store, or `${store}/HD` released high drag. */
export function modelKey(p: WeaponProfile): string {
  if (p.drag !== 'HD' || !HIGH_DRAG_STORES.includes(p.store)) return p.store;
  let k = hdKeys[p.store];
  if (k === undefined) {
    k = p.store + '/HD';
    hdKeys[p.store] = k;
  }
  return k;
}

/** The model the computer flies a profile's store with (the weapons module's), or null. */
export function modelFor(p: WeaponProfile): StoreBallistics | null {
  return storeBallistics(modelKey(p));
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
  return predictImpact(
    model,
    origin,
    velocity,
    wind,
    ground,
    maxTime,
    model.dt ?? SIM_DT,
    out,
    RELEASE.storeChordTime,
  );
}

const _r = new Vector3();
const _u = new Vector3();

/**
 * Position and velocity (world) of a store leaving `station` now: the pylon's suspension point
 * (A10_GEOMETRY.stations), the aircraft's velocity plus ω × r and the rack's ejection velocity
 * (the model's, body frame) — what the weapons module starts the live body with.
 */
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

/**
 * The same `tau` seconds from now, the aircraft flying on along its present flight path
 * (constant velocity and attitude): what the CCRP computer assumes about the future.
 */
export function releaseStateAt(
  ac: AircraftState,
  station: number,
  model: StoreBallistics,
  tau: number,
  pos: Vector3,
  vel: Vector3,
): void {
  releaseState(ac, station, model, pos, vel);
  pos.addScaledVector(ac.velocity, tau);
}

/** The station the next release of the profile's store leaves from (stations.ts), or 0. */
export function stationFor(sim: Sim, p: WeaponProfile): number {
  return nextStation(sim, p.store, null, sim.avionics.delivery.lastSide);
}

// ---------------------------------------------------------------------------------------------
// The HUD glass and the delay cue
// ---------------------------------------------------------------------------------------------

/** Bottom edge of the HUD combiner glass (its two lower corners share y and z), body frame. */
const GLASS_BOTTOM_Y = Math.max(A10_GEOMETRY.hudCorners[2].y, A10_GEOMETRY.hudCorners[3].y);
const GLASS_BOTTOM_Z = A10_GEOMETRY.hudCorners[2].z;
/** The bottom edge on the HUD's flat (gnomonic) plane seen from the design eye: y = tan(el). */
const GLASS_BOTTOM_PLANE_Y =
  (GLASS_BOTTOM_Y - A10_GEOMETRY.eye.y) / (A10_GEOMETRY.eye.z - GLASS_BOTTOM_Z);
/** The delay cue's line on the flat plane, RELEASE.delayCueMargin above the edge. */
const DELAY_CUE_PLANE_Y = Math.tan(Math.atan(GLASS_BOTTOM_PLANE_Y) + RELEASE.delayCueMargin);

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

const _rayHit: TerrainHit = createTerrainHit();

/** Where a ray meets the computer's ground (terrain database or plane), or false. */
export function groundRay(
  ground: FireControlGround,
  origin: Vector3,
  dir: Vector3,
  maxDistance: number,
  out: Vector3,
): boolean {
  if (!ground.valid) return false;
  if (ground.terrain) {
    if (!ground.terrain.raycast(origin, dir, maxDistance, _rayHit)) return false;
    out.copy(_rayHit.point);
    return true;
  }
  const len = dir.length();
  if (!(len > 0) || dir.y >= 0) return false;
  const t = ((ground.plane - origin.y) / dir.y) * len;
  if (!(t >= 0) || t > maxDistance) return false;
  out
    .copy(dir)
    .multiplyScalar(t / len)
    .add(origin);
  return true;
}

/** True when a point is above the computer's ground (a release point must be). */
function aboveGround(ground: FireControlGround, p: Vector3): boolean {
  if (ground.terrain) return p.y > ground.terrain.heightAt(p.x, p.z);
  return p.y > ground.plane;
}

const _tvv = new Vector3();
const _cue = new Vector3();
const _angles = { az: 0, el: 0 };

/**
 * The delay cue (see ReleaseSolution): on the HUD's flat plane, the straight fall line from the
 * velocity vector (TVV) to the pipper crosses the cue line just above the glass bottom; the
 * ground point seen through it is what a pickle press designates.
 */
function computeDelayCue(ac: AircraftState, ground: FireControlGround, rel: ReleaseSolution): void {
  rel.delayCueValid = false;
  worldToBody(ac.orientation, ac.velocity, _tvv);
  if (_tvv.z >= -1e-6) return;
  const xv = _tvv.x / -_tvv.z;
  const yv = _tvv.y / -_tvv.z;
  eyeWorld(ac, _e);
  worldToBody(ac.orientation, _d.subVectors(rel.impact, _e), _d);
  if (_d.z >= -1e-6) return;
  const xp = _d.x / -_d.z;
  const yp = _d.y / -_d.z;
  const yc = DELAY_CUE_PLANE_Y;
  if (!(yp < yc && yv > yc)) return;
  const s = (yv - yc) / (yv - yp);
  _cue.set(xv + s * (xp - xv), yc, -1);
  hudAnglesFromBodyDir(_cue, _angles);
  _cue.applyQuaternion(ac.orientation);
  if (!groundRay(ground, _e, _cue, RELEASE.delayCueMaxRange, rel.delayCue)) return;
  rel.delayCueAz = _angles.az;
  rel.delayCueEl = _angles.el;
  rel.delayCueValid = true;
}

// ---------------------------------------------------------------------------------------------
// The release-time solver (CCRP and consent)
// ---------------------------------------------------------------------------------------------

/** Result of a release-time solution. */
export interface ReleaseTimeSolution {
  /** Seconds from the present state to the release (negative: the point is behind). */
  tau: number;
  /** Impact of that release (along the track exactly on the target). */
  impact: Vector3;
  timeOfFall: number;
  /** dE/dτ, m/s (negative). */
  slope: number;
  /** Height of the release point above the target, m. */
  releaseHeight: number;
  /** Cross-track miss of that release (+ = target right of the impact), m. */
  cross: number;
  /** Along-track distance from the aircraft now to the target, m. */
  along: number;
}

export function createReleaseTimeSolution(): ReleaseTimeSolution {
  return {
    tau: 0,
    impact: new Vector3(),
    timeOfFall: 0,
    slope: 0,
    releaseHeight: 0,
    cross: 0,
    along: 0,
  };
}

const _so = new Vector3();
const _sv = new Vector3();
const _sp = createImpactPrediction();
let _evalE = 0;
/** Predictions flown by the solver and the loft measurement this step. */
let _predictions = 0;

/** E(τ) for a release τ from now: false when the release point is underground or no impact. */
function evaluate(
  ac: AircraftState,
  model: StoreBallistics,
  station: number,
  tau: number,
  target: Vector3,
  ground: FireControlGround,
  wind: Vector3,
  ux: number,
  uz: number,
): boolean {
  releaseStateAt(ac, station, model, tau, _so, _sv);
  if (!aboveGround(ground, _so)) return false;
  _predictions++;
  if (!predictStoreImpact(model, _so, _sv, wind, ground, _sp)) return false;
  _evalE = (target.x - _sp.point.x) * ux + (target.z - _sp.point.z) * uz;
  return true;
}

/**
 * Solve the release time that puts the impact on `target` along the track (see the file
 * comment). `warm` uses the last solution in `sim.avionics.fc` (aged by the caller); `refine`
 * re-predicts until the error is inside RELEASE.solverTolerance (for the release itself).
 * Allocation-free.
 */
export function solveReleaseTime(
  sim: Sim,
  model: StoreBallistics,
  station: number,
  target: Vector3,
  ground: FireControlGround,
  wind: Vector3,
  refine: boolean,
  out: ReleaseTimeSolution,
): boolean {
  const ac = sim.aircraft;
  const fc = sim.avionics.fc;
  const vx = ac.velocity.x;
  const vz = ac.velocity.z;
  const vg = Math.sqrt(vx * vx + vz * vz);
  if (vg < 1) {
    fc.solveValid = false;
    return false;
  }
  const ux = vx / vg;
  const uz = vz / vg;
  const warm =
    fc.solveValid &&
    Math.abs(fc.solveTarget.x - target.x) + Math.abs(fc.solveTarget.z - target.z) < 2 &&
    Math.abs(fc.solveTarget.y - target.y) < 2;
  let tau = warm ? fc.solveTau : 0;
  let slope = warm && fc.solveSlope < 0 ? fc.solveSlope : -vg;
  let prevTau = NaN;
  let prevE = NaN;
  let goodTau = NaN;
  let solved = false;
  const maxTau = RELEASE.maxTimeToRelease;
  for (let i = 0; i < RELEASE.solverMaxIterations; i++) {
    if (!evaluate(ac, model, station, tau, target, ground, wind, ux, uz)) {
      // Underground release point (a dive ends before it) or no impact: back off.
      if (Number.isNaN(goodTau)) {
        if (tau <= 0) break;
        tau *= 0.5;
      } else tau = 0.5 * (tau + goodTau);
      continue;
    }
    const e = _evalE;
    if (!Number.isNaN(prevE) && Math.abs(tau - prevTau) > 1e-6) {
      const s = (e - prevE) / (tau - prevTau);
      // Keep a sane slope: the impact advances at between 5 % and 3× the ground speed.
      if (s < -0.05 * vg && s > -3 * vg) slope = s;
    }
    goodTau = tau;
    const tol = !refine && warm && i === 0 ? RELEASE.solverLinear : RELEASE.solverTolerance;
    if (Math.abs(e) <= tol) {
      // Accept, with the remaining error taken out along the slope (second order: mm).
      const dTau = -e / slope;
      out.tau = tau + dTau;
      out.impact.set(_sp.point.x + e * ux, _sp.point.y, _sp.point.z + e * uz);
      out.timeOfFall = _sp.time;
      out.slope = slope;
      solved = true;
      break;
    }
    prevTau = tau;
    prevE = e;
    let step = -e / slope;
    if (step > RELEASE.solverMaxStep) step = RELEASE.solverMaxStep;
    else if (step < -RELEASE.solverMaxStep) step = -RELEASE.solverMaxStep;
    tau += step;
    if (tau > maxTau) tau = maxTau;
    else if (tau < -maxTau) tau = -maxTau;
  }
  if (!solved) {
    fc.solveValid = false;
    return false;
  }
  fc.solveTau = out.tau;
  fc.solveSlope = out.slope;
  fc.solveValid = true;
  fc.solveTarget.copy(target);
  out.releaseHeight = ac.position.y + ac.velocity.y * out.tau - target.y;
  // Steering: the cross-track miss over the along-track distance still to fly to the target.
  // n = (−uz, 0, ux) is the horizontal right of the track.
  const dx = target.x - out.impact.x;
  const dz = target.z - out.impact.z;
  out.cross = -dx * uz + dz * ux;
  out.along = (target.x - ac.position.x) * ux + (target.z - ac.position.z) * uz;
  return true;
}

const _lv = new Vector3();

/**
 * How far a pull-up throws the store: m of along-track impact per rad of flight-path angle,
 * from a prediction with the release velocity turned up by RELEASE.cueLoftStep in the vertical
 * plane of the track, at the solution's release point. Kept in fc.loftGain.
 */
function measureLoftGain(
  sim: Sim,
  model: StoreBallistics,
  station: number,
  tau: number,
  ground: FireControlGround,
  wind: Vector3,
  impact: Vector3,
): void {
  const ac = sim.aircraft;
  const fc = sim.avionics.fc;
  const vg = Math.sqrt(ac.velocity.x * ac.velocity.x + ac.velocity.z * ac.velocity.z);
  if (vg < 1) return;
  const ux = ac.velocity.x / vg;
  const uz = ac.velocity.z / vg;
  releaseStateAt(ac, station, model, tau, _so, _sv);
  // Turn the (along-track, vertical) part of the velocity up by the loft step.
  const h = _sv.x * ux + _sv.z * uz;
  const c = -_sv.x * uz + _sv.z * ux;
  const g = RELEASE.cueLoftStep;
  const h2 = h * Math.cos(g) - _sv.y * Math.sin(g);
  const y2 = h * Math.sin(g) + _sv.y * Math.cos(g);
  _lv.set(h2 * ux - c * uz, y2, h2 * uz + c * ux);
  _predictions++;
  if (!predictStoreImpact(model, _so, _lv, wind, ground, _sp)) return;
  const gain = ((_sp.point.x - impact.x) * ux + (_sp.point.z - impact.z) * uz) / g;
  if (gain > 10) {
    fc.loftGain = gain;
    fc.loftAge = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// The release solution
// ---------------------------------------------------------------------------------------------

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
    designated: new Vector3(),
    designatedValid: false,
    azimuthError: 0,
    cueEl: 0,
    store: '',
    station: 0,
    delayCue: new Vector3(),
    delayCueValid: false,
    delayCueAz: 0,
    delayCueEl: 0,
    armed: false,
    passed: false,
    timeToImpact: -1,
    fuzeNoArm: false,
    releaseHeight: 0,
    pulsesLeft: 0,
  };
}

function invalidate(rel: ReleaseSolution): void {
  rel.valid = false;
  rel.releaseNow = false;
  rel.belowMinimum = false;
  rel.belowGlass = false;
  rel.timeToRelease = 0;
  rel.timeOfFall = 0;
  rel.designatedValid = false;
  rel.azimuthError = 0;
  rel.cueEl = 0;
  rel.delayCueValid = false;
  rel.passed = false;
  rel.fuzeNoArm = false;
  rel.releaseHeight = 0;
}

const _origin = new Vector3();
const _vel = new Vector3();
const _wind = new Vector3();
const _pred = createImpactPrediction();
const _solve = createReleaseTimeSolution();

/** The fire-control time of the present aircraft state: step 9 runs before the clock advances. */
export function fireControlTime(sim: Sim, dt: number): number {
  return sim.time + dt;
}

/**
 * Apply a release-time solution to the HUD fields: time to release, time of fall, steering,
 * the solution cue and the minimum-altitude / fuze cues of the planned release.
 */
function applySolution(
  sim: Sim,
  model: StoreBallistics,
  station: number,
  ground: FireControlGround,
  p: WeaponProfile,
  s: ReleaseTimeSolution,
  rel: ReleaseSolution,
): void {
  const fc = sim.avionics.fc;
  rel.timeToRelease = s.tau;
  rel.timeOfFall = s.timeOfFall;
  rel.passed = s.tau < 0;
  rel.azimuthError = Math.atan2(s.cross, Math.max(1, s.along));
  if (fc.loftAge >= RELEASE.cueRefreshSteps || !(fc.loftGain > 0)) {
    measureLoftGain(sim, model, station, s.tau, ground, _wind, s.impact);
  }
  rel.cueEl = fc.loftGain > 0 ? (-s.slope * s.tau) / fc.loftGain : 0;
  rel.releaseHeight = s.releaseHeight;
  rel.fuzeNoArm = s.timeOfFall < p.armingTime;
  rel.belowMinimum = s.releaseHeight < p.minAltitude || rel.fuzeNoArm;
}

/**
 * The release solution of the selected profile for the present sight (`av.release`), from the
 * aircraft state at fire-control time. Run after the selected station is known. Allocation-free.
 */
export function computeReleaseSolution(sim: Sim, ground: FireControlGround, dt: number): void {
  const av = sim.avionics;
  const rel = av.release;
  const fc = av.fc;
  const d = av.delivery;
  _predictions = 0;
  if (fc.solveValid) fc.solveTau -= dt;
  fc.loftAge++;
  const now = fireControlTime(sim, dt);
  rel.timeToImpact = d.lastImpactTime > now ? d.lastImpactTime - now : -1;
  rel.pulsesLeft = d.phase === 'SERIES' ? Math.max(0, d.pulses - d.pulseIndex) : 0;
  rel.armed = d.phase === 'CONSENT' || d.phase === 'CCRP';
  rel.releaseNow = false;
  const sight = av.sight;
  const p = sight === 'CCIP' || sight === 'CCRP' ? selectedProfile(sim) : null;
  const model = p ? modelFor(p) : null;
  const station = av.selectedStation;
  rel.store = p ? p.store : '';
  rel.station = p ? station : 0;
  if (!p || !model || station === 0) {
    invalidate(rel);
    fc.solveValid = false;
    fc.storePredictions = _predictions;
    return;
  }
  const ac = sim.aircraft;
  windAt(sim.world, ac.position, _wind);
  if (sight === 'CCIP') {
    releaseState(ac, station, model, _origin, _vel);
    _predictions++;
    if (!predictStoreImpact(model, _origin, _vel, _wind, ground, _pred)) {
      invalidate(rel);
      fc.solveValid = false;
      fc.storePredictions = _predictions;
      return;
    }
    rel.valid = true;
    rel.impact.copy(_pred.point);
    hudAnglesOfPoint(ac, rel.impact, _angles);
    rel.az = _angles.az;
    rel.el = _angles.el;
    rel.timeToRelease = 0;
    rel.timeOfFall = _pred.time;
    rel.releaseHeight = ac.position.y - rel.impact.y;
    rel.fuzeNoArm = rel.timeOfFall < p.armingTime;
    rel.belowMinimum = rel.releaseHeight < p.minAltitude || rel.fuzeNoArm;
    rel.belowGlass = belowGlass(ac, rel.impact);
    if (rel.belowGlass) computeDelayCue(ac, ground, rel);
    else rel.delayCueValid = false;
    // Consent release designated: steer and count down to the designated point as in CCRP.
    rel.designatedValid = d.phase === 'CONSENT' && d.aimValid;
    if (rel.designatedValid) {
      rel.designated.copy(d.aim);
      if (solveReleaseTime(sim, model, station, rel.designated, ground, _wind, false, _solve)) {
        applySolution(sim, model, station, ground, p, _solve, rel);
      } else {
        rel.timeToRelease = 0;
        rel.azimuthError = 0;
        rel.cueEl = 0;
        rel.passed = false;
      }
    } else {
      fc.solveValid = false;
      rel.azimuthError = 0;
      rel.cueEl = 0;
      rel.passed = false;
    }
  } else {
    // CCRP onto the SPI.
    const spi = av.spi;
    if (
      !spi.valid ||
      !solveReleaseTime(sim, model, station, spi.position, ground, _wind, false, _solve)
    ) {
      invalidate(rel);
      fc.storePredictions = _predictions;
      return;
    }
    rel.valid = true;
    rel.impact.copy(spi.position);
    hudAnglesOfPoint(ac, rel.impact, _angles);
    rel.az = _angles.az;
    rel.el = _angles.el;
    rel.designated.copy(spi.position);
    rel.designatedValid = true;
    rel.belowGlass = false;
    rel.delayCueValid = false;
    applySolution(sim, model, station, ground, p, _solve, rel);
  }
  fc.storePredictions = _predictions;
}

/**
 * Solve and show the release for a newly designated point at once (the consent press), so the
 * HUD's countdown and steering start in the press step. Returns false without a solution.
 */
export function solveDesignated(sim: Sim, ground: FireControlGround, target: Vector3): boolean {
  const av = sim.avionics;
  const p = selectedProfile(sim);
  const model = p ? modelFor(p) : null;
  if (!p || !model || av.selectedStation === 0) return false;
  windAt(sim.world, sim.aircraft.position, _wind);
  av.fc.solveValid = false;
  if (!solveReleaseTime(sim, model, av.selectedStation, target, ground, _wind, false, _solve)) {
    return false;
  }
  applySolution(sim, model, av.selectedStation, ground, p, _solve, av.release);
  av.fc.storePredictions += _predictions;
  return true;
}

/**
 * Refine the present solution for the release itself (CCRP or consent, in the step it is due):
 * re-predict until the along-track error is inside RELEASE.solverTolerance. Returns the release
 * time from the present state, s, or NaN.
 */
export function refineReleaseTime(
  sim: Sim,
  model: StoreBallistics,
  station: number,
  target: Vector3,
  ground: FireControlGround,
): number {
  windAt(sim.world, sim.aircraft.position, _wind);
  if (!solveReleaseTime(sim, model, station, target, ground, _wind, true, _solve)) return NaN;
  sim.avionics.fc.storePredictions += _predictions;
  return _solve.tau;
}

/**
 * Where a store released at `tau` from now from `station` lands by the computer's prediction
 * (present flight path, measured wind): the aim of an immediate CCIP pulse. Returns the time of
 * fall, or NaN without an impact.
 */
export function predictReleaseAt(
  sim: Sim,
  model: StoreBallistics,
  station: number,
  tau: number,
  ground: FireControlGround,
  out: Vector3,
): number {
  const ac = sim.aircraft;
  windAt(sim.world, ac.position, _wind);
  releaseStateAt(ac, station, model, tau, _origin, _vel);
  if (!predictStoreImpact(model, _origin, _vel, _wind, ground, _pred)) return NaN;
  out.copy(_pred.point);
  return _pred.time;
}

// ---------------------------------------------------------------------------------------------
// A full flight (simulated releases)
// ---------------------------------------------------------------------------------------------

const _fp = new Vector3();
const _fv = new Vector3();
const _fa = new Vector3();
const _fw = new Vector3();
const _fh: TerrainHit = createTerrainHit();

/**
 * Fly a store the way a live body flies (the wind AT the body every step, SIM_DT steps, the real
 * terrain; no vehicles): where a store released from this state really lands. Master Arm TRAIN
 * records it for the debrief without anything leaving the aircraft. Allocation-free.
 */
export function flyStore(
  sim: Sim,
  model: StoreBallistics,
  origin: Vector3,
  velocity: Vector3,
  maxTime: number,
  out: ImpactPrediction,
): boolean {
  const terrain = sim.world.terrain;
  _fp.copy(origin);
  _fv.copy(velocity);
  let t = 0;
  while (t < maxTime) {
    windAt(sim.world, _fp, _fw);
    _fa.copy(_fp);
    model.integrate(_fp, _fv, _fw, SIM_DT, t);
    if (terrain.segmentHit(_fa, _fp, _fh)) {
      out.point.copy(_fh.point);
      out.velocity.copy(_fv);
      out.time = t + _fh.t * SIM_DT;
      return true;
    }
    t += SIM_DT;
  }
  return false;
}

/** The state of a store leaving `station` at `tau` from now (present flight path), for flyStore. */
export function storeReleaseState(
  sim: Sim,
  model: StoreBallistics,
  station: number,
  tau: number,
  pos: Vector3,
  vel: Vector3,
): void {
  releaseStateAt(sim.aircraft, station, model, tau, pos, vel);
}
