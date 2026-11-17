/**
 * The Terrain built from TerrainData: THE height function and every ground query.
 *
 *   heightAt(x, z) = B(x, z)                 uniform cubic B-spline over the height grid (C2;
 *                                            stays inside its 4 × 4 control points, which lets
 *                                            the ray hierarchy bound it exactly)
 *                  + m(x, z) · (1 + 2.2 r)   analytic micro-relief: three octaves of gradient
 *                                            noise at 170, 61 and 23 m, ±1.6 m on fields, ×3.2
 *                                            on broken rock (r = roughness mask)
 *                  then the feature blends  roads, river surface and banks, flat pads
 *                                            (features.ts): exactly flat where they are flat.
 *
 * createTerrain is pure and DOM-free: a Web Worker given the same TerrainData (structuredClone)
 * builds a terrain that returns bit-identical answers.
 */
import { Vector3 } from 'three';
import { worldExtra } from './extra';
import {
  blendFeatures,
  buildFeatureSet,
  cellFeatureBounds,
  createFeatureQuery,
  KIND_TRACK,
  padCentre,
  padPlane,
  padSpecsOf,
  queryFeatures,
  segmentEnds,
  type FeatureQuery,
  type FeatureSet,
  type PadSpec,
} from './features';
import { createFieldCell, locateField, type FieldCell, type FieldSystem } from './fields';
import { MICRO_GRAD, MICRO_PEAK, MICRO_ROUGH_GAIN, microRelief, microSeeds } from './micro';
import { hash2, noise2 } from './noise';
import { RANGE_WORLD } from './params';
import { canopyStats, cellBounds } from './bounds';
import { buildPyramid, segmentClearOfBounds, traceRay, type RayField } from './raytrace';
import type {
  FieldSample,
  SurfaceKind,
  Terrain,
  TerrainData,
  TerrainHit,
  TerrainSample,
  WorldExtra,
} from './types';

/** Forest-edge noise amplitude (added to the 0..1 forest density before the 0.5 threshold). */
const FOREST_EDGE_AMP = 0.23;
/** Farmland threshold at a field's centre / at the point for the field to be farmed. */
const FARM_CENTRE = 0.5 * 255;
const FARM_POINT = 0.18 * 255;
/** Range-pad surface: bare earth inside this fraction of the radius. */
const PAD_DIRT_FRACTION = 0.55;

/**
 * roadDistanceAt is exact up to this distance from a road's centre line (the shortest road
 * reach: track half width + shoulder + blend + index margin), m; beyond it may say Infinity.
 */
export const ROAD_QUERY_RANGE = 20;

/** Internal state shared by the query functions of one terrain. */
interface Land {
  q: FeatureQuery;
  cell: FieldCell;
  /** The point lies on a farmed field. */
  field: boolean;
  canopy: number;
  /** 0 none, 1 forest, 2 hedge, 3 riparian. */
  canopyKind: number;
}

/** Options for createTerrain. */
export interface CreateTerrainOptions {
  /**
   * Build the ray-query hierarchy on first use instead of now (the generator's internal terrain
   * never casts rays). Default false: everything is ready when createTerrain returns.
   */
  lazyRayQueries?: boolean;
}

