/**
 * Flight-model constants.
 *
 * UNITS: metres, seconds, TONNES for mass and KILONEWTONS for force
 * (so acceleration = force / mass is in m/s² with no conversion factor, and the
 * numbers stay well inside single-precision range for the physics engine).
 *
 * Owned by the physics module — tune here. Other modules may read but not edit.
 */
import { DEG2RAD } from '../utils/math';
import { TURBINE } from './layout';

export const PHYS = {
  gravity: 9.81,
  /** Carrier mass in tonnes. */
  mass: 100_000,
  /** Principal moments of inertia (t·m²) about local X (pitch), Y (yaw), Z (roll). */
  inertia: [9.0e8, 9.4e8, 1.8e8] as readonly [number, number, number],
  /** Max thrust per turbine at sea level, kN. Four turbines give ≈ 1.63 × weight. */
  maxThrust: 400_000,
  /** Air-density scale height (m): thrust and drag fall off as exp(-altitude / scaleHeight). */
  densityScaleHeight: 9000,
  /** First-order spool response rates (1/s) of the fans when speeding up / slowing down. */
  spoolUpRate: 0.9,
  spoolDownRate: 0.7,
  /** Max tilt slew rate of a nacelle, rad/s. */
  tiltRate: 18 * DEG2RAD,
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
