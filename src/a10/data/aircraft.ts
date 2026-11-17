/**
 * A-10C airframe, mass, aerodynamic, engine, flight-control and warning data (PLAN_A10.md §5,
 * §6.2, §13, §19). SI units and radians unless a name ends in Deg/Kt/Ft/Lb. Owned by the FLIGHT
 * module; the flight model (src/a10/core/flight) reads every number from here.
 *
 * Body frame (docs/a10/ARCHITECTURE.md §2): +X right wing, +Y up, -Z nose. The origin is the
 * reference point of data/geometry.ts (25 % of the mean aerodynamic chord, on the centreline),
 * which is also the centre of gravity of the empty aircraft and the moment reference of the
 * aerodynamic coefficients below.
 *
 * Coefficients use the usual aircraft conventions: angle of attack α and sideslip β in radians,
 * rates non-dimensionalised as p̂ = p·b/2V, q̂ = q·c̄/2V, r̂ = r·b/2V, control deflections in
 * radians with these signs: elevator + = trailing edge UP (nose-up command), aileron + = roll
 * RIGHT, rudder + = nose RIGHT. Moments: roll + right wing down, pitch + nose up, yaw + nose
 * right.
 *
 * Where public data is missing, values are estimates from the FlightGear A-10 package (YASim and
 * JSBSim/Aeromatic files: geometry and starting values only), from standard preliminary-design
 * methods (DATCOM lift slope, Korn drag divergence, Viterna post-stall, Goman–Khrabrov dynamic
 * stall, Mattingly thrust lapse) and then TUNED so the flight model meets the public figures
 * (tests/unit/a10/flight.test.ts). Every key has a *_NOTES entry: source id (data/sources.ts) and
 * confidence.
 */
import { FT, KT, LB, LBF } from '../core/units';
import type { SourceNote } from './sources';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// Airframe and published performance
// ---------------------------------------------------------------------------------------------

export const A10 = {
  length: 16.26,
  span: 17.53,
  height: 4.47,
  wingArea: 47.0,
  /** Mean aerodynamic chord, m: reference length of the pitching-moment coefficients. */
  mac: 2.7,
  emptyMass: 24959 * LB,
  maxTakeoffMass: 50000 * LB,
  internalFuel: 11000 * LB,
  /** Static thrust per engine (TF34-GE-100A), N. */
  engineThrust: 9065 * LBF,
  engines: 2,
  /** Maximum level speed, clean, sea level, m/s. */
  maxLevelSpeed: 381 * KT,
  /** Never-exceed speed, m/s (indicated). */
  vne: 450 * KT,
  /** Stall speed, clean, at the reference mass, m/s (indicated). */
  stallSpeed: 120 * KT,
  stallReferenceMass: 13600,
  /** Initial climb rate, clean, m/s. */
  climbRate: (6000 * FT) / 60,
  gLimitPositive: 7.33,
  gLimitNegative: -3,
  stations: 11,
  storesCapacity: 16000 * LB,
  /** Flap angles, rad: UP, MVR, DN. */
  flapAngles: [0, 7 * DEG, 20 * DEG] as const,
  /** Full speed-brake split, rad (upper and lower deceleron halves together). */
  speedBrakeMax: 80 * DEG,
} as const;

export const A10_NOTES: Record<keyof typeof A10, SourceNote> = {
  length: { source: 'aerospaceweb', confidence: 'confirmed' },
  span: { source: 'aerospaceweb', confidence: 'confirmed' },
  height: { source: 'aerospaceweb', confidence: 'confirmed' },
  wingArea: { source: 'aerospaceweb', confidence: 'confirmed' },
  mac: {
    source: 'flightgearA10',
    confidence: 'estimate',
    note: 'S/b = 2.68 m; constant-chord centre section plus tapered outer panels (YASim chord 3.23 m, taper 0.7)',
  },
  emptyMass: { source: 'aerocorner', confidence: 'confirmed' },
  maxTakeoffMass: {
    source: 'aerocorner',
    confidence: 'approximate',
    note: 'sources give 50,000–51,000 lb',
  },
  internalFuel: { source: 'aerocorner', confidence: 'confirmed' },
  engineThrust: { source: 'wikiTf34', confidence: 'confirmed' },
  engines: { source: 'wikiA10', confidence: 'confirmed' },
  maxLevelSpeed: { source: 'aerospaceweb', confidence: 'confirmed' },
  vne: { source: 'wikiA10', confidence: 'approximate' },
  stallSpeed: {
    source: 'wikiA10',
    confidence: 'approximate',
    note: '120 kn at 30,000 lb (13,600 kg); read as the 1-g stall, clean',
  },
  stallReferenceMass: { source: 'wikiA10', confidence: 'approximate' },
  climbRate: { source: 'wikiA10', confidence: 'approximate' },
  gLimitPositive: { source: 'aerocorner', confidence: 'approximate' },
  gLimitNegative: { source: 'plan', confidence: 'approximate' },
  stations: { source: 'wikiA10', confidence: 'confirmed' },
  storesCapacity: { source: 'wikiA10', confidence: 'confirmed' },
  flapAngles: { source: 'plan', confidence: 'approximate' },
  speedBrakeMax: { source: 'plan', confidence: 'approximate' },
};