/** Build the terrain from generated (or hand-built grid) data. */
export function createTerrain(data: TerrainData, options: CreateTerrainOptions = {}): Terrain {
  const extra = worldExtra(data);
  const n = data.resolution;
  if (n < 2 || data.heights.length < n * n) {
    throw new Error('createTerrain: data has no height grid (use createFlatTerrain for tests)');
  }
  const size = data.size;
  const half = size / 2;
  const spacing = size / (n - 1);
  const inv = 1 / spacing;

  // Padded copy of the grid (2 samples of edge repeat on each side) so the 4 × 4 B-spline
  // stencil never needs bounds checks.
  const PW = n + 4;
  const H = new Float32Array(PW * PW);
  for (let r = 0; r < PW; r++) {
    const sr = Math.min(n - 1, Math.max(0, r - 2));
    for (let c = 0; c < PW; c++) {
      const sc = Math.min(n - 1, Math.max(0, c - 2));
      H[r * PW + c] = data.heights[sr * n + sc];
    }
  }

  const rough = extra ? extra.roughness : null;
  const forest = extra ? extra.forest : null;
  const farm = extra ? extra.farmland : null;
  const moist = extra ? extra.moisture : null;
  const noiseSeed = extra ? extra.noiseSeed | 0 : 0;
  const { s0: ms0, s1: ms1, s2: ms2 } = microSeeds(noiseSeed);
  const fe1 = hash2(4, 0, noiseSeed) | 0;
  const fe2 = hash2(5, 0, noiseSeed) | 0;
  const fh1 = hash2(6, 0, noiseSeed) | 0;
  const fh2 = hash2(7, 0, noiseSeed) | 0;
  const rkSeed = hash2(8, 0, noiseSeed) | 0;
  const mudSeed = hash2(9, 0, noiseSeed) | 0;
  const ripSeed = hash2(10, 0, noiseSeed) | 0;

  const features: FeatureSet | null = extra ? buildFeatures(extra, size) : null;
  const fieldSystem: FieldSystem | null =
    extra && extra.fieldGrid.length >= 5
      ? {
          regions: extra.fieldRegions,
          cell: extra.fieldGrid[0],
          ox: extra.fieldGrid[1],
          oz: extra.fieldGrid[2],
          nx: extra.fieldGrid[3],
          nz: extra.fieldGrid[4],
        }
      : null;

  // ---------------------------------------------------------------- height

  /** B-spline surface of the grid at (x, z) (x, z already inside the map). */
  function bspline(x: number, z: number): number {
    let gx = (x + half) * inv;
    let gz = (z + half) * inv;
    if (gx < 0) gx = 0;
    else if (gx > n - 1) gx = n - 1;
    if (gz < 0) gz = 0;
    else if (gz > n - 1) gz = n - 1;
    let i = Math.floor(gx);
    let j = Math.floor(gz);
    if (i > n - 2) i = n - 2;
    if (j > n - 2) j = n - 2;
    const t = gx - i;
    const u = gz - j;
    const t2 = t * t;
    const t3 = t2 * t;
    const u2 = u * u;
    const u3 = u2 * u;
    const bx0 = (1 - 3 * t + 3 * t2 - t3) / 6;
    const bx1 = (3 * t3 - 6 * t2 + 4) / 6;
    const bx2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
    const bx3 = t3 / 6;
    const bz0 = (1 - 3 * u + 3 * u2 - u3) / 6;
    const bz1 = (3 * u3 - 6 * u2 + 4) / 6;
    const bz2 = (-3 * u3 + 3 * u2 + 3 * u + 1) / 6;
    const bz3 = u3 / 6;
    let o = (j + 1) * PW + (i + 1);
    const r0 = bx0 * H[o] + bx1 * H[o + 1] + bx2 * H[o + 2] + bx3 * H[o + 3];
    o += PW;
    const r1 = bx0 * H[o] + bx1 * H[o + 1] + bx2 * H[o + 2] + bx3 * H[o + 3];
    o += PW;
    const r2 = bx0 * H[o] + bx1 * H[o + 1] + bx2 * H[o + 2] + bx3 * H[o + 3];
    o += PW;
    const r3 = bx0 * H[o] + bx1 * H[o + 1] + bx2 * H[o + 2] + bx3 * H[o + 3];
    return bz0 * r0 + bz1 * r1 + bz2 * r2 + bz3 * r3;
  }

  /** |∇B| at (x, z): the large-scale slope (tan of the slope angle). */
  function bsplineSlope(x: number, z: number): number {
    let gx = (x + half) * inv;
    let gz = (z + half) * inv;
    if (gx < 0) gx = 0;
    else if (gx > n - 1) gx = n - 1;
    if (gz < 0) gz = 0;
    else if (gz > n - 1) gz = n - 1;
    let i = Math.floor(gx);
    let j = Math.floor(gz);
    if (i > n - 2) i = n - 2;
    if (j > n - 2) j = n - 2;
    const t = gx - i;
    const u = gz - j;
    const t2 = t * t;
    const t3 = t2 * t;
    const u2 = u * u;
    const u3 = u2 * u;
    // Cubic B-spline weights and their derivatives in x (b*, d*) and z (c*, e*).
    const b0 = (1 - 3 * t + 3 * t2 - t3) / 6;
    const b1 = (3 * t3 - 6 * t2 + 4) / 6;
    const b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
    const b3 = t3 / 6;
    const d0 = -(1 - t) * (1 - t) * 0.5;
    const d1 = 1.5 * t2 - 2 * t;
    const d2 = -1.5 * t2 + t + 0.5;
    const d3 = 0.5 * t2;
    const c0 = (1 - 3 * u + 3 * u2 - u3) / 6;
    const c1 = (3 * u3 - 6 * u2 + 4) / 6;
    const c2 = (-3 * u3 + 3 * u2 + 3 * u + 1) / 6;
    const c3 = u3 / 6;
    const e0 = -(1 - u) * (1 - u) * 0.5;
    const e1 = 1.5 * u2 - 2 * u;
    const e2 = -1.5 * u2 + u + 0.5;
    const e3 = 0.5 * u2;
    let o = (j + 1) * PW + (i + 1);
    let r = b0 * H[o] + b1 * H[o + 1] + b2 * H[o + 2] + b3 * H[o + 3];
    let q = d0 * H[o] + d1 * H[o + 1] + d2 * H[o + 2] + d3 * H[o + 3];
    let sx = c0 * q;
    let sz = e0 * r;
    o += PW;
    r = b0 * H[o] + b1 * H[o + 1] + b2 * H[o + 2] + b3 * H[o + 3];
    q = d0 * H[o] + d1 * H[o + 1] + d2 * H[o + 2] + d3 * H[o + 3];
    sx += c1 * q;
    sz += e1 * r;
    o += PW;
    r = b0 * H[o] + b1 * H[o + 1] + b2 * H[o + 2] + b3 * H[o + 3];
    q = d0 * H[o] + d1 * H[o + 1] + d2 * H[o + 2] + d3 * H[o + 3];
    sx += c2 * q;
    sz += e2 * r;
    o += PW;
    r = b0 * H[o] + b1 * H[o + 1] + b2 * H[o + 2] + b3 * H[o + 3];
    q = d0 * H[o] + d1 * H[o + 1] + d2 * H[o + 2] + d3 * H[o + 3];
    sx += c3 * q;
    sz += e3 * r;
    return Math.sqrt(sx * sx + sz * sz) * inv;
  }

  /** Bilinear sample of a byte mask (0..255) at (x, z) inside the map. */
  function mask(m: Uint8Array, x: number, z: number): number {
    let gx = (x + half) * inv;
    let gz = (z + half) * inv;
    if (gx < 0) gx = 0;
    else if (gx > n - 1) gx = n - 1;
    if (gz < 0) gz = 0;
    else if (gz > n - 1) gz = n - 1;
    let i = Math.floor(gx);
    let j = Math.floor(gz);
    if (i > n - 2) i = n - 2;
    if (j > n - 2) j = n - 2;
    const fx = gx - i;
    const fz = gz - j;
    const k = j * n + i;
    const a = m[k] + (m[k + 1] - m[k]) * fx;
    const b = m[k + n] + (m[k + n + 1] - m[k + n]) * fx;
    return a + (b - a) * fz;
  }

  function heightAt(x: number, z: number): number {
    if (x < -half) x = -half;
    else if (x > half) x = half;
    if (z < -half) z = -half;
    else if (z > half) z = half;
    let h = bspline(x, z);
    if (rough) {
      h += microRelief(x, z, ms0, ms1, ms2) * (1 + (MICRO_ROUGH_GAIN / 255) * mask(rough, x, z));
    }
    if (features) h = blendFeatures(features, x, z, h);
    return h;
  }

  const NORMAL_EPS = 0.5;
  function normalAt(x: number, z: number, out: Vector3): Vector3 {
    const hx = heightAt(x + NORMAL_EPS, z) - heightAt(x - NORMAL_EPS, z);
    const hz = heightAt(x, z + NORMAL_EPS) - heightAt(x, z - NORMAL_EPS);
    return out.set(-hx, 2 * NORMAL_EPS, -hz).normalize();
  }

  // ---------------------------------------------------------------- land cover

  const land: Land = {
    q: createFeatureQuery(),
    cell: createFieldCell(),
    field: false,
    canopy: 0,
    canopyKind: 0,
  };

  /**
   * Resolve features, field and canopy at (x, z) into `land` (x, z inside the map).
   * The canopy is cleared on roads, water, banks, the airfield and range pads.
   */
  function evalLand(x: number, z: number): Land {
    const q = land.q;
    land.field = false;
    land.canopy = 0;
    land.canopyKind = 0;
    if (features) queryFeatures(features, x, z, q);
    else {
      q.roadDistance = Infinity;
      q.riverDistance = Infinity;
      q.padDistance = Infinity;
      q.airfieldDistance = Infinity;
      q.padIndex = -1;
      q.waterLevel = -Infinity;
    }
    if (!extra) return land;
    const verge = q.roadKind === KIND_TRACK ? 1.5 : 3;
    const cleared =
      q.roadDistance < q.roadHalfWidth + verge ||
      q.riverDistance < q.riverHalfWidth + q.riverBank ||
      q.airfieldDistance < 120 ||
      q.padDistance < 60;
    // Riverside trees.
    if (!cleared && q.riverDistance < q.riverHalfWidth + q.riverBank + RANGE_WORLD.riparianWidth) {
      const n1 = noise2(x / 70, z / 70, ripSeed);
      if (n1 > -0.35) {
        land.canopy = 12 + 8 * (0.5 + 0.5 * noise2(x / 130, z / 130, ripSeed ^ 77));
        land.canopyKind = 3;
        return land;
      }
    }
    // Farmed fields (cut the forest; may carry hedgerows).
    if (fieldSystem && farm && q.airfieldDistance > 60 && q.padDistance > 30) {
      if (mask(farm, x, z) >= FARM_POINT) {
        locateField(fieldSystem, x, z, land.cell);
        if (mask(farm, land.cell.cx, land.cell.cz) >= FARM_CENTRE) {
          land.field = !cleared || q.riverDistance >= q.riverHalfWidth + q.riverBank;
          if (!cleared && land.cell.hedgeDistance < RANGE_WORLD.hedgeHalfWidth) {
            land.canopy =
              RANGE_WORLD.hedgeMin +
              (RANGE_WORLD.hedgeMax - RANGE_WORLD.hedgeMin) * land.cell.hedgeHeight;
            land.canopyKind = 2;
          }
          return land;
        }
      }
    }
    // Forest.
    if (!cleared && forest) {
      const d = mask(forest, x, z) / 255;
      if (d + FOREST_EDGE_AMP > 0.5) {
        const e = d + 0.16 * noise2(x / 85, z / 85, fe1) + 0.07 * noise2(x / 26, z / 26, fe2);
        if (e > 0.5) {
          let k = 0.5 + 0.5 * noise2(x / 330, z / 330, fh1) + 0.15 * noise2(x / 45, z / 45, fh2);
          k = k < 0 ? 0 : k > 1 ? 1 : k;
          let hc = RANGE_WORLD.canopyMin + (RANGE_WORLD.canopyMax - RANGE_WORLD.canopyMin) * k;
          const edge = (e - 0.5) / 0.12;
          if (edge < 1) hc *= 0.72 + 0.28 * edge * edge * (3 - 2 * edge);
          land.canopy = hc;
          land.canopyKind = 1;
        }
      }
    }
    return land;
  }

  function clampX(v: number): number {
    return v < -half ? -half : v > half ? half : v;
  }

  function canopyAt(x: number, z: number): number {
    if (!extra) return 0;
    return evalLand(clampX(x), clampX(z)).canopy;
  }

  /** Bare rock: slopes over 28°, or over 19° on the high ridges (above ROCK_HIGH m). */
  const ROCK_SLOPE = Math.tan((28 * Math.PI) / 180);
  const ROCK_SLOPE_HIGH = Math.tan((19 * Math.PI) / 180);
  const ROCK_HIGH = 680;

  /**
   * Upper bound of the B-spline slope per grid cell (filled by buildAccel): where it is below the
   * gentlest rock slope (minus the jitter), the rock test is skipped.
   */
  let slopeBound: Float32Array | null = null;
  const ROCK_MIN_SLOPE = ROCK_SLOPE_HIGH - 0.06;

  /**
   * Classify the ground at (x, z) from an evaluated `land`; `h` is the height there, or NaN to
   * compute it only if a rule needs it.
   */
  function classify(x: number, z: number, h: number, L: Land): SurfaceKind {
    const q = L.q;
    if (q.airfieldDistance === 0 && extra?.airbase?.paved) {
      for (const p of extra.airbase.paved) {
        const ex = Math.sin(p.heading);
        const ez = -Math.cos(p.heading);
        const px = x - p.x;
        const pz = z - p.z;
        if (
          Math.abs(px * ex + pz * ez) <= p.length / 2 &&
          Math.abs(-px * ez + pz * ex) <= p.width / 2
        )
          return 'concrete';
      }
      if (q.roadDistance < q.roadHalfWidth) return q.roadKind === KIND_TRACK ? 'dirt' : 'road';
      return 'grass';
    }
    if (q.roadDistance < q.roadHalfWidth) return q.roadKind === KIND_TRACK ? 'dirt' : 'road';
    if (q.riverDistance < q.riverHalfWidth) return 'water';
    if (q.roadDistance < q.roadHalfWidth + (q.roadKind === KIND_TRACK ? 0.6 : 1.5)) return 'dirt';
    if (q.riverDistance < q.riverHalfWidth + q.riverBank) return 'sand';
    if (q.riverDistance < q.riverHalfWidth + q.riverBank + 22) {
      if (h !== h) h = heightAt(x, z);
      if (h - q.waterLevel < 2.8 && noise2(x / 40, z / 40, mudSeed) > -0.25) return 'mud';
    }
    if (q.padIndex >= 0 && q.padDistance === 0) {
      const c = padCentre(features!, q.padIndex);
      const ex = x - c.x;
      const ez = z - c.z;
      const r = c.radius * PAD_DIRT_FRACTION;
      return ex * ex + ez * ez < r * r ? 'dirt' : 'grass';
    }
    if (q.airfieldDistance < 60) return 'grass';
    if (!slopeBound || slopeBound[gridCell(x, z)] > ROCK_MIN_SLOPE) {
      const s = bsplineSlope(x, z);
      if (s > ROCK_MIN_SLOPE) {
        const j = 0.1 * noise2(x / 70, z / 70, rkSeed);
        if (s + j > ROCK_SLOPE) return 'rock';
        if (s + 0.6 * j > ROCK_SLOPE_HIGH) {
          if (h !== h) h = heightAt(x, z);
          if (h > ROCK_HIGH) return 'rock';
        }
      }
    }
    if (L.canopy > 0) return 'forest';
    if (L.field) {
      const c = L.cell;
      if (c.trackDistance < 2) return 'dirt';
      if (c.edgeDistance < 2.5) return 'grass';
      const crop = cropAt(c);
      return crop === 'ploughed' ? 'dirt' : crop === 'pasture' ? 'grass' : 'field';
    }
    return 'grass';
  }

  /** The crop of a located field: pasture on wet ground, else the field's own crop. */
  function cropAt(c: FieldCell): FieldSample['crop'] {
    if (moist && mask(moist, c.cx, c.cz) > 0.72 * 255 && c.crop !== 'ploughed') return 'pasture';
    return c.crop;
  }

  function surfaceAt(x: number, z: number): SurfaceKind {
    x = clampX(x);
    z = clampX(z);
    if (!extra) return 'grass';
    return classify(x, z, NaN, evalLand(x, z));
  }

  /** Index of the grid cell containing (x, z) (inside the map). */
  function gridCell(x: number, z: number): number {
    let i = Math.floor((x + half) * inv);
    let j = Math.floor((z + half) * inv);
    if (i > n - 2) i = n - 2;
    else if (i < 0) i = 0;
    if (j > n - 2) j = n - 2;
    else if (j < 0) j = 0;
    return j * (n - 1) + i;
  }

  // ---------------------------------------------------------------- ray queries

  // The ray-query hierarchy (built now, or on first use with lazyRayQueries).
  let accelBuilt: { field: RayField; minHeight: number } | null = options.lazyRayQueries
    ? null
    : buildAccel();
  function accelOf(): RayField {
    if (!accelBuilt) accelBuilt = buildAccel();
    return accelBuilt.field;
  }

  function buildAccel(): { field: RayField; minHeight: number } {
    const cellsGrid = n - 1;
    let cells = 1;
    while (cells < cellsGrid) cells *= 2;
    const nc = cellsGrid * cellsGrid;

    // B-spline + micro-relief bounds per grid cell, straight into pyramid level 0 (a
    // power-of-two square; cells beyond the grid never hold the ground).
    const upper0 = new Float32Array(cells * cells).fill(-Infinity);
    const grad0 = new Float32Array(cells * cells);
    const canopy0 = new Float32Array(cells * cells);
    const loT = new Float32Array(nc);
    const sb = new Float32Array(nc);
    cellBounds(
      H,
      PW,
      cellsGrid,
      inv,
      rough,
      n,
      MICRO_PEAK,
      MICRO_GRAD,
      MICRO_ROUGH_GAIN / 255,
      0.01,
      cells,
      upper0,
      grad0,
      loT,
      sb,
    );
    slopeBound = sb;
    if (extra) {
      canopyStats(
        forest,
        farm,
        n,
        cellsGrid,
        cells,
        FOREST_EDGE_AMP,
        RANGE_WORLD.canopyMax,
        FARM_POINT,
        RANGE_WORLD.hedgeMax,
        canopy0,
      );
    }

    // Feature layer: for every non-empty feature cell, the grid cells it overlaps.
    if (features) {
      const microPeakMax = MICRO_PEAK * (1 + MICRO_ROUGH_GAIN);
      const microGradMax = MICRO_GRAD * (1 + MICRO_ROUGH_GAIN);
      const segDepth = new Float64Array(features.segCount).fill(NaN);
      const padDepth = new Float64Array(features.padCount).fill(NaN);
      const se = { ax: 0, az: 0, bx: 0, bz: 0, ha: 0, hb: 0, reach: 0 };
      const pp = { x: 0, z: 0, reach: 0, h0: 0, gx: 0, gz: 0 };
      // Index of the pyramid level-0 cell containing (x, z).
      const cellOf = (x: number, z: number) => {
        const i = Math.min(cellsGrid - 1, Math.max(0, Math.floor((x + half) * inv)));
        const j = Math.min(cellsGrid - 1, Math.max(0, Math.floor((z + half) * inv)));
        return j * cells + i;
      };
      // Cut/fill depth bounds: the feature surface vs the B-spline at the segment ends, plus how
      // far the natural ground can wander within the segment's reach.
      const depthOfSegment = (k: number): number => {
        if (segDepth[k] === segDepth[k]) return segDepth[k];
        segmentEnds(features, k, se);
        const len = Math.sqrt((se.bx - se.ax) ** 2 + (se.bz - se.az) ** 2);
        const ga = Math.max(grad0[cellOf(se.ax, se.az)], grad0[cellOf(se.bx, se.bz)]);
        const d =
          Math.max(
            Math.abs(se.ha - bspline(clampX(se.ax), clampX(se.az))),
            Math.abs(se.hb - bspline(clampX(se.bx), clampX(se.bz))),
          ) +
          microPeakMax +
          (ga + microGradMax) * (len + se.reach) +
          3;
        segDepth[k] = d;
        return d;
      };
      const depthOfPad = (k: number): number => {
        if (padDepth[k] === padDepth[k]) return padDepth[k];
        padPlane(features, k, pp);
        let d = 0;
        for (let a = 0; a < 48; a++) {
          const ang = (a / 48) * Math.PI * 2;
          for (let f = 0; f <= 1; f += 0.25) {
            const x = clampX(pp.x + Math.cos(ang) * pp.reach * f);
            const z = clampX(pp.z + Math.sin(ang) * pp.reach * f);
            const plane = pp.h0 + pp.gx * (x - pp.x) + pp.gz * (z - pp.z);
            d = Math.max(d, Math.abs(plane - bspline(x, z)));
          }
        }
        d += microPeakMax + (grad0[cellOf(pp.x, pp.z)] + microGradMax) * spacing + 3;
        padDepth[k] = d;
        return d;
      };
      const fb = { hMax: 0, hMin: 0, slope: 0 };
      const fcs = features.cellSize;
      const fStart = features.cellStart;
      for (let fj = 0; fj < features.cells; fj++) {
        for (let fi = 0; fi < features.cells; fi++) {
          const fc = fj * features.cells + fi;
          if (fStart[fc] === fStart[fc + 1]) continue;
          cellFeatureBounds(features, fc, depthOfSegment, depthOfPad, Infinity, fb);
          const hMax = fb.hMax;
          const hMin = fb.hMin;
          const x0 = features.origin + fi * fcs;
          const z0 = features.origin + fj * fcs;
          const gi0 = Math.max(0, Math.floor((x0 + half) * inv));
          const gi1 = Math.min(cellsGrid - 1, Math.floor((x0 + fcs * 0.9999 + half) * inv));
          const gj0 = Math.max(0, Math.floor((z0 + half) * inv));
          const gj1 = Math.min(cellsGrid - 1, Math.floor((z0 + fcs * 0.9999 + half) * inv));
          for (let gj = gj0; gj <= gj1; gj++) {
            for (let gi = gi0; gi <= gi1; gi++) {
              const c = gj * cellsGrid + gi;
              const k = gj * cells + gi;
              const up = Math.max(upper0[k], hMax + 0.01);
              const lo = Math.min(loT[c], hMin);
              cellFeatureBounds(features, fc, depthOfSegment, depthOfPad, up - lo, fb);
              upper0[k] = up;
              loT[c] = lo;
              grad0[k] += fb.slope;
              // Riverside trees (and anything else near a feature): up to 20 m.
              if (canopy0[k] < 20) canopy0[k] = 20;
            }
          }
        }
      }
    }

    let maxGrad = 0;
    let maxHeight = -Infinity;
    let minHeight = Infinity;
    let maxCanopy = 0;
    const upperC0 = new Float32Array(cells * cells).fill(-Infinity);
    for (let j = 0; j < cellsGrid; j++) {
      for (let i = 0; i < cellsGrid; i++) {
        const k = j * cells + i;
        if (grad0[k] > maxGrad) maxGrad = grad0[k];
        if (upper0[k] > maxHeight) maxHeight = upper0[k];
        if (loT[j * cellsGrid + i] < minHeight) minHeight = loT[j * cellsGrid + i];
        if (canopy0[k] > maxCanopy) maxCanopy = canopy0[k];
        upperC0[k] = upper0[k] + canopy0[k];
      }
    }
    return {
      field: {
        size,
        cells,
        spacing,
        heightAt,
        canopyAt,
        upper: buildPyramid(upper0, cells),
        upperCanopy: buildPyramid(upperC0, cells),
        canopyMax: canopy0,
        grad: grad0,
        maxHeight,
        maxGrad,
        maxCanopy,
      },
      minHeight,
    };
  }

  const _d = new Vector3();

  function fillHit(out: TerrainHit, x: number, z: number, s: number, len: number): void {
    const h = heightAt(x, z);
    out.point.set(x, h, z);
    normalAt(x, z, out.normal);
    out.distance = s;
    out.t = len > 0 ? Math.min(1, s / len) : 0;
    out.surface = surfaceAt(x, z);
  }

  function segmentHit(p0: Vector3, p1: Vector3, out: TerrainHit): boolean {
    const ddx = p1.x - p0.x;
    const ddy = p1.y - p0.y;
    const ddz = p1.z - p0.z;
    const len = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    if (len < 1e-9) {
      if (p0.y - heightAt(p0.x, p0.z) <= 0) {
        fillHit(out, p0.x, p0.z, 0, 0);
        return true;
      }
      return false;
    }
    // Early rejection against the bound pyramid (most rounds and bombs, most of the time).
    const xa = ddx < 0 ? p1.x : p0.x;
    const xb = ddx < 0 ? p0.x : p1.x;
    const za = ddz < 0 ? p1.z : p0.z;
    const zb = ddz < 0 ? p0.z : p1.z;
    const ymin = ddy < 0 ? p1.y : p0.y;
    const accel = accelOf();
    if (ymin > accel.maxHeight) return false;
    if (segmentClearOfBounds(accel, xa, za, xb, zb, ymin, false)) return false;
    const il = 1 / len;
    const r = traceRay(accel, p0.x, p0.y, p0.z, ddx * il, ddy * il, ddz * il, len, false);
    if (r.s < 0) return false;
    fillHit(out, p0.x + ddx * il * r.s, p0.z + ddz * il * r.s, r.s, len);
    return true;
  }

  function raycast(origin: Vector3, dir: Vector3, maxDistance: number, out: TerrainHit): boolean {
    _d.copy(dir);
    const l = _d.length();
    if (l < 1e-12 || !(maxDistance > 0)) return false;
    _d.multiplyScalar(1 / l);
    const r = traceRay(
      accelOf(),
      origin.x,
      origin.y,
      origin.z,
      _d.x,
      _d.y,
      _d.z,
      maxDistance,
      false,
    );
    if (r.s < 0) return false;
    fillHit(out, origin.x + _d.x * r.s, origin.z + _d.z * r.s, r.s, maxDistance);
    return true;
  }

  function lineOfSight(a: Vector3, b: Vector3, includeTrees = false): boolean {
    const ddx = b.x - a.x;
    const ddy = b.y - a.y;
    const ddz = b.z - a.z;
    const len = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    const margin = 1;
    if (len <= 2 * margin) return true;
    const il = 1 / len;
    const r = traceRay(
      accelOf(),
      a.x,
      a.y,
      a.z,
      ddx * il,
      ddy * il,
      ddz * il,
      len - margin,
      includeTrees,
      margin,
    );
    return r.s < 0;
  }

  // ---------------------------------------------------------------- optional queries

  function fieldAt(x: number, z: number, out: FieldSample): boolean {
    if (!extra) return false;
    x = clampX(x);
    z = clampX(z);
    const L = evalLand(x, z);
    const q = L.q;
    if (!L.field || L.canopyKind === 3) return false;
    if (q.roadDistance < q.roadHalfWidth + 1.5 || q.riverDistance < q.riverHalfWidth + q.riverBank)
      return false;
    const c = L.cell;
    out.id = c.id;
    out.variant = c.variant;
    out.crop = cropAt(c);
    const ang = c.furrowsAlongRows ? c.rowAngle : c.rowAngle + Math.PI / 2;
    let hd = Math.atan2(Math.cos(ang), -Math.sin(ang));
    if (hd < 0) hd += Math.PI * 2;
    out.rowHeading = hd;
    out.edgeDistance = c.edgeDistance;
    out.hedge = c.edgeType === 1;
    out.track = c.edgeType === 2;
    return true;
  }

  function fieldVariantAt(x: number, z: number): number {
    return fieldAt(x, z, sampleField) ? sampleField.variant : -1;
  }
  const sampleField: FieldSample = {
    id: 0,
    variant: 0,
    crop: 'cereal',
    rowHeading: 0,
    edgeDistance: 0,
    hedge: false,
    track: false,
  };

  function waterLevelAt(x: number, z: number): number {
    if (!features) return -Infinity;
    const q = queryFeatures(features, clampX(x), clampX(z), land.q);
    return q.riverDistance < q.riverHalfWidth ? q.waterLevel : -Infinity;
  }

  function waterDepthAt(x: number, z: number): number {
    if (!features || !extra) return 0;
    const q = queryFeatures(features, clampX(x), clampX(z), land.q);
    if (!(q.riverDistance < q.riverHalfWidth)) return 0;
    const depth = extra.rivers[q.riverIndex]?.depth ?? RANGE_WORLD.riverDepth;
    const f = q.riverDistance / q.riverHalfWidth;
    return depth * (1 - f * f);
  }

  function roadDistanceAt(x: number, z: number): number {
    if (!features) return Infinity;
    return queryFeatures(features, clampX(x), clampX(z), land.q).roadDistance;
  }

  function forestDensityAt(x: number, z: number): number {
    return forest ? mask(forest, clampX(x), clampX(z)) / 255 : 0;
  }

  function moistureAt(x: number, z: number): number {
    return moist ? mask(moist, clampX(x), clampX(z)) / 255 : 0.5;
  }

  function slopeAt(x: number, z: number): number {
    return Math.atan(bsplineSlope(clampX(x), clampX(z)));
  }

  function sampleAt(x: number, z: number, out: TerrainSample): TerrainSample {
    x = clampX(x);
    z = clampX(z);
    const h = heightAt(x, z);
    out.height = h;
    normalAt(x, z, out.normal);
    if (!extra) {
      out.surface = 'grass';
      out.canopy = 0;
      out.waterLevel = -Infinity;
      out.forestDensity = 0;
      out.moisture = 0.5;
      out.roadDistance = Infinity;
      out.fieldVariant = -1;
      return out;
    }
    const L = evalLand(x, z);
    out.surface = classify(x, z, h, L);
    out.canopy = L.canopy;
    out.waterLevel = L.q.riverDistance < L.q.riverHalfWidth ? L.q.waterLevel : -Infinity;
    out.roadDistance = L.q.roadDistance;
    out.forestDensity = forest ? mask(forest, x, z) / 255 : 0;
    out.moisture = moist ? mask(moist, x, z) / 255 : 0.5;
    out.fieldVariant =
      L.field &&
      L.canopyKind !== 3 &&
      !(L.q.roadDistance < L.q.roadHalfWidth + 1.5) &&
      !(L.q.riverDistance < L.q.riverHalfWidth + L.q.riverBank)
        ? L.cell.variant
        : -1;
    return out;
  }

  function heightGrid(
    x0: number,
    z0: number,
    step: number,
    count: number,
    out: Float32Array,
  ): Float32Array {
    for (let j = 0; j < count; j++) {
      const z = z0 + j * step;
      for (let i = 0; i < count; i++) out[j * count + i] = heightAt(x0 + i * step, z);
    }
    return out;
  }

  return {
    seed: data.seed,
    size,
    get minHeight() {
      accelOf();
      return accelBuilt!.minHeight;
    },
    get maxHeight() {
      return accelOf().maxHeight;
    },
    heightAt,
    normalAt,
    surfaceAt,
    canopyAt,
    segmentHit,
    raycast,
    lineOfSight,
    roads: extra ? extra.roads : [],
    targetAreas: extra ? extra.targetAreas : [],
    airbase: extra ? extra.airbase : null,
    start: extra ? extra.start : { x: 0, z: 0, heading: 0 },
    data,
    rivers: extra ? extra.rivers : [],
    waterLevelAt,
    waterDepthAt,
    forestDensityAt,
    moistureAt,
    roadDistanceAt,
    fieldAt,
    fieldVariantAt,
    slopeAt,
    sampleAt,
    heightGrid,
  };
}

/** Feature tables of a generated world. */
function buildFeatures(extra: WorldExtra, size: number): FeatureSet {
  const pads: PadSpec[] = padSpecsOf(extra.pads, extra.airfield);
  return buildFeatureSet(size, extra.rivers, extra.roads, pads, {
    highway: RANGE_WORLD.highwayBlend,
    road: RANGE_WORLD.roadBlend,
    track: RANGE_WORLD.trackBlend,
  });
}
