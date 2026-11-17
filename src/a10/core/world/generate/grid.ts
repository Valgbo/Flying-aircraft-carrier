/**
 * The generator's working height grid and small helpers to sample it (bilinear: the generator
 * only needs large-scale values; the finished terrain uses the B-spline surface).
 */

export interface Grid {
  /** Samples per edge. */
  n: number;
  size: number;
  half: number;
  spacing: number;
  /** Heights, row-major (row = z, north → south). */
  h: Float32Array;
}

export function createGrid(n: number, size: number): Grid {
  return { n, size, half: size / 2, spacing: size / (n - 1), h: new Float32Array(n * n) };
}

/** Bilinear height at world (x, z), clamped to the map. */
export function gridHeight(g: Grid, x: number, z: number): number {
  return sampleBilinear(g, g.h, x, z);
}

/** Bilinear sample of any per-sample array of the grid's size. */
export function sampleBilinear(
  g: Grid,
  a: Float32Array | Uint8Array,
  x: number,
  z: number,
): number {
  const n = g.n;
  let gx = (x + g.half) / g.spacing;
  let gz = (z + g.half) / g.spacing;
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
  const p = a[k] + (a[k + 1] - a[k]) * fx;
  const q = a[k + n] + (a[k + n + 1] - a[k + n]) * fx;
  return p + (q - p) * fz;
}

/**
 * The uniform cubic B-spline surface of the grid at world (x, z): the same surface the finished
 * terrain's heightAt starts from (before micro-relief and features).
 */
export function gridBSpline(g: Grid, x: number, z: number): number {
  const n = g.n;
  const h = g.h;
  let gx = (x + g.half) / g.spacing;
  let gz = (z + g.half) / g.spacing;
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
  const b0 = (1 - 3 * t + 3 * t2 - t3) / 6;
  const b1 = (3 * t3 - 6 * t2 + 4) / 6;
  const b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
  const b3 = t3 / 6;
  // Clamped neighbour columns (edge repeat, as the terrain's padded grid).
  const c0 = i > 0 ? i - 1 : 0;
  const c3 = i + 2 < n ? i + 2 : n - 1;
  let v = 0;
  for (let b = 0; b < 4; b++) {
    let jj = j - 1 + b;
    if (jj < 0) jj = 0;
    else if (jj > n - 1) jj = n - 1;
    const o = jj * n;
    const r = b0 * h[o + c0] + b1 * h[o + i] + b2 * h[o + i + 1] + b3 * h[o + c3];
    const w =
      b === 0
        ? (1 - 3 * u + 3 * u2 - u3) / 6
        : b === 1
          ? (3 * u3 - 6 * u2 + 4) / 6
          : b === 2
            ? (-3 * u3 + 3 * u2 + 3 * u + 1) / 6
            : u3 / 6;
    v += w * r;
  }
  return v;
}

/** Slope (tan) at grid sample (i, j) by central differences. */
export function gridSlope(g: Grid, i: number, j: number): number {
  const n = g.n;
  const h = g.h;
  const i0 = i > 0 ? i - 1 : i;
  const i1 = i < n - 1 ? i + 1 : i;
  const j0 = j > 0 ? j - 1 : j;
  const j1 = j < n - 1 ? j + 1 : j;
  const sx = (h[j * n + i1] - h[j * n + i0]) / ((i1 - i0) * g.spacing);
  const sz = (h[j1 * n + i] - h[j0 * n + i]) / ((j1 - j0) * g.spacing);
  return Math.sqrt(sx * sx + sz * sz);
}

/**
 * Upsample a coarse grid (nc² samples over the same square) into `fine` with Catmull-Rom
 * interpolation (keeps the coarse values at the coarse sample points).
 */
export function upsample(coarse: Float32Array, nc: number, fine: Grid): void {
  const nf = fine.n;
  const ratio = (nc - 1) / (nf - 1);
  const at = (i: number, j: number) =>
    coarse[Math.min(nc - 1, Math.max(0, j)) * nc + Math.min(nc - 1, Math.max(0, i))];
  for (let j = 0; j < nf; j++) {
    const gz = j * ratio;
    const jz = Math.min(nc - 2, Math.floor(gz));
    const tz = gz - jz;
    const wz0 = ((-tz + 2) * tz - 1) * tz * 0.5;
    const wz1 = ((3 * tz - 5) * tz * tz + 2) * 0.5;
    const wz2 = ((-3 * tz + 4) * tz + 1) * tz * 0.5;
    const wz3 = (tz - 1) * tz * tz * 0.5;
    for (let i = 0; i < nf; i++) {
      const gx = i * ratio;
      const ix = Math.min(nc - 2, Math.floor(gx));
      const tx = gx - ix;
      const wx0 = ((-tx + 2) * tx - 1) * tx * 0.5;
      const wx1 = ((3 * tx - 5) * tx * tx + 2) * 0.5;
      const wx2 = ((-3 * tx + 4) * tx + 1) * tx * 0.5;
      const wx3 = (tx - 1) * tx * tx * 0.5;
      let v = 0;
      for (let b = 0; b < 4; b++) {
        const wz = b === 0 ? wz0 : b === 1 ? wz1 : b === 2 ? wz2 : wz3;
        const jj = jz - 1 + b;
        v +=
          wz *
          (wx0 * at(ix - 1, jj) + wx1 * at(ix, jj) + wx2 * at(ix + 1, jj) + wx3 * at(ix + 2, jj));
      }
      fine.h[j * nf + i] = v;
    }
  }
}