// ---------------------------------------------------------------------------------------------
// Mass distribution (body frame, origin = empty CG)
// ---------------------------------------------------------------------------------------------

/** A point mass position in the body frame, m. */
export interface BodyPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const A10_MASS = {
  /** Pilot with flight equipment, kg, and where he sits. */
  pilotMass: 100,
  pilotPosition: { x: 0, y: 0.6, z: -4.45 },
  /**
   * Inertia of the empty aircraft about its own CG, kg·m², AVIATION axes: xx roll (about the
   * nose axis), yy pitch (about the wing axis), zz yaw (about the vertical axis), xz the
   * roll–yaw product ∫x·z dm with x forward and z down.
   */
  emptyInertia: { xx: 52000, yy: 98000, zz: 142000, xz: 2500 },
  /** Complete 30 mm round in the drum (projectile, propellant, case), kg. */
  roundMass: 0.69,
  /** Spent case kept in the drum after firing (cases are not ejected), kg. */
  spentCaseMass: 0.15,
  /** Ammunition drum centre (behind the cockpit). */
  drumPosition: { x: 0, y: -0.3, z: -2.4 },
  /** Two integral wing tanks (centre wing box), each. Drained first. */
  wingTankCapacity: 2090 * LB,
  wingTankPosition: { x: 2.0, y: -0.3, z: 0.65 },
  /** Forward and aft fuselage main tanks share the rest of the internal fuel equally. */
  mainTankForward: { x: 0, y: 0.33, z: -0.45 },
  mainTankAft: { x: 0, y: 0.33, z: 1.15 },
  /** Mean height and fore–aft position of the stores' CG (pylon bottoms, data/geometry.ts). */
  storesPosition: { y: -1.0, z: -0.1 },
  /** Radius of gyration of the stores about the roll axis, m (wing and fuselage stations). */
  storesRollRadius: 3.3,
  /**
   * Clean mass with full internal fuel and ammunition, kg. Adding stores lowers the g limits so
   * that limit load factor × (this mass + stores) stays constant (wing-root bending design).
   */
  gLimitReferenceMass: 38000 * LB,
} as const;

export const A10_MASS_NOTES: Record<keyof typeof A10_MASS, SourceNote> = {
  pilotMass: { source: 'plan', confidence: 'estimate' },
  pilotPosition: { source: 'flightgearA10', confidence: 'approximate', note: 'cockpit view point' },
  emptyInertia: {
    source: 'flightgearA10',
    confidence: 'estimate',
    note: 'component build-up (wing, gear pods, engines, tails, gun); Aeromatic gives 73,300 / 86,600 / 136,000 kg·m²',
  },
  roundMass: { source: 'wikiGau8', confidence: 'approximate', note: 'complete PGU-14/B round' },
  spentCaseMass: {
    source: 'plan',
    confidence: 'estimate',
    note: 'aluminium case and primer; cases return to the drum (PLAN §6.2)',
  },
  drumPosition: {
    source: 'flightgearA10',
    confidence: 'estimate',
    note: 'YASim ammunition weight point',
  },
  wingTankCapacity: {
    source: 'flightgearA10',
    confidence: 'approximate',
    note: 'YASim tanks: 2 × 2,090 lb wing, 2 × 3,434 lb fuselage',
  },
  wingTankPosition: { source: 'flightgearA10', confidence: 'approximate' },
  mainTankForward: { source: 'flightgearA10', confidence: 'approximate' },
  mainTankAft: { source: 'flightgearA10', confidence: 'approximate' },
  storesPosition: { source: 'flightgearA10', confidence: 'estimate' },
  storesRollRadius: {
    source: 'flightgearA10',
    confidence: 'estimate',
    note: 'fallback when StoresState gives no rollInertia (Σm·x² over the stations)',
  },
  gLimitReferenceMass: {
    source: 'plan',
    confidence: 'estimate',
    note: '+7.33 / −3 g clean (PLAN §5); n·W held constant as stores are added',
  },
};

// ---------------------------------------------------------------------------------------------
// Ground contact. The hull, gear-pod and wheel points are measured on the model
// (data/geometry.ts `hull` and `gearContacts`); core/flight/ground.ts tests them.
// ---------------------------------------------------------------------------------------------

/**
 * Ground contact in the Relaxed preset (realism flag `invulnerable`, PLAN §2: "the aircraft
 * bounces off"): an aid, not physics. The aircraft is put back into flight away from the surface.
 */
export const A10_CONTACT = {
  /** Fraction of the speed kept by a bounce. */
  bounceSpeedKept: 0.85,
  /** Least speed after a bounce, m/s (≈1.4 × the clean stall speed: it can fly away). */
  bounceMinSpeed: 170 * KT,
  /** Climb angle away from the surface after a bounce, rad. */
  bounceClimbAngle: 12 * DEG,
  /** Largest angle of attack the bounce sets (the 1 g angle at the new speed, below the stall). */
  bounceMaxAlpha: 10 * DEG,
  /** Height the lowest hull point is put above the surface, m. */
  bounceClearance: 0.5,
  /** Shortest time between two GROUND CONTACT messages, s. */
  contactMessageInterval: 3,
} as const;

