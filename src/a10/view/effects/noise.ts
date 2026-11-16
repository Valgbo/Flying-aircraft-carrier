/**
 * Small deterministic noise helpers shared by the effects and vehicle art (CPU side): integer
 * hashing, 2-D value noise and fBm for building textures once at start-up, and a cheap uniform
 * random source for purely cosmetic variation (docs/a10/ARCHITECTURE.md §2: view randomness may
 * use Math.random; this one is seedable so sandboxes repeat).
 */

/** 32-bit integer hash → [0, 1). */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 2-D value noise in [0, 1], tiling with `period` cells when period > 0. */
export function valueNoise(x: number, y: number, seed = 0, period = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  let x0 = xi;
  let x1 = xi + 1;
  let y0 = yi;
  let y1 = yi + 1;
  if (period > 0) {
    x0 = ((x0 % period) + period) % period;
    x1 = ((x1 % period) + period) % period;
    y0 = ((y0 % period) + period) % period;
    y1 = ((y1 % period) + period) % period;
  }
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Fractal value noise in about [0, 1]. */
export function fbm(x: number, y: number, octaves: number, seed = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * f, y * f, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** A tiny seedable PRNG (mulberry32) for cosmetic randomness. Allocation-free. */
export class CosmeticRandom {
  private s: number;
  constructor(seed = 0x1234567) {
    this.s = seed >>> 0;
  }
  reseed(seed: number): void {
    this.s = seed >>> 0;
  }
  /** Uniform [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Uniform [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** Symmetric [-a, a). */
  signed(a = 1): number {
    return (this.next() * 2 - 1) * a;
  }
  /** Roughly normal (sum of three uniforms), mean 0, sd ≈ 1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2;
  }
}

/** The effects' shared cosmetic random source. */
export const fxRandom = new CosmeticRandom(0xa10f);
