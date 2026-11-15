/**
 * Pure value formatting for the HUD and the turbine panel. Everything here returns plain
 * strings / small enums so it can be unit-tested without a DOM.
 */
import { PHYS } from '../../config/physicsConfig';
import { clamp, wrapDeg360 } from '../../utils/math';

/** Compass heading as three zero-padded digits; 359.6° reads 000, never 360. */
export function formatHeading(headingDeg: number): string {
  if (!Number.isFinite(headingDeg)) return '000';
  const whole = Math.round(wrapDeg360(headingDeg)) % 360;
  return String(whole).padStart(3, '0');
}

/** Rounded integer without a negative zero ("-0"). */
export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value);
  return String(rounded === 0 ? 0 : rounded);
}

/** Signed fixed-point number: "+3.2", "-0.4", and a bare "0.0" when it rounds to zero. */
export function formatSigned(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return (0).toFixed(decimals);
  const magnitude = Math.abs(value).toFixed(decimals);
  if (Number(magnitude) === 0) return magnitude;
  return (value > 0 ? '+' : '-') + magnitude;
}

/** Nacelle tilt in whole degrees with an explicit sign, e.g. "+12°", "-5°", "0°". */
export function formatTiltDeg(tiltDeg: number): string {
  if (!Number.isFinite(tiltDeg)) return '0°';
  const rounded = Math.round(tiltDeg);
  if (rounded === 0) return '0°';
  return `${rounded > 0 ? '+' : '-'}${Math.abs(rounded)}°`;
}

/** A 0..1 fraction as a whole percentage (clamped to 0..100). */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '0';
  return String(Math.round(clamp(fraction, 0, 1) * 100));
}

/** Thrust of one turbine as a fraction of its sea-level maximum, 0..1. */
export function thrustFraction(thrustKN: number): number {
  if (!Number.isFinite(thrustKN)) return 0;
  return clamp(thrustKN / PHYS.maxThrust, 0, 1);
}

/** Thrust in meganewtons for the panel readout (the model works in kN). */
export function formatThrustMN(thrustKN: number): string {
  if (!Number.isFinite(thrustKN)) return '0';
  return String(Math.round(Math.max(0, thrustKN) / 1000));
}

export type MotionSense = 'ahead' | 'astern' | 'stopped';

/** Below this the ship is treated as stopped, so the indicator does not chatter in a hover. */
export const MOTION_DEADBAND_KTS = 0.5;

/**
 * Whether the ship is making way ahead or astern, from the speed along its own axis.
 * That axis tilts with the bow, so a pure climb with the bow up has a forward component:
 * without ground speed the ship counts as stopped.
 */
export function motionSense(forwardSpeedKts: number, groundSpeedKts: number): MotionSense {
  if (groundSpeedKts <= MOTION_DEADBAND_KTS) return 'stopped';
  if (forwardSpeedKts > MOTION_DEADBAND_KTS) return 'ahead';
  if (forwardSpeedKts < -MOTION_DEADBAND_KTS) return 'astern';
  return 'stopped';
}

export type VerticalTrend = 'climb' | 'descent' | 'level';

/** Dead band of the climb / descent colouring, m/s. */
export const VERTICAL_DEADBAND = 0.25;

export function verticalTrend(verticalSpeed: number): VerticalTrend {
  if (verticalSpeed > VERTICAL_DEADBAND) return 'climb';
  if (verticalSpeed < -VERTICAL_DEADBAND) return 'descent';
  return 'level';
}

export type TargetSense = 'above' | 'below' | 'held';

/** Where the flight computer's target altitude lies relative to the ship (±3 m counts as held). */
export function targetSense(targetAltitude: number, altitude: number): TargetSense {
  const delta = targetAltitude - altitude;
  if (delta > 3) return 'above';
  if (delta < -3) return 'below';
  return 'held';
}

/** The keel-height readout is only useful near the sea. */
export const SEA_READOUT_BELOW = 250;

/** True when the "SEA nn m" readout should be shown. */
export function showSeaReadout(keelClearance: number, afloat: boolean): boolean {
  return !afloat && keelClearance < SEA_READOUT_BELOW;
}