export const A10_CONTACT_NOTES: Record<keyof typeof A10_CONTACT, SourceNote> = {
  bounceSpeedKept: {
    source: 'plan',
    confidence: 'estimate',
    note: 'Relaxed preset aid (review FC-2: a reflection alone left steep impacts stuck)',
  },
  bounceMinSpeed: { source: 'plan', confidence: 'estimate' },
  bounceClimbAngle: { source: 'plan', confidence: 'estimate' },
  bounceMaxAlpha: { source: 'plan', confidence: 'estimate' },
  bounceClearance: { source: 'plan', confidence: 'estimate' },
  contactMessageInterval: { source: 'plan', confidence: 'estimate' },
};

// ---------------------------------------------------------------------------------------------
// Aerodynamics
// ---------------------------------------------------------------------------------------------

export const A10_AERO = {
  // ---- lift (whole aircraft, flaps up, attached flow) ----
  /** Lift coefficient at zero body angle of attack (cambered NACA 6716/6713 wing, −1° incidence). */
  cl0: 0.3,
  /** Lift-curve slope at low Mach, per rad. Scaled with Mach by the DATCOM formula. */
  clAlpha: 5.0,
  /** Span efficiency used in the DATCOM lift-slope formula. */
  datcomEta: 0.95,
  /** Lift due to elevator (trailing edge up reduces tail lift), per rad. */
  clElevator: -0.35,
  /** Lift due to pitch rate and to rate of change of α, per unit q̂ and per unit α̇c̄/2V. */
  clQ: 5.2,
  clAlphaDot: 2.4,

  // ---- stall (separation model) ----
  /**
   * Angle of attack where half the flow is separated (static), slats retracted, flaps up, low
   * Mach and the reference Reynolds number. The static lift peak lies within about half a
   * degree of it (the attached lift keeps rising while the flow starts to separate).
   */
  alphaStall: 10.5 * DEG,
  /** Leading-edge slats fully out delay the separation by this angle. */
  slatAlphaGain: 2.5 * DEG,
  /** Width of the separation sigmoid: small = abrupt stall, large = gentle. */
  stallWidth: 1.6 * DEG,
  /** Negative-α stall (pushing). */
  alphaStallNegative: -11 * DEG,
  /** The stall angle falls this much per unit Mach above `stallMachOnset` (shock-induced). */
  stallMachSlope: 6 * DEG,
  stallMachOnset: 0.35,
  /**
   * Reynolds-number effect: the separation moves later as Re grows, by this angle per decade
   * of Re above the reference (≈ the 1-g stall at 120 kn), bounded.
   */
  stallReynoldsSlope: 1.3 * DEG,
  reynoldsReference: 9e6,
  stallReynoldsLimit: 1.0 * DEG,
  /**
   * Goman–Khrabrov dynamic separation: relaxation time τ1 and delay τ2 in units of c̄/2V. A quick
   * pull holds the flow attached briefly beyond the static stall (lift overshoot); a stall
   * recovers late (hysteresis).
   */
  separationTau1: 30,
  separationTau2: 10,
  /** Separated-flow normal force at 90° (3-D plate, Viterna: 1.11 + 0.018·AR). */
  cd90: 1.23,
  /** Residual circulation of the separated wing (bounded Viterna term) and its width. */
  separatedResidual: 0.33,
  separatedResidualWidth: 0.2,

  // ---- flaps, slats, gear, speed brakes ----
  /** Lift added by the trailing-edge flaps per degree. */
  flapCl: 0.022,
  /** Stall angle change per degree of flap, rad/deg. */
  flapAlphaStall: -0.06 * DEG,
  /** Flap drag: ΔCD = a·δ + b·δ² (δ in degrees). */
  flapCdLinear: 0.0006,
  flapCdQuadratic: 0.0001,
  /** Flap pitching moment per degree (nose down). */
  flapCm: -0.0045,
  slatCd: 0.003,
  gearCd: 0.025,
  gearCm: -0.012,
  /** Speed brakes fully split: drag, lift and pitch increments. */
  speedBrakeCd: 0.09,
  speedBrakeCl: -0.03,
  speedBrakeCm: 0.012,
  /**
   * Roll power gain with the decelerons split, by speed-brake opening 0, 0.4, 0.7, 1: the A-10
   * rolls faster with the speed brakes partly open (≈130 °/s clean, ≈200 °/s at 40 %, 300 KIAS).
   */
  speedBrakeRollGain: [1.0, 1.55, 1.45, 1.25] as const,

  // ---- drag ----
  /** Zero-lift drag, clean (gun, pylons, gear pods, nacelles): tuned to the 381 kn maximum. */
  cd0: 0.0477,
  /** Induced-drag factor 1/(π·AR·e), e ≈ 0.75. */
  inducedK: 0.065,
  /** Lift coefficient of minimum drag (cambered wing). */
  clMinDrag: 0.15,
  /** Sideslip drag: ΔCD = k·sin²β. */
  cdBeta: 0.75,
  /** Elevator drag per rad of deflection. */
  cdElevator: 0.04,
  /** Korn drag-divergence: M_dd = κ − t/c − CL/10; wave drag 20·(M − M_crit)⁴. */
  kornKappa: 0.87,
  thicknessRatio: 0.15,
  waveDragFactor: 20,

  // ---- pitching moment about the reference point ----
  cm0: 0.025,
  cmAlpha: -0.55,
  /** Elevator power, per rad (trailing edge up = nose up). */
  cmElevator: 0.83,
  cmQ: -10,
  cmAlphaDot: -4,
  /** Nose-down moment of the separated wing (centre of pressure moves aft). */
  cmStall: -0.08,
  /**
   * Elevator power left when the wing is fully stalled: the tail sits in the separated wake
   * (lower dynamic pressure), so full aft stick cannot drive the aircraft deep into the stall.
   */
  elevatorStalledFactor: 0.5,

  // ---- lateral–directional ----
  cyBeta: -0.65,
  cyRudder: -0.2,
  cyR: 0.35,
  /** Dihedral effect: Clβ = a + b·CL (outer panels have dihedral). */
  clBeta: -0.08,
  clBetaCl: -0.08,
  /** Clβ of the fully separated wing: the yawed wing drops (wing-drop tendency). */
  clBetaStalled: 0.05,
  clP: -0.45,
  /** Roll damping kept by the fully stalled wing (fraction). */
  clPStalled: 0.35,
  clR: 0.04,
  clRCl: 0.25,
  clAileron: 0.122,
  clRudder: -0.025,
  /** Roll moment of an asymmetric stall (airframe asymmetry ±1 drawn per flight). */
  stallRollAsymmetry: 0.003,
  stallYawAsymmetry: 0.0015,
  cnBeta: 0.14,
  cnR: -0.22,
  cnP: -0.01,
  cnPCl: -0.125,
  cnAileron: -0.006,
  cnRudder: 0.075,

  // ---- control surfaces (travel) ----
  elevatorMax: 25 * DEG,
  aileronMax: 25 * DEG,
  rudderMax: 20 * DEG,

  // ---- buffet ----
  /** Buffet starts this far below the stall angle, rad. */
  buffetOnsetMargin: 3 * DEG,
  /** Random normal-force buffet at full intensity, as a fraction of q̄·S. */
  buffetForce: 0.012,
} as const;

