/**
 * Exact, fast ray and segment queries against the terrain height function.
 *
 * A max-height pyramid ("maximum mipmap") bounds heightAt from above over every grid cell and
 * every 2^k block of cells. A ray is walked through the pyramid front to back: a block whose bound
 * lies below the ray over the block's extent is skipped whole. Inside a candidate grid cell the
 * first root of f(s) = y(s) − heightAt(x(s), z(s)) is found by Lipschitz-bounded sphere tracing:
 * |∇heightAt| ≤ G in the cell (bounds from the B-spline control points, the micro-detail
 * amplitude and the feature blends), so f cannot fall faster than r = G·|dir_xz| − dir_y and no
 * root lies within f/r of the current point. Steps therefore never jump over the ground, however
 * shallow the ray (grazing rounds), and stop within EPS of it. An over-relaxed step (Keinert et
 * al. 2014) is tried first and kept only when a two-sided Lipschitz test proves it skipped nothing.
 *
 * The tree-canopy volume (lineOfSight with trees) uses a second pyramid bounding
 * heightAt + canopyAt and samples the canopy every few metres where the ray is inside the band.
 */

/** What the tracer needs from the terrain. */
export interface RayField {
  size: number;
  /** Cells per side of the finest pyramid level (a power of two ≥ the grid's cells). */
  cells: number;
  /** Grid spacing, m (one finest cell). */
  spacing: number;
  heightAt(x: number, z: number): number;
  canopyAt(x: number, z: number): number;
  /** Pyramid of upper bounds of heightAt, level 0 = finest (cells × cells). */
  upper: Float32Array[];
  /** Pyramid of upper bounds of heightAt + canopyAt. */
  upperCanopy: Float32Array[];
  /** Upper bound of the canopy height per finest cell (0 = no trees possible). */
  canopyMax: Float32Array;
  /** |∇heightAt| bound per finest cell. */
  grad: Float32Array;
  /** Global bounds (for parts of a ray outside the map, where the edge is extended). */
  maxHeight: number;
  maxGrad: number;
  maxCanopy: number;
}

/** Hit when the ray is within this height of the ground, m. */
const EPS = 0.001;
/** Canopy sampling step inside the canopy band, m. */
const CANOPY_STEP = 3;
/** Sphere-tracing iteration cap per search (a ray tangent to the ground within EPS). */
const MAX_ITER = 3000;

/**
 * Ray state of the current query (module scratch, no allocation per query). The numbers are fields
 * of one object: a number stored in a module variable would be boxed on every store (review RT-1).
 */
const R = { ox: 0.5, oy: 0.5, oz: 0.5, dx: 0.5, dy: 0.5, dz: 0.5, hx: 0.5, half: 0.5 };
let field: RayField;
let withTrees = false;

/** Result of the last search: ray parameter of the hit, or -1. */
export interface TraceResult {
  s: number;
  /** 'ground' or 'canopy' (lineOfSight with trees). */
  canopy: boolean;
}

const _res: TraceResult = { s: -1, canopy: false };

/**
 * First point along origin + dir·s, s ∈ [0, length], where the ray meets the ground (or, with
 * trees, the canopy volume). `dir` must be a unit vector. Returns s or −1.
 */
export function traceRay(
  f: RayField,
  px: number,
  py: number,
  pz: number,
  ux: number,
  uy: number,
  uz: number,
  length: number,
  trees: boolean,
  startS = 0,
): TraceResult {
  field = f;
  R.ox = px;
  R.oy = py;
  R.oz = pz;
  R.dx = ux;
  R.dy = uy;
  R.dz = uz;
  R.hx = Math.sqrt(ux * ux + uz * uz);
  R.half = f.size / 2;
  withTrees = trees;
  _res.s = -1;
  _res.canopy = false;
  const s0 = startS;
  const s1 = length;
  if (s1 < s0) return _res;

  // Whole query above everything: done.
  const top = trees ? f.maxHeight + f.maxCanopy : f.maxHeight;
  if (R.oy + R.dy * s0 > top && R.oy + R.dy * s1 > top) return _res;

  // The part of the ray inside the map square.
  const a = s0;
  const b = s1;
  let ta = -Infinity;
  let tb = Infinity;
  if (Math.abs(R.dx) < 1e-12) {
    if (R.ox < -R.half || R.ox > R.half) {
      ta = Infinity;
      tb = -Infinity;
    }
  } else {
    const t1 = (-R.half - R.ox) / R.dx;
    const t2 = (R.half - R.ox) / R.dx;
    ta = Math.max(ta, Math.min(t1, t2));
    tb = Math.min(tb, Math.max(t1, t2));
  }
  if (Math.abs(R.dz) < 1e-12) {
    if (R.oz < -R.half || R.oz > R.half) {
      ta = Infinity;
      tb = -Infinity;
    }
  } else {
    const t1 = (-R.half - R.oz) / R.dz;
    const t2 = (R.half - R.oz) / R.dz;
    ta = Math.max(ta, Math.min(t1, t2));
    tb = Math.min(tb, Math.max(t1, t2));
  }
  const inA = Math.max(a, ta);
  const inB = Math.min(b, tb);
  if (inB < inA) {
    // Entirely outside the map: the edge-extended ground, global bounds.
    const s = outsideSearch(a, b);
    _res.s = s;
    return _res;
  }
  if (inA > a) {
    const s = outsideSearch(a, inA);
    if (s >= 0) {
      _res.s = s;
      return _res;
    }
  }
  const levels = f.upper.length - 1;
  const s = traceNode(levels, 0, 0, inA, inB);
  if (s >= 0) {
    _res.s = s;
    return _res;
  }
  if (inB < b) {
    const s2 = outsideSearch(inB, b);
    if (s2 >= 0) {
      _res.s = s2;
      return _res;
    }
  }
  return _res;
}

