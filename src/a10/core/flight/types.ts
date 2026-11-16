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
  /** Fan speed as a fraction of maximum (spool-lagged), ~0.55 at idle in flight. */
  n1: number;
  /** Core speed fraction, for gauges and sound. */
  n2: number;
  /** Net thrust produced this step, N. */
  thrust: number;
  /** Interstage turbine temperature, °C, for the gauge. */
  itt: number;
  /** Fuel flow, kg/s. */
  fuelFlow: number;
  running: boolean;
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
  refPitch: number;
  refBank: number;
}

export interface PacState {
  /** Trigger stage seen by PAC: 0 off, 1 = first detent (PAC-1), 2 = firing (PAC-2). */
  stage: 0 | 1 | 2;
  /** PAC is armed (GUN/PAC switch at ARM) and acting. */
  active: boolean;
  /** Pitch and yaw commands PAC added this step, -1..1 of its authority (for gauges/debug). */
  pitchCmd: number;
  yawCmd: number;
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
  /** True airspeed, m/s. */
  tas: number;
  /** Indicated (calibrated) airspeed, m/s. */
  ias: number;
  mach: number;
  /** Angle of attack, rad (+ nose above the flight path). */
  alpha: number;
  /** Sideslip, rad (+ relative wind from the right). */
  beta: number;
  /** Normal load factor along body +Y, g (1 in level flight). */
  gLoad: number;
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

  // ---- mass ----
  /** Total mass including fuel, ammunition and stores, kg. */
  mass: number;
  /** Centre of gravity in body coordinates, m (moves with fuel and stores). */
  cgBody: Vector3;
  /** Body-axis inertia, kg·m². */
  inertia: { xx: number; yy: number; zz: number; xz: number };
  /** Internal fuel, kg. */
  fuel: number;

  // ---- systems ----
  engines: [EngineState, EngineState];
  surfaces: SurfaceState;
  trim: TrimState;
  /** Flap handle: 0 UP, 1 MVR (7°), 2 DN (20°). */
  flapHandle: 0 | 1 | 2;
  /** Speed brake command, 0..1 (the switch moves it while held). */
  speedBrakeCmd: number;
  gearDown: boolean;
  autopilot: AutopilotState;
  pac: PacState;
  /** Altitude alert setting, m above ground (radar). */
  altitudeAlert: number;
  warnings: Record<WarningId, boolean>;

  // ---- outcome ----
  /** The aircraft hit the ground or broke up; the step functions stop moving it. */
  crashed: boolean;
  /** Highest g reached in this flight, for the debrief. */
  maxG: number;
}