const fg = (note: string): SourceNote => ({
  source: 'flightgearA10',
  confidence: 'estimate',
  note,
});
const est = (note: string): SourceNote => ({ source: 'plan', confidence: 'estimate', note });

export const A10_AERO_NOTES: Record<keyof typeof A10_AERO, SourceNote> = {
  cl0: fg('JSBSim 0.28, Aeromatic 0.41; tuned with the stall speed'),
  clAlpha: fg('DATCOM for AR 6.54 plus tail: ≈4.5 + 0.5; JSBSim 5.17'),
  datcomEta: est('airfoil efficiency in the DATCOM lift-slope formula'),
  clElevator: fg('tail lift slope × elevator effectiveness × S_t/S'),
  clQ: fg('JSBSim 5.21'),
  clAlphaDot: fg('JSBSim 2.44'),
  alphaStall: fg(
    'YASim stall 15° (wing); tuned: 1-g reference stall speed (FAR 25.103 V_SR) ≈118 kn at 13,600 kg',
  ),
  slatAlphaGain: est('inboard slats only'),
  stallWidth: est('docile trailing-edge stall of a thick wing'),
  alphaStallNegative: est('cambered wing stalls earlier when pushed'),
  stallMachSlope: est('thick wing: CLmax falls with Mach'),
  stallMachOnset: est(''),
  stallReynoldsSlope: est(
    'CLmax grows with Reynolds number (thick cambered sections, Re 9–30 million)',
  ),
  reynoldsReference: est('Re of the 1-g stall at 120 kn, 3,000 m'),
  stallReynoldsLimit: est(''),
  separationTau1: est(
    'Goman & Khrabrov (1994); wings show τ1 ≈ 10–30 (c̄/2V). Upper range: a sharp pull at 300 kn overshoots the static CLmax and passes +7.33 g',
  ),
  separationTau2: est('Goman & Khrabrov (1994): τ2 ≈ 3–10 (c̄/2V)'),
  cd90: est('Viterna & Corrigan (1982): 1.11 + 0.018·AR'),
  separatedResidual: est('fitted to a gradual post-stall lift (≈1.0 at 25°)'),
  separatedResidualWidth: est(''),
  flapCl: fg('JSBSim 0.0107/deg per 1/2 travel'),
  flapAlphaStall: est(''),
  flapCdLinear: fg('JSBSim 0.0023/deg'),
  flapCdQuadratic: fg(''),
  flapCm: est(''),
  slatCd: est(''),
  gearCd: fg('JSBSim 0.02'),
  gearCm: est('gear drag below the CG'),
  speedBrakeCd: fg('JSBSim 0.08; split decelerons ≈6 m² of plate at 80°'),
  speedBrakeCl: est('small lift change (PLAN §5)'),
  speedBrakeCm: est(''),
  speedBrakeRollGain: {
    source: 'plan',
    confidence: 'approximate',
    note: 'A-10C flight manual as quoted in DCS A-10C documentation (130 / 200 °/s at 300 KIAS)',
  },
  cd0: est('tuned so the maximum level speed clean at sea level is 381 kn'),
  inducedK: est('AR 6.54, Oswald e ≈ 0.75'),
  clMinDrag: est('cambered wing'),
  cdBeta: fg('JSBSim 0.05 at 15°'),
  cdElevator: fg('JSBSim 0.04'),
  kornKappa: est('Korn equation, conventional airfoils'),
  thicknessRatio: {
    source: 'wikiA10',
    confidence: 'approximate',
    note: 'NACA 6716 root, 6713 tip',
  },
  waveDragFactor: est("Lock's fourth-power law"),
  cm0: est('trimmed elevator near neutral at 250 kn cruise'),
  cmAlpha: est('static margin ≈11 % MAC; JSBSim −1.59 is Aeromatic generic'),
  cmElevator: fg('tail volume 0.56 × tail slope 3.3 × τ 0.5'),
  cmQ: fg('JSBSim −13.7; tail estimate −8'),
  cmAlphaDot: fg('JSBSim −9.4; tail estimate −3.6'),
  cmStall: est('nose drop at the stall'),
  elevatorStalledFactor: est('tail in the stalled wake; docile, spin-resistant A-10'),
  cyBeta: fg('JSBSim −0.49; twin fins'),
  cyRudder: fg('JSBSim 0.30 (opposite sign convention)'),
  cyR: fg('JSBSim 0.36'),
  clBeta: fg('JSBSim −0.04 … −0.32'),
  clBetaCl: est('straight wing with dihedral'),
  clBetaStalled: est('wing-drop tendency'),
  clP: fg('JSBSim −0.44'),
  clPStalled: est('docile: never autorotative'),
  clR: fg(''),
  clRCl: est('straight wing: ≈CL/4'),
  clAileron: {
    source: 'plan',
    confidence: 'approximate',
    note: 'tuned to ≈130 °/s at 300 KIAS (A-10C flight manual via DCS documentation); JSBSim 0.12',
  },
  clRudder: fg('JSBSim 0.01'),
  stallRollAsymmetry: est(''),
  stallYawAsymmetry: est(''),
  cnBeta: fg('JSBSim 0.18'),
  cnR: fg('JSBSim −0.15'),
  cnP: fg(''),
  cnPCl: est('straight wing: ≈−CL/8'),
  cnAileron: est('small adverse yaw'),
  cnRudder: fg('JSBSim 0.11 (opposite sign convention)'),
  elevatorMax: est(''),
  aileronMax: est(''),
  rudderMax: est(''),
  buffetOnsetMargin: est(''),
  buffetForce: est(''),
};