/** Recursive front-to-back walk of the pyramid over ray interval [sa, sb]. */
function traceNode(level: number, ix: number, iz: number, sa: number, sb: number): number {
  const n = field.cells >> level;
  const k = iz * n + ix;
  const ya = R.oy + R.dy * sa;
  const yb = R.oy + R.dy * sb;
  const ymin = ya < yb ? ya : yb;
  const bound = withTrees ? field.upperCanopy[level][k] : field.upper[level][k];
  if (ymin > bound) return -1;
  if (level === 0) return cellSearch(k, sa, sb, ya, bound);

  const nodeSize = field.spacing * (1 << level);
  const xm = -R.half + (ix + 0.5) * nodeSize;
  const zm = -R.half + (iz + 0.5) * nodeSize;
  // Parameters where the ray crosses the node's mid lines, if inside (sa, sb).
  let c1 = Infinity;
  let c2 = Infinity;
  if (R.dx !== 0) {
    const t = (xm - R.ox) / R.dx;
    if (t > sa && t < sb) c1 = t;
  }
  if (R.dz !== 0) {
    const t = (zm - R.oz) / R.dz;
    if (t > sa && t < sb) {
      if (t < c1) {
        c2 = c1;
        c1 = t;
      } else c2 = t;
    }
  }
  // Visit the (up to three) children the ray crosses, in order along the ray.
  const cuts = (c1 < Infinity ? 1 : 0) + (c2 < Infinity ? 1 : 0);
  let a = sa;
  for (let part = 0; part <= cuts; part++) {
    const b = part === cuts ? sb : part === 0 ? c1 : c2;
    if (b > a || sa === sb) {
      const m = 0.5 * (a + b);
      const cx = R.ox + R.dx * m >= xm ? 1 : 0;
      const cz = R.oz + R.dz * m >= zm ? 1 : 0;
      const r = traceNode(level - 1, 2 * ix + cx, 2 * iz + cz, a, b);
      if (r >= 0) return r;
    }
    a = b;
  }
  return -1;
}

/** Search one finest cell over [sa, sb] (ya = ray height at sa, bound = cell's upper bound). */
function cellSearch(k: number, sa: number, sb: number, ya: number, bound: number): number {
  const G = field.grad[k];
  const groundBound = withTrees ? field.upper[0][k] : bound;
  // Trim to where the ray is below the ground bound.
  let a = sa;
  let b = sb;
  if (R.dy < 0) {
    if (ya > groundBound) a = (groundBound - R.oy) / R.dy;
  } else if (R.dy > 0) {
    const yb = R.oy + R.dy * sb;
    if (yb > groundBound) b = (groundBound - R.oy) / R.dy;
  }
  if (b >= a) {
    const s = lipschitzSearch(a, b, G);
    if (s >= 0) return s;
  }
  if (withTrees && field.canopyMax[k] > 0) {
    const s = canopySearch(sa, sb, G, field.canopyMax[k]);
    if (s >= 0) {
      _res.canopy = true;
      return s;
    }
  }
  return -1;
}

/** f(s) = ray height − ground height. */
function gap(s: number): number {
  return R.oy + R.dy * s - field.heightAt(R.ox + R.dx * s, R.oz + R.dz * s);
}

/**
 * First root of f on [sa, sb] given |∇h| ≤ G there: over-relaxed sphere tracing with a two-sided
 * Lipschitz acceptance test. Returns s or −1.
 */
function lipschitzSearch(sa: number, sb: number, G: number): number {
  const rDec = G * R.hx - R.dy;
  const rInc = G * R.hx + R.dy;
  let s = sa;
  let f = gap(s);
  if (f <= EPS) return s;
  if (rDec <= 0) return -1;
  let omega = 1.7;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const safe = f / rDec;
    if (s + safe >= sb) return -1;
    if (omega > 1) {
      let s2 = s + omega * safe;
      if (s2 > sb) s2 = sb;
      const f2 = gap(s2);
      // No root in [s, s2] iff the two Lipschitz cones from s and s2 do not meet below zero.
      if (f2 > EPS && f / rDec + (rInc > 0 ? f2 / rInc : Infinity) > s2 - s) {
        if (s2 >= sb) return -1;
        s = s2;
        f = f2;
        continue;
      }
      omega = 1;
    }
    s += safe;
    f = gap(s);
    if (f <= EPS) return s;
  }
  // Tangent within millimetres over a long stretch: count it as touching.
  return s;
}

