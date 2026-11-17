/**
 * The river: a meandering channel down the valley floor, its water level falling downstream, and
 * the flood plain it has built (flat ground ≈ 2 m above the water, a few hundred metres wide).
 *
 * The centre line is a sine-generated curve (Langbein & Leopold 1966): the heading oscillates
 * as θ(s) = θ_valley + ω·sin(2π s / M), with the arc wavelength M ≈ 15 channel widths, slowly
 * varying amplitude ω, and a steering term that keeps the meander belt on the valley floor and
 * makes it wander across it on a kilometre scale.
 */
import { Rng } from '../../rng';
import { noise2, smoothstep } from '../noise';
import { RANGE_WORLD } from '../params';
import type { RiverPolyline } from '../types';
import {
  axisSlope,
  axisV,
  floorAt,
  fromUVx,
  fromUVz,
  halfWidth,
  toU,
  toV,
  type Layout,
} from './layout';
import type { Grid } from './grid';

/** River centre-line spacing, m. */
const STEP = 20;

/**
 * Distance stored beyond the river field's reach (finite, so bilinear samples across the reach
 * boundary stay finite and large).
 */
export const FAR = 1e9;

export function makeRiver(L: Layout, rng: Rng, seed: number): RiverPolyline {
  const half = L.half;
  // Start upstream outside the map on the valley axis and flow down-valley.
  const dir = -L.upstream;
  let u = L.upstream * half * 1.5;
  let v = axisV(L, u);
  let phase = rng.range(0, Math.PI * 2);
  const omega0 = rng.range(0.75, 1.0);
  const beltSeed = rng.int(0, 0x7fffffff);
  const pts: number[] = [];
  let inside = false;
  let s = 0;
  for (let i = 0; i < 20000; i++) {
    const x = fromUVx(L, u, v);
    const z = fromUVz(L, u, v);
    const inMap = Math.abs(x) < half + 400 && Math.abs(z) < half + 400;
    if (inMap) {
      pts.push(x, z);
      inside = true;
    } else if (inside) break;
    if (Math.abs(u) > half * 1.6) break;
    // Down-valley heading in (u, v) axes.
    const base = Math.atan2(dir * axisSlope(L, u), dir);
    const W = halfWidth(L, u);
    // Meander belt centre wanders ±0.25 W across the floor on a 15 km scale.
    const belt = axisV(L, u) + 0.25 * W * noise2(u / 15000, 0.5, beltSeed);
    const steer = Math.max(-0.7, Math.min(0.7, (-1.6 * (v - belt)) / W)) * dir;
    // Channel width at this point (grows downstream) sets the meander wavelength.
    const prog = Math.min(1, Math.max(0, (half - u * L.upstream) / L.size));
    const width =
      RANGE_WORLD.riverWidthUp + (RANGE_WORLD.riverWidthDown - RANGE_WORLD.riverWidthUp) * prog;
    const M = 1.25 * RANGE_WORLD.meanderPerWidth * width;
    const omega = omega0 * (0.7 + 0.45 * (0.5 + 0.5 * noise2(s / 9000, 3.3, beltSeed)));
    const theta = base + omega * Math.sin(phase) + steer;
    phase +=
      (2 * Math.PI * STEP) / (M * (0.8 + 0.4 * (0.5 + 0.5 * noise2(s / 7000, 9.1, beltSeed))));
    u += Math.cos(theta) * STEP;
    v += Math.sin(theta) * STEP;
    s += STEP;
  }
  const n = pts.length / 2;
  const points = new Float64Array(pts);
  const arc = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    arc[i] =
      arc[i - 1] +
      Math.hypot(points[2 * i] - points[2 * i - 2], points[2 * i + 1] - points[2 * i - 1]);
  }
  const length = arc[n - 1];
  // Width grows downstream; water level follows the valley floor 3.2 m down, never rising.
  const widths = new Float64Array(n);
  const levels = new Float64Array(n);
  let prev = Infinity;
  for (let i = 0; i < n; i++) {
    const f = arc[i] / length;
    widths[i] =
      RANGE_WORLD.riverWidthUp + (RANGE_WORLD.riverWidthDown - RANGE_WORLD.riverWidthUp) * f;
    const uu = toU(L, points[2 * i], points[2 * i + 1]);
    let wl = floorAt(L, uu) - 3.2;
    if (wl > prev) wl = prev;
    levels[i] = wl;
    prev = wl;
  }
  // Smooth the level profile (running min leaves steps) while keeping it non-increasing.
  const sm = new Float64Array(n);
  const win = 40;
  for (let i = 0; i < n; i++) {
    let a = 0;
    let c = 0;
    for (let k = Math.max(0, i - win); k <= Math.min(n - 1, i + win); k++) {
      a += levels[k];
      c++;
    }
    sm[i] = a / c;
  }
  for (let i = 1; i < n; i++) if (sm[i] > sm[i - 1]) sm[i] = sm[i - 1];
  void seed;
  return {
    id: 0,
    points,
    widths,
    levels: sm,
    arc,
    length,
    bankWidth: RANGE_WORLD.riverBank,
    depth: RANGE_WORLD.riverDepth,
  };
}

