/**
 * Response curve shared by the analog sources (gamepad sticks, the touch stick): a blend of
 * linear and quadratic that keeps full deflection at 1 but softens the first half of the
 * travel, so small corrections are easy and the ends are still reachable.
 */

/** How much of the curve is quadratic (0 = linear). */
export const RESPONSE_SOFTNESS = 0.4;

/** Odd-symmetric: maps [-1, 1] onto [-1, 1], monotonic, with f(0) = 0 and f(±1) = ±1. */
export function responseCurve(v: number, softness = RESPONSE_SOFTNESS): number {
  const a = Math.abs(v);
  return v * (1 - softness + softness * a);
}
