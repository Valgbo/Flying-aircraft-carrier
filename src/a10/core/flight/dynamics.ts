/**
 * Six-degree-of-freedom rigid body, integrated with classical fourth-order Runge–Kutta.
 *
 * State (14 numbers): position and velocity of the body ORIGIN (the reference point) in the
 * world frame, the body→world quaternion, the body angular velocity (contract axes: +X right,
 * +Y up, -Z nose) and the wing-flow attachment x of the dynamic-stall model.
 *
 * Equations (body frame unless stated):
 *   m · a_cg = R·F + m·g                      (F: aero + thrust + external + buffet)
 *   a_origin = a_cg − ω̇ × c − ω × (ω × c)      (c = CG offset from the origin; the structure is
 *                                              continuous when the CG jumps at store release)
 *   I·ω̇ = M_cg − ω × (I·ω + h)                  (full tensor with the roll–yaw product, engine
 *                                              spool momentum h along the nose axis)
 *   q̇ = ½ q ⊗ ω,    ẋ = (x0(α − τ2·α̇·c̄/2V) − x) / (τ1·c̄/2V)
 *
 * Aerodynamic forces act at the reference point; their moment about the CG is
 * M_ref − c × F. Thrust acts on each engine's line. External forces (gun recoil) act at the CG
 * with their own moment. Controls, thrust, wind and external forces are held over the step
 * (zero-order hold). No allocation: module-level scratch only.
 */
import { A10, A10_AERO, TF34 } from '../../data/aircraft';
import { G0 } from '../constants';
import {
  computeAero,
  createAeroCoefficients,
  type AeroCoefficients,
  type AeroControls,
  type AeroFlow,
} from './aero';

export const STATE_SIZE = 14;

/** Everything the derivative needs that is constant over one step. */
export interface StepContext {
  mass: number;
  /** CG offset from the body origin (contract body axes), m. */
  cgX: number;
  cgY: number;
  cgZ: number;
  /** Inertia tensor about the CG in CONTRACT axes: XX pitch, YY yaw, ZZ roll, YZ product. */
  iXX: number;
  iYY: number;
  iZZ: number;
  iYZ: number;
  /** Inverse of the yaw–roll block. */
  invYY: number;
  invYZ: number;
  invZZ: number;
  rho: number;
  speedOfSound: number;
  /** Dynamic viscosity of the air, Pa·s. */
  viscosity: number;
  /** Air motion at the aircraft (mean wind + turbulence), world m/s. */
  windX: number;
  windY: number;
  windZ: number;
  /** Total thrust force (body) and its moment about the origin. */
  thrustFx: number;
  thrustFy: number;
  thrustFz: number;
  thrustMx: number;
  thrustMy: number;
  thrustMz: number;
  /** External force (at the CG) and moment (about the CG), body. */
  extFx: number;
  extFy: number;
  extFz: number;
  extMx: number;
  extMy: number;
  extMz: number;
  /** Random buffet force along body +Y, N. */
  buffetFy: number;
  /** Engine spool angular momentum, N·m·s, along the nose axis (−Z). */
  spool: number;
  /** Rate of change of α from the previous steps, rad/s. */
  alphaDot: number;
  controls: AeroControls;
}

export function createStepContext(): StepContext {
  return {
    mass: 1,
    cgX: 0,
    cgY: 0,
    cgZ: 0,
    iXX: 1,
    iYY: 1,
    iZZ: 1,
    iYZ: 0,
    invYY: 1,
    invYZ: 0,
    invZZ: 1,
    rho: 1.225,
    speedOfSound: 340,
    viscosity: 1.79e-5,
    windX: 0,
    windY: 0,
    windZ: 0,
    thrustFx: 0,
    thrustFy: 0,
    thrustFz: 0,
    thrustMx: 0,
    thrustMy: 0,
    thrustMz: 0,
    extFx: 0,
    extFy: 0,
    extFz: 0,
    extMx: 0,
    extMy: 0,
    extMz: 0,
    buffetFy: 0,
    spool: 0,
    alphaDot: 0,
    controls: {
      flapsDeg: 0,
      slats: 0,
      speedBrake: 0,
      gear: 0,
      elevator: 0,
      aileron: 0,
      rudder: 0,
      asymmetry: 0,
      storesDragArea: 0,
    },
  };
}

