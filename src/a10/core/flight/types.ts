/**
 * Flight contract: the aircraft rigid body, engines, flight controls and warnings. Owned by the
 * FLIGHT module (core/flight). See docs/a10/ARCHITECTURE.md §4.
 *
 * Frames: docs/a10/ARCHITECTURE.md §2 and core/frames.ts.
 */
import type { Quaternion, Vector3 } from 'three';

export interface EngineState {
  /** Throttle lever position this engine follows, 0 = IDLE, 1 = MAX. */
  lever: number;
  /**
   * Fan speed as a fraction of maximum (spool-lagged): ≈0.28 at idle on the ground, higher at
   * idle in flight (windmilling), 1 at MAX.
   */
  n1: number;
  /** Core speed fraction, for gauges and sound (≈0.6 at idle). */
  n2: number;
  /** Net thrust produced this step, N (negative = idle ram drag at high speed). */
  thrust: number;
  /** Interstage turbine temperature, °C, for the gauge. */
  itt: number;
  /** Fuel flow, kg/s. */
  fuelFlow: number;
  running: boolean;
  /** Igniters on (they run while the gun trigger is held, against gun-gas flame-out). */
  igniters: boolean;
}

/** Actual (actuator-lagged) control positions. Normalised unless stated. */
export interface SurfaceState {
  /** Elevator, -1..1, + = trailing edge up (nose-up command). */
  elevator: number;
  /** Aileron, -1..1, + = roll right (right aileron up). */
  aileron: number;
  /** Rudder, -1..1, + = nose right. */
  rudder: number;
  /** Flap angle, rad (0, 7° manoeuvre, 20° down). */
  flaps: number;
  /** Speed brake opening, 0..1 (split ailerons, 1 = 80° split). */
  speedBrake: number;
  /** Leading-edge slats, 0..1 (deployed by angle of attack). */
  slats: number;
}

export interface TrimState {
  /** Pitch trim, -1..1 of authority, + nose up. */
  pitch: number;
  /** Roll trim, -1..1, + right wing down. */
  roll: number;
  /** Rudder trim, -1..1, + nose right. */
  yaw: number;
}

export type AutopilotMode = 'PATH' | 'ALT_HDG' | 'ALT';

export interface AutopilotState {
  engaged: boolean;
  mode: AutopilotMode;
  /** Captured references when engaged. */
  refAltitude: number;
  refHeading: number;
  /** PATH: the flight-path angle to hold, rad. */
  refPitch: number;
  /** ALT: the bank angle to hold, rad. */
  refBank: number;
  /** Elevator and aileron the autopilot adds this step, -1..1 (debug, gauges). */
  pitchCmd: number;
  rollCmd: number;
}

export interface PacState {
  /** Trigger stage seen by PAC: 0 off, 1 = first detent (PAC-1), 2 = firing (PAC-2). */
  stage: 0 | 1 | 2;
  /** PAC is armed (GUN/PAC switch at ARM) and acting. */
  active: boolean;
  /** Pitch and yaw commands PAC added this step, -1..1 of its authority (for gauges/debug). */
  pitchCmd: number;
  yawCmd: number;
  /** The ground point PAC holds the pipper on (captured at the first detent), world. */
  aimPoint: Vector3;
  aimValid: boolean;
  /** The pilot's stick or pedals override PAC this step (it re-captures when they centre). */
  overridden: boolean;
  /**
   * The pilot is walking the pipper: the controls are away from where they were when the point
   * was captured, so the held point follows the pipper (it is captured again when they return).
   */
  walking: boolean;
  /** Pipper error to the aim point, rad (HUD azimuth + right, elevation + up). */
  errorAz: number;
  errorEl: number;
}

export type WarningId =
  | 'stall' // steady stall tone: approaching the stall
  | 'stallChopped' // chopped tone: at/beyond stall angle of attack
  | 'overG'
  | 'altitude' // below the set altitude alert
  | 'pullUp' // ground collision warning: break-X on the HUD + voice
  | 'overspeed'
  | 'lowFuel'
  | 'masterCaution';

/** Ground-collision prediction (the PULL UP warning and the HUD break-X). */
export interface GroundCollisionState {
  /**
   * Lowest predicted height above the ground of a maximum-performance recovery started after
   * the reaction allowance, m (Infinity when no terrain is near the path).
   */
  clearance: number;
  /** Time to ground impact if the present flight path continues straight, s (Infinity if none). */
  timeToImpact: number;
}

/** Internal states of the flight-control computers and air model (owned by the flight module). */
export interface FlightControlInternals {
  /** Washout filter states of the pitch and yaw dampers. */
  pitchWashout: number;
  yawWashout: number;
  /** Autopilot integrators. */
  apGIntegral: number;
  apBankIntegral: number;
  /** PAC: previous pipper errors for the rate terms, and whether they are valid. */
  pacPrevAz: number;
  pacPrevEl: number;
  pacPrevValid: boolean;
  pacRateAz: number;
  pacRateEl: number;
  /** PAC integrators (fractions of its authority). */
  pacIntAz: number;
  pacIntEl: number;
  /** Stick and pedal positions when PAC captured its point (walking is measured from them). */
  pacRefPitch: number;
  pacRefRoll: number;
  pacRefRudder: number;
  /** Time since the controls came back after a walk, s (−1: not settling). */
  pacSettleTime: number;
  /** How long the pipper has been slower than the settle rate while settling, s. */
  pacSettleDwell: number;
  /** Commanded (pre-actuator) surface positions this step, -1..1. */
  elevatorCmd: number;
  aileronCmd: number;
  rudderCmd: number;
  /** Separation state of the wing flow: 1 attached … 0 fully separated (dynamic stall). */
  flowAttachment: number;
  /** Filtered rate of change of α, rad/s (unsteady aerodynamics). */
  alphaRate: number;
  /** Airframe asymmetry of this flight, -1..1 (which wing drops first in a stall). */
  asymmetry: number;
  /** The air start has not been trimmed yet (done at the first step). */
  trimPending: boolean;
  /** Low-passed random buffet force, -∞..∞ (unit variance). */
  buffetNoise: number;
  /** Flap blow-up latches: DN blown back to MVR, MVR blown back to UP (hysteresis). */
  flapDnBlown: boolean;
  flapMvrBlown: boolean;
  /** Steps since the last ground-collision prediction. */
  gcasCounter: number;
  /** A body point was on the ground last step (invulnerable bounces). */
  inContact: boolean;
  /** Sim time of the last GROUND CONTACT message, s (they are spaced out). */
  contactMessageTime: number;
  /** A bounce (invulnerable) happened: re-trim for 1 g at the start of the next control step. */
  bounceTrimPending: boolean;
}

