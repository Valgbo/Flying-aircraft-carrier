/**
 * Geometry of the artificial horizon, the vertical-speed needle and the turbine gauges.
 *
 * SVG conventions used throughout: +x right, +y DOWN, and a positive `rotate()` angle turns
 * CLOCKWISE on screen. The sign conventions of the ship (docs/ARCHITECTURE.md §2):
 * roll > 0 = starboard side down, pitch > 0 = bow up, tilt > 0 = thrust toward the bow.
 */
import { clamp, clamp01 } from '../../utils/math';

/** View box of the attitude indicator is HORIZON_SIZE × HORIZON_SIZE, centred on (50, 50). */
export const HORIZON_SIZE = 100;
export const HORIZON_CENTER = HORIZON_SIZE / 2;
/** Vertical scale of the pitch ladder, user units per degree. */
export const PITCH_UNITS_PER_DEG = 2;
/** The ladder stops here; beyond it the horizon parks at the edge of the instrument. */
export const PITCH_LIMIT_DEG = 30;

/**
 * Rotation of the horizon, SVG degrees. When the ship rolls to starboard the pilot sees the
 * horizon rotate counter-clockwise, so the angle is the negated roll.
 */
export function horizonRotationDeg(rollDeg: number): number {
  if (!Number.isFinite(rollDeg)) return 0;
  return -clamp(rollDeg, -180, 180);
}

/**
 * Translation of the horizon along the instrument's own vertical axis, user units.
 * Bow up moves the horizon DOWN the instrument (+y).
 */
export function horizonShift(pitchDeg: number): number {
  if (!Number.isFinite(pitchDeg)) return 0;
  return clamp(pitchDeg, -PITCH_LIMIT_DEG, PITCH_LIMIT_DEG) * PITCH_UNITS_PER_DEG;
}

export interface LadderRung {
  /** Pitch angle of the rung, degrees (positive = above the horizon). */
  deg: number;
  /** y of the rung in the un-shifted horizon group. */
  y: number;
  halfWidth: number;
  /** Rungs at whole tens carry a number. */
  label: string | null;
}

/** Rungs every 5° up to the pitch limit, wider and labelled at the tens. */
export function buildPitchLadder(): LadderRung[] {
  const rungs: LadderRung[] = [];
  for (let deg = -PITCH_LIMIT_DEG; deg <= PITCH_LIMIT_DEG; deg += 5) {
    if (deg === 0) continue;
    const tens = deg % 10 === 0;
    rungs.push({
      deg,
      y: HORIZON_CENTER - deg * PITCH_UNITS_PER_DEG,
      halfWidth: tens ? 11 : 5,
      label: tens ? String(Math.abs(deg)) : null,
    });
  }
  return rungs;
}

/** Bank angles marked on the roll scale, degrees either side of zero. */
export const ROLL_SCALE_MARKS: readonly number[] = [-45, -30, -20, -10, 0, 10, 20, 30, 45];

/** Full-scale deflection of the vertical-speed needle, m/s. */
export const VSI_FULL_SCALE = 30;

/**
 * Needle deflection of the vertical-speed indicator, -1 (full descent) .. +1 (full climb).
 * Square-root law: half the travel covers the first quarter of the range, so small rates
 * near a hover stay readable.
 */
export function vsiFraction(verticalSpeed: number): number {
  if (!Number.isFinite(verticalSpeed)) return 0;
  const magnitude = Math.sqrt(Math.min(Math.abs(verticalSpeed), VSI_FULL_SCALE) / VSI_FULL_SCALE);
  return verticalSpeed < 0 ? -magnitude : magnitude;
}

/** The throttle arc starts at the lower left of the dial and sweeps clockwise over the top. */
export const ARC_START_DEG = 135;
export const ARC_SWEEP_DEG = 270;

/** SVG angle of a 0..1 value on the throttle arc. */
export function arcAngleDeg(fraction: number): number {
  return ARC_START_DEG + clamp01(Number.isFinite(fraction) ? fraction : 0) * ARC_SWEEP_DEG;
}

/** Length of the lit part of the arc for a 0..1 value on a circle of `radius`. */
export function arcLength(fraction: number, radius: number): number {
  const full = 2 * Math.PI * radius * (ARC_SWEEP_DEG / 360);
  return clamp01(Number.isFinite(fraction) ? fraction : 0) * full;
}

export type GaugeState = 'normal' | 'high' | 'off';

/** Above this throttle a gauge turns amber: the turbine has no margin left. */
export const HIGH_THROTTLE = 0.95;

export function gaugeState(enabled: boolean, throttle: number): GaugeState {
  if (!enabled) return 'off';
  return throttle > HIGH_THROTTLE ? 'high' : 'normal';
}

/**
 * Position of a value on a linear bar, 0..1 — used by the live bars of the turbine panel
 * (throttle 0..1 and tilt between the nacelle limits).
 */
export function barFraction(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || max <= min) return 0;
  return clamp01((value - min) / (max - min));
}