/** What one derivative evaluation found, for the derived air data. */
export interface FlowRecord {
  speed: number;
  alpha: number;
  beta: number;
  mach: number;
  dynamicPressure: number;
  /** Air velocity in body (contract) axes, m/s. */
  airX: number;
  airY: number;
  airZ: number;
  /** Specific force (non-gravitational acceleration of the CG), body, m/s². */
  specificX: number;
  specificY: number;
  specificZ: number;
  coefficients: AeroCoefficients;
}

export function createFlowRecord(): FlowRecord {
  return {
    speed: 0,
    alpha: 0,
    beta: 0,
    mach: 0,
    dynamicPressure: 0,
    airX: 0,
    airY: 0,
    airZ: 0,
    specificX: 0,
    specificY: 0,
    specificZ: 0,
    coefficients: createAeroCoefficients(),
  };
}

const S = A10.wingArea;
const B = A10.span;
const C = A10.mac;

const _flow: AeroFlow = {
  speed: 0,
  alpha: 0,
  beta: 0,
  mach: 0,
  p: 0,
  q: 0,
  r: 0,
  alphaDot: 0,
  reynolds: 1e7,
  attachment: 1,
};
const _coef = createAeroCoefficients();

/**
 * State derivative. Writes d = ds/dt. When `record` is given it receives the flow and the
 * specific force at this state.
 */
