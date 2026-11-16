/**
 * The farmed-field patchwork, evaluated analytically so field edges, margins, farm tracks and
 * hedgerows are sharp at any distance (a raster at 62.5 m could not draw a 9 m hedge).
 *
 * The valley is split into regions (Voronoi cells around jittered sites, ≈ 4 km), each with its
 * own row direction (roughly along the valley, as land is divided along roads and contours). A
 * region is cut into rows of jittered height; each row is cut into fields of jittered length,
 * some neighbours merged. Every boundary has a hashed type: plain, hedgerow or farm track.
 * Whether a field is actually farmed is decided from the farmland mask at the field's centre, so
 * whole fields appear or not and the farmland edge follows field boundaries, as it does in life.
 */
import { hash01, hash2, noise2 } from './noise';
import type { CropKind } from './types';

/** Region record stride in `regions`: siteX, siteZ, rowAngle, rowHeight, fieldLength, seed. */
/** Hedges are resolved only this close to a field boundary, m. */
export const HEDGE_QUERY = 8;

export const REGION_STRIDE = 6;

export interface FieldSystem {
  regions: Float64Array;
  /** Jittered-grid cell size and origin; nx × nz sites. */
  cell: number;
  ox: number;
  oz: number;
  nx: number;
  nz: number;
}

/** Result of locating a field (geometry only; presence is decided by the caller). */
export interface FieldCell {
  id: number;
  variant: number;
  crop: CropKind;
  /** Field centre, world m. */
  cx: number;
  cz: number;
  /** Row direction: math angle (rad) of the row axis in x/z, and whether furrows run along it. */
  rowAngle: number;
  furrowsAlongRows: boolean;
  /** Distance to the nearest boundary of the field, m. */
  edgeDistance: number;
  /** Type of the nearest boundary: 0 plain, 1 hedge, 2 farm track. */
  edgeType: number;
  /**
   * Distance to the nearest hedgerow boundary of this field and its height 0..1; Infinity when
   * no hedge lies within HEDGE_QUERY metres (hedges are only resolved close to a boundary).
   */
  hedgeDistance: number;
  hedgeHeight: number;
  /** Distance to the nearest farm-track boundary (Infinity if none). */
  trackDistance: number;
}

export function createFieldCell(): FieldCell {
  return {
    id: 0,
    variant: 0,
    crop: 'cereal',
    cx: 0,
    cz: 0,
    rowAngle: 0,
    furrowsAlongRows: true,
    edgeDistance: Infinity,
    edgeType: 0,
    hedgeDistance: Infinity,
    hedgeHeight: 0,
    trackDistance: Infinity,
  };
}

/** Crop by variant byte: cereal 30 %, green crop 22 %, ploughed 18 %, pasture 16 %, fallow 8 %, rapeseed 6 %. */
export function cropOfVariant(variant: number): CropKind {
  const u = variant / 256;
  if (u < 0.3) return 'cereal';
  if (u < 0.52) return 'greenCrop';
  if (u < 0.7) return 'ploughed';
  if (u < 0.86) return 'pasture';
  if (u < 0.94) return 'fallow';
  return 'rapeseed';
}

/** Build the region table: one site per jittered-grid cell covering the map plus a margin. */
export function buildFieldSystem(
  size: number,
  cell: number,
  seed: number,
  /** Row direction for a site (math angle, rad) — e.g. the valley direction there. */
  angleAt: (x: number, z: number) => number,
): FieldSystem {
  const half = size / 2;
  const ox = -half - cell;
  const oz = -half - cell;
  const nx = Math.ceil((size + 2 * cell) / cell);
  const nz = nx;
  const regions = new Float64Array(nx * nz * REGION_STRIDE);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * REGION_STRIDE;
      const sx = ox + (i + 0.5 + 0.8 * (hash01(i, j, seed) - 0.5)) * cell;
      const sz = oz + (j + 0.5 + 0.8 * (hash01(i, j, seed ^ 0x51ed) - 0.5)) * cell;
      const r = hash01(i, j, seed ^ 0x2bd3);
      // Most regions follow the valley; a quarter are turned square to it.
      let angle = angleAt(sx, sz) + (hash01(i, j, seed ^ 0x77a1) - 0.5) * 0.5;
      if (r < 0.25) angle += Math.PI / 2;
      regions[k] = sx;
      regions[k + 1] = sz;
      regions[k + 2] = angle;
      regions[k + 3] = 150 + 210 * hash01(i, j, seed ^ 0x1f3c); // row height, m
      regions[k + 4] = 260 + 440 * hash01(i, j, seed ^ 0x4a91); // field length, m
      regions[k + 5] = hash2(i, j, seed ^ 0x6d2b) | 0;
    }
  }
  return { regions, cell, ox, oz, nx, nz };
}

