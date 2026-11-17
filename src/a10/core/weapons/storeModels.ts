/**
 * Released stores in free flight (PLAN_A10.md §6.1, §6.5–§6.7; ARCHITECTURE §12.2): the model
 * every bomb, rocket, missile airframe and jettisoned rack flies with, and the same model
 * registered with the fire-control computer (rule 2: the computer predicts with the function
 * that moves the live body).
 *
 * Equation of motion (world frame, point mass, v_air = v − wind):
 *     dv/dt = −(ρ(h)·CdA(M, t) / 2m(t)) · |v_air| · v_air − g·ŷ + (T(t) / m(t)) · v̂_air  [+ a_guidance]
 *     CdA = Cd(M)·A · (plume factor while a motor burns) + ballute(t) + a tumbling rack's area
 * ρ and the speed of sound come from the ISA at the body's height (the rounds' tables).
 *
 * Thrust acts along the AIR-RELATIVE velocity: the fins hold the airframe within a small angle
 * of the relative wind (a Hydra's weathercock frequency is ≈1–2 Hz at launch speeds), so a
 * rocket pushes along v_air and, in a crosswind, turns INTO the wind while it burns (v_air
 * points upwind of the ground track). The computer's model has no attitude state, so nothing in
 * the motion may depend on one; the drawn attitude lags the relative wind (bodies.ts).
 *
 * A rocket leaves its tube already moving: the motor pushes it 1.5 m along the tube first
 * (≈0.07 s, ≈45 m/s), constrained to the tube's axis. That phase is solved once here; the rocket
 * starts its free flight from the station with that velocity along the tube (the registered
 * model's `ejection`) and its motor clock at the exit time (`motorOffset`).
 *
 * Integrator: Heun's method (explicit trapezoid, second order), as the rounds use. Each call
 * splits its interval at the model's BREAKPOINTS (ballute start and full inflation, the thrust
 * curve's knots, burn-out), so between two breakpoints the forcing is smooth and any step
 * length — the live bodies' 1/120 s, a partial first step, or the predictor's coarser step —
 * meets the discontinuities exactly. While a motor burns, pieces are at most 1/60 s.
 */
import { Vector3 } from 'three';
import { A10_GEOMETRY } from '../../data/geometry';
import {
  BSU49,
  EJECTOR,
  HYDRA70,
  MK66,
  STORE_BODY,
  STORE_FLIGHT,
  STORES,
  TUMBLE,
  type DragCurve,
} from '../../data/munitions';
import { registerStoreBallistics, storeBallistics, type StoreBallistics } from '../avionics';
import { G0 } from '../constants';
import type { Vec3Like } from '../types';
import { airAtHeight } from './ballistics';
import { motorThrust } from './guided';
import type { RocketMotor, StoreBody, StoreFlightSpec, StoreType } from './types';

// ---- drag tables ---------------------------------------------------------------------------------

/** Mach spacing of the drag tables. */
export const FLIGHT_MACH_STEP = 0.02;
const MACH_MAX = 5;
const CD_POINTS = Math.round(MACH_MAX / FLIGHT_MACH_STEP) + 1;

/** Cd of a curve at a Mach number (linear between its points, the end values beyond). */
function curveAt(curve: DragCurve, mach: number): number {
  if (mach <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (mach <= curve[i][0]) {
      const [m0, c0] = curve[i - 1];
      const [m1, c1] = curve[i];
      return c0 + ((c1 - c0) * (mach - m0)) / (m1 - m0);
    }
  }
  return curve[curve.length - 1][1];
}

/** A drag curve × factor resampled on the uniform Mach grid. */
export function dragTable(curve: DragCurve, factor = 1): Float64Array {
  const out = new Float64Array(CD_POINTS);
  for (let i = 0; i < CD_POINTS; i++) out[i] = factor * curveAt(curve, i * FLIGHT_MACH_STEP);
  return out;
}

/** Value of a uniform-grid drag table at a Mach number. */
export function tableAt(table: Float64Array, mach: number): number {
  const x = mach / FLIGHT_MACH_STEP;
  if (!(x > 0)) return table[0];
  const i = Math.floor(x);
  if (i >= CD_POINTS - 1) return table[CD_POINTS - 1];
  return table[i] + (table[i + 1] - table[i]) * (x - i);
}

// ---- the rocket motor ----------------------------------------------------------------------------

