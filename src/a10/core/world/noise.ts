/**
 * Deterministic hash-based gradient noise (no tables, no global state, no Math.random): the world
 * generator, the terrain's analytic micro-detail and the gust field are built from it. The same
 * inputs give the same bits on the main thread and in a worker.
 *
 * Noise values are scaled to roughly [-1, 1]. Gradient bounds (per lattice unit) are given so ray
 * queries can use the micro-detail as a Lipschitz-bounded function.
 */

/**
 * 32-bit hash of two integers and a seed (multiply–xorshift, murmur3 finaliser), as a SIGNED
 * int32 (stays a small integer in V8: no heap-number boxing in hot loops). Use `>>> 0` or
 * hash01 for an unsigned value.
 */
export function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return h ^ (h >>> 16);
}

/** 32-bit hash of three integers and a seed (signed int32, see hash2). */
export function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h =
    Math.imul(ix | 0, 0x27d4eb2d) ^
    Math.imul(iy | 0, 0x9e3779b1) ^
    Math.imul(iz | 0, 0x165667b1) ^
    (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return h ^ (h >>> 16);
}

/** Uniform [0, 1) from a lattice point and a seed. */
export function hash01(ix: number, iz: number, seed: number): number {
  return (hash2(ix, iz, seed) >>> 0) / 4294967296;
}

/** 16 unit gradients, rotated off the axes so the lattice does not show. */
const GX = new Float64Array(16);
const GZ = new Float64Array(16);
for (let k = 0; k < 16; k++) {
  const a = ((k + 0.37) * Math.PI) / 8;
  GX[k] = Math.cos(a);
  GZ[k] = Math.sin(a);
}

/** Scale that brings 2D gradient noise (|n| ≤ √2/2 with unit gradients) to ≈ [-1, 1]. */
const N2 = Math.SQRT2;

/**
 * Upper bound of |∇ noise2| per lattice unit (after the N2 scaling). Derived from the quintic
 * fade (max slope 15/8) and unit gradients: |∂n/∂x| ≤ (15/8)·√5/2·2 + 1 per unscaled unit,
 * combined over both axes; measured maxima are about half of it.
 */
export const NOISE2_GRAD_BOUND = N2 * Math.SQRT2 * ((15 / 8) * Math.sqrt(5) + 1);

/** Peak |noise2| (after scaling). */
export const NOISE2_PEAK = 1.0;

/** 2D gradient noise in ≈ [-1, 1], C2 (quintic fade). */
export function noise2(x: number, z: number, seed: number): number {
  const fx0 = Math.floor(x);
  const fz0 = Math.floor(z);
  const fx = x - fx0;
  const fz = z - fz0;
  const ix = fx0 | 0;
  const iz = fz0 | 0;
  const h00 = hash2(ix, iz, seed) & 15;
  const h10 = hash2(ix + 1, iz, seed) & 15;
  const h01 = hash2(ix, iz + 1, seed) & 15;
  const h11 = hash2(ix + 1, iz + 1, seed) & 15;
  const g00 = GX[h00] * fx + GZ[h00] * fz;
  const g10 = GX[h10] * (fx - 1) + GZ[h10] * fz;
  const g01 = GX[h01] * fx + GZ[h01] * (fz - 1);
  const g11 = GX[h11] * (fx - 1) + GZ[h11] * (fz - 1);
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  return N2 * (g00 + u * (g10 - g00) + v * (g01 - g00) + u * v * (g00 - g10 - g01 + g11));
}

/** Noise value and its gradient (per lattice unit). */
export interface NoiseD {
  v: number;
  dx: number;
  dz: number;
}

/** 2D gradient noise with its analytic gradient, written into `out`. */
export function noise2d(x: number, z: number, seed: number, out: NoiseD): NoiseD {
  const fx0 = Math.floor(x);
  const fz0 = Math.floor(z);
  const fx = x - fx0;
  const fz = z - fz0;
  const ix = fx0 | 0;
  const iz = fz0 | 0;
  const h00 = hash2(ix, iz, seed) & 15;
  const h10 = hash2(ix + 1, iz, seed) & 15;
  const h01 = hash2(ix, iz + 1, seed) & 15;
  const h11 = hash2(ix + 1, iz + 1, seed) & 15;
  const g00 = GX[h00] * fx + GZ[h00] * fz;
  const g10 = GX[h10] * (fx - 1) + GZ[h10] * fz;
  const g01 = GX[h01] * fx + GZ[h01] * (fz - 1);
  const g11 = GX[h11] * (fx - 1) + GZ[h11] * (fz - 1);
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const du = 30 * fx * fx * (fx * (fx - 2) + 1);
  const dv = 30 * fz * fz * (fz * (fz - 2) + 1);
  const k1 = g10 - g00;
  const k2 = g01 - g00;
  const k3 = g00 - g10 - g01 + g11;
  out.v = N2 * (g00 + u * k1 + v * k2 + u * v * k3);
  // d/dx of the bilinear blend of the four corner ramps, plus the ramps' own slopes.
  const ax = GX[h00] + u * (GX[h10] - GX[h00]) + v * (GX[h01] - GX[h00]);
  const bx = u * v * (GX[h00] - GX[h10] - GX[h01] + GX[h11]);
  const az = GZ[h00] + u * (GZ[h10] - GZ[h00]) + v * (GZ[h01] - GZ[h00]);
  const bz = u * v * (GZ[h00] - GZ[h10] - GZ[h01] + GZ[h11]);
  out.dx = N2 * (ax + bx + du * (k1 + v * k3));
  out.dz = N2 * (az + bz + dv * (k2 + u * k3));
  return out;
}