export interface AircraftState {
  // ---- rigid body (integrated by the flight module) ----
  /** World position of the reference point (centre of gravity), m. y = altitude above sea level. */
  position: Vector3;
  /** World inertial velocity, m/s. */
  velocity: Vector3;
  /** Body → world rotation. */
  orientation: Quaternion;
  /** Body-frame angular velocity, rad/s (right-hand rule about body axes; see core/frames.ts). */
  angularVelocity: Vector3;
  /** World linear acceleration over the last step, m/s². */
  acceleration: Vector3;

  // ---- state at the START of the last flight step (for sub-step interpolation) ----
  prevPosition: Vector3;
  prevVelocity: Vector3;
  prevOrientation: Quaternion;

  // ---- forces from other systems, applied in the NEXT flight step, then cleared ----
  /** Extra body-frame force, N (gun recoil, store ejection reaction…). */
  externalForceBody: Vector3;
  /** Extra body-frame moment about the CG, N·m. */
  externalMomentBody: Vector3;

  // ---- derived each step by the flight module ----
  /** Air-relative velocity in the body frame, m/s. */
  airVelocityBody: Vector3;
  /** Wind (mean wind plus turbulence) at the aircraft, world m/s, the direction the air moves. */
  wind: Vector3;
  /** True airspeed, m/s. */
  tas: number;
  /** Indicated (calibrated) airspeed, m/s. */
  ias: number;
  mach: number;
  /** Dynamic pressure, Pa. */
  dynamicPressure: number;
  /** Angle of attack, rad (+ nose above the flight path). */
  alpha: number;
  /** Sideslip, rad (+ relative wind from the right). */
  beta: number;
  /** Normal load factor along body +Y, g (1 in level flight). */
  gLoad: number;
  /** Lateral load factor along body +X, g (the slip ball: + = pushed right). */
  lateralG: number;
  /** Longitudinal load factor along the nose (body −Z), g (+ = pushed back in the seat). */
  axialG: number;
  /** Heading / pitch / bank, rad (see core/frames.ts). */
  heading: number;
  pitch: number;
  bank: number;
  /** Climb angle of the velocity vector, rad. */
  flightPathAngle: number;
  /** Track over the ground, rad, 0 = north. */
  track: number;
  groundSpeed: number;
  /** m/s, + up. */
  verticalSpeed: number;
  /** Height above sea level, m (= position.y). */
  altitude: number;
  /** Height above the ground directly below (radar altimeter), m. */
  agl: number;
  /** Static stall angle of attack in the present configuration (flaps, slats, Mach), rad. */
  stallAlpha: number;
  /** Aerodynamic lift and drag coefficients this step (wind axes; energy displays, tests). */
  liftCoefficient: number;
  dragCoefficient: number;
  /** Airframe buffet intensity 0..1 (approach to stall, overspeed). */
  buffet: number;

  // ---- mass ----
  /** Total mass including fuel, ammunition and stores, kg. */
  mass: number;
  /** Centre of gravity in body coordinates, m (moves with fuel and stores). */
  cgBody: Vector3;
  /**
   * Inertia about the CG, kg·m², in AVIATION body axes: xx roll (about the nose axis, body Z),
   * yy pitch (about body X), zz yaw (about body Y), xz the roll–yaw product ∫x·z dm with x
   * forward and z down.
   */
  inertia: { xx: number; yy: number; zz: number; xz: number };
  /** Internal fuel, kg. */
  fuel: number;
  /** Positive g limit for the present load (lower with heavy stores). */
  gLimitPositive: number;
  gLimitNegative: number;

  // ---- systems ----
  engines: [EngineState, EngineState];
  surfaces: SurfaceState;
  trim: TrimState;
  /** Flap handle: 0 UP, 1 MVR (7°), 2 DN (20°). */
  flapHandle: 0 | 1 | 2;
  /** Speed brake command, 0..1 (the switch moves it while held). */
  speedBrakeCmd: number;
  gearDown: boolean;
  /** Gear position, 0 up … 1 down and locked (transit takes several seconds). */
  gearPosition: number;
  autopilot: AutopilotState;
  pac: PacState;
  /** Altitude alert setting, m above ground (radar). */
  altitudeAlert: number;
  warnings: Record<WarningId, boolean>;
  groundCollision: GroundCollisionState;
  fcs: FlightControlInternals;

  // ---- outcome ----
  /** The aircraft hit the ground or broke up; the step functions stop moving it. */
  crashed: boolean;
  /** Highest g reached in this flight, for the debrief. */
  maxG: number;
  /** Lowest g reached in this flight, for the debrief. */
  minG: number;
}