/** The Mk 66's thrust curve scaled to its total impulse, with the mass it starts from. */
function buildMotor(ignitionMass: number): RocketMotor {
  const shape = MK66.thrustShape;
  const n = shape.length;
  const time = new Float64Array(n);
  const thrust = new Float64Array(n);
  const impulse = new Float64Array(n);
  let area = 0;
  for (let i = 0; i < n; i++) {
    time[i] = shape[i][0];
    if (i > 0) area += 0.5 * (shape[i][1] + shape[i - 1][1]) * (shape[i][0] - shape[i - 1][0]);
  }
  // Thrust = shape × the scale that delivers the published total impulse.
  const scale = MK66.totalImpulse / area;
  let cumulative = 0;
  for (let i = 0; i < n; i++) {
    thrust[i] = shape[i][1] * scale;
    if (i > 0) cumulative += 0.5 * (thrust[i] + thrust[i - 1]) * (time[i] - time[i - 1]);
    impulse[i] = cumulative;
  }
  return {
    time,
    thrust,
    impulse,
    totalImpulse: cumulative,
    burnTime: time[n - 1],
    ignitionMass,
    propellant: MK66.propellantMass,
    plumeDrag: MK66.plumeDrag,
  };
}

/** Thrust of a motor `tm` s after ignition, N (linear between knots, 0 outside the burn). */
export function motorThrustAt(m: RocketMotor, tm: number): number {
  const t = m.time;
  if (!(tm > t[0]) || tm >= m.burnTime) return 0;
  for (let i = 1; i < t.length; i++) {
    if (tm <= t[i]) {
      const f = (tm - t[i - 1]) / (t[i] - t[i - 1]);
      return m.thrust[i - 1] + (m.thrust[i] - m.thrust[i - 1]) * f;
    }
  }
  return 0;
}

/** Impulse delivered `tm` s after ignition, N·s. */
function motorImpulseAt(m: RocketMotor, tm: number): number {
  const t = m.time;
  if (!(tm > t[0])) return 0;
  if (tm >= m.burnTime) return m.totalImpulse;
  for (let i = 1; i < t.length; i++) {
    if (tm <= t[i]) {
      const h = tm - t[i - 1];
      const f0 = m.thrust[i - 1];
      const slope = (m.thrust[i] - f0) / (t[i] - t[i - 1]);
      return m.impulse[i - 1] + f0 * h + 0.5 * slope * h * h;
    }
  }
  return m.totalImpulse;
}

/** Mass of a rocket `tm` s after ignition, kg: the propellant burns with the impulse. */
export function motorMassAt(m: RocketMotor, tm: number): number {
  return m.ignitionMass - (m.propellant * motorImpulseAt(m, tm)) / m.totalImpulse;
}

/**
 * The rocket in its launch tube: thrust along the tube until it has moved `travel` m (gravity
 * across the tube and the tube's friction neglected). Returns the exit time, speed and mass.
 */
function tubeExit(m: RocketMotor, travel: number): { time: number; speed: number; mass: number } {
  const h = 1e-5;
  let t = 0;
  let v = 0;
  let x = 0;
  while (x < travel && t < m.burnTime) {
    const a0 = motorThrustAt(m, t) / motorMassAt(m, t);
    const a1 = motorThrustAt(m, t + h) / motorMassAt(m, t + h);
    const v1 = v + 0.5 * (a0 + a1) * h;
    const dx = 0.5 * (v + v1) * h;
    if (x + dx >= travel) {
      // Interpolate the exit within the last small step.
      const f = (travel - x) / dx;
      t += f * h;
      v += f * (v1 - v);
      break;
    }
    x += dx;
    v = v1;
    t += h;
  }
  return { time: t, speed: v, mass: motorMassAt(m, t) };
}

// ---- specs ---------------------------------------------------------------------------------------

/** Breakpoints after release (s) of a spec's ballute and motor, ascending, positive only. */
function breakpoints(
  motor: RocketMotor | null,
  motorOffset: number,
  balluteStart: number,
  balluteFull: number,
  hasBallute: boolean,
): Float64Array {
  const list: number[] = [];
  if (hasBallute) list.push(balluteStart, balluteFull);
  if (motor) for (const t of motor.time) list.push(t - motorOffset);
  const out = list.filter((t) => t > 1e-9).sort((a, b) => a - b);
  return Float64Array.from(out);
}

function circleArea(diameter: number): number {
  return Math.PI * (diameter / 2) ** 2;
}

