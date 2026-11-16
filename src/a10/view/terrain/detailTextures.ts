/**
 * Close-range ground detail, generated in code (no image assets): one seamlessly tiling layer
 * per detail class (palette.ts DETAIL) plus a micro-noise layer, packed for a texture array.
 *
 *   RGB  albedo modulation around mid-grey (the shader multiplies the baked albedo by rgb × 2,
 *        so the average colour seen from far away is the baked one)
 *   A    height, for the bump that lights furrows, rows, clods and rock cracks
 *
 * Runs in the terrain worker at start-up (a few hundred ms there, nothing on the main thread).
 */
import { DETAIL, DETAIL_LAYERS } from './palette';
import { hash01, tilingFbm, tilingNoise } from './noise';

/** Texels per layer edge. */
export const DETAIL_SIZE = 256;
/** Layers: the detail classes plus the micro-noise layer. */
export const DETAIL_LAYER_COUNT = DETAIL_LAYERS + 1;
export const MICRO_LAYER = DETAIL_LAYERS;

/**
 * World metres covered by one repeat of each layer (index = layer). Rows and furrows are along
 * the texture's u axis; the shader rotates them to each field's row direction.
 */
export const DETAIL_SCALE = [5, 3.2, 7, 11, 4.5, 16, 5, 9, 1.6] as const;

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Build every layer: DETAIL_LAYER_COUNT × DETAIL_SIZE² × RGBA8, layer-major. */
export function buildDetailTextures(seed = 4242): Uint8Array<ArrayBuffer> {
  const n = DETAIL_SIZE;
  const out = new Uint8Array(DETAIL_LAYER_COUNT * n * n * 4);
  for (let layer = 0; layer < DETAIL_LAYER_COUNT; layer++) {
    const base = layer * n * n * 4;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = x / n;
        const v = y / n;
        let r = 1;
        let g = 1;
        let b = 1;
        let h = 0.5;
        const fine = tilingFbm(u, v, 32, 3, seed + layer * 31);
        const mid = tilingFbm(u, v, 8, 3, seed + layer * 53);
        switch (layer) {
          case DETAIL.grass: {
            // blades and clumps: high-frequency speckle over soft clumps, yellower tips
            const speck = hash01(x, y, seed);
            const clump = tilingFbm(u, v, 12, 2, seed + 5);
            const k = 0.78 + 0.3 * clump + 0.22 * (speck - 0.5) + 0.15 * (fine - 0.5);
            r = k * (0.96 + 0.1 * speck);
            g = k;
            b = k * 0.92;
            h = 0.3 + 0.5 * clump + 0.2 * speck;
            break;
          }
          case DETAIL.crop: {
            // rows across v (8 per repeat): plants on the rows, bare soil between
            const rows = 8;
            const rv = v * rows;
            const across = Math.abs((rv % 1) - 0.5) * 2; // 0 on the row, 1 between
            const plant = tilingNoise(u * 64, rv * 2, 64, seed + 9) * 0.6 + fine * 0.4;
            const cover = Math.max(0, 1 - across * 1.35) * (0.6 + 0.6 * plant);
            const soil = 0.55 + 0.15 * fine;
            const leaf = 1.1 + 0.2 * (plant - 0.5);
            const k = soil + (leaf - soil) * Math.min(1, cover);
            const brown = 1 - Math.min(1, cover);
            r = k * (1 + 0.25 * brown);
            g = k * (1 - 0.05 * brown);
            b = k * (1 - 0.2 * brown);
            h = 0.25 + 0.6 * Math.min(1, cover) + 0.15 * fine;
            break;
          }
          case DETAIL.ploughed: {
            // furrows across v (12 per repeat) with clods
            const rv = v * 12;
            const ridge = 0.5 + 0.5 * Math.cos(rv * Math.PI * 2);
            const clod = tilingFbm(u, v, 24, 3, seed + 17);
            const k = 0.72 + 0.38 * ridge + 0.25 * (clod - 0.5) + 0.12 * (fine - 0.5);
            r = k * 1.02;
            g = k;
            b = k * 0.97;
            h = 0.15 + 0.6 * ridge + 0.25 * clod;
            break;
          }
          case DETAIL.rock: {
            // strata and cracks
            const ridged = 1 - Math.abs(2 * tilingFbm(u, v, 6, 4, seed + 23) - 1);
            const crack = Math.pow(ridged, 6);
            const lichen = tilingFbm(u, v, 16, 2, seed + 29) > 0.62 ? 1 : 0;
            const k = 0.85 + 0.3 * (mid - 0.5) + 0.12 * (fine - 0.5) - 0.45 * crack;
            r = k * (1 + 0.06 * lichen);
            g = k * (1 + 0.1 * lichen);
            b = k * (1 - 0.04 * lichen);
            h = 0.6 + 0.3 * mid - 0.5 * crack;
            break;
          }
          case DETAIL.sand: {
            // fine grain and gentle ripples
            const ripple = 0.5 + 0.5 * Math.sin((v * 10 + 0.6 * mid) * Math.PI * 2);
            const grain = hash01(x, y, seed + 37);
            const k = 0.9 + 0.12 * ripple + 0.12 * (grain - 0.5) + 0.08 * (mid - 0.5);
            r = k;
            g = k * 0.99;
            b = k * 0.96;
            h = 0.4 + 0.3 * ripple + 0.3 * grain;
            break;
          }
          case DETAIL.forest: {
            // crowns seen from above: round lit blobs with dark gaps
            const cells = 6;
            let best = 9;
            let best2 = 9;
            const cx = u * cells;
            const cy = v * cells;
            const ix = Math.floor(cx);
            const iy = Math.floor(cy);
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const gx = (((ix + dx) % cells) + cells) % cells;
                const gy = (((iy + dy) % cells) + cells) % cells;
                const px = ix + dx + 0.15 + 0.7 * hash01(gx, gy, seed + 41);
                const py = iy + dy + 0.15 + 0.7 * hash01(gx, gy, seed + 43);
                const d = Math.hypot(cx - px, cy - py);
                if (d < best) {
                  best2 = best;
                  best = d;
                } else if (d < best2) best2 = d;
              }
            }
            const dome = Math.max(0, 1 - best / 0.62);
            const gap = Math.min(1, (best2 - best) * 3);
            const k = 0.45 + 0.75 * dome * (0.75 + 0.25 * gap) + 0.2 * (fine - 0.5);
            r = k * 0.98;
            g = k;
            b = k * 0.95;
            h = dome * 0.85 + fine * 0.15;
            break;
          }
          case DETAIL.paved: {
            // asphalt aggregate with a few cracks and patches
            const grain = hash01(x, y, seed + 59);
            const patch = tilingFbm(u, v, 3, 2, seed + 61);
            const crack = Math.pow(1 - Math.abs(2 * tilingFbm(u, v, 5, 3, seed + 67) - 1), 14);
            const k = 0.95 + 0.14 * (grain - 0.5) + 0.12 * (patch - 0.5) - 0.3 * crack;
            r = k;
            g = k;
            b = k * 1.01;
            h = 0.5 + 0.2 * grain - 0.3 * crack;
            break;
          }
          case DETAIL.mud: {
            // wet patches and ruts
            const wet = tilingFbm(u, v, 4, 3, seed + 71);
            const rut = Math.pow(Math.abs(Math.sin(u * Math.PI * 4)), 30);
            const k = 0.9 + 0.25 * (mid - 0.5) - 0.3 * Math.max(0, wet - 0.55) - 0.15 * rut;
            r = k;
            g = k * 0.98;
            b = k * 0.95;
            h = 0.5 - 0.4 * Math.max(0, wet - 0.55) - 0.3 * rut + 0.1 * fine;
            break;
          }
          default: {
            // micro noise: neutral grey speckle for speed cues near the aircraft
            const grain = hash01(x, y, seed + 83);
            const k = 0.85 + 0.2 * (fine - 0.5) + 0.2 * (grain - 0.5) + 0.15;
            r = k;
            g = k;
            b = k;
            h = fine;
          }
        }
        const o = base + (y * n + x) * 4;
        out[o] = clamp255(r * 128);
        out[o + 1] = clamp255(g * 128);
        out[o + 2] = clamp255(b * 128);
        out[o + 3] = clamp255(h * 255);
      }
    }
    // normalise each layer's mean to exactly mid-grey: far ground keeps its baked colour
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let i = 0; i < n * n; i++) {
      sr += out[base + i * 4];
      sg += out[base + i * 4 + 1];
      sb += out[base + i * 4 + 2];
    }
    const kr = (128 * n * n) / Math.max(1, sr);
    const kg = (128 * n * n) / Math.max(1, sg);
    const kb = (128 * n * n) / Math.max(1, sb);
    for (let i = 0; i < n * n; i++) {
      out[base + i * 4] = clamp255(out[base + i * 4] * kr);
      out[base + i * 4 + 1] = clamp255(out[base + i * 4 + 1] * kg);
      out[base + i * 4 + 2] = clamp255(out[base + i * 4 + 2] * kb);
    }
  }
  return out;
}