// ---------------------------------------------------------------------------------------------
// Engines: two General Electric TF34-GE-100A high-bypass turbofans
// ---------------------------------------------------------------------------------------------

export const TF34 = {
  /** Uninstalled static sea-level thrust, N. */
  staticThrust: 9065 * LBF,
  bypassRatio: 6.2,
  /**
   * Mattingly's throttle ratio for the thrust lapse of a high-bypass turbofan:
   * T/T0 = δ0·(1 − 0.49·√M − 3·(θ0 − TR)/(1.5 + M)) when θ0 > TR.
   */
  throttleRatio: 1.0,
  lapseMachCoefficient: 0.49,
  /** Fan and core speed at idle (fraction of maximum), static. */
  n1Idle: 0.28,
  n2Idle: 0.6,
  /** Windmilling raises the idle fan speed with Mach. */
  n1IdleRam: 0.25,
  /** Fan speed vs core speed: n1_rel = n2_rel^k. */
  fanCoreExponent: 1.6,
  /** Thrust above idle grows as n1_rel^k. */
  thrustExponent: 1.7,
  /** Net idle thrust as a fraction of static thrust: a − b·M − c·M² (ram drag at speed). */
  idleThrust: [0.05, 0.12, 0.1] as const,
  /**
   * Core acceleration schedule (fuel control): the core speed may rise at most
   * accelBase + accelSlope·(n2 − n2Idle) per second, and follows its command with `spoolGain`.
   */
  accelBase: 0.024,
  accelSlope: 0.32,
  /** Maximum deceleration rate, fraction per second. */
  decelRate: 0.12,
  spoolGain: 2.5,
  /** Fan spool lag behind its quasi-static value, s. */
  fanLag: 0.25,
  /** Specific fuel consumption at static maximum thrust, kg/(N·s) (0.37 lb/(lbf·h)). */
  tsfcStatic: (0.37 * LB) / LBF / 3600,
  /** Fuel flow at idle, static, kg/s (≈480 lb/h). */
  idleFuelFlow: 0.06,
  /** Corrected fuel flow above idle grows as n2_rel^k. */
  fuelFlowExponent: 2.5,
  /** Interstage turbine temperature at idle and at maximum, °C (gauges). */
  ittIdle: 470,
  ittMax: 880,
  /** Rotor inertias, kg·m², and maximum speeds, rpm (gyroscopic moment). */
  fanInertia: 8,
  coreInertia: 1.5,
  n1MaxRpm: 7365,
  n2MaxRpm: 17900,
  /** Engine fan centres (thrust line), body frame: left engine; the right one mirrors it. */
  position: { x: -1.476, y: 0.965, z: 3.15 },
  /** Thrust line pitch relative to the body −Z axis, rad (+ = thrust points nose-up). */
  thrustPitch: 0,
} as const;