/** The free-flight spec of a weapon store (rocket pods: one of their rockets). */
function weaponSpec(type: StoreType, highDrag: boolean): StoreFlightSpec {
  const f = STORE_FLIGHT[type];
  if (!f) throw new Error(`no free-flight data for ${type}`);
  const data = STORES[type];
  let motor: RocketMotor | null = null;
  let motorOffset = 0;
  let mass = data.mass;
  if (f.launch === 'tube') {
    // One rocket of the pod: Mk 66 motor + this pod's warhead.
    motor = buildMotor(data.rocketMass ?? HYDRA70.motorMass + HYDRA70.m151Mass);
    const exit = tubeExit(motor, MK66.tubeTravel);
    motorOffset = exit.time;
    mass = exit.mass;
  }
  const balluteArea = highDrag ? BSU49.dragArea : 0;
  return {
    key: highDrag ? `${type}/HD` : type,
    mass,
    area: circleArea(f.referenceDiameter),
    cd: dragTable(f.drag, f.dragFactor),
    extraDragArea: 0,
    balluteArea,
    balluteStart: BSU49.openStart,
    balluteFull: BSU49.openFull,
    motor,
    motorOffset,
    breaks: breakpoints(motor, motorOffset, BSU49.openStart, BSU49.openFull, highDrag),
    weathercockTime: f.weathercockTime,
  };
}

/** Mean slope of the pylon bottoms, rad (nose down < 0): stores hang and leave along it. */
const PYLON_PITCH = (() => {
  let sum = 0;
  let n = 0;
  for (const p of A10_GEOMETRY.stationPitch) {
    if (p === null) continue;
    sum += p;
    n++;
  }
  return sum / n;
})();

/** Slope of one station's pylon bottom, rad. */
export function stationPitch(station: number): number {
  return A10_GEOMETRY.stationPitch[station] ?? PYLON_PITCH;
}

/** Speed a cartridge ejector gives a store of `mass` kg, m/s (constant ejector work). */
export function ejectionSpeed(mass: number): number {
  return Math.min(EJECTOR.maxVelocity, Math.sqrt((2 * EJECTOR.energy) / Math.max(mass, 1)));
}

/**
 * Ejection velocity of a store, body frame, m/s: an ejector pushes it along the pylon's downward
 * normal (down, and a little aft of a nose-down pylon); a rocket leaves its tube along the tube.
 */
export function ejectionVelocity(
  launch: 'ejector' | 'rail' | 'tube',
  speed: number,
  pitch: number,
  out: Vector3,
): Vector3 {
  if (launch === 'ejector')
    return out.set(0, -Math.cos(pitch), -Math.sin(pitch)).multiplyScalar(speed);
  if (launch === 'tube') return out.set(0, Math.sin(pitch), -Math.cos(pitch)).multiplyScalar(speed);
  return out.set(0, 0, 0);
}

// ---- the integrator ------------------------------------------------------------------------------

/**
 * What acts on a GUIDED body besides drag and gravity (the guided module's commands), held over
 * one step. The registered models pass none.
 */
export interface BodyForcing {
  /** Commanded acceleration, world m/s² (guidanceAccel). */
  accel: Vector3;
  /** The missile whose motor thrust the guided module gives (motorThrust), or null. */
  motorBody: StoreBody | null;
  /** Its mass, kg. */
  mass: number;
  /** Direction to push along when there is no relative wind (a launch from rest), world unit. */
  axis: Vector3;
}

/**
 * Scratch results of the hot path. Written in place, not returned: a double returned from a
 * function that is not inlined is boxed (allocated) by the engine. Initialised to non-integers so
 * their fields hold doubles from the start.
 */
const _air = { density: 1.5, sound: 340.5 };
/** Mass (kg) and thrust (N) of a motor at one instant. */
const _motor = { mass: 1.5, thrust: 0.5 };
/** Acceleration of one evaluation. */
const acc = { x: 0.5, y: 0.5, z: 0.5 };

/** Mass and thrust of a motor `tm` s after ignition (into _motor). */
function motorAt(m: RocketMotor, tm: number, burning: boolean): void {
  const t = m.time;
  if (!(tm > t[0])) {
    _motor.mass = m.ignitionMass;
    _motor.thrust = 0;
    return;
  }
  if (tm >= m.burnTime) {
    _motor.mass = m.ignitionMass - m.propellant;
    _motor.thrust = 0;
    return;
  }
  let i = 1;
  while (i < t.length - 1 && tm > t[i]) i++;
  const h = tm - t[i - 1];
  const f0 = m.thrust[i - 1];
  const slope = (m.thrust[i] - f0) / (t[i] - t[i - 1]);
  const impulse = m.impulse[i - 1] + f0 * h + 0.5 * slope * h * h;
  _motor.mass = m.ignitionMass - (m.propellant * impulse) / m.totalImpulse;
  _motor.thrust = burning ? f0 + slope * h : 0;
}

