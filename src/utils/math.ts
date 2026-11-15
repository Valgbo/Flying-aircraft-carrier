/** Small dependency-free math helpers shared by simulation, visuals and UI. */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const TAU = Math.PI * 2;

/** metres/second → knots */
export const MS_TO_KTS = 1.943844;
/** metres → feet */
export const M_TO_FT = 3.28084;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

/** Map v from [inMin, inMax] to [outMin, outMax], clamped. */
export function remap(
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  return lerp(outMin, outMax, clamp01(inverseLerp(inMin, inMax, v)));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential smoothing toward a target.
 * `lambda` is the response rate in 1/s (≈ 1 / time-constant). Larger = snappier.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Move `current` toward `target` by at most `maxDelta` (never overshoots). */
export function moveToward(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Wrap an angle in radians to (-π, π]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a <= 0) a += TAU;
  return a - Math.PI;
}

/** Wrap degrees to [0, 360). */
export function wrapDeg360(d: number): number {
  d %= 360;
  return d < 0 ? d + 360 : d;
}

/** Shortest signed difference b - a in degrees, in (-180, 180]. */
export function deltaDeg(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Apply a centred dead zone to a stick axis in [-1, 1] and rescale the remainder. */
export function deadzone(v: number, zone = 0.12): number {
  const a = Math.abs(v);
  if (a <= zone) return 0;
  return Math.sign(v) * ((a - zone) / (1 - zone));
}

/** Deterministic pseudo-random generator (mulberry32). Use for seeded scene content. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
