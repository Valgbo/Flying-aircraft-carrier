/**
 * Display formatting for the A-10 overlay (OWNED BY THE UI MODULE). The core is SI; the screens
 * show what pilots read: knots, feet, degrees, metres for weapon ranges (PLAN_A10.md §4 "Units").
 * Pure functions, covered by tests/unit/a10/ui-format.test.ts.
 */
import { FT, KT, LB } from '../core/units';

/** Non-breaking space between a number and its unit. */
export const NBSP = ' ';
/** Typographic minus. */
export const MINUS = '−';
/** Shown for a value that is not known (yet). */
export const DASH = '—';

const known = (v: number): boolean => Number.isFinite(v);

/** Whole number with thousands separators and a typographic minus: -1234.6 → "−1,235". */
export function formatInt(n: number): string {
  if (!known(n)) return DASH;
  const r = Math.round(n);
  const text = Math.abs(r).toLocaleString('en-US');
  return r < 0 ? MINUS + text : text;
}

/** Fixed decimals with a typographic minus: (1.234, 1) → "1.2". */
export function formatFixed(n: number, digits: number): string {
  if (!known(n)) return DASH;
  const text = Math.abs(n).toFixed(digits);
  return n < 0 && Number(text) !== 0 ? MINUS + text : text;
}

/** Mass in kilograms: 3412.4 → "3,412 kg". */
export function formatKg(kg: number): string {
  return known(kg) ? `${formatInt(kg)}${NBSP}kg` : DASH;
}

/** Mass in pounds from kilograms: 3412 → "7,522 lb". */
export function formatLbFromKg(kg: number): string {
  return known(kg) ? `${formatInt(kg / LB)}${NBSP}lb` : DASH;
}

/** A distance in metres, rounded to `step` (default 1): 1218 → "1,218 m"; ≤ 0 or unknown → "—". */
export function formatRangeM(m: number, step = 1): string {
  if (!known(m) || m <= 0) return DASH;
  return `${formatInt(Math.round(m / step) * step)}${NBSP}m`;
}

/** A small distance with one decimal under 10 m: 3.46 → "3.5 m", 23.4 → "23 m". */
export function formatMiss(m: number): string {
  if (!known(m) || m < 0) return DASH;
  return m < 10 ? `${formatFixed(m, 1)}${NBSP}m` : `${formatInt(m)}${NBSP}m`;
}

/** Speed in knots from m/s: 154.3 → "300 kn". */
export function formatKnots(ms: number): string {
  return known(ms) ? `${formatInt(ms / KT)}${NBSP}kn` : DASH;
}

/** Height in feet from metres: 300 → "984 ft". */
export function formatFeetFromM(m: number): string {
  return known(m) ? `${formatInt(m / FT)}${NBSP}ft` : DASH;
}

/** Angle in whole degrees from radians, typographic minus: −0.52 → "−30°". */
export function formatDegFromRad(rad: number): string {
  if (!known(rad)) return DASH;
  return `${formatInt((rad * 180) / Math.PI)}°`;
}

/** Load factor: 4.26 → "4.3 g". */
export function formatG(g: number): string {
  return known(g) ? `${formatFixed(g, 1)}${NBSP}g` : DASH;
}

/** Seconds as a clock: 75.4 → "1:15", 3725 → "1:02:05". Negative or unknown → "—". */
export function formatClock(seconds: number): string {
  if (!known(seconds) || seconds < 0) return DASH;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A short duration: 1.43 → "1.4 s". */
export function formatSeconds(seconds: number): string {
  return known(seconds) && seconds >= 0 ? `${formatFixed(seconds, 1)}${NBSP}s` : DASH;
}

/** Fraction as a whole percentage: 0.347 → "35 %"; unknown (0/0) → "—". */
export function formatPct(fraction: number): string {
  return known(fraction) ? `${formatInt(fraction * 100)}${NBSP}%` : DASH;
}

/** Hit rate as "hits / rounds (pct)": (12, 120) → "12 / 120 (10 %)"; no rounds → "0 / 0". */
export function formatHitRate(hits: number, rounds: number): string {
  if (rounds <= 0) return `${formatInt(hits)} / 0`;
  return `${formatInt(hits)} / ${formatInt(rounds)} (${formatPct(hits / rounds)})`;
}

/** Drag area in square metres: 0.4234 → "0.42 m²"; unknown → "—". */
export function formatDragArea(m2: number): string {
  return known(m2) ? `${formatFixed(m2, 2)}${NBSP}m²` : DASH;
}

/** Thickness in millimetres: 27.6 → "28 mm". */
export function formatMm(mm: number): string {
  return known(mm) ? `${formatInt(mm)}${NBSP}mm` : DASH;
}

/** Clock direction 1..12 → "3 o'clock"; anything else → "—". */
export function formatClockDirection(clock: number): string {
  if (!known(clock)) return DASH;
  const c = Math.round(clock);
  if (c < 1 || c > 12) return DASH;
  return `${c} o'clock`;
}

/** "camelCase" or "kebab-case" identifiers as words: 'runningGear' → 'running gear'. */
export function humanize(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .trim();
}

/** First letter upper case: 'penetrated' → 'Penetrated'. */
export function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