export function derivative(
  s: Float64Array,
  d: Float64Array,
  ctx: StepContext,
  record?: FlowRecord,
): void {
  let qx = s[6];
  let qy = s[7];
  let qz = s[8];
  let qw = s[9];
  const qn = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
  qx *= qn;
  qy *= qn;
  qz *= qn;
  qw *= qn;
  // Body → world rotation matrix.
  const r00 = 1 - 2 * (qy * qy + qz * qz);
  const r01 = 2 * (qx * qy - qw * qz);
  const r02 = 2 * (qx * qz + qw * qy);
  const r10 = 2 * (qx * qy + qw * qz);
  const r11 = 1 - 2 * (qx * qx + qz * qz);
  const r12 = 2 * (qy * qz - qw * qx);
  const r20 = 2 * (qx * qz - qw * qy);
  const r21 = 2 * (qy * qz + qw * qx);
  const r22 = 1 - 2 * (qx * qx + qy * qy);

  // Air-relative velocity in the body frame.
  const awx = s[3] - ctx.windX;
  const awy = s[4] - ctx.windY;
  const awz = s[5] - ctx.windZ;
  const bx = r00 * awx + r10 * awy + r20 * awz;
  const by = r01 * awx + r11 * awy + r21 * awz;
  const bz = r02 * awx + r12 * awy + r22 * awz;
  // Aviation components: u forward, v right, w down.
  const u = -bz;
  const v = bx;
  const w = -by;
  const speed = Math.sqrt(u * u + v * v + w * w);
  const vs = Math.max(speed, 1);
  const alpha = Math.atan2(w, u);
  const beta = Math.asin(Math.max(-1, Math.min(1, v / vs)));

  const wx = s[10];
  const wy = s[11];
  const wz = s[12];

  _flow.speed = vs;
  _flow.alpha = alpha;
  _flow.beta = beta;
  _flow.mach = speed / ctx.speedOfSound;
  _flow.p = -wz;
  _flow.q = wx;
  _flow.r = -wy;
  _flow.alphaDot = ctx.alphaDot;
  _flow.reynolds = (ctx.rho * vs * C) / ctx.viscosity;
  _flow.attachment = s[13];
  const coef = computeAero(_flow, ctx.controls, record ? record.coefficients : _coef);

  // Wind-axis forces → aviation body axes → contract body axes.
  const qbar = 0.5 * ctx.rho * speed * speed;
  const qS = qbar * S;
  const lift = qS * coef.cl;
  const drag = qS * coef.cd;
  const side = qS * coef.cy;
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  const cb = Math.cos(beta);
  const sb = Math.sin(beta);
  const xa = -drag * ca * cb - side * ca * sb + lift * sa;
  const ya = -drag * sb + side * cb;
  const za = -drag * sa * cb - side * sa * sb - lift * ca;
  const fax = ya;
  const fay = -za;
  const faz = -xa;

  // Forces applied at the origin or on the engine lines (moment transferred to the CG below).
  const Fx = fax + ctx.thrustFx;
  const Fy = fay + ctx.thrustFy + ctx.buffetFy;
  const Fz = faz + ctx.thrustFz;
  const fx = Fx + ctx.extFx;
  const fy = Fy + ctx.extFy;
  const fz = Fz + ctx.extFz;

  // Moments about the CG (contract axes): pitch → +X, yaw (nose right) → −Y, roll (right) → −Z.
  const cx = ctx.cgX;
  const cy = ctx.cgY;
  const cz = ctx.cgZ;
  let mx = qS * C * coef.cPitch + ctx.thrustMx + ctx.extMx - (cy * Fz - cz * Fy);
  let my = -qS * B * coef.cYaw + ctx.thrustMy + ctx.extMy - (cz * Fx - cx * Fz);
  let mz = -qS * B * coef.cRoll + ctx.thrustMz + ctx.extMz - (cx * Fy - cy * Fx);

  // Euler and gyroscopic terms: M − ω × (I·ω + h), h along −Z.
  const hx = ctx.iXX * wx;
  const hy = ctx.iYY * wy + ctx.iYZ * wz;
  const hz = ctx.iYZ * wy + ctx.iZZ * wz - ctx.spool;
  mx -= wy * hz - wz * hy;
  my -= wz * hx - wx * hz;
  mz -= wx * hy - wy * hx;
  const dwx = mx / ctx.iXX;
  const dwy = ctx.invYY * my + ctx.invYZ * mz;
  const dwz = ctx.invYZ * my + ctx.invZZ * mz;

  // Translational: CG acceleration, then the origin's (rigid-body offset terms).
  const im = 1 / ctx.mass;
  const ox = wy * cz - wz * cy;
  const oy = wz * cx - wx * cz;
  const oz = wx * cy - wy * cx;
  const tx = fx * im - (dwy * cz - dwz * cy) - (wy * oz - wz * oy);
  const ty = fy * im - (dwz * cx - dwx * cz) - (wz * ox - wx * oz);
  const tz = fz * im - (dwx * cy - dwy * cx) - (wx * oy - wy * ox);

  d[0] = s[3];
  d[1] = s[4];
  d[2] = s[5];
  d[3] = r00 * tx + r01 * ty + r02 * tz;
  d[4] = r10 * tx + r11 * ty + r12 * tz - G0;
  d[5] = r20 * tx + r21 * ty + r22 * tz;
  // Quaternion kinematics with body rates: q̇ = ½ q ⊗ (ω, 0).
  d[6] = 0.5 * (qw * wx + qy * wz - qz * wy);
  d[7] = 0.5 * (qw * wy + qz * wx - qx * wz);
  d[8] = 0.5 * (qw * wz + qx * wy - qy * wx);
  d[9] = -0.5 * (qx * wx + qy * wy + qz * wz);
  d[10] = dwx;
  d[11] = dwy;
  d[12] = dwz;
  const tau1 = (A10_AERO.separationTau1 * C) / (2 * vs);
  d[13] = (coef.attachmentTarget - s[13]) / tau1;

  if (record) {
    record.speed = speed;
    record.alpha = alpha;
    record.beta = beta;
    record.mach = speed / ctx.speedOfSound;
    record.dynamicPressure = qbar;
    record.airX = bx;
    record.airY = by;
    record.airZ = bz;
    record.specificX = fx * im;
    record.specificY = fy * im;
    record.specificZ = fz * im;
  }
}

