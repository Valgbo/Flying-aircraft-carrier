/**
 * Hydraulic erosion of the mountain landform (droplet model after H. T. Beyer, "Implementation of
 * a method for hydraulic erosion", 2015). Rain drops run downhill with inertia; a drop picks up
 * sediment while its carrying capacity (∝ speed × water × the drop in height) exceeds its load
 * and deposits where it slows or climbs. Thousands of drops cut branching valleys between sharp
 * ridges — the drainage pattern noise alone cannot draw.
 *
 * Runs on the coarse macro lattice (heights in metres, `spacing` m per cell) before it is
 * upsampled; `mask` (0..1 per sample) limits the work to the mountains. Deterministic: drops
 * are placed from the given Rng.
 */
import { Rng } from '../../rng';

export interface ErosionParams {
  drops: number;
  maxSteps: number;
  inertia: number;
  capacity: number;
  minCapacity: number;
  erodeRate: number;
  depositRate: number;
  evaporate: number;
  gravity: number;
  /** Brush radius for erosion, cells. */
  radius: number;
}

export const DEFAULT_EROSION: ErosionParams = {
  drops: 45000,
  maxSteps: 48,
  inertia: 0.25,
  capacity: 6,
  minCapacity: 0.01,
  erodeRate: 0.3,
  depositRate: 0.25,
  evaporate: 0.025,
  gravity: 8,
  radius: 2,
};

/**
 * Erode `h` (n × n, metres) in place. Heights are scaled by 1/spacing inside the model so
 * differences per cell are slopes.
 */
export function erode(
  h: Float32Array,
  n: number,
  spacing: number,
  mask: Float32Array,
  rng: Rng,
  p: ErosionParams = DEFAULT_EROSION,
): void {
  const inv = 1 / spacing;
  // Brush offsets and weights (∝ 1 − distance / radius).
  const R = p.radius;
  const bOff: number[] = [];
  const bW: number[] = [];
  let wsum = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > R) continue;
      const w = 1 - d / (R + 1e-9);
      bOff.push(dx, dy);
      bW.push(w);
      wsum += w;
    }
  }
  for (let k = 0; k < bW.length; k++) bW[k] /= wsum;

  const height = (x: number, y: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const o = iy * n + ix;
    return (
      (h[o] * (1 - fx) * (1 - fy) + h[o + 1] * fx * (1 - fy) + h[o + n] * (1 - fx) * fy + h[o + n + 1] * fx * fy) *
      inv
    );
  };

  for (let d = 0; d < p.drops; d++) {
    // Drops fall in the mountains (rejection-sample the mask).
    let x = 0;
    let y = 0;
    let ok = false;
    for (let tries = 0; tries < 8 && !ok; tries++) {
      x = rng.range(R + 1, n - R - 2);
      y = rng.range(R + 1, n - R - 2);
      ok = rng.next() < mask[Math.floor(y) * n + Math.floor(x)];
    }
    if (!ok) continue;
    let dx = 0;
    let dy = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;
    for (let step = 0; step < p.maxSteps; step++) {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const fx = x - ix;
      const fy = y - iy;
      const o = iy * n + ix;
      const h00 = h[o] * inv;
      const h10 = h[o + 1] * inv;
      const h01 = h[o + n] * inv;
      const h11 = h[o + n + 1] * inv;
      const gx = (h10 - h00) * (1 - fy) + (h11 - h01) * fy;
      const gy = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
      const hh = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
      dx = dx * p.inertia - gx * (1 - p.inertia);
      dy = dy * p.inertia - gy * (1 - p.inertia);
      const l = Math.sqrt(dx * dx + dy * dy);
      if (l < 1e-9) break;
      dx /= l;
      dy /= l;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < R + 1 || ny < R + 1 || nx >= n - R - 2 || ny >= n - R - 2) break;
      const dh = height(nx, ny) - hh;
      const m = mask[o];
      const cap = Math.max(-dh * speed * water * p.capacity, p.minCapacity);
      if (sediment > cap || dh > 0) {
        // Deposit: fill the pit we climb into, or drop what we cannot carry.
        const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * p.depositRate;
        sediment -= amount;
        const a = amount * spacing;
        h[o] += a * (1 - fx) * (1 - fy);
        h[o + 1] += a * fx * (1 - fy);
        h[o + n] += a * (1 - fx) * fy;
        h[o + n + 1] += a * fx * fy;
      } else {
        const amount = Math.min((cap - sediment) * p.erodeRate, -dh) * m;
        const a = amount * spacing;
        for (let k = 0; k < bW.length; k++) {
          const q = (iy + bOff[2 * k + 1]) * n + ix + bOff[2 * k];
          h[q] -= a * bW[k];
        }
        sediment += amount;
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * p.gravity));
      water *= 1 - p.evaporate;
      x = nx;
      y = ny;
    }
  }
}
