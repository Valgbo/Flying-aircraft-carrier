/**
 * Flight-model constants.
 *
 * UNITS: metres, seconds, TONNES for mass and KILONEWTONS for force
 * (so acceleration = force / mass is in m/s² with no conversion factor, and the
 * numbers stay well inside single-precision range for the physics engine).
 *
 * Owned by the physics module — tune here. Other modules may read but not edit.
 *
 * Where the numbers come from (the closed-loop tests in tests/unit assert the resulting feel):
 *   - four turbines give ≈ 1.63 × weight at sea level, so the hover throttle is ≈ 61 % and the
 *     thrust ceiling (thrust = weight at full throttle) sits near 4400 m;
 *   - drag is strongly anisotropic: the hull slips through the air bow-first, resists sliding
 *     sideways and, falling flat, behaves like a leaf (terminal sink rate ≈ 27 m/s);
 *   - the yaw and pitch inertia assume the mass is concentrated amidships (reactor, hangar,
 *     magazines), which is what lets differential nacelle tilt stop a turn in a couple of seconds.
 */
import { DEG2RAD } from '../utils/math';
import { TURBINE } from './layout';

export const PHYS = {
  gravity: 9.81,
  /** Carrier mass in tonnes. */
  mass: 100_000,
  /** Principal moments of inertia (t·m²) about local X (pitch), Y (yaw), Z (roll). */
  inertia: [3.6e8, 3.9e8, 1.3e8] as readonly [number, number, number],
  /** Max thrust per turbine at sea level, kN. Four turbines give ≈ 1.63 × weight. */
  maxThrust: 400_000,
  /** Air-density scale height (m): thrust and drag fall off as exp(-altitude / scaleHeight). */
  densityScaleHeight: 9000,
  /** First-order spool response rates (1/s) of the fans when speeding up / slowing down. */
  spoolUpRate: 0.9,
  spoolDownRate: 0.7,
  /** Max tilt slew rate of a nacelle, rad/s. */
  tiltRate: 24 * DEG2RAD,
  tiltMin: TURBINE.tiltMinDeg * DEG2RAD,
  tiltMax: TURBINE.tiltMaxDeg * DEG2RAD,
  /** Sea water density, t/m³. */
  waterDensity: 1.025,
} as const;

/** Weight of the ship in kN. */
export const WEIGHT = PHYS.mass * PHYS.gravity;

/** Per-turbine throttle (0..1) that exactly balances the weight in a level hover at sea level. */
export const HOVER_THROTTLE = WEIGHT / (4 * PHYS.maxThrust);

/** Altitude the ship idles at in the menu and hangar scenes (m ASL). */
export const IDLE_ALTITUDE = 420;
/** Altitude flight-ops mode starts at (m ASL). */
export const OPS_START_ALTITUDE = 600;

/** Aerodynamics of the hull. Every term scales with the air-density factor. */
export const AERO = {
  /** Quadratic drag, kN per (m/s)², along local X (sideways), Y (vertical), Z (bow axis). */
  dragQuadratic: [400, 1300, 78] as readonly [number, number, number],
  /** Linear drag, kN per (m/s), same axes — keeps low-speed motion damped. */
  dragLinear: [1500, 3000, 800] as readonly [number, number, number],
  /** Rotational damping in still air, kN·m per (rad/s), about local X (pitch), Y (yaw), Z (roll). */
  angularDamping: [6.0e7, 5.0e7, 3.0e7] as readonly [number, number, number],
  /**
   * Squared radius of gyration (m²) of the area that resists rotation about local X, Y, Z:
   * the ends of the deck plunge through the air when the ship pitches, the sides when it
   * rolls, bow and stern sweep sideways when it yaws. Multiplied by the drag slope of that
   * area at the current airspeed it gives the extra damping of a moving ship — which is what
   * keeps a flat fall from turning into a tumble.
   */
  dampingGyration: [5500, 5500, 420] as readonly [number, number, number],
  /**
   * How far (m) the centre of pressure of the vertical drag moves toward the leading edge of
   * the deck in a flat fall, along local X and Z. It is what rights the ship like a falling
   * leaf when it sinks with dead engines.
   */
  pressureShift: [9, 40] as readonly [number, number],
  /** Extra thrust close to the sea (ground effect): gain × exp(-nozzle height / height scale). */
  groundEffectGain: 0.05,
  groundEffectHeight: 30,
} as const;

/** Hydrostatics and hydrodynamics of the hull in the water. */
export const HYDRO = {
  /** Heave damping of the whole hull at the design draft, kN per (m/s). */
  heaveDamping: 140_000,
  /** Quadratic slamming drag of the whole hull, kN per (m/s)² — what stops a hard splashdown. */
  slamDrag: 3000,
  /** Sideways drag of the immersed hull: linear kN per (m/s) and quadratic kN per (m/s)². */
  lateralLinear: 20_000,
  lateralQuadratic: 4000,
  /** Drag along the keel line, same units. */
  longitudinalLinear: 2500,
  longitudinalQuadratic: 150,
  /** Waterplane area (m²) of one nacelle acting as an outrigger float when it dips in. */
  nacelleFloatArea: 900,
} as const;

