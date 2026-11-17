/**
 * Small geometry helpers of the debrief: miss distances, clock directions and the heading frames
 * the plots use. Pure functions on world x/z (x east, z south; compass headings, 0 = north,
 * clockwise), so the weapons module and the screens can share them.
 */

const TWO_PI = Math.PI * 2;
const HOUR = Math.PI / 6;

/** A point in a heading frame: x to the right of the heading, y along it (ahead +), m. */
export interface FramePoint {
  x: number;
  y: number;
}

/**
 * An offset (dx east, dz south) in the frame of a compass heading: x to the right, y ahead.
 * Ahead is (sin h, −cos h) in world x/z and right is (cos h, sin h).
 */
export function toHeadingFrame(
  dx: number,
  dz: number,
  heading: number,
  out: FramePoint = { x: 0, y: 0 },
): FramePoint {
  const s = Math.sin(heading);
  const c = Math.cos(heading);
  out.x = dx * c + dz * s;
  out.y = dx * s - dz * c;
  return out;
}

/**
 * Clock direction of a miss (dx east, dz south from the target) seen along a run-in heading, the
 * way a range scores a bomb: 12 o'clock is long (beyond the target along the run-in), 3 right,
 * 6 short, 9 left. NaN for a hit on the point itself (no direction).
 */
export function missClock(dx: number, dz: number, runIn: number): number {
  if (dx * dx + dz * dz < 1e-6) return NaN;
  const bearing = Math.atan2(dx, -dz);
  let rel = (bearing - runIn) % TWO_PI;
  if (rel < 0) rel += TWO_PI;
  const c = Math.round(rel / HOUR) % 12;
  return c === 0 ? 12 : c;
}

/** Horizontal distance between two world points, m. */
export function groundDistance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

/**
 * Distance from a point to a line across a run-in, measured along the run-in: how far the point
 * is SHORT of the line through (lx, lz) perpendicular to the heading (negative once past it), m.
 */
export function shortOfLine(px: number, pz: number, lx: number, lz: number, runIn: number): number {
  return (lx - px) * Math.sin(runIn) - (lz - pz) * Math.cos(runIn);
}

/** Compass heading of a world direction (dx east, dz south), rad in [0, 2π). */
export function headingOfOffset(dx: number, dz: number): number {
  const h = Math.atan2(dx, -dz);
  return h < 0 ? h + TWO_PI : h;
}

/** Median of a list (the circular error probable of a set of miss distances); NaN when empty. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Mean of a list; NaN when empty. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}