/**
 * The state one evaluation is made at, written by heun. Passed through these double fields, not
 * as arguments: V8 boxes a double argument of a call it does not inline, and `accelerate` is too
 * big to inline — as arguments the integrator allocated 80 B (bomb) to 96 B (rocket) per call;
 * this way, nothing.
 */
const _ev = { t: 0.5, y: 0.5, vx: 0.5, vy: 0.5, vz: 0.5, isa: 0.5 };

/**
 * Acceleration (into `acc`) at the state in _ev: time t after release, height y, velocity v, in
 * air moving with `wind`.
 */
function accelerate(
  spec: StoreFlightSpec,
  wind: Vector3,
  burning: boolean,
  forcing: BodyForcing | null,
): void {
  const t = _ev.t;
  const y = _ev.y;
  const isa = _ev.isa;
  const ax = _ev.vx - wind.x;
  const ay = _ev.vy - wind.y;
  const az = _ev.vz - wind.z;
  const speed = Math.sqrt(ax * ax + ay * ay + az * az);
  const motor = spec.motor;
  let mass = spec.mass;
  let thrust = 0;
  if (motor) {
    motorAt(motor, t + spec.motorOffset, burning);
    mass = _motor.mass;
    thrust = _motor.thrust;
  }
  if (forcing) {
    mass = forcing.mass;
    if (forcing.motorBody) thrust += motorThrust(forcing.motorBody, t);
  }
  let k = 0;
  if (speed > 0) {
    airAtHeight(y, isa, _air);
    // Cd at this Mach number (the uniform table, inlined).
    const table = spec.cd;
    const x = speed / _air.sound / FLIGHT_MACH_STEP;
    let cd: number;
    if (!(x > 0)) cd = table[0];
    else {
      const i = Math.floor(x);
      cd =
        i >= CD_POINTS - 1 ? table[CD_POINTS - 1] : table[i] + (table[i + 1] - table[i]) * (x - i);
    }
    if (burning && motor) cd *= motor.plumeDrag;
    let cda = cd * spec.area + spec.extraDragArea;
    // The ballute's drag area grows linearly as it fills.
    if (spec.balluteArea > 0 && t > spec.balluteStart) {
      cda +=
        t >= spec.balluteFull
          ? spec.balluteArea
          : (spec.balluteArea * (t - spec.balluteStart)) / (spec.balluteFull - spec.balluteStart);
    }
    k = (0.5 * _air.density * cda * speed) / mass;
  }
  let tx = 0;
  let ty = 0;
  let tz = 0;
  if (thrust !== 0) {
    if (speed > 1e-6) {
      const s = thrust / (mass * speed);
      tx = ax * s;
      ty = ay * s;
      tz = az * s;
    } else if (forcing) {
      const s = thrust / mass;
      tx = forcing.axis.x * s;
      ty = forcing.axis.y * s;
      tz = forcing.axis.z * s;
    }
  }
  acc.x = -k * ax + tx;
  acc.y = -k * ay + ty - G0;
  acc.z = -k * az + tz;
  if (forcing) {
    acc.x += forcing.accel.x;
    acc.y += forcing.accel.y;
    acc.z += forcing.accel.z;
  }
}