export const TF34_NOTES: Record<keyof typeof TF34, SourceNote> = {
  staticThrust: { source: 'geTf34', confidence: 'confirmed' },
  bypassRatio: { source: 'wikiTf34', confidence: 'confirmed' },
  throttleRatio: est('Mattingly, Aircraft Engine Design (2002), high-bypass turbofan'),
  lapseMachCoefficient: est('Mattingly (2002)'),
  n1Idle: fg('JSBSim TF34 30 %, YASim 20 %'),
  n2Idle: fg('JSBSim TF34 60 %, YASim 56 %'),
  n1IdleRam: est(''),
  fanCoreExponent: est(''),
  thrustExponent: est(''),
  idleThrust: fg('Aeromatic idle-thrust table'),
  accelBase: {
    source: 'plan',
    confidence: 'estimate',
    note: 'no TF34 figure is published; tuned to idle → 95 % thrust in ≈6 s (FAA 14 CFR 33.73 requires ≤5 s for civil engines; YASim note: 10 s idle → 100 %)',
  },
  accelSlope: est('faster acceleration from mid-range'),
  decelRate: est(''),
  spoolGain: est(''),
  fanLag: est(''),
  tsfcStatic: { source: 'wikiTf34', confidence: 'approximate', note: '0.37 lb/(lbf·h)' },
  idleFuelFlow: est(''),
  fuelFlowExponent: est(''),
  ittIdle: est(''),
  ittMax: est(''),
  fanInertia: est(''),
  coreInertia: est(''),
  n1MaxRpm: fg('YASim note: fan 7,365 rpm'),
  n2MaxRpm: fg('YASim note: core 17,900 rpm'),
  position: {
    source: 'flightgearA10',
    confidence: 'approximate',
    note: 'fan spin centres in A-10-model.xml',
  },
  thrustPitch: {
    source: 'flightgearA10',
    confidence: 'approximate',
    note: 'model nacelles are aligned with the fuselage; the often-quoted 9° cant is unverified',
  },
};

// ---------------------------------------------------------------------------------------------
// Flight controls: actuators, SAS, trim, flaps, gear, speed brakes, slats, PAC, autopilot
// ---------------------------------------------------------------------------------------------