const _k1 = new Float64Array(STATE_SIZE);
const _k2 = new Float64Array(STATE_SIZE);
const _k3 = new Float64Array(STATE_SIZE);
const _k4 = new Float64Array(STATE_SIZE);
const _tmp = new Float64Array(STATE_SIZE);

/** One classical RK4 step of `s` (in place), then renormalise the quaternion. */
export function integrateRk4(s: Float64Array, dt: number, ctx: StepContext): void {
  const n = STATE_SIZE;
  derivative(s, _k1, ctx);
  for (let i = 0; i < n; i++) _tmp[i] = s[i] + 0.5 * dt * _k1[i];
  derivative(_tmp, _k2, ctx);
  for (let i = 0; i < n; i++) _tmp[i] = s[i] + 0.5 * dt * _k2[i];
  derivative(_tmp, _k3, ctx);
  for (let i = 0; i < n; i++) _tmp[i] = s[i] + dt * _k3[i];
  derivative(_tmp, _k4, ctx);
  const h = dt / 6;
  for (let i = 0; i < n; i++) s[i] += h * (_k1[i] + 2 * _k2[i] + 2 * _k3[i] + _k4[i]);
  const qn = 1 / Math.sqrt(s[6] * s[6] + s[7] * s[7] + s[8] * s[8] + s[9] * s[9]);
  s[6] *= qn;
  s[7] *= qn;
  s[8] *= qn;
  s[9] *= qn;
  s[13] = Math.min(1, Math.max(0, s[13]));
}

/** Thrust line of the left engine (the right one mirrors it in X): unit direction, body. */
const THRUST_DIR_Y = Math.sin(TF34.thrustPitch);
const THRUST_DIR_Z = -Math.cos(TF34.thrustPitch);

/**
 * Fill the thrust force and its moment about the origin from the two engines' thrust.
 * Engine 0 is the left engine (−X).
 */
export function setThrust(ctx: StepContext, leftThrust: number, rightThrust: number): void {
  const p = TF34.position;
  const total = leftThrust + rightThrust;
  ctx.thrustFx = 0;
  ctx.thrustFy = total * THRUST_DIR_Y;
  ctx.thrustFz = total * THRUST_DIR_Z;
  // r × F for each engine at (±|x|, y, z) with F = T·(0, dy, dz).
  const ex = Math.abs(p.x);
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (let i = 0; i < 2; i++) {
    const t = i === 0 ? leftThrust : rightThrust;
    const rx = i === 0 ? -ex : ex;
    const fy = t * THRUST_DIR_Y;
    const fz = t * THRUST_DIR_Z;
    mx += p.y * fz - p.z * fy;
    my += -rx * fz;
    mz += rx * fy;
  }
  ctx.thrustMx = mx;
  ctx.thrustMy = my;
  ctx.thrustMz = mz;
}

/** Fill the inertia entries of the context from aviation-axis inertia. */
export function setInertia(
  ctx: StepContext,
  inertia: { xx: number; yy: number; zz: number; xz: number },
): void {
  // Contract axes: X = pitch (aviation y), Y = yaw (−aviation z), Z = roll (−aviation x).
  ctx.iXX = inertia.yy;
  ctx.iYY = inertia.zz;
  ctx.iZZ = inertia.xx;
  ctx.iYZ = -inertia.xz;
  const det = ctx.iYY * ctx.iZZ - ctx.iYZ * ctx.iYZ;
  ctx.invYY = ctx.iZZ / det;
  ctx.invYZ = -ctx.iYZ / det;
  ctx.invZZ = ctx.iYY / det;
}
