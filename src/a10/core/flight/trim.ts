/**
 * Trim solver: steady straight flight at the present position, true airspeed and track.
 *
 * Newton iteration on (α, elevator, aileron, rudder) with a finite-difference Jacobian so that
 * the acceleration normal to the flight path and the three angular accelerations vanish, using
 * the very same derivative function the integrator flies. Sideslip is zero and the wings are
 * level; the engines are settled at their levers. The solution is then written to the aircraft:
 * attitude, velocity, surfaces and the trim positions that hold those surfaces with the stick
 * neutral (within the trim authority).
 *
 * Used for the air start (a trimmed aircraft at 250 kn) and by tests and tools. Not a hot path.
 */
import { A10, A10_AERO, A10_FCS } from '../../data/aircraft';
import { quaternionFromAttitude } from '../frames';
import type { Sim } from '../types';
import { speedOfSoundAt, windAt } from '../world';
import { stallAlphaFor, staticAttachment } from './aero';
import { derivative } from './dynamics';
import { settleEngine } from './engine';
import { updateMass } from './mass';
import { engineConditions, fillContext, packState, refreshDerived, scratch } from './step';
import { clamp } from './util';

const DEG = Math.PI / 180;

export interface TrimResult {
  converged: boolean;
  iterations: number;
  /** Angle of attack, rad. */
  alpha: number;
  /** Surface deflections, rad. */
  elevator: number;
  aileron: number;
  rudder: number;
  /** Acceleration along the flight path at the solution, m/s² (thrust minus drag). */
  alongPath: number;
}

const _x = new Float64Array(4);
const _r = new Float64Array(4);
const _r2 = new Float64Array(4);
const _jac = new Float64Array(16);
const _dx = new Float64Array(4);

interface TrimSetup {
  speed: number;
  track: number;
  gamma: number;
}
const setup: TrimSetup = { speed: 0, track: 0, gamma: 0 };

/** Put the aircraft in the trim candidate `x` and evaluate the residuals into `r`. */
function evaluate(sim: Sim, x: Float64Array, r: Float64Array): number {
  const ac = sim.aircraft;
  const { speed, track, gamma } = setup;
  quaternionFromAttitude(track, gamma + x[0], 0, ac.orientation);
  const hx = Math.sin(track);
  const hz = -Math.cos(track);
  const cg = Math.cos(gamma);
  const sg = Math.sin(gamma);
  ac.velocity.set(speed * hx * cg + ac.wind.x, speed * sg + ac.wind.y, speed * hz * cg + ac.wind.z);
  ac.angularVelocity.set(0, 0, 0);
  const ctx = scratch.ctx;
  fillContext(sim, ctx);
  ctx.alphaDot = 0;
  ctx.controls.elevator = x[1];
  ctx.controls.aileron = x[2];
  ctx.controls.rudder = x[3];
  const mach = speed / ctx.speedOfSound;
  const reynolds = (ctx.rho * speed * A10.mac) / ctx.viscosity;
  ac.fcs.flowAttachment = staticAttachment(
    x[0],
    stallAlphaFor(ctx.controls.flapsDeg, ctx.controls.slats, mach, reynolds),
  );
  const s = scratch.state;
  const d = scratch.deriv;
  packState(ac, s);
  derivative(s, d, ctx);
  // Normal to the path in the vertical plane, and along it.
  r[0] = d[4] * cg - (d[3] * hx + d[5] * hz) * sg;
  r[1] = d[10];
  r[2] = d[12];
  r[3] = d[11];
  return (d[3] * hx + d[5] * hz) * cg + d[4] * sg;
}

/** Solve the 4×4 system J·dx = −r (Gaussian elimination with partial pivoting). */
function solve4(jac: Float64Array, r: Float64Array, out: Float64Array): boolean {
  const a = jac;
  for (let i = 0; i < 4; i++) out[i] = -r[i];
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let row = col + 1; row < 4; row++) {
      if (Math.abs(a[row * 4 + col]) > Math.abs(a[piv * 4 + col])) piv = row;
    }
    if (Math.abs(a[piv * 4 + col]) < 1e-12) return false;
    if (piv !== col) {
      for (let k = 0; k < 4; k++) {
        const t = a[col * 4 + k];
        a[col * 4 + k] = a[piv * 4 + k];
        a[piv * 4 + k] = t;
      }
      const t = out[col];
      out[col] = out[piv];
      out[piv] = t;
    }
    for (let row = col + 1; row < 4; row++) {
      const f = a[row * 4 + col] / a[col * 4 + col];
      for (let k = col; k < 4; k++) a[row * 4 + k] -= f * a[col * 4 + k];
      out[row] -= f * out[col];
    }
  }
  for (let row = 3; row >= 0; row--) {
    let sum = out[row];
    for (let k = row + 1; k < 4; k++) sum -= a[row * 4 + k] * out[k];
    out[row] = sum / a[row * 4 + row];
  }
  return true;
}

/**
 * Trim for steady straight flight along the present track at the present true airspeed,
 * climbing at `gamma` (rad, default level). Engines are settled at their present levers.
 */
