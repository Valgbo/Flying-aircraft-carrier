/**
 * 30 mm round ballistics: a point mass with Mach-dependent drag, gravity and wind, in the
 * standard atmosphere. The fire-control computer predicts with THESE functions, so the pipper
 * and the rounds always agree (PLAN_A10.md §6.1 rule 2).
 *
 * Equation of motion (world frame, v_air = v − wind):
 *     dv/dt = −(ρ(h) · Cd(M) · A / 2m) · |v_air| · v_air − g·ŷ,     M = |v_air| / a(h)
 * ρ and the speed of sound a come from the ISA at the round's altitude (core/world/atmosphere),
 * Cd(M) = form factor × the G7 standard drag function (data/gun.ts).
 *
 * Integrator: Heun's method (explicit trapezoid), second order. One step evaluates the
 * acceleration at the start and at the Euler-predicted end, averages them for the velocity and
 * averages the start and end velocities for the position. Without drag it reproduces the
 * parabola exactly; with drag at dt = 1/120 s its error over a 2 km flight is well under a
 * millimetre. Live rounds (stepProjectiles) and the predictor use the same step.
 */
import { Vector3 } from 'three';
import { GAU8, GUN_DRAG_G7 } from '../../data/gun';
import { G0, SIM_DT } from '../constants';
import { densityAt, speedOfSoundAt } from '../world';
import type { Terrain, TerrainHit } from '../world/types';
import { RoundType } from './types';

/** Projectile cross-section, m². */
const AREA = Math.PI * (GAU8.calibre / 2) ** 2;

/** Projectile mass, kg. */
export function roundMass(type: RoundType): number {
  return type === RoundType.API
    ? GAU8.massApi
    : type === RoundType.HEI
      ? GAU8.massHei
      : GAU8.massTp;
}

/** Muzzle velocity relative to the gun, m/s. */
export function muzzleVelocity(type: RoundType): number {
  return type === RoundType.HEI ? GAU8.muzzleVelocityHei : GAU8.muzzleVelocity;
}

// ---- drag tables: the G7 curve × form factor, resampled on a uniform Mach grid ----------------

const MACH_STEP = 0.01;
const MACH_MAX = 5;
const CD_POINTS = Math.round(MACH_MAX / MACH_STEP) + 1;

function g7(mach: number): number {
  const t = GUN_DRAG_G7;
  if (mach <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (mach <= t[i][0]) {
      const [m0, c0] = t[i - 1];
      const [m1, c1] = t[i];
      return c0 + ((c1 - c0) * (mach - m0)) / (m1 - m0);
    }
  }
  return t[t.length - 1][1];
}

function buildTable(formFactor: number): Float64Array {
  const out = new Float64Array(CD_POINTS);
  for (let i = 0; i < CD_POINTS; i++) out[i] = formFactor * g7(i * MACH_STEP);
  return out;
}

/** Cd against Mach for each RoundType (index = type). */
const CD_TABLES: readonly Float64Array[] = [
  buildTable(GAU8.formFactorApi),
  buildTable(GAU8.formFactorHei),
  buildTable(GAU8.formFactorTp),
];

/** Drag coefficient (on the calibre's cross-section) of a round at a Mach number. */
export function dragCoefficient(type: RoundType, mach: number): number {
  const table = CD_TABLES[type];
  const x = mach / MACH_STEP;
  if (!(x > 0)) return table[0];
  const i = Math.floor(x);
  if (i >= CD_POINTS - 1) return table[CD_POINTS - 1];
  const f = x - i;
  return table[i] + (table[i + 1] - table[i]) * f;
}

/** Drag deceleration factor k so that a = -k · ρ · |v_air| · v_air (k = Cd·A / 2m, m²/kg). */
export function dragFactor(type: RoundType, mach: number): number {
  return (0.5 * dragCoefficient(type, mach) * AREA) / roundMass(type);
}

// ---- the air: the ISA tabulated every 10 m ----------------------------------------------------
//
// Density and the speed of sound are needed twice per round per step. The ISA formulas (powers
// and exponentials) are sampled into tables once per ISA deviation and interpolated linearly;
// over 10 m the interpolation error is ~1e-7 of the value. Outside the table the formulas are
// used directly. Two deviations are kept, so the fire-control computer and the live rounds may
// use different ones without rebuilding the tables every call.

const AIR_STEP = 10;
const AIR_MIN = -1000;
const AIR_MAX = 20000;
const AIR_POINTS = (AIR_MAX - AIR_MIN) / AIR_STEP + 1;

interface AirTable {
  isa: number;
  density: Float64Array;
  sound: Float64Array;
}

/** The tables in use, most recently used first (at most two). */
const airTables: AirTable[] = [];

