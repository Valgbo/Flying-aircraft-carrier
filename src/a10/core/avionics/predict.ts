/**
 * The fire-control computer's ballistic predictor (PLAN_A10.md §6.1 rule 2): it flies a weapon
 * forward with the weapon's OWN model — the weapons module's integrator, the very function that
 * moves the live bodies — from the aircraft's present state, with the wind held at the value
 * measured at the aircraft, until the body meets the computer's ground model.
 *
 * Cost. The trajectory is integrated in steps of `dt`, and the ground is tested along CHORDS that
 * span about `FIRE_CONTROL.groundChordTime` of flight. A ballistic path is concave downward:
 * gravity only ever turns the velocity down, and drag acts along it, so the path lies above the
 * chord between any two of its points. A chord that clears the ground therefore proves that the
 * arc above it clears it too, and only a chord that touches the ground is refined, segment by
 * segment between the stored sub-step points. A chord wholly above the ground's ceiling (the
 * highest terrain, or the plane) needs no query at all.
 *
 * The step may be coarser than the live rounds' step only while the result stays within
 * `FIRE_CONTROL.predictorTolerance` of them: `calibrateStep` measures that once per model.
 */
import { Vector3 } from 'three';
import type { TerrainHit } from '../world/types';
import { FIRE_CONTROL } from './data';
import { createTerrainHit, groundSegmentHit, type FireControlGround } from './ground';

/** A body the computer can fly: the weapons module's own integrator for that body. */
export interface BallisticModel {
  /** Advance `pos` and `vel` (world, m and m/s) in place by `dt`, in an air mass moving at `wind`. */
  integrate(pos: Vector3, vel: Vector3, wind: Vector3, dt: number): void;
}

export interface ImpactPrediction {
  /** Impact point, world. */
  point: Vector3;
  /** Velocity at the impact, world m/s. */
  velocity: Vector3;
  /** Flight time to the impact, s. */
  time: number;
}

export function createImpactPrediction(): ImpactPrediction {
  return { point: new Vector3(), velocity: new Vector3(), time: 0 };
}

/** Work counters of the last prediction (cost diagnostics and tests). */
export const predictorStats = { steps: 0, groundTests: 0 };

/** Sub-step points of the current chord: positions and velocities, 3 numbers each. */
const MAX_CHORD_STEPS = 64;
const _bufP = new Float64Array(3 * (MAX_CHORD_STEPS + 1));
const _bufV = new Float64Array(3 * (MAX_CHORD_STEPS + 1));
const _p = new Vector3();
const _v = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _hit: TerrainHit = createTerrainHit();

function store(i: number, p: Vector3, v: Vector3): void {
  const k = 3 * i;
  _bufP[k] = p.x;
  _bufP[k + 1] = p.y;
  _bufP[k + 2] = p.z;
  _bufV[k] = v.x;
  _bufV[k + 1] = v.y;
  _bufV[k + 2] = v.z;
}

function load(i: number, out: Vector3): Vector3 {
  const k = 3 * i;
  return out.set(_bufP[k], _bufP[k + 1], _bufP[k + 2]);
}

/**
 * Fly a body from `origin` with world velocity `velocity` until it meets `ground` or `maxTime`
 * passes; the wind is held constant. Returns false when there is no impact in that time (or the
 * ground has no data). Allocation-free.
 */