/** One Heun step of length h from time t after release (no breakpoint inside it). */
function heun(
  spec: StoreFlightSpec,
  pos: Vector3,
  vel: Vector3,
  wind: Vector3,
  t: number,
  h: number,
  isa: number,
  forcing: BodyForcing | null,
): void {
  // The piece lies wholly inside or outside the burn (burn-out is a breakpoint).
  const burning = spec.motor !== null && t + spec.motorOffset < spec.motor.burnTime - 1e-12;
  const vx0 = vel.x;
  const vy0 = vel.y;
  const vz0 = vel.z;
  const ev = _ev;
  ev.t = t;
  ev.y = pos.y;
  ev.vx = vx0;
  ev.vy = vy0;
  ev.vz = vz0;
  ev.isa = isa;
  accelerate(spec, wind, burning, forcing);
  const a0x = acc.x;
  const a0y = acc.y;
  const a0z = acc.z;
  ev.t = t + h;
  ev.y = pos.y + vy0 * h;
  ev.vx = vx0 + a0x * h;
  ev.vy = vy0 + a0y * h;
  ev.vz = vz0 + a0z * h;
  accelerate(spec, wind, burning, forcing);
  const hh = 0.5 * h;
  const vx1 = vx0 + (a0x + acc.x) * hh;
  const vy1 = vy0 + (a0y + acc.y) * hh;
  const vz1 = vz0 + (a0z + acc.z) * hh;
  pos.x += (vx0 + vx1) * hh;
  pos.y += (vy0 + vy1) * hh;
  pos.z += (vz0 + vz1) * hh;
  vel.x = vx1;
  vel.y = vy1;
  vel.z = vz1;
}

/** Breakpoints closer than this are the same instant, s. */
const BREAK_EPS = 1e-9;
/**
 * Longest Heun step while a motor burns, s: the rocket gains ≈700 m/s in a second through the
 * transonic drag rise, so a coarse predictor step is subdivided there (the live bodies' 1/120 s
 * steps are not affected); after burn-out the step is the caller's.
 */
const BURN_STEP = 1 / 60;

/**
 * Advance a store body by dt from t s after release: position and velocity (world) in place, in
 * air moving at `wind` (held over the interval), the ISA shifted by `isaDeviation` K. The
 * interval is split at the model's breakpoints. THE function both the live bodies and the
 * fire-control computer's registered models fly with. Allocation-free.
 */
export function integrateStore(
  spec: StoreFlightSpec,
  pos: Vector3,
  vel: Vector3,
  wind: Vector3,
  dt: number,
  t: number,
  isaDeviation = 0,
  forcing: BodyForcing | null = null,
): void {
  const end = t + dt;
  const breaks = spec.breaks;
  let i = 0;
  while (i < breaks.length && breaks[i] <= t + BREAK_EPS) i++;
  const burnEnd = spec.motor ? spec.motor.burnTime - spec.motorOffset : -Infinity;
  let tc = t;
  while (end - tc > BREAK_EPS) {
    let tn = end;
    if (i < breaks.length && breaks[i] < end - BREAK_EPS) tn = breaks[i++];
    // Within the burn: equal pieces of at most BURN_STEP.
    const n = tc < burnEnd - BREAK_EPS ? Math.ceil((tn - tc) / BURN_STEP - 1e-9) : 1;
    const h = (tn - tc) / n;
    for (let k = 0; k < n; k++) heun(spec, pos, vel, wind, tc + k * h, h, isaDeviation, forcing);
    tc = tn;
  }
}

/** Mass of a body flying `spec`, `t` s after release, kg. */
export function specMassAt(spec: StoreFlightSpec, t: number): number {
  return spec.motor ? motorMassAt(spec.motor, t + spec.motorOffset) : spec.mass;
}

/** Motor burn time left `t` s after release, s (0 without a motor). */
export function specBurnLeft(spec: StoreFlightSpec, t: number): number {
  return spec.motor ? Math.max(0, spec.motor.burnTime - spec.motorOffset - t) : 0;
}

// ---- registered models ---------------------------------------------------------------------------

/** A store's model as the fire-control computer flies it (PLAN §6.1 rule 2). */
export interface StoreModel extends StoreBallistics {
  readonly spec: StoreFlightSpec;
  /** How the store leaves its station. */
  readonly launch: 'ejector' | 'rail' | 'tube';
  /** ISA deviation the computer flies with, K (stepStores keeps it equal to the world's). */
  isaDeviation: number;
}

function makeModel(type: StoreType, highDrag: boolean): StoreModel {
  const spec = weaponSpec(type, highDrag);
  const f = STORE_FLIGHT[type]!;
  const speed =
    f.launch === 'ejector'
      ? ejectionSpeed(spec.mass)
      : f.launch === 'tube'
        ? tubeExit(spec.motor!, MK66.tubeTravel).speed
        : 0;
  const e = ejectionVelocity(f.launch, speed, PYLON_PITCH, new Vector3());
  const ejection: Vec3Like = { x: e.x, y: e.y, z: e.z };
  return {
    spec,
    launch: f.launch,
    ejection,
    dt: f.launch === 'tube' ? STORE_BODY.predictorStepRocket : STORE_BODY.predictorStepBomb,
    isaDeviation: 0,
    integrate(pos: Vector3, vel: Vector3, wind: Vector3, dt: number, t: number): void {
      integrateStore(this.spec, pos, vel, wind, dt, t, this.isaDeviation);
    },
  };
}