/** Row boundary j of a region: j·H jittered by ±30 % (monotonic in j). */
function rowBoundary(j: number, rowH: number, s: number): number {
  return rowH * (j + 0.6 * (hash01(j, 101, s) - 0.5));
}

/** Field boundary k within row j. */
function fieldBoundary(j: number, k: number, len: number, off: number, s: number): number {
  return off + len * (k + 0.7 * (hash01(j * 7919 + k, 404, s) - 0.5));
}

/** Boundary k of row j exists (else the fields either side are one field). */
function boundaryPresent(j: number, k: number, s: number): boolean {
  return hash01(j * 7919 + k, 505, s) >= 0.22;
}

/** Boundary type from a hash: 0 plain, 1 hedge (p), 2 track (q). */
function edgeType(h: number, pHedge: number, pTrack: number): number {
  return h < pHedge ? 1 : h < pHedge + pTrack ? 2 : 0;
}

/**
 * Locate the field containing (x, z). Always succeeds (every point of the plane belongs to some
 * field cell); whether it is farmed is up to the caller.
 */
export function locateField(fs: FieldSystem, x: number, z: number, out: FieldCell): FieldCell {
  // Nearest and second-nearest region sites.
  const ci = Math.floor((x - fs.ox) / fs.cell);
  const cj = Math.floor((z - fs.oz) / fs.cell);
  let best = -1;
  let bestD = Infinity;
  let second = -1;
  let secondD = Infinity;
  const R = fs.regions;
  for (let dj = -1; dj <= 1; dj++) {
    const j = cj + dj;
    if (j < 0 || j >= fs.nz) continue;
    for (let di = -1; di <= 1; di++) {
      const i = ci + di;
      if (i < 0 || i >= fs.nx) continue;
      const k = j * fs.nx + i;
      const ddx = x - R[k * REGION_STRIDE];
      const ddz = z - R[k * REGION_STRIDE + 1];
      const d = ddx * ddx + ddz * ddz;
      if (d < bestD) {
        second = best;
        secondD = bestD;
        best = k;
        bestD = d;
      } else if (d < secondD) {
        second = k;
        secondD = d;
      }
    }
  }
  const o = best * REGION_STRIDE;
  const sx = R[o];
  const sz = R[o + 1];
  const angle = R[o + 2];
  const rowH = R[o + 3];
  const lenBase = R[o + 4];
  const s = R[o + 5];
  // Distance to the region boundary (bisector with the second-nearest site).
  let regionEdge = Infinity;
  if (second >= 0) {
    const o2 = second * REGION_STRIDE;
    const bx = R[o2] - sx;
    const bz = R[o2 + 1] - sz;
    const bl = Math.sqrt(bx * bx + bz * bz);
    regionEdge = (secondD - bestD) / (2 * bl);
  }

  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const dx = x - sx;
  const dz = z - sz;
  const u = dx * ca + dz * sa;
  const v = -dx * sa + dz * ca;

  // Row.
  let j = Math.floor(v / rowH);
  if (v < rowBoundary(j, rowH, s)) j--;
  else if (v >= rowBoundary(j + 1, rowH, s)) j++;
  const v0 = rowBoundary(j, rowH, s);
  const v1 = rowBoundary(j + 1, rowH, s);

  // Fields along the row (merged across absent boundaries, at most 4 slots each way).
  const len = lenBase * (0.6 + 0.8 * hash01(j, 202, s));
  const off = len * hash01(j, 303, s);
  let k = Math.floor((u - off) / len);
  if (u < fieldBoundary(j, k, len, off, s)) k--;
  else if (u >= fieldBoundary(j, k + 1, len, off, s)) k++;
  let kl = k;
  for (let n = 0; n < 3 && !boundaryPresent(j, kl, s); n++) kl--;
  let kr = k + 1;
  for (let n = 0; n < 3 && !boundaryPresent(j, kr, s); n++) kr++;
  const u0 = fieldBoundary(j, kl, len, off, s);
  const u1 = fieldBoundary(j, kr, len, off, s);

  const id = hash2(best * 4099 + j, kl, s ^ 0x3c6e);
  out.id = id;
  out.variant = (id >>> 8) & 255;
  out.crop = cropOfVariant(out.variant);
  out.rowAngle = angle;
  out.furrowsAlongRows = (id & 1) === 0;
  const uc = (u0 + u1) / 2;
  const vc = (v0 + v1) / 2;
  out.cx = sx + uc * ca - vc * sa;
  out.cz = sz + uc * sa + vc * ca;

  // Distances to the five boundaries and their types.
  const dv0 = v - v0;
  const dv1 = v1 - v;
  const du0 = u - u0;
  const du1 = u1 - u;
  const tv0 = edgeType(hash01(j, 606, s), 0.32, 0.1);
  const tv1 = edgeType(hash01(j + 1, 606, s), 0.32, 0.1);
  const tu0 = edgeType(hash01(j * 7919 + kl, 707, s), 0.18, 0.08);
  const tu1 = edgeType(hash01(j * 7919 + kr, 707, s), 0.18, 0.08);
  const tr =
    second >= 0
      ? edgeType(hash01(Math.min(best, second), Math.max(best, second), 0x5a17), 0.5, 0.15)
      : 0;

  let ed = dv0;
  let et = tv0;
  if (dv1 < ed) {
    ed = dv1;
    et = tv1;
  }
  if (du0 < ed) {
    ed = du0;
    et = tu0;
  }
  if (du1 < ed) {
    ed = du1;
    et = tu1;
  }
  if (regionEdge < ed) {
    ed = regionEdge;
    et = tr;
  }
  out.edgeDistance = ed;
  out.edgeType = et;

  // Hedges: nearest hedge boundary (with gaps along it) and its height.
  let hd = Infinity;
  let hh = 0;
  if (ed < HEDGE_QUERY) {
    const gapSeed = s ^ 0x1234;
    if (tv0 === 1 && dv0 < HEDGE_QUERY && hedgeAt(u, j, gapSeed)) {
      hd = dv0;
      hh = hash01(j, 808, s);
    }
    if (tv1 === 1 && dv1 < HEDGE_QUERY && dv1 < hd && hedgeAt(u, j + 1, gapSeed)) {
      hd = dv1;
      hh = hash01(j + 1, 808, s);
    }
    if (tu0 === 1 && du0 < HEDGE_QUERY && du0 < hd && hedgeAt(v, j * 7919 + kl + 0.5, gapSeed)) {
      hd = du0;
      hh = hash01(j * 7919 + kl, 909, s);
    }
    if (tu1 === 1 && du1 < HEDGE_QUERY && du1 < hd && hedgeAt(v, j * 7919 + kr + 0.5, gapSeed)) {
      hd = du1;
      hh = hash01(j * 7919 + kr, 909, s);
    }
    if (tr === 1 && regionEdge < HEDGE_QUERY && regionEdge < hd && hedgeAt(u + v, best + second, gapSeed)) {
      hd = regionEdge;
      hh = 0.5;
    }
  }
  out.hedgeDistance = hd;
  out.hedgeHeight = hh;

  let td = Infinity;
  if (tv0 === 2) td = dv0;
  if (tv1 === 2 && dv1 < td) td = dv1;
  if (tu0 === 2 && du0 < td) td = du0;
  if (tu1 === 2 && du1 < td) td = du1;
  if (tr === 2 && regionEdge < td) td = regionEdge;
  out.trackDistance = td;
  return out;
}

/** Hedgerows have gaps: trees stand where a 1D noise along the boundary is above a threshold. */
function hedgeAt(along: number, line: number, seed: number): boolean {
  return noise2(along / 45, line * 1.618, seed) > -0.45;
}