export function predictImpact(
  model: BallisticModel,
  origin: Vector3,
  velocity: Vector3,
  wind: Vector3,
  ground: FireControlGround,
  maxTime: number,
  dt: number,
  out: ImpactPrediction,
): boolean {
  predictorStats.steps = 0;
  predictorStats.groundTests = 0;
  if (!ground.valid || !(dt > 0)) return false;
  // A plane above the start: the computer has no solution (the aircraft is below its ground).
  if (!ground.terrain && origin.y <= ground.plane) return false;
  const chordSteps = Math.max(
    1,
    Math.min(MAX_CHORD_STEPS, Math.round(FIRE_CONTROL.groundChordTime / dt)),
  );
  const ceiling = ground.ceiling;
  _p.copy(origin);
  _v.copy(velocity);
  store(0, _p, _v);
  let n = 0;
  let t = 0;
  /** Height of the current chord's first point. */
  let chordStartY = _p.y;
  for (;;) {
    model.integrate(_p, _v, wind, dt);
    t += dt;
    n++;
    predictorStats.steps++;
    store(n, _p, _v);
    const last = t >= maxTime - 1e-9;
    if (n < chordSteps && !last) continue;
    // Test the chord from the first to the last stored point.
    const startY = chordStartY;
    chordStartY = _p.y;
    if (Math.min(startY, _p.y) <= ceiling) {
      predictorStats.groundTests++;
      if (groundSegmentHit(ground, load(0, _a), _p, _hit)) {
        // Refine: the first sub-step segment that meets the ground.
        for (let j = 1; j <= n; j++) {
          load(j - 1, _a);
          load(j, _b);
          predictorStats.groundTests++;
          if (groundSegmentHit(ground, _a, _b, _hit)) {
            const f = _hit.t;
            out.point.copy(_hit.point);
            const k0 = 3 * (j - 1);
            const k1 = 3 * j;
            out.velocity.set(
              _bufV[k0] + (_bufV[k1] - _bufV[k0]) * f,
              _bufV[k0 + 1] + (_bufV[k1 + 1] - _bufV[k0 + 1]) * f,
              _bufV[k0 + 2] + (_bufV[k1 + 2] - _bufV[k0 + 2]) * f,
            );
            out.time = t - (n - j + 1) * dt + f * dt;
            return true;
          }
        }
        // The chord touched the ground but the path did not (a crest under a long chord).
      }
    }
    if (last) return false;
    store(0, _p, _v);
    n = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Step calibration
// ---------------------------------------------------------------------------------------------

/** A reference shot for the calibration: start state and the height of a flat ground plane. */
export interface CalibrationShot {
  origin: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  wind: { x: number; y: number; z: number };
  groundHeight: number;
}

const _calGround: FireControlGround = {
  source: 'BARO',
  valid: true,
  terrain: null,
  plane: 0,
  ceiling: 0,
};
const _o = new Vector3();
const _v0 = new Vector3();
const _w = new Vector3();
const _ref = createImpactPrediction();
const _try = createImpactPrediction();
const _d = new Vector3();
const _los = new Vector3();

/** Angle between two impact points seen from `from`, rad (the miss across the line of sight). */
function angularMiss(from: Vector3, a: Vector3, b: Vector3): number {
  _los.subVectors(a, from);
  const range = _los.length();
  if (range < 1e-6) return 0;
  _los.multiplyScalar(1 / range);
  _d.subVectors(b, a);
  _d.addScaledVector(_los, -_d.dot(_los));
  return _d.length() / range;
}

/**
 * Largest angular difference between flying the shots with step `dt` and with `referenceDt`
 * (the live rounds' step), rad. Infinity if a shot has no impact.
 */
export function stepError(
  model: BallisticModel,
  shots: readonly CalibrationShot[],
  dt: number,
  referenceDt: number,
): number {
  let worst = 0;
  for (const s of shots) {
    _calGround.plane = s.groundHeight;
    _calGround.ceiling = s.groundHeight;
    _o.set(s.origin.x, s.origin.y, s.origin.z);
    _v0.set(s.velocity.x, s.velocity.y, s.velocity.z);
    _w.set(s.wind.x, s.wind.y, s.wind.z);
    if (!predictImpact(model, _o, _v0, _w, _calGround, 30, referenceDt, _ref)) return Infinity;
    if (!predictImpact(model, _o, _v0, _w, _calGround, 30, dt, _try)) return Infinity;
    worst = Math.max(worst, angularMiss(_o, _ref.point, _try.point));
  }
  return worst;
}

/**
 * The coarsest step from `candidates` (coarsest first) whose error against `referenceDt` stays
 * within `tolerance` on every shot; `referenceDt` itself if none does. Deterministic.
 */
export function calibrateStep(
  model: BallisticModel,
  shots: readonly CalibrationShot[],
  referenceDt: number,
  candidates: readonly number[] = FIRE_CONTROL.predictorSteps,
  tolerance: number = FIRE_CONTROL.predictorTolerance,
): number {
  for (const dt of candidates) {
    if (dt <= referenceDt) break;
    if (stepError(model, shots, dt, referenceDt) <= tolerance) return dt;
  }
  return referenceDt;
}