function airTable(isa: number): AirTable {
  const a = airTables[0];
  if (a && a.isa === isa) return a;
  const b = airTables[1];
  if (b && b.isa === isa) {
    airTables[0] = b;
    airTables[1] = a;
    return b;
  }
  // A new deviation: fill the least recently used table (or a new one, twice at most).
  const t = b ?? {
    isa,
    density: new Float64Array(AIR_POINTS),
    sound: new Float64Array(AIR_POINTS),
  };
  t.isa = isa;
  for (let i = 0; i < AIR_POINTS; i++) {
    const h = AIR_MIN + i * AIR_STEP;
    t.density[i] = densityAt(h, isa);
    t.sound[i] = speedOfSoundAt(h, isa);
  }
  airTables[0] = t;
  if (a) airTables[1] = a;
  return t;
}

/** Air scratch: density (kg/m³) and speed of sound (m/s) at the last altitude asked. */
const air = { density: 0, sound: 0 };

function airAt(y: number, isa: number): void {
  const x = (y - AIR_MIN) / AIR_STEP;
  if (x >= 0 && x < AIR_POINTS - 1) {
    const t = airTable(isa);
    const i = Math.floor(x);
    const f = x - i;
    air.density = t.density[i] + (t.density[i + 1] - t.density[i]) * f;
    air.sound = t.sound[i] + (t.sound[i + 1] - t.sound[i]) * f;
  } else {
    air.density = densityAt(y, isa);
    air.sound = speedOfSoundAt(y, isa);
  }
}

// ---- integration --------------------------------------------------------------------------------

/** Acceleration scratch (one evaluation). */
const acc = { x: 0, y: 0, z: 0 };

/** Drag + gravity acceleration at (altitude y, velocity v) in air moving with `wind`. */
function accelerate(
  type: RoundType,
  y: number,
  vx: number,
  vy: number,
  vz: number,
  wind: Vector3,
  isaDeviation: number,
  dragScale: number,
): void {
  const ax = vx - wind.x;
  const ay = vy - wind.y;
  const az = vz - wind.z;
  const speed = Math.sqrt(ax * ax + ay * ay + az * az);
  let k = 0;
  if (dragScale !== 0 && speed > 0) {
    airAt(y, isaDeviation);
    k = dragScale * dragFactor(type, speed / air.sound) * air.density * speed;
  }
  acc.x = -k * ax;
  acc.y = -k * ay - G0;
  acc.z = -k * az;
}

/**
 * Advance one round by dt with Heun's method (see the file comment). `wind` is the world air
 * velocity at the round, held over the step. Position and velocity are updated in place.
 * `isaDeviation` (K) shifts the standard atmosphere; `dragScale` 0 flies in vacuum (checks).
 */
export function integrateRound(
  type: RoundType,
  pos: Vector3,
  vel: Vector3,
  wind: Vector3,
  dt: number,
  isaDeviation = 0,
  dragScale = 1,
): void {
  const vx0 = vel.x;
  const vy0 = vel.y;
  const vz0 = vel.z;
  accelerate(type, pos.y, vx0, vy0, vz0, wind, isaDeviation, dragScale);
  const a0x = acc.x;
  const a0y = acc.y;
  const a0z = acc.z;
  // Euler predictor for the end of the step.
  const py = pos.y + vy0 * dt;
  accelerate(
    type,
    py,
    vx0 + a0x * dt,
    vy0 + a0y * dt,
    vz0 + a0z * dt,
    wind,
    isaDeviation,
    dragScale,
  );
  const h = 0.5 * dt;
  const vx1 = vx0 + (a0x + acc.x) * h;
  const vy1 = vy0 + (a0y + acc.y) * h;
  const vz1 = vz0 + (a0z + acc.z) * h;
  pos.x += (vx0 + vx1) * h;
  pos.y += (vy0 + vy1) * h;
  pos.z += (vz0 + vz1) * h;
  vel.x = vx1;
  vel.y = vy1;
  vel.z = vz1;
}

export interface RoundPrediction {
  point: Vector3;
  velocity: Vector3;
  time: number;
}

/** Sub-steps per terrain test in the predictor: chords of ≤ 1/12 s sag under 1 cm. */
const CHORD_TIME = 1 / 12;
const MAX_CHORD_STEPS = 16;

const _p = new Vector3();
const _v = new Vector3();
const _chord0 = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _steps = new Float64Array((MAX_CHORD_STEPS + 1) * 6);
const _hit: TerrainHit = {
  point: new Vector3(),
  normal: new Vector3(),
  distance: 0,
  t: 0,
  surface: 'grass',
};