/**
 * Keys the weapons module registers with the fire-control computer: every unguided store, the
 * Mk 82 AIR's high-drag configuration, each rocket pod (one of its rockets), and the GBU-12 and
 * CBU-97 airframes (ballistic: a CCRP release is computed for the unguided fall).
 */
export const REGISTERED_STORE_KEYS: readonly string[] = [
  'MK-82',
  'MK-82AIR',
  'MK-82AIR/HD',
  'GBU-12',
  'CBU-97',
  'LAU-131-M151',
  'LAU-131-M156',
  'LAU-68-M151',
  'LAU-68-M156',
];

/** Every model by key: the registered ones and the Maverick airframes (flown, not predicted). */
const MODELS = new Map<string, StoreModel>();
/** The same models as a list (walked every step without an iterator). */
const MODEL_LIST: StoreModel[] = [];
for (const key of REGISTERED_STORE_KEYS) {
  const hd = key.endsWith('/HD');
  const type = (hd ? key.slice(0, -3) : key) as StoreType;
  MODELS.set(key, makeModel(type, hd));
}
for (const type of ['AGM-65D', 'AGM-65H', 'AGM-65G', 'AGM-65K'] as const) {
  MODELS.set(type, makeModel(type, false));
}
MODELS.forEach((m) => MODEL_LIST.push(m));

/** The model of a key (a store type or `${store}/HD`), or null. */
export function storeModel(key: string): StoreModel | null {
  return MODELS.get(key) ?? null;
}

/**
 * The model a release flies with: the high-drag configuration when asked and the store has one
 * (the Mk 82 AIR), otherwise the store's own; null for a store that cannot fly free.
 */
export function modelFor(store: StoreType, highDrag: boolean): StoreModel | null {
  if (highDrag) {
    const hd = MODELS.get(`${store}/HD`);
    if (hd) return hd;
  }
  return MODELS.get(store) ?? null;
}

/** Keep the registered models' atmosphere equal to the world's (the computer's air data). */
export function syncModelAtmosphere(isaDeviation: number): void {
  for (let i = 0; i < MODEL_LIST.length; i++) MODEL_LIST[i].isaDeviation = isaDeviation;
}

/**
 * Register the unguided stores' models with the fire-control computer (avionics
 * registerStoreBallistics). `replace` false keeps a model already registered under a key (a
 * test's own model); the call at module load replaces.
 */
export function registerStoreModels(replace = false): void {
  for (const key of REGISTERED_STORE_KEYS) {
    if (!replace && storeBallistics(key)) continue;
    registerStoreBallistics(key, MODELS.get(key)!);
  }
}

// At module load (ARCHITECTURE §12.2). When an import cycle evaluates this module before the
// avionics registry exists, the call throws; createStoresState then registers (every sim).
try {
  registerStoreModels(true);
} catch {
  // registered by createStoresState
}

// ---- jettisoned assemblies -----------------------------------------------------------------------

/**
 * The free-flight spec of a jettisoned station: the rack, launcher or pod with what it still
 * carries, falling as one tumbling body (weapons with their own drag, the rest as tumbling
 * cylinders). Allocates (once per jettison).
 */
export function assemblySpec(items: readonly StoreType[], mass: number): StoreFlightSpec {
  const cd = new Float64Array(CD_POINTS);
  let tumble = 0;
  for (const type of items) {
    const f = STORE_FLIGHT[type];
    const data = STORES[type];
    if (f && data.kind !== 'rocketPod') {
      const area = circleArea(f.referenceDiameter);
      for (let i = 0; i < CD_POINTS; i++) {
        cd[i] += area * f.dragFactor * curveAt(f.drag, i * FLIGHT_MACH_STEP);
      }
    } else {
      tumble += TUMBLE.broadsideCd * TUMBLE.meanShare * data.length * data.diameter;
    }
  }
  return {
    key: 'JETTISON',
    mass,
    area: 1,
    cd,
    extraDragArea: tumble,
    balluteArea: 0,
    balluteStart: 0,
    balluteFull: 0,
    motor: null,
    motorOffset: 0,
    breaks: new Float64Array(0),
    weathercockTime: 1,
  };
}
