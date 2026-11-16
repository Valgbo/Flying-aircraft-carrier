/**
 * A-10C aerodynamic coefficients (data: A10_AERO in data/aircraft.ts).
 *
 * Lift, drag and pitching moment blend two flow states with the Goman–Khrabrov separation
 * variable x (1 = attached, 0 = fully separated):
 *
 *   C = x · C_attached(α) + (1 − x) · C_separated(α)
 *
 * The attached branch is the classic linear polar (DATCOM lift slope with Mach, parabolic
 * induced drag). The separated branch is a 3-D plate whose normal force is
 * CN = CD90·sin α plus a bounded Viterna residual-circulation term, so lift falls gently after
 * the stall and drag grows toward CD90 at 90°. In steady flight x equals its static value
 * x0(α) (a sigmoid around the stall angle); in manoeuvres x lags x0, which gives the lift
 * overshoot of a quick pull and the late re-attachment of a stall recovery (hysteresis).
 *
 * Lateral–directional derivatives are linear in β, p̂, r̂ and the controls, with the stalled
 * wing losing roll damping and dihedral effect (wing-drop tendency) and a small per-flight
 * airframe asymmetry deciding which wing drops first.
 *
 * Conventions: AVIATION body axes (x forward, y right, z down); α, β in rad; moments about the
 * reference point (body origin); control deflections in rad with elevator + = trailing edge
 * up, aileron + = roll right, rudder + = nose right. Pure functions; no allocation.
 */
import { A10, A10_AERO as A } from '../../data/aircraft';

const ASPECT = (A10.span * A10.span) / A10.wingArea;
/** Lock's drag-rise law: the critical Mach lies (0.1 / 80)^(1/3) below drag divergence. */
const CRITICAL_BELOW_DIVERGENCE = Math.cbrt(0.1 / 80);
const SPEED_BRAKE_GAIN_X = [0, 0.4, 0.7, 1.0];

/** Configuration and control state that the coefficients depend on. */
export interface AeroControls {
  /** Flap angle, degrees. */
  flapsDeg: number;
  /** Slat extension 0..1. */
  slats: number;
  /** Speed brake opening 0..1. */
  speedBrake: number;
  /** Gear position 0..1. */
  gear: number;
  /** Surface deflections, rad. */
  elevator: number;
  aileron: number;
  rudder: number;
  /** Airframe asymmetry of this flight, -1..1. */
  asymmetry: number;
  /** Drag area of the external stores (Σ CD·A from the weapons module), m². */
  storesDragArea: number;
}

/** Flow state the coefficients depend on. */
export interface AeroFlow {
  /** True airspeed, m/s (> 0). */
  speed: number;
  alpha: number;
  beta: number;
  mach: number;
  /** Aviation body rates, rad/s: roll (+ right wing down), pitch (+ nose up), yaw (+ nose right). */
  p: number;
  q: number;
  r: number;
  /** Rate of change of α, rad/s. */
  alphaDot: number;
  /** Reynolds number on the mean aerodynamic chord. */
  reynolds: number;
  /** Flow attachment 0..1. */
  attachment: number;
}

/** Coefficients: CL, CD, CY in wind axes; Cl, Cm, Cn about the body axes at the reference point. */
export interface AeroCoefficients {
  cl: number;
  cd: number;
  cy: number;
  cRoll: number;
  cPitch: number;
  cYaw: number;
  /** Attached-flow lift (for the induced-drag and Clβ terms). */
  clAttached: number;
  /** Static stall angle for this configuration and Mach, rad. */
  alphaStall: number;
  /** Static separation target x0 at the lag-corrected angle of attack. */
  attachmentTarget: number;
}

export function createAeroCoefficients(): AeroCoefficients {
  return {
    cl: 0,
    cd: 0,
    cy: 0,
    cRoll: 0,
    cPitch: 0,
    cYaw: 0,
    clAttached: 0,
    alphaStall: A.alphaStall,
    attachmentTarget: 1,
  };
}

/** DATCOM lift-curve slope of a straight wing at Mach M (per rad), for the Mach scaling. */
function datcomSlope(mach: number): number {
  const m = Math.min(mach, 0.95);
  const b2 = 1 - m * m;
  const k = (ASPECT * ASPECT * b2) / (A.datcomEta * A.datcomEta);
  return (2 * Math.PI * ASPECT) / (2 + Math.sqrt(4 + k));
}
const DATCOM_0 = datcomSlope(0);