export const A10_FCS = {
  /** Surface actuator rate limits, full travel fractions per second (≈40/60/40 °/s). */
  elevatorRate: 1.6,
  aileronRate: 2.4,
  rudderRate: 2.0,
  /** Actuator first-order lag, s. */
  actuatorLag: 0.04,
  /** Flap travel UP → DN, s. */
  flapTravelTime: 7,
  /** Flaps blow back to the next position above these indicated speeds, m/s (10 kn hysteresis). */
  flapLimitDn: 200 * KT,
  flapLimitMvr: 335 * KT,
  flapBlowupHysteresis: 10 * KT,
  /** Gear transit time, s. */
  gearTravelTime: 7,
  /** Speed-brake travel 0 → 100 % while the switch is held, s. */
  speedBrakeTravelTime: 2.5,
  /** Slats: extend above / retract below these angles of attack, travel time. */
  slatExtendAlpha: 9.5 * DEG,
  slatRetractAlpha: 7.5 * DEG,
  slatTravelTime: 0.8,

  /** Trim: full-range rates (fraction of trim authority per second) and authority. */
  pitchTrimRate: 0.12,
  rollTrimRate: 0.25,
  yawTrimRate: 0.25,
  /** Trim authority as a fraction of surface travel. */
  pitchTrimAuthority: 0.4,
  rollTrimAuthority: 0.15,
  yawTrimAuthority: 0.25,
  /** Auto-trim: stick inside this dead band counts as neutral. */
  autoTrimDeadband: 0.05,
  /** Auto-trim integral gains: trim per second per g, per rad/s of roll, per rad of sideslip. */
  autoTrimPitchGain: 0.25,
  autoTrimRollGain: 0.6,
  autoTrimYawGain: 1.2,

  /** Pitch SAS: pitch-rate damper with washout; gain ∝ 1/V (reference 300 kn). */
  pitchSasGain: 0.2,
  pitchSasWashout: 1.5,
  pitchSasAuthority: 0.3,
  /** Yaw SAS: yaw damper with washout, sideslip (turn) coordination, aileron–rudder interconnect. */
  yawSasGain: 0.65,
  yawSasWashout: 1.0,
  yawSasBetaGain: 1.5,
  yawSasAileronGain: 0.1,
  yawSasAuthority: 0.3,
  /** Reference true airspeed of the scheduled gains, m/s. */
  gainReferenceSpeed: 300 * KT,

  /** PAC (Precision Attitude Control): limited series authority and its gains. */
  pacPitchAuthority: 0.2,
  pacYawAuthority: 0.25,
  /**
   * Fade-out of PAC's command after the trigger is released, authority fractions per second.
   * Only there: inside the loop a slew limit causes a limit cycle (review GFC-1 / FC-1).
   */
  pacReleaseRate: 3.0,
  /** Time constant of the pipper-error rate filter, s. */
  pacRateFilter: 0.05,
  /** PAC integrator limit, fractions of its authority. */
  pacIntegralLimit: 0.6,
  /** The integrator only works on pipper errors smaller than this, rad (no wind-up in a swing). */
  pacIntegralZone: 0.004,
  /**
   * Pipper error → command (fractions of PAC authority): proportional per rad, damping per rad/s
   * of error rate, and an integral per rad·s that nulls the steady line-of-sight drift of a dive.
   */
  pacElevGain: 140,
  pacElevRateGain: 25,
  pacElevIntegral: 200,
  pacAzGain: 160,
  pacAzRateGain: 28,
  pacAzIntegral: 200,
  /** Body-rate damping per rad/s. */
  pacPitchDamping: 3.0,
  pacYawDamping: 3.75,
  /** Stick / pedal displacement above which the pilot overrides PAC. */
  pacOverrideStick: 0.25,
  pacOverridePedal: 0.3,
  /**
   * Stick / pedal movement from where they were at the capture beyond which the pilot walks the
   * pipper (the held point follows it until the controls return).
   */
  pacWalkStick: 0.02,
  pacWalkPedal: 0.03,
  /**
   * After a walk: PAC holds the new point once the pipper moves slower than this over the ground,
   * rad/s (seen from the eye), or at the latest after the time limit, s.
   */
  pacSettleRate: 0.003,
  pacSettleDwellTime: 0.1,
  pacSettleMaxTime: 1.0,
  /** Pipper error beyond which the proportional term stops growing, rad (bounded closing rate). */
  pacErrorLimit: 0.005,

  /** Autopilot (low-altitude autopilot: PATH, ALT/HDG, ALT). */
  apEngageBankLimit: 10 * DEG,
  apAltEngageBankLimit: 60 * DEG,
  /** Stick displacement that disengages the autopilot (≈10 lb). */
  apDisengageStick: 0.3,
  /** Heading hold: bank per rad of heading error and the bank limit. */
  apHeadingGain: 2.0,
  apHeadingBankLimit: 20 * DEG,
  /** Altitude hold: climb rate per m of error and the limit, m/s. */
  apAltitudeGain: 0.2,
  apClimbRateLimit: 10,
  /** Flight-path loop: g per rad/s... normal acceleration gain on γ error, 1/s. */
  apGammaGain: 0.8,
  /** Load-factor loop (inner): elevator per g and integral per g·s. */
  apGGain: 0.08,
  apGIntegral: 0.25,
  apPitchDamping: 0.3,
  /** Bank loop: aileron per rad of bank error, per rad/s of roll rate, integral. */
  apBankGain: 1.2,
  apRollDamping: 0.35,
  apBankIntegral: 0.15,
  /** Autopilot authority on elevator and aileron. */
  apAuthority: 0.5,
} as const;

