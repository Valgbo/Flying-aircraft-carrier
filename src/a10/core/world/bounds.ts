/**
 * Per-cell bounds of the B-spline height surface, for the ray-query hierarchy and the rock test.
 * Module-level functions with plain typed-array parameters (fast loops, no closure state).
 *
 * For grid cell (i, j) the B-spline uses control points (i−1 … i+2, j−1 … j+2). Its value lies
 * between their min and max (convex hull: the weights are ≥ 0 and sum to 1), and its x-slope is
 * a convex combination of the control-point differences along x divided by the spacing (likewise
 * z), so |∇B| ≤ √(max|Δx|² + max|Δz|²) / spacing.
 */

/**
 * Bounds of B-spline + micro-relief for every grid cell, written at `stride` into the pyramid's
 * level 0: `upper` (max height + `margin`), `grad` (|∇h| bound: B-spline slope bound plus the
 * micro-relief's amplitude and gradient bounds scaled by the roughness mask), and per grid cell
 * `lower` (min height) and `slopeB` (pure B-spline slope bound). H is the padded grid (PW samples
 * per row, 2 samples of padding). Row statistics of the 4 control points per cell column live in
 * a 4-row ring buffer, so no full-size temporaries are allocated.
 */
export function cellBounds(
  H: Float32Array,
  PW: number,
  cells: number,
  inv: number,
  rough: Uint8Array | null,
  n: number,
  microPeak: number,
  microGrad: number,
  roughGain: number,
  margin: number,
  stride: number,
  upper: Float32Array,
  grad: Float32Array,
  lower: Float32Array,
  slopeB: Float32Array,
): void {
  // Ring of 4 padded-row statistics: max, min, max |Δx| (4 control points) and max |Δz| to the
  // next padded row.
  const rMax = new Float32Array(4 * cells);
  const rMin = new Float32Array(4 * cells);
  const rDx = new Float32Array(4 * cells);
  const rDz = new Float32Array(4 * cells);
  const fill = (r: number) => {
    const slot = (r & 3) * cells;
    for (let i = 0; i < cells; i++) {
      const o = r * PW + i + 1;
      const a = H[o];
      const b = H[o + 1];
      const c = H[o + 2];
      const d = H[o + 3];
      let mx = a > b ? a : b;
      if (c > mx) mx = c;
      if (d > mx) mx = d;
      let mn = a < b ? a : b;
      if (c < mn) mn = c;
      if (d < mn) mn = d;
      let dx = b > a ? b - a : a - b;
      let t = c > b ? c - b : b - c;
      if (t > dx) dx = t;
      t = d > c ? d - c : c - d;
      if (t > dx) dx = t;
      const p = o + PW;
      let dz = H[p] > a ? H[p] - a : a - H[p];
      t = H[p + 1] > b ? H[p + 1] - b : b - H[p + 1];
      if (t > dz) dz = t;
      t = H[p + 2] > c ? H[p + 2] - c : c - H[p + 2];
      if (t > dz) dz = t;
      t = H[p + 3] > d ? H[p + 3] - d : d - H[p + 3];
      if (t > dz) dz = t;
      rMax[slot + i] = mx;
      rMin[slot + i] = mn;
      rDx[slot + i] = dx;
      rDz[slot + i] = dz;
    }
  };
  // Cell row j uses padded rows j+1 … j+4 (max/min/Δx) and the Δz between j+1…j+2, j+2…j+3,
  // j+3…j+4 (stored on the upper row of each pair).
  fill(1);
  fill(2);
  fill(3);
  for (let j = 0; j < cells; j++) {
    fill(j + 4);
    const s0 = ((j + 1) & 3) * cells;
    const s1 = ((j + 2) & 3) * cells;
    const s2 = ((j + 3) & 3) * cells;
    const s3 = ((j + 4) & 3) * cells;
    for (let i = 0; i < cells; i++) {
      let up = rMax[s0 + i];
      let lo = rMin[s0 + i];
      let gx = rDx[s0 + i];
      let gz = rDz[s0 + i];
      let v = rMax[s1 + i];
      if (v > up) up = v;
      v = rMin[s1 + i];
      if (v < lo) lo = v;
      v = rDx[s1 + i];
      if (v > gx) gx = v;
      v = rDz[s1 + i];
      if (v > gz) gz = v;
      v = rMax[s2 + i];
      if (v > up) up = v;
      v = rMin[s2 + i];
      if (v < lo) lo = v;
      v = rDx[s2 + i];
      if (v > gx) gx = v;
      v = rDz[s2 + i];
      if (v > gz) gz = v;
      v = rMax[s3 + i];
      if (v > up) up = v;
      v = rMin[s3 + i];
      if (v < lo) lo = v;
      v = rDx[s3 + i];
      if (v > gx) gx = v;
      const c = j * cells + i;
      let g = Math.sqrt(gx * gx + gz * gz) * inv;
      slopeB[c] = g;
      let mp = 0;
      if (rough) {
        const q = j * n + i;
        const r00 = rough[q];
        const r10 = rough[q + 1];
        const r01 = rough[q + n];
        const r11 = rough[q + n + 1];
        let rmax = r00 > r10 ? r00 : r10;
        if (r01 > rmax) rmax = r01;
        if (r11 > rmax) rmax = r11;
        const amp = 1 + roughGain * rmax;
        let drx = r10 > r00 ? r10 - r00 : r00 - r10;
        let t = r11 > r01 ? r11 - r01 : r01 - r11;
        if (t > drx) drx = t;
        let drz = r01 > r00 ? r01 - r00 : r00 - r01;
        t = r11 > r10 ? r11 - r10 : r10 - r11;
        if (t > drz) drz = t;
        mp = microPeak * amp;
        g += microGrad * amp + microPeak * Math.sqrt(drx * drx + drz * drz) * inv * roughGain;
      }
      const k = j * stride + i;
      upper[k] = up + mp + margin;
      grad[k] = g;
      lower[c] = lo - mp;
    }
  }
}

/** Canopy bound per cell: forest possible (density + edge noise > 0.5) or farmland (hedges). */
export function canopyStats(
  forest: Uint8Array | null,
  farm: Uint8Array | null,
  n: number,
  cells: number,
  stride: number,
  forestEdgeAmp: number,
  forestHeight: number,
  farmThreshold: number,
  hedgeHeight: number,
  out: Float32Array,
): void {
  const forestMin = (0.5 - forestEdgeAmp) * 255;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const q = j * n + i;
      let cm = 0;
      if (forest) {
        if (
          forest[q] > forestMin ||
          forest[q + 1] > forestMin ||
          forest[q + n] > forestMin ||
          forest[q + n + 1] > forestMin
        )
          cm = forestHeight;
      }
      if (farm && cm < hedgeHeight) {
        if (
          farm[q] >= farmThreshold ||
          farm[q + 1] >= farmThreshold ||
          farm[q + n] >= farmThreshold ||
          farm[q + n + 1] >= farmThreshold
        )
          cm = hedgeHeight;
      }
      out[j * stride + i] = cm;
    }
  }
}
