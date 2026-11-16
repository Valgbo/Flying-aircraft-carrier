/**
 * The airbase (one 2,400 m runway with a parallel taxiway, link taxiways and an apron) and the
 * range complex near it (STRAFE PIT, BOMB CIRCLE, TACTICAL LANE): chosen where the valley floor
 * is flattest, away from the river, then flattened into the grid so the analytic pads only need
 * to finish the job (remove the micro-relief, make it exactly planar).
 */
import { headingOf } from '../../frames';
import { Rng } from '../../rng';
import { smoothstep } from '../noise';
import { RANGE_WORLD } from '../params';
import type { Airbase, PavedArea, WorldExtra } from '../types';
import { gridHeight, type Grid } from './grid';
import { axisV, downValleyAngle, fromUVx, fromUVz, halfWidth, toU, type Layout } from './layout';
import type { RiverField } from './river';
import { sampleBilinear } from './grid';

/** A planar patch: h = elevation + gx·(x − cx) + gz·(z − cz). */
export interface Plane {
  cx: number;
  cz: number;
  elevation: number;
  gx: number;
  gz: number;
}

/** Least-squares plane through grid heights at points (x, z), with the gradient clamped. */
function fitPlane(g: Grid, pts: Array<[number, number]>, cx: number, cz: number, maxGrad: number): Plane & { rms: number; grad: number } {
  let sx = 0;
  let sz = 0;
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  let sh = 0;
  let sxh = 0;
  let szh = 0;
  const n = pts.length;
  const hs: number[] = [];
  for (const [x, z] of pts) {
    const h = gridHeight(g, x, z);
    hs.push(h);
    const dx = x - cx;
    const dz = z - cz;
    sx += dx;
    sz += dz;
    sxx += dx * dx;
    szz += dz * dz;
    sxz += dx * dz;
    sh += h;
    sxh += dx * h;
    szh += dz * h;
  }
  // Solve the 3×3 normal equations by Cramer's rule.
  const a = [
    [n, sx, sz],
    [sx, sxx, sxz],
    [sz, sxz, szz],
  ];
  const b = [sh, sxh, szh];
  const det3 = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(a);
  const col = (k: number) => a.map((row, r) => row.map((v, c) => (c === k ? b[r] : v)));
  let e = det3(col(0)) / D;
  let gx = det3(col(1)) / D;
  let gz = det3(col(2)) / D;
  const grad = Math.hypot(gx, gz);
  if (grad > maxGrad) {
    gx *= maxGrad / grad;
    gz *= maxGrad / grad;
    e = sh / n; // re-centre on the mean height
  }
  let rr = 0;
  pts.forEach(([x, z], k) => {
    const d = hs[k] - (e + gx * (x - cx) + gz * (z - cz));
    rr += d * d;
  });
  return { cx, cz, elevation: e, gx, gz, rms: Math.sqrt(rr / n), grad };
}

/** Blend the grid toward a plane: exactly the plane where dist(x, z) ≤ 0, fading over `blend`. */
function flattenGrid(
  g: Grid,
  plane: Plane,
  bbox: [number, number, number, number],
  dist: (x: number, z: number) => number,
  blend: number,
): void {
  const { n, spacing, half, h } = g;
  const i0 = Math.max(0, Math.floor((bbox[0] - blend + half) / spacing));
  const i1 = Math.min(n - 1, Math.ceil((bbox[2] + blend + half) / spacing));
  const j0 = Math.max(0, Math.floor((bbox[1] - blend + half) / spacing));
  const j1 = Math.min(n - 1, Math.ceil((bbox[3] + blend + half) / spacing));
  for (let j = j0; j <= j1; j++) {
    const z = -half + j * spacing;
    for (let i = i0; i <= i1; i++) {
      const x = -half + i * spacing;
      const d = dist(x, z);
      if (d >= blend) continue;
      const w = 1 - smoothstep(0, blend, d);
      const p = plane.elevation + plane.gx * (x - plane.cx) + plane.gz * (z - plane.cz);
      h[j * n + i] += w * (p - h[j * n + i]);
    }
  }
}

export interface AirbaseSite {
  airbase: Airbase;
  airfield: NonNullable<WorldExtra['airfield']>;
  /** The road connection point (outer edge of the apron, outside the airfield rectangle). */
  gate: { x: number; z: number };
  /** Which side of the runway (+1 / −1 along the right-hand normal) the apron is on. */
  side: number;
}

