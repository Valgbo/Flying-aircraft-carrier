/**
 * Smooth, deterministic 1-D noise for camera shake, and the trauma model that turns shake
 * energy into an amplitude. Pure functions of their inputs: fed with `sim.time` they freeze
 * on pause and repeat exactly in fixed-time screenshots.
 */

/** Integer lattice hash → [-1, 1]. */
function latticeValue(i: number, seed: number): number {
  let h = Math.imul(i ^ Math.imul(seed + 1, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483647.5 - 1;
}

/**
 * Value noise with quintic interpolation: continuous in value and slope, range [-1, 1].
 * Different `seed`s give independent channels.
 */
export function smoothNoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const a = latticeValue(i, seed);
  const b = latticeValue(i + 1, seed);
  return a + (b - a) * u;
}

/** Two octaves of `smoothNoise`, still within [-1, 1]. */
export function shakeNoise(x: number, seed: number): number {
  return (smoothNoise(x, seed) + 0.5 * smoothNoise(x * 2.03 + 11.7, seed + 101)) / 1.5;
}

/** Shake energy left after `dt` seconds of linear decay at `rate` per second. */
export function decayTrauma(trauma: number, rate: number, dt: number): number {
  return Math.max(0, trauma - rate * dt);
}

/**
 * Trauma-style response: the visible shake grows with the square of the stored energy, so
 * small knocks stay subtle and big ones hit hard. Result is clamped to [0, 1].
 */
export function traumaLevel(trauma: number): number {
  const t = trauma < 0 ? 0 : trauma > 1 ? 1 : trauma;
  return t * t;
}