/**
 * Fly a round from `origin` with world velocity `velocity` (muzzle velocity + aircraft velocity)
 * until it meets the terrain or `maxTime` passes. Wind is held constant (the fire-control
 * computer only knows the wind at the aircraft). Returns false if no impact within maxTime.
 *
 * Same integrator and step as the live rounds. The terrain is tested along chords of several
 * steps (they stay within a centimetre of the curved path) and the step that crosses the
 * ground is then found exactly, so a prediction costs a few terrain queries, not hundreds.
 */
export function predictRoundImpact(
  type: RoundType,
  origin: Vector3,
  velocity: Vector3,
  terrain: Terrain,
  wind: Vector3,
  maxTime: number,
  out: RoundPrediction,
  dt = SIM_DT,
  isaDeviation = 0,
): boolean {
  _p.copy(origin);
  _v.copy(velocity);
  const perChord = Math.max(1, Math.min(MAX_CHORD_STEPS, Math.floor(CHORD_TIME / dt)));
  let t = 0;
  while (t < maxTime) {
    // Integrate one chord, keeping every step's end state.
    _chord0.copy(_p);
    const t0 = t;
    writeStep(0, _p, _v);
    let n = 0;
    while (n < perChord && t < maxTime) {
      integrateRound(type, _p, _v, wind, dt, isaDeviation);
      t += dt;
      n++;
      writeStep(n, _p, _v);
    }
    const above = _chord0.y > terrain.maxHeight && _p.y > terrain.maxHeight;
    if (!above && terrain.segmentHit(_chord0, _p, _hit)) {
      // The first step of the chord that crosses the ground, exactly as a live round sees it.
      for (let i = 0; i < n; i++) {
        if (terrain.segmentHit(readStep(i, _a), readStep(i + 1, _b), _hit)) {
          return predicted(out, i, _hit.t, t0, dt);
        }
      }
      // The chord touched the ground between two steps (a grazing pass): take the chord's hit.
      terrain.segmentHit(_chord0, _p, _hit);
      const s = Math.min(n - 1e-9, _hit.t * n);
      const i = Math.floor(s);
      return predicted(out, i, s - i, t0, dt);
    }
  }
  return false;
}

/** Fill a prediction from the ground hit in `_hit`, which lies `f` of the way through step `i`. */
function predicted(out: RoundPrediction, i: number, f: number, t0: number, dt: number): true {
  out.point.copy(_hit.point);
  readVelocity(i, _a);
  readVelocity(i + 1, _b);
  out.velocity.copy(_a).lerp(_b, f);
  out.time = t0 + (i + f) * dt;
  return true;
}

function writeStep(i: number, p: Vector3, v: Vector3): void {
  const o = i * 6;
  _steps[o] = p.x;
  _steps[o + 1] = p.y;
  _steps[o + 2] = p.z;
  _steps[o + 3] = v.x;
  _steps[o + 4] = v.y;
  _steps[o + 5] = v.z;
}

function readStep(i: number, out: Vector3): Vector3 {
  const o = i * 6;
  return out.set(_steps[o], _steps[o + 1], _steps[o + 2]);
}

function readVelocity(i: number, out: Vector3): Vector3 {
  const o = i * 6 + 3;
  return out.set(_steps[o], _steps[o + 1], _steps[o + 2]);
}

/** A round's state where it first reaches a given straight-line distance from its origin. */
export interface RoundAtRange {
  /** Time of flight, s. */
  time: number;
  /** Speed (inertial), m/s. */
  speed: number;
  /** Height relative to the origin, m (negative = below). */
  drop: number;
  point: Vector3;
  velocity: Vector3;
}

/**
 * Fly a round until its straight-line distance from `origin` reaches `range` (tables, the
 * penetration fit and fixed-range sights). The crossing is interpolated within the last step.
 * Returns false if it does not get there within `maxTime`.
 */
export function flyRoundToRange(
  type: RoundType,
  origin: Vector3,
  velocity: Vector3,
  range: number,
  wind: Vector3,
  out: RoundAtRange,
  dt = SIM_DT,
  isaDeviation = 0,
  dragScale = 1,
  maxTime = 20,
): boolean {
  _p.copy(origin);
  _v.copy(velocity);
  let t = 0;
  let d0 = 0;
  while (t < maxTime) {
    _a.copy(_p);
    _b.copy(_v);
    integrateRound(type, _p, _v, wind, dt, isaDeviation, dragScale);
    const d1 = _p.distanceTo(origin);
    if (d1 >= range) {
      const f = d1 > d0 ? (range - d0) / (d1 - d0) : 1;
      out.time = t + f * dt;
      out.point.copy(_a).lerp(_p, f);
      out.velocity.copy(_b).lerp(_v, f);
      out.speed = out.velocity.length();
      out.drop = out.point.y - origin.y;
      return true;
    }
    d0 = d1;
    t += dt;
  }
  return false;
}
