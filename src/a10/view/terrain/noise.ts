/**
 * Small, fast, deterministic noise for the terrain bake (worker) and generated textures.
 * Our own (the world module's noise is internal to it): integer hash → value noise → fBm.
 */

/** 32-bit integer hash of two integers and a seed → [0, 1). */
export function hash01(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise, [0, 1), lattice spacing 1. */
export function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash01(ix, iz, seed);
  const b = hash01(ix + 1, iz, seed);
  const c = hash01(ix, iz + 1, seed);
  const d = hash01(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/** Fractal value noise, [0, 1): `octaves` at doubling frequency, amplitude halving. */
export function fbm(x: number, z: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * f, z * f, seed + o * 1013);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** Periodic value noise on a `period` lattice (tiles seamlessly), [0, 1). */
export function tilingNoise(x: number, z: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const x0 = ((ix % period) + period) % period;
  const z0 = ((iz % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const z1 = (z0 + 1) % period;
  const a = hash01(x0, z0, seed);
  const b = hash01(x1, z0, seed);
  const c = hash01(x0, z1, seed);
  const d = hash01(x1, z1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/** Periodic fBm on a texture of `size` texels with base lattice `cells` (tiles seamlessly). */
export function tilingFbm(
  u: number,
  v: number,
  cells: number,
  octaves: number,
  seed: number,
): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let c = cells;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tilingNoise(u * c, v * c, c, seed + o * 7919);
    norm += amp;
    amp *= 0.5;
    c *= 2;
  }
  return sum / norm;
}