/** Rectangle distance in local axes (0 inside). */
function rectDistance(
  x: number,
  z: number,
  cx: number,
  cz: number,
  ex: number,
  ez: number,
  hl: number,
  hw: number,
): number {
  const px = x - cx;
  const pz = z - cz;
  const a = Math.abs(px * ex + pz * ez) - hl;
  const b = Math.abs(-px * ez + pz * ex) - hw;
  const ax = a > 0 ? a : 0;
  const bz = b > 0 ? b : 0;
  return Math.sqrt(ax * ax + bz * bz);
}

/** Find, lay out and flatten the airbase. */
export function placeAirbase(L: Layout, g: Grid, rf: RiverField, rng: Rng): AirbaseSite {
  const half = L.half;
  const halfLength = RANGE_WORLD.runwayLength / 2 + 320;
  const footHalfWidth = 470;
  let best: { cost: number; x: number; z: number; heading: number; side: number; plane: Plane } | null = null;
  const uOffset = rng.range(-0.25, 0.25) * half;
  for (let a = -10; a <= 10; a++) {
    const u = uOffset + a * 1500;
    const W = halfWidth(L, u);
    for (const vf of [-0.62, -0.48, -0.34, 0.34, 0.48, 0.62]) {
      const v = axisV(L, u) + vf * W;
      const x = fromUVx(L, u, v);
      const z = fromUVz(L, u, v);
      if (Math.abs(x) > half - 7000 || Math.abs(z) > half - 7000) continue;
      const ang = downValleyAngle(L, u);
      const ex = Math.cos(ang);
      const ez = Math.sin(ang);
      // Keep the whole footprint 900 m from the river.
      let ok = true;
      const pts: Array<[number, number]> = [];
      for (let p = -4; p <= 4 && ok; p++) {
        for (let q = -2; q <= 2; q++) {
          const px = x + ex * (p / 4) * halfLength - ez * (q / 2) * footHalfWidth;
          const pz = z + ez * (p / 4) * halfLength + ex * (q / 2) * footHalfWidth;
          const dr = sampleBilinear(g, rf.dist, px, pz);
          if (dr < 900) {
            ok = false;
            break;
          }
          pts.push([px, pz]);
        }
      }
      if (!ok) continue;
      const plane = fitPlane(g, pts, x, z, 0.006);
      const cost = plane.rms + 400 * plane.grad + Math.abs(u - uOffset) / 4000 + Math.abs(vf) * 2;
      if (!best || cost < best.cost) {
        best = { cost, x, z, heading: headingOf(ex, ez), side: vf > 0 ? 1 : -1, plane };
      }
    }
  }
  if (!best) {
    // Fallback (never expected): the map centre on the axis.
    const u = 0;
    const v = axisV(L, u) + 0.4 * halfWidth(L, u);
    const x = fromUVx(L, u, v);
    const z = fromUVz(L, u, v);
    best = { cost: 0, x, z, heading: headingOf(L.ca, L.sa), side: 1, plane: { cx: x, cz: z, elevation: gridHeight(g, x, z), gx: 0, gz: 0 } };
  }
  const { x, z, heading, plane } = best;
  const ex = Math.sin(heading);
  const ez = -Math.cos(heading);
  // Right-hand normal of the runway direction; the apron goes on the side away from the valley axis.
  const nx = -ez;
  const nz = ex;
  const uC = toU(L, x, z);
  const axisX = fromUVx(L, uC, axisV(L, uC));
  const axisZ = fromUVz(L, uC, axisV(L, uC));
  const side = (x - axisX) * nx + (z - axisZ) * nz >= 0 ? 1 : -1;
  flattenGrid(
    g,
    plane,
    [x - halfLength - footHalfWidth, z - halfLength - footHalfWidth, x + halfLength + footHalfWidth, z + halfLength + footHalfWidth],
    (px, pz) => rectDistance(px, pz, x, z, ex, ez, halfLength, footHalfWidth),
    650,
  );
  const at = (along: number, across: number) => ({
    x: x + ex * along + nx * across * side,
    z: z + ez * along + nz * across * side,
  });
  const len = RANGE_WORLD.runwayLength;
  const taxiOff = 190;
  const apronOff = 345;
  const paved: PavedArea[] = [];
  const add = (kind: PavedArea['kind'], along: number, across: number, length: number, width: number, hdg: number) => {
    const p = at(along, across);
    paved.push({ kind, x: p.x, z: p.z, heading: hdg, length, width });
  };
  const cross = heading + Math.PI / 2;
  add('runway', 0, 0, len, RANGE_WORLD.runwayWidth, heading);
  add('taxiway', 0, taxiOff, len, RANGE_WORLD.taxiwayWidth, heading);
  for (const along of [-len / 2 + 30, -len / 4, len / 4, len / 2 - 30]) {
    add('taxiway', along, taxiOff / 2, taxiOff, RANGE_WORLD.taxiwayWidth, cross);
  }
  add('apron', 0, apronOff, RANGE_WORLD.apronLength, RANGE_WORLD.apronWidth, heading);
  add('taxiway', 0, (taxiOff + apronOff) / 2, apronOff - taxiOff, RANGE_WORLD.taxiwayWidth * 1.4, cross);
  const gatePos = at(0, footHalfWidth + 40);
  const airbase: Airbase = {
    x,
    z,
    heading,
    runwayLength: len,
    runwayWidth: RANGE_WORLD.runwayWidth,
    elevation: plane.elevation,
    paved,
  };
  return {
    airbase,
    airfield: {
      x,
      z,
      heading,
      halfLength,
      halfWidth: footHalfWidth,
      blend: 60,
      elevation: plane.elevation,
      gx: plane.gx,
      gz: plane.gz,
    },
    gate: gatePos,
    side,
  };
}