export const A10_FCS_NOTES: Record<keyof typeof A10_FCS, SourceNote> = {
  elevatorRate: est('hydraulic actuators'),
  aileronRate: est(''),
  rudderRate: est(''),
  actuatorLag: est(''),
  flapTravelTime: fg('YASim flap transition 15 s; estimate 7 s'),
  flapLimitDn: est('flap blow-up'),
  flapLimitMvr: est(''),
  flapBlowupHysteresis: est(''),
  gearTravelTime: fg('YASim gear transition 7 s'),
  speedBrakeTravelTime: est('≈2–3 s full travel (PLAN brief)'),
  slatExtendAlpha: fg('slats extend at high AoA to keep the inlets clean'),
  slatRetractAlpha: est(''),
  slatTravelTime: est(''),
  pitchTrimRate: est(''),
  rollTrimRate: est(''),
  yawTrimRate: est(''),
  pitchTrimAuthority: est(''),
  rollTrimAuthority: est(''),
  yawTrimAuthority: est(''),
  autoTrimDeadband: est(''),
  autoTrimPitchGain: est(''),
  autoTrimRollGain: est(''),
  autoTrimYawGain: est(''),
  pitchSasGain: est('short-period damping ratio ≈0.7'),
  pitchSasWashout: est(''),
  pitchSasAuthority: est('series SAS, limited authority'),
  yawSasGain: est('Dutch-roll damping ratio ≈0.5'),
  yawSasWashout: est(''),
  yawSasBetaGain: est('turn coordination'),
  yawSasAileronGain: est(''),
  yawSasAuthority: est(''),
  gainReferenceSpeed: est(''),
  pacPitchAuthority: {
    source: 'dcsForumPac',
    confidence: 'estimate',
    note: 'PAC acts through the SAS with limited authority: it steadies, it does not aim',
  },
  pacYawAuthority: { source: 'dcsForumPac', confidence: 'estimate' },
  pacReleaseRate: est('smooth hand-back after the trigger is released'),
  pacRateFilter: est(''),
  pacIntegralLimit: est(''),
  pacIntegralZone: est('tuned with the transient cases of review GFC-1 (flightControls test)'),
  pacElevGain: est(
    'tuned: steadiest pipper in turbulence without ringing (tests/unit/a10/flightControls.test.ts)',
  ),
  pacElevRateGain: est(''),
  pacElevIntegral: est(''),
  pacAzGain: est(''),
  pacAzRateGain: est(''),
  pacAzIntegral: est(''),
  pacPitchDamping: est(''),
  pacYawDamping: est(''),
  pacOverrideStick: est(''),
  pacOverridePedal: est(''),
  pacWalkStick: est(
    'small enough for fine aiming, larger than a held stick drifts (review GFC-2: the pipper must walk)',
  ),
  pacWalkPedal: est(''),
  pacSettleRate: est(''),
  pacSettleDwellTime: est(''),
  pacSettleMaxTime: est(''),
  pacErrorLimit: est('tuned with the transient cases of review GFC-1 (flightControls test)'),
  apEngageBankLimit: {
    source: 'plan',
    confidence: 'approximate',
    note: 'PATH and ALT/HDG do not engage above 10° of bank (DCS A-10C documentation)',
  },
  apAltEngageBankLimit: est(''),
  apDisengageStick: {
    source: 'plan',
    confidence: 'approximate',
    note: 'more than ≈10 lb of stick force disengages (DCS A-10C documentation)',
  },
  apHeadingGain: est(''),
  apHeadingBankLimit: est(''),
  apAltitudeGain: est(''),
  apClimbRateLimit: est(''),
  apGammaGain: est(''),
  apGGain: est(''),
  apGIntegral: est(''),
  apPitchDamping: est(''),
  apBankGain: est(''),
  apRollDamping: est(''),
  apBankIntegral: est(''),
  apAuthority: est(''),
};

// ---------------------------------------------------------------------------------------------
// Warnings (PLAN §5, §13)
// ---------------------------------------------------------------------------------------------

export const A10_WARNINGS = {
  /** Steady stall tone this far below the (slats-out) stall angle of attack, rad. */
  stallSteadyMargin: 4.5 * DEG,
  /** Chopped stall tone this far below it, rad. */
  stallChoppedMargin: 1.8 * DEG,
  /** Stall tones only above this indicated airspeed (sensor validity), m/s. */
  stallMinSpeed: 40 * KT,
  /** Lowest positive g limit with heavy stores. */
  minPositiveGLimit: 5.0,
  /** Over-g warning stays on until the load is this far back inside the limit, g. */
  overGHysteresis: 0.15,
  /** Overspeed buffet reaches full intensity this far above Vne, m/s. */
  overspeedBuffetRange: 30 * KT,
  /** Low-fuel warning, kg (about 500 lb in each main tank). */
  lowFuel: 1000 * LB,
  /** Default altitude alert, m above ground (radar). */
  altitudeAlertDefault: 500 * FT,
  /** Ground-collision prediction (PULL UP / break-X). */
  gcasReactionTime: 1.0,
  gcasRollRate: 90 * DEG,
  /** Recovery load factor as a fraction of what is available (limit or lift), at most… */
  gcasGFraction: 0.85,
  /** …the design recovery load factor, g, reached at this onset rate, g/s. */
  gcasRecoveryG: 5,
  gcasOnsetRate: 4,
  /** Warn when the predicted recovery would bottom out closer than this to the ground, m. */
  gcasMinClearance: 30,
  /** The warning clears when the predicted clearance is this much larger again, m. */
  gcasHysteresis: 30,
  /** The prediction runs every N simulation steps (≈20 Hz). */
  gcasInterval: 6,
  /** Prediction time step and horizon, s. */
  gcasStep: 0.1,
  gcasHorizon: 20,
} as const;

export const A10_WARNINGS_NOTES: Record<keyof typeof A10_WARNINGS, SourceNote> = {
  stallSteadyMargin: fg('FlightGear: steady tone 10–13.5° body AoA, chopped above'),
  stallChoppedMargin: fg(''),
  stallMinSpeed: est(''),
  minPositiveGLimit: est(''),
  overGHysteresis: est(''),
  overspeedBuffetRange: est(''),
  lowFuel: est(''),
  altitudeAlertDefault: est(''),
  gcasReactionTime: est('pilot reaction allowance of the prediction'),
  gcasRollRate: est(''),
  gcasGFraction: est(''),
  gcasRecoveryG: est('a normal recovery pull, not a maximum one'),
  gcasOnsetRate: est('g onset of a firm pull'),
  gcasMinClearance: est(''),
  gcasHysteresis: est(''),
  gcasInterval: est(''),
  gcasStep: est(''),
  gcasHorizon: est(''),
};