/** 3D gradient noise in ≈ [-1, 1] (12 cube-edge gradients). */
export function noise3(x: number, y: number, z: number, seed: number): number {
  const fx0 = Math.floor(x);
  const fy0 = Math.floor(y);
  const fz0 = Math.floor(z);
  const fx = x - fx0;
  const fy = y - fy0;
  const fz = z - fz0;
  const ix = fx0 | 0;
  const iy = fy0 | 0;
  const iz = fz0 | 0;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const n000 = grad3(hash3(ix, iy, iz, seed), fx, fy, fz);
  const n100 = grad3(hash3(ix + 1, iy, iz, seed), fx - 1, fy, fz);
  const n010 = grad3(hash3(ix, iy + 1, iz, seed), fx, fy - 1, fz);
  const n110 = grad3(hash3(ix + 1, iy + 1, iz, seed), fx - 1, fy - 1, fz);
  const n001 = grad3(hash3(ix, iy, iz + 1, seed), fx, fy, fz - 1);
  const n101 = grad3(hash3(ix + 1, iy, iz + 1, seed), fx - 1, fy, fz - 1);
  const n011 = grad3(hash3(ix, iy + 1, iz + 1, seed), fx, fy - 1, fz - 1);
  const n111 = grad3(hash3(ix + 1, iy + 1, iz + 1, seed), fx - 1, fy - 1, fz - 1);
  const x00 = n000 + u * (n100 - n000);
  const x10 = n010 + u * (n110 - n010);
  const x01 = n001 + u * (n101 - n001);
  const x11 = n011 + u * (n111 - n011);
  const y0 = x00 + v * (x10 - x00);
  const y1 = x01 + v * (x11 - x01);
  // Edge gradients have length √2; peak of the blend ≈ 1.04 → scale to ≈ [-1, 1].
  return 0.96 * (y0 + w * (y1 - y0));
}

/** Dot product of one of the 12 cube-edge gradients (chosen by hash) with (x, y, z). */
function grad3(h: number, x: number, y: number, z: number): number {
  switch ((h >>> 0) % 12) {
    case 0:
      return x + y;
    case 1:
      return -x + y;
    case 2:
      return x - y;
    case 3:
      return -x - y;
    case 4:
      return x + z;
    case 5:
      return -x + z;
    case 6:
      return x - z;
    case 7:
      return -x - z;
    case 8:
      return y + z;
    case 9:
      return -y + z;
    case 10:
      return y - z;
    default:
      return -y - z;
  }
}

/** Fractal sum of 2D noise: octaves at doubling frequency, amplitude × gain each. */
export function fbm2(
  x: number,
  z: number,
  octaves: number,
  seed: number,
  gain = 0.5,
  lacunarity = 2.0,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fz = z;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(fx, fz, seed + o * 1013);
    norm += amp;
    amp *= gain;
    // Rotate each octave (≈ 37°) so lattice directions do not line up.
    const nx = 0.8 * fx - 0.6 * fz;
    const nz = 0.6 * fx + 0.8 * fz;
    fx = nx * lacunarity + 17.13;
    fz = nz * lacunarity - 9.71;
  }
  return sum / norm;
}

/** Ridged fractal noise in [0, 1]: sharp crests where the noise crosses zero. */
export function ridged2(x: number, z: number, octaves: number, seed: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let weight = 1;
  let fx = x;
  let fz = z;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(noise2(fx, fz, seed + o * 7919));
    n *= n;
    n *= weight;
    weight = Math.min(1, Math.max(0, n * 1.6));
    sum += amp * n;
    norm += amp;
    amp *= gain;
    const nx = 0.8 * fx - 0.6 * fz;
    const nz = 0.6 * fx + 0.8 * fz;
    fx = nx * 2.03 + 3.1;
    fz = nz * 2.03 - 7.7;
  }
  return sum / norm;
}

const _nd: NoiseD = { v: 0, dx: 0, dz: 0 };

/**
 * "Eroded" fractal noise: each octave is damped by the slope accumulated so far, so slopes stay
 * smooth in valleys and detail gathers on crests (after I. Quílez's derivative-damped fBm).
 * Returns ≈ [-1, 1].
 */
export function erodedFbm2(x: number, z: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let dsx = 0;
  let dsz = 0;
  let fx = x;
  let fz = z;
  let scale = 1;
  for (let o = 0; o < octaves; o++) {
    noise2d(fx, fz, seed + o * 4111, _nd);
    // Accumulate the gradient in world units of the first octave.
    dsx += _nd.dx * scale * amp;
    dsz += _nd.dz * scale * amp;
    sum += (amp * _nd.v) / (1 + 0.6 * (dsx * dsx + dsz * dsz));
    norm += amp;
    amp *= 0.5;
    scale *= 2;
    const nx = 0.8 * fx - 0.6 * fz;
    const nz = 0.6 * fx + 0.8 * fz;
    fx = nx * 2 + 11.3;
    fz = nz * 2 - 5.1;
  }
  return sum / norm;
}

/** Hermite smoothstep of x between e0 and e1 (clamped). */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = (x - e0) / (e1 - e0);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