/** Flight computer (flight assist) and manual-mode handling. */
export const FLIGHT = {
  /** Highest altitude the computer accepts as a target, m — safely below the thrust ceiling. */
  maxTargetAltitude: 3500,
  /** How fast full collective moves the target altitude, m/s. */
  targetRate: 24,
  /** The pilot cannot push the target further than this from the ship, m. */
  targetLead: 90,
  /** Vertical-speed limits of the altitude hold, m/s. */
  climbRateMax: 25,
  sinkRateMax: 22,
  /** Altitude error → vertical speed, 1/s (close to the target). */
  altitudeGain: 0.35,
  /** Deceleration the approach profile plans for further out, m/s². */
  approachDecel: 2.2,
  /**
   * Flare: close to the sea the sink rate is limited to `touchdownSinkRate` (m/s) plus
   * `flareGain` (1/s) × keel height, so a commanded descent always meets the water softly.
   */
  touchdownSinkRate: 1.5,
  flareGain: 0.3,
  /** Vertical-speed error → acceleration, 1/s. */
  verticalSpeedGain: 1.0,
  /** Altitude error → acceleration trim, 1/s², and its limit, m/s². */
  altitudeIntegralGain: 0.06,
  altitudeIntegralLimit: 1.2,
  /** Largest vertical acceleration the computer asks for, m/s². */
  verticalAccelLimit: 5,
  /**
   * Spool-lag compensation: the throttle command overshoots the wanted throttle by this many
   * times the remaining error, which shortens the effective lag to 1 / (1 + lead).
   */
  throttleLead: 2,
  /** Lowest collective the computer uses while airborne (fraction of weight) so the fans never lose attitude authority. */
  minCollective: 0.12,
  /** Share of full throttle the hover feed-forward may use before the nacelle tilt is held back. */
  tiltThrottleBudget: 0.86,
  /** If the fans still run out of lift, the nacelles are pulled back at this rate (rad/s) and released at `tiltRecoverRate`. */
  tiltReliefRate: 4 * DEG2RAD,
  tiltRecoverRate: 1.5 * DEG2RAD,
  /** How fast full tilt input moves the tilt lever, rad/s. */
  leverRate: 14 * DEG2RAD,
  /** How far tilt input can push the lever past what the lift budget allows the nacelles, rad. */
  leverOverrun: 2 * DEG2RAD,
  /** Neutral stop: a lever that reaches 0° waits there for this long while the input stays held, s. */
  leverNeutralHold: 0.6,
  /** Attitude hold: natural frequency (rad/s) per axis, damping ratio, integral gain (1/s³) and limit (rad/s²). */
  pitchFrequency: 1.0,
  rollFrequency: 1.1,
  attitudeDamping: 0.9,
  attitudeIntegralGain: 0.1,
  attitudeIntegralLimit: 0.02,
  /** Bank commanded by full strafe input, rad; the command eases in at `bankResponse` (1/s), never faster than `bankRate` (rad/s). */
  maxBank: 8 * DEG2RAD,
  bankRate: 5 * DEG2RAD,
  bankResponse: 1.4,
  /** Yaw: rate at full input (rad/s), rate-loop gain (1/s), heading-hold gain (1/s), capture threshold (rad/s). */
  yawRateMax: 6.5 * DEG2RAD,
  yawRateGain: 1.6,
  headingGain: 0.6,
  headingCaptureRate: 0.6 * DEG2RAD,
  /** Largest differential tilt (each side, rad) the computer uses for yaw. */
  yawTiltMax: 18 * DEG2RAD,
  /** Manual mode: throttle change per second at full collective, tilt change per second at full tilt input. */
  manualThrottleRate: 0.22,
  manualTiltRate: 14 * DEG2RAD,
  /** Manual mode: momentary differential tilt at full yaw input (each side, rad). */
  manualYawTilt: 10 * DEG2RAD,
  /** Manual mode: momentary differential throttle at full strafe input (each side). */
  manualStrafeThrottle: 0.06,
} as const;

/** Wind and turbulence. `level` 1 is the light air of free flight. */
export const WIND = {
  /** Mean wind speed per unit level, m/s. */
  meanSpeed: 3.5,
  /** Gust amplitude per unit level, m/s. */
  gustSpeed: 1.6,
  /** Turbulence torque amplitude per unit level² about local X, Y, Z, kN·m. */
  turbulenceTorque: [7.5e5, 4.0e5, 5.0e5] as readonly [number, number, number],
  /** Levels used by the driver. */
  freeFlightLevel: 1,
  opsLevel: 2.6,
} as const;

/** Sink rate at water contact (m/s) above which a splashdown counts as a hard landing. */
export const HARD_LANDING_SINK_RATE = 7;