/** Lift-slope multiplier for compressibility (1 at low Mach). */
export function machLiftFactor(mach: number): number {
  return datcomSlope(mach) / DATCOM_0;
}

/**
 * Static stall angle (half the flow separated) for a configuration, rad: slats and flaps,
 * compressibility (earlier separation above `stallMachOnset`) and Reynolds number (later
 * separation at higher Re).
 */
export function stallAlphaFor(
  flapsDeg: number,
  slats: number,
  mach: number,
  reynolds: number = A.reynoldsReference,
): number {
  const re = Math.log10(Math.max(1e5, reynolds) / A.reynoldsReference) * A.stallReynoldsSlope;
  return (
    A.alphaStall +
    A.slatAlphaGain * slats +
    A.flapAlphaStall * flapsDeg -
    A.stallMachSlope * Math.max(0, mach - A.stallMachOnset) +
    Math.max(-A.stallReynoldsLimit, Math.min(A.stallReynoldsLimit, re))
  );
}

/** Dynamic viscosity of air (Sutherland), Pa·s. */
export function airViscosity(temperature: number): number {
  return (1.458e-6 * Math.pow(temperature, 1.5)) / (temperature + 110.4);
}

/** Static attachment x0(α): logistic around the positive and negative stall angles. */
export function staticAttachment(alpha: number, alphaStall: number): number {
  const w = A.stallWidth;
  const pos = 1 / (1 + Math.exp(Math.min(60, (alpha - alphaStall) / w)));
  const neg = 1 / (1 + Math.exp(Math.min(60, (A.alphaStallNegative - alpha) / w)));
  return pos * neg;
}

/** Separated-flow normal-force coefficient (3-D plate plus bounded residual circulation). */
function separatedNormal(alpha: number): number {
  const s = Math.sin(alpha);
  const c = Math.cos(alpha);
  const w = A.separatedResidualWidth;
  return A.cd90 * s + (A.separatedResidual * c * s) / (s * s + w * w);
}

/** Interpolate the speed-brake roll-power gain table. */
function speedBrakeRollGain(sb: number): number {
  const g = A.speedBrakeRollGain;
  const xs = SPEED_BRAKE_GAIN_X;
  if (sb <= 0) return g[0];
  for (let i = 1; i < xs.length; i++) {
    if (sb <= xs[i]) {
      const t = (sb - xs[i - 1]) / (xs[i] - xs[i - 1]);
      return g[i - 1] + (g[i] - g[i - 1]) * t;
    }
  }
  return g[g.length - 1];
}

/** Attached-flow lift at α for a configuration (no rate or control terms). */
export function attachedLift(alpha: number, flapsDeg: number, mach: number): number {
  return A.cl0 + A.flapCl * flapsDeg + A.clAlpha * machLiftFactor(mach) * Math.sin(alpha);
}

/** Static (steady, x = x0) lift coefficient at α, without controls: for warnings and tests. */
export function staticLift(
  alpha: number,
  flapsDeg: number,
  slats: number,
  mach: number,
  reynolds: number = A.reynoldsReference,
): number {
  const x = staticAttachment(alpha, stallAlphaFor(flapsDeg, slats, mach, reynolds));
  const sep = separatedNormal(alpha) * Math.cos(alpha) + 0.5 * A.flapCl * flapsDeg;
  return x * attachedLift(alpha, flapsDeg, mach) + (1 - x) * sep;
}

/**
 * Highest static lift coefficient of a configuration (slats out), searched around the stall
 * angle. Used by the ground-collision prediction and tests.
 */
export function maxStaticLift(
  flapsDeg: number,
  mach: number,
  reynolds: number = A.reynoldsReference,
): number {
  const a0 = stallAlphaFor(flapsDeg, 1, mach, reynolds);
  let best = -Infinity;
  for (let i = -16; i <= 4; i++) {
    const cl = staticLift(a0 + i * 0.25 * (Math.PI / 180), flapsDeg, 1, mach, reynolds);
    if (cl > best) best = cl;
  }
  return best;
}

/**
 * All six coefficients for a flow state and configuration. Writes into `out` and returns it.
 */