export function trimAircraft(sim: Sim, gamma = 0): TrimResult {
  const ac = sim.aircraft;
  updateMass(sim);
  windAt(sim.world, ac.position, ac.wind);
  const air = Math.hypot(
    ac.velocity.x - ac.wind.x,
    ac.velocity.y - ac.wind.y,
    ac.velocity.z - ac.wind.z,
  );
  setup.speed = Math.max(40, air > 1 ? air : ac.tas);
  const gs = Math.hypot(ac.velocity.x, ac.velocity.z);
  setup.track = gs > 1 ? Math.atan2(ac.velocity.x, -ac.velocity.z) : ac.heading;
  setup.gamma = gamma;

  const isa = sim.world.isaDeviation;
  const alt = ac.position.y;
  const cond = engineConditions(alt, setup.speed / speedOfSoundAt(alt, isa), isa, scratch.cond);
  for (const e of ac.engines) settleEngine(e, cond);

  _x[0] = 2 * DEG;
  _x[1] = 0;
  _x[2] = 0;
  _x[3] = 0;
  let converged = false;
  let it = 0;
  for (; it < 30; it++) {
    evaluate(sim, _x, _r);
    if (
      Math.abs(_r[0]) < 1e-4 &&
      Math.abs(_r[1]) < 1e-6 &&
      Math.abs(_r[2]) < 1e-6 &&
      Math.abs(_r[3]) < 1e-6
    ) {
      converged = true;
      break;
    }
    for (let j = 0; j < 4; j++) {
      const h = 1e-5;
      const keep = _x[j];
      _x[j] = keep + h;
      evaluate(sim, _x, _r2);
      _x[j] = keep;
      for (let i = 0; i < 4; i++) _jac[i * 4 + j] = (_r2[i] - _r[i]) / h;
    }
    if (!solve4(_jac, _r, _dx)) break;
    // Damped step within physical bounds.
    _x[0] = clamp(_x[0] + clamp(_dx[0], -3 * DEG, 3 * DEG), -15 * DEG, 25 * DEG);
    _x[1] = clamp(_x[1] + _dx[1], -A10_AERO.elevatorMax, A10_AERO.elevatorMax);
    _x[2] = clamp(_x[2] + _dx[2], -A10_AERO.aileronMax, A10_AERO.aileronMax);
    _x[3] = clamp(_x[3] + _dx[3], -A10_AERO.rudderMax, A10_AERO.rudderMax);
  }
  const alongPath = evaluate(sim, _x, _r);

  // Write the solution: surfaces, trim, filters.
  const s = ac.surfaces;
  const f = ac.fcs;
  s.elevator = clamp(_x[1] / A10_AERO.elevatorMax, -1, 1);
  s.aileron = clamp(_x[2] / A10_AERO.aileronMax, -1, 1);
  s.rudder = clamp(_x[3] / A10_AERO.rudderMax, -1, 1);
  ac.trim.pitch = clamp(s.elevator / A10_FCS.pitchTrimAuthority, -1, 1);
  ac.trim.roll = clamp(s.aileron / A10_FCS.rollTrimAuthority, -1, 1);
  ac.trim.yaw = clamp(s.rudder / A10_FCS.yawTrimAuthority, -1, 1);
  f.elevatorCmd = s.elevator;
  f.aileronCmd = s.aileron;
  f.rudderCmd = s.rudder;
  f.pitchWashout = 0;
  f.yawWashout = 0;
  f.alphaRate = 0;
  f.trimPending = false;
  ac.prevPosition.copy(ac.position);
  ac.prevVelocity.copy(ac.velocity);
  ac.prevOrientation.copy(ac.orientation);
  const ctx = scratch.ctx;
  fillContext(sim, ctx);
  refreshDerived(sim, ctx, 0);
  return {
    converged,
    iterations: it,
    alpha: _x[0],
    elevator: _x[1],
    aileron: _x[2],
    rudder: _x[3],
    alongPath,
  };
}

/**
 * The throttle lever (both engines) that holds the present true airspeed in steady flight at
 * flight-path angle `gamma`, by bisection on the trimmed acceleration along the path. Leaves
 * the aircraft trimmed with its engines settled at that lever (callers set sim.input.throttle
 * to it). Returns 1 when even MAX cannot hold the speed, 0 when idle is too much.
 */
export function levelFlightThrottle(sim: Sim, gamma = 0): number {
  const ac = sim.aircraft;
  const along = (lever: number) => {
    ac.engines[0].lever = lever;
    ac.engines[1].lever = lever;
    return trimAircraft(sim, gamma).alongPath;
  };
  if (along(1) < 0) return 1;
  if (along(0) > 0) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (along(mid) > 0) hi = mid;
    else lo = mid;
  }
  const lever = (lo + hi) / 2;
  along(lever);
  return lever;
}

/**
 * The first trim of a new flight: draw this airframe's asymmetry and trim the air start along
 * the flight path it was created on (level, or the AirStart's climb/dive angle).
 */
export function startTrim(sim: Sim): void {
  const ac = sim.aircraft;
  const f = ac.fcs;
  f.trimPending = false;
  f.asymmetry = sim.rng.air.range(-1, 1);
  const v = ac.velocity;
  trimAircraft(sim, Math.atan2(v.y, Math.hypot(v.x, v.z)));
}