/**
 * Canopy volume search on [sa, sb]: blocked where the ray is below ground + canopy. Steps of
 * CANOPY_STEP inside the band (ground … ground + canopyMax), Lipschitz skips above it.
 */
function canopySearch(sa: number, sb: number, G: number, cmax: number): number {
  const rDec = G * R.hx - R.dy;
  let s = sa;
  for (let iter = 0; iter < 100000 && s <= sb; iter++) {
    const x = R.ox + R.dx * s;
    const z = R.oz + R.dz * s;
    const g = R.oy + R.dy * s - field.heightAt(x, z);
    if (g < cmax) {
      const c = field.canopyAt(x, z);
      if (c > 0 && g < c) return s;
      s += CANOPY_STEP;
    } else {
      const skip = rDec > 0 ? (g - cmax) / rDec : Infinity;
      if (skip === Infinity) return -1;
      s += skip > CANOPY_STEP ? skip : CANOPY_STEP;
    }
  }
  return -1;
}

/** Ray parts outside the map (edge-extended ground): global bounds, plain Lipschitz search. */
function outsideSearch(sa: number, sb: number): number {
  const top = field.maxHeight + (withTrees ? field.maxCanopy : 0);
  let a = sa;
  let b = sb;
  const ya = R.oy + R.dy * sa;
  const yb = R.oy + R.dy * sb;
  if (ya > top && yb > top) return -1;
  if (R.dy < 0 && ya > top) a = (top - R.oy) / R.dy;
  if (R.dy > 0 && yb > top) b = (top - R.oy) / R.dy;
  if (b < a) return -1;
  const s = lipschitzSearch(a, b, field.maxGrad);
  if (s >= 0) return s;
  if (withTrees && field.maxCanopy > 0) {
    const c = canopySearch(a, b, field.maxGrad, field.maxCanopy);
    if (c >= 0) {
      _res.canopy = true;
      return c;
    }
  }
  return -1;
}

/**
 * Build the max pyramids from the finest-level bounds (cells × cells, power of two).
 */
export function buildPyramid(level0: Float32Array, cells: number): Float32Array[] {
  const levels: Float32Array[] = [level0];
  let n = cells;
  let prev = level0;
  while (n > 1) {
    const m = n >> 1;
    const next = new Float32Array(m * m);
    for (let j = 0; j < m; j++) {
      const r0 = 2 * j * n;
      const r1 = r0 + n;
      for (let i = 0; i < m; i++) {
        const a = prev[r0 + 2 * i];
        const b = prev[r0 + 2 * i + 1];
        const c = prev[r1 + 2 * i];
        const d = prev[r1 + 2 * i + 1];
        const ab = a > b ? a : b;
        const cd = c > d ? c : d;
        next[j * m + i] = ab > cd ? ab : cd;
      }
    }
    levels.push(next);
    prev = next;
    n = m;
  }
  return levels;
}

/**
 * Quick reject for a short segment: the max bound of the ≤ 2 × 2 pyramid nodes covering its
 * horizontal extent, at the level where it fits. Returns true if the segment is certainly above
 * the ground (and the canopy, with trees) everywhere.
 */
export function segmentClearOfBounds(
  f: RayField,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  ymin: number,
  trees: boolean,
): boolean {
  const h = f.size / 2;
  if (x0 < -h || x1 > h || z0 < -h || z1 > h) return false;
  const inv = 1 / f.spacing;
  let i0 = Math.floor((x0 + h) * inv);
  let i1 = Math.floor((x1 + h) * inv);
  let j0 = Math.floor((z0 + h) * inv);
  let j1 = Math.floor((z1 + h) * inv);
  const last = f.cells - 1;
  if (i1 > last) i1 = last;
  if (j1 > last) j1 = last;
  if (i0 > last) i0 = last;
  if (j0 > last) j0 = last;
  let level = 0;
  while ((i1 - i0 > 1 || j1 - j0 > 1) && level < f.upper.length - 1) {
    i0 >>= 1;
    i1 >>= 1;
    j0 >>= 1;
    j1 >>= 1;
    level++;
  }
  const arr = trees ? f.upperCanopy[level] : f.upper[level];
  const n = f.cells >> level;
  let m = arr[j0 * n + i0];
  let v = arr[j0 * n + i1];
  if (v > m) m = v;
  v = arr[j1 * n + i0];
  if (v > m) m = v;
  v = arr[j1 * n + i1];
  if (v > m) m = v;
  return ymin > m;
}