export interface RangePad {
  name: 'STRAFE PIT' | 'BOMB CIRCLE' | 'TACTICAL LANE';
  x: number;
  z: number;
  radius: number;
  heading: number;
  plane: Plane;
}

/** Choose and flatten the three range areas near the airbase. */
export function placeRange(
  L: Layout,
  g: Grid,
  rf: RiverField,
  site: AirbaseSite,
  rng: Rng,
): RangePad[] {
  const half = L.half;
  const specs: Array<{ name: RangePad['name']; radius: number }> = [
    { name: 'TACTICAL LANE', radius: 850 },
    { name: 'BOMB CIRCLE', radius: 380 },
    { name: 'STRAFE PIT', radius: 260 },
  ];
  const out: RangePad[] = [];
  const ab = site.airbase;
  const aex = Math.sin(ab.heading);
  const aez = -Math.cos(ab.heading);
  for (const spec of specs) {
    let best: { cost: number; x: number; z: number; plane: Plane } | null = null;
    for (let k = 0; k < 220; k++) {
      const ang = rng.range(0, Math.PI * 2);
      const dist = rng.range(4500, 13000);
      const x = ab.x + Math.cos(ang) * dist;
      const z = ab.z + Math.sin(ang) * dist;
      const r = spec.radius;
      if (Math.abs(x) > half - r - 3000 || Math.abs(z) > half - r - 3000) continue;
      const u = toU(L, x, z);
      const t = Math.abs(-x * L.sa + z * L.ca - axisV(L, u)) / halfWidth(L, u);
      if (t > 0.78) continue;
      // Clear of the airfield and of the other range areas.
      if (rectDistance(x, z, ab.x, ab.z, aex, aez, site.airfield.halfLength, site.airfield.halfWidth) < r + 1400) continue;
      if (out.some((o) => Math.hypot(o.x - x, o.z - z) < o.radius + r + 1300)) continue;
      // No river within the pad and its blend.
      const pts: Array<[number, number]> = [[x, z]];
      let ok = sampleBilinear(g, rf.dist, x, z) > r + 450;
      for (let ring = 1; ring <= 3 && ok; ring++) {
        const rr = (r + 300) * (ring / 3);
        for (let a = 0; a < 8 + ring * 4; a++) {
          const aa = (a / (8 + ring * 4)) * Math.PI * 2;
          const px = x + Math.cos(aa) * rr;
          const pz = z + Math.sin(aa) * rr;
          if (sampleBilinear(g, rf.dist, px, pz) < 300) {
            ok = false;
            break;
          }
          pts.push([px, pz]);
        }
      }
      if (!ok) continue;
      const plane = fitPlane(g, pts, x, z, 0.012);
      const cost = plane.rms + 300 * plane.grad + dist / 3000;
      if (!best || cost < best.cost) best = { cost, x, z, plane };
    }
    if (!best) continue;
    const { x, z, plane } = best;
    const r = spec.radius;
    flattenGrid(g, plane, [x - r, z - r, x + r, z + r], (px, pz) => Math.max(0, Math.hypot(px - x, pz - z) - r), 380);
    // Run-in heading: along the valley, from the side with the lower approach.
    const u = toU(L, x, z);
    const a0 = downValleyAngle(L, u);
    let bestH = 0;
    let bestTop = Infinity;
    for (const a of [a0, a0 + Math.PI]) {
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      let top = -Infinity;
      for (let s = 1000; s <= 7000; s += 500) top = Math.max(top, gridHeight(g, x - dx * s, z - dz * s));
      if (top < bestTop) {
        bestTop = top;
        bestH = headingOf(dx, dz);
      }
    }
    out.push({ name: spec.name, x, z, radius: r, heading: bestH, plane });
  }
  return out;
}