export function computeAero(
  flow: AeroFlow,
  ctl: AeroControls,
  out: AeroCoefficients,
): AeroCoefficients {
  const { alpha, beta, mach } = flow;
  const v = Math.max(flow.speed, 1);
  const x = Math.min(1, Math.max(0, flow.attachment));
  const xs = 1 - x;
  const halfChordTime = A10.mac / (2 * v);
  const halfSpanTime = A10.span / (2 * v);
  const qHat = flow.q * halfChordTime;
  const pHat = flow.p * halfSpanTime;
  const rHat = flow.r * halfSpanTime;
  const alphaDotHat = flow.alphaDot * halfChordTime;
  const sinA = Math.sin(alpha);
  const cosA = Math.cos(alpha);

  // ---- static separation target (with the Goman–Khrabrov delay τ2) ----
  const alphaStall = stallAlphaFor(ctl.flapsDeg, ctl.slats, mach, flow.reynolds);
  out.alphaStall = alphaStall;
  out.attachmentTarget = staticAttachment(
    alpha - A.separationTau2 * halfChordTime * flow.alphaDot,
    alphaStall,
  );

  // ---- lift ----
  const clAtt = attachedLift(alpha, ctl.flapsDeg, mach);
  const cnSep = separatedNormal(alpha);
  const clSep = cnSep * cosA + 0.5 * A.flapCl * ctl.flapsDeg;
  out.clAttached = clAtt;
  let cl = x * clAtt + xs * clSep;
  cl += A.clElevator * (x + xs * A.elevatorStalledFactor) * ctl.elevator;
  cl += A.clQ * qHat + A.clAlphaDot * alphaDotHat;
  cl += A.speedBrakeCl * ctl.speedBrake;
  out.cl = cl;

  // ---- drag ----
  const dl = clAtt - A.clMinDrag;
  const cdAtt = A.cd0 + A.inducedK * dl * dl;
  const cdSep = A.cd0 + cnSep * sinA;
  let cd = x * cdAtt + xs * cdSep;
  // Compressibility: Korn drag divergence and Lock's fourth-power wave drag.
  const mdd = A.kornKappa - A.thicknessRatio - Math.min(1.5, Math.abs(cl)) / 10;
  const mcrit = mdd - CRITICAL_BELOW_DIVERGENCE;
  if (mach > mcrit) {
    const dm = mach - mcrit;
    cd += A.waveDragFactor * dm * dm * dm * dm;
  }
  const sinB = Math.sin(beta);
  cd += A.cdBeta * sinB * sinB;
  cd += A.cdElevator * Math.abs(ctl.elevator);
  const f = ctl.flapsDeg;
  cd += A.flapCdLinear * f + A.flapCdQuadratic * f * f;
  cd += A.slatCd * ctl.slats + A.gearCd * ctl.gear;
  cd += A.speedBrakeCd * ctl.speedBrake;
  // External stores: their drag area referred to the wing area.
  cd += ctl.storesDragArea / A10.wingArea;
  out.cd = cd;

  // ---- side force ----
  out.cy = A.cyBeta * sinB + A.cyRudder * ctl.rudder + A.cyR * rHat;

  // ---- pitching moment ----
  const tailPower = x + xs * A.elevatorStalledFactor;
  let cm = A.cm0 + A.cmAlpha * sinA + A.cmElevator * tailPower * ctl.elevator;
  cm += A.cmQ * qHat + A.cmAlphaDot * alphaDotHat;
  cm += A.flapCm * f + A.gearCm * ctl.gear + A.speedBrakeCm * ctl.speedBrake;
  if (cosA > 0) cm += A.cmStall * xs * Math.sign(alpha);
  out.cPitch = cm;

  // ---- rolling moment ----
  const clForTerms = Math.min(1.5, Math.max(0, cl));
  const clBeta =
    x * (A.clBeta + A.clBetaCl * Math.min(1.5, Math.max(0, clAtt))) + xs * A.clBetaStalled;
  const clP = A.clP * (x + xs * A.clPStalled);
  const clR = A.clR + A.clRCl * clForTerms;
  const aileronPower = A.clAileron * speedBrakeRollGain(ctl.speedBrake) * (0.5 + 0.5 * x);
  out.cRoll =
    clBeta * sinB +
    clP * pHat +
    clR * rHat +
    aileronPower * ctl.aileron +
    A.clRudder * ctl.rudder +
    A.stallRollAsymmetry * ctl.asymmetry * xs;

  // ---- yawing moment ----
  const cosB = Math.cos(beta);
  out.cYaw =
    A.cnBeta * sinB * cosB +
    A.cnR * (0.5 + 0.5 * x) * rHat +
    (A.cnP + A.cnPCl * clForTerms) * pHat +
    A.cnAileron * ctl.aileron +
    A.cnRudder * ctl.rudder +
    A.stallYawAsymmetry * ctl.asymmetry * xs;
  return out;
}