/**
 * Distance field around the river on the grid: for every sample within `reach` metres of the
 * centre line, the distance, the signed side (+1 / −1, by the cross product with the flow) and
 * the water level at the nearest point. Splatted segment by segment (exact distances).
 */
export interface RiverField {
  /** Distance to the centre line, m; FAR (a large finite number) beyond the reach. */
  dist: Float32Array;
  side: Int8Array;
  level: Float32Array;
  halfW: Float32Array;
}

export function riverField(grid: Grid, river: RiverPolyline, reach: number): RiverField {
  const { n, spacing, half } = grid;
  const dist = new Float32Array(n * n).fill(FAR);
  const side = new Int8Array(n * n);
  const level = new Float32Array(n * n);
  const halfW = new Float32Array(n * n);
  const p = river.points;
  const m = p.length / 2;
  // Chords of every 4th vertex (80 m) for the splat: within a few metres of the true curve,
  // plenty for the flood plain, land cover and road costs (the terrain itself uses every vertex).
  for (let a = 0; a < m - 1; a += 4) {
    const b = Math.min(m - 1, a + 4);
    const ax = p[2 * a];
    const az = p[2 * a + 1];
    const bx = p[2 * b];
    const bz = p[2 * b + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    if (l2 < 1e-9) continue;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach + half) / spacing));
    const i1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx) + reach + half) / spacing));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - reach + half) / spacing));
    const j1 = Math.min(n - 1, Math.ceil((Math.max(az, bz) + reach + half) / spacing));
    const la = river.levels[a];
    const lb = river.levels[b];
    const wa = river.widths[a] / 2;
    const wb = river.widths[b] / 2;
    for (let j = j0; j <= j1; j++) {
      const z = -half + j * spacing;
      for (let i = i0; i <= i1; i++) {
        const x = -half + i * spacing;
        let t = ((x - ax) * dx + (z - az) * dz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = x - (ax + dx * t);
        const qz = z - (az + dz * t);
        const d = Math.sqrt(qx * qx + qz * qz);
        const k = j * n + i;
        if (d < dist[k]) {
          dist[k] = d;
          side[k] = dx * qz - dz * qx >= 0 ? 1 : -1;
          level[k] = la + (lb - la) * t;
          halfW[k] = wa + (wb - wa) * t;
        }
      }
    }
  }
  return { dist, side, level, halfW };
}

/**
 * Cut the flood plain into the grid: within `reach` of the river the ground blends to a flat
 * plain ≈ floodPlainRise above the water, rising gently away from the channel, and never lies
 * below the water level + 1.2 m near it.
 */
export function carveFloodPlain(grid: Grid, rf: RiverField, seed: number): void {
  const { n, spacing, half, h } = grid;
  const reach = 900;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const d = rf.dist[k];
      if (!(d < reach)) continue;
      const x = -half + i * spacing;
      const z = -half + j * spacing;
      const plain =
        rf.level[k] +
        RANGE_WORLD.floodPlainRise +
        1.6 * smoothstep(rf.halfW[k] + 40, reach, d) +
        0.5 * noise2(x / 600, z / 600, seed);
      const w = 1 - smoothstep(reach * 0.4, reach, d);
      let v = h[k] + (plain - h[k]) * w;
      const floor = rf.level[k] + 1.2;
      if (v < floor) v = floor;
      h[k] = v;
    }
  }
}

/** Valley-side test helper (exported for placement code). */
export function riverSideOf(L: Layout, river: RiverPolyline, x: number, z: number): number {
  // Side by the valley coordinate relative to the river point at the same u.
  const u = toU(L, x, z);
  let best = Infinity;
  let bv = 0;
  const p = river.points;
  for (let i = 0; i < p.length / 2; i += 4) {
    const du = Math.abs(toU(L, p[2 * i], p[2 * i + 1]) - u);
    if (du < best) {
      best = du;
      bv = toV(L, p[2 * i], p[2 * i + 1]);
    }
  }
  return toV(L, x, z) >= bv ? 1 : -1;
}
