/**
 * Display formatting shared by the shell UI (menu, hangar, settings, pause). Pure functions,
 * no DOM — covered by tests/unit/shell.test.ts.
 */
import { clamp01 } from '../../utils/math';

const MINUTES_PER_DAY = 24 * 60;
/** Non-breaking space between a number and its unit, so "400 MN" never wraps apart. */
const NBSP = ' ';
/** Typographic minus — the ASCII hyphen reads as a dash next to a degree sign. */
const MINUS = '−';

/**
 * Time of day in hours → "HH:MM" on a 24-hour clock. Any real number is accepted and wraps
 * at midnight (24 → "00:00", -0.5 → "23:30"); rounding is to the nearest minute.
 */
export function formatTimeOfDay(hours: number): string {
  if (!Number.isFinite(hours)) return '--:--';
  const minutes =
    ((Math.round(hours * 60) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Fraction 0..1 → whole percent with its unit, e.g. 0.613 → "61 %". Clamped to 0..100. */
export function formatPercent(fraction: number): string {
  return `${Math.round(clamp01(fraction) * 100)}${NBSP}%`;
}

/** Plain degrees with a typographic minus: -20 → "−20°", 25 → "25°". */
export function formatDeg(deg: number): string {
  const rounded = Math.round(deg);
  return `${rounded < 0 ? MINUS : ''}${Math.abs(rounded)}°`;
}

/** Degrees with an explicit sign for ranges and offsets: -20 → "−20°", 60 → "+60°", 0 → "0°". */
export function formatSignedDeg(deg: number): string {
  const rounded = Math.round(deg);
  if (rounded === 0) return '0°';
  return `${rounded < 0 ? MINUS : '+'}${Math.abs(rounded)}°`;
}

/** Force in kilonewtons (the physics unit) → whole meganewtons, e.g. 981_000 → "981 MN". */
export function formatMeganewtons(kN: number): string {
  return `${Math.round(kN / 1000).toLocaleString('en-US')}${NBSP}MN`;
}

/** Length in metres, e.g. 38 → "38 m"; pass `digits` for decimals. */
export function formatMeters(m: number, digits = 0): string {
  return `${m.toFixed(digits)}${NBSP}m`;
}

/** Ratio as a multiplier with two decimals, e.g. 1.6309 → "1.63×". */
export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(2)}×`;
}

/**
 * Snap a value onto a slider's step grid (anchored at `min`) and clamp it to the range, so a
 * controlled range input is always handed a value it can represent exactly.
 */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value)) return min;
  const snapped = step > 0 ? min + Math.round((value - min) / step) * step : value;
  const clamped = snapped < min ? min : snapped > max ? max : snapped;
  // strip float noise such as 16.499999999999996
  return Number(clamped.toFixed(6));
}

/** Position of `value` inside [min, max] as a fraction 0..1 (0 for an empty range). */
export function rangeFraction(value: number, min: number, max: number): number {
  return max > min ? clamp01((value - min) / (max - min)) : 0;
}
