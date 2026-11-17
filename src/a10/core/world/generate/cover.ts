/**
 * Land cover masks on the height grid: forest density, farmland suitability, moisture and
 * micro-relief roughness (WorldExtra layout). Rules:
 *  - forest covers the hill and mountain slopes, thins on the highest crests and on crags, and
 *    stands in scattered woods on the valley floor; clearings are cut out of it;
 *  - farmland is the flat valley floor (< ≈ 5°) outside woods, rough-grazing patches, the river
 *    banks, the airfield and the range;
 *  - moisture is high by the river and in the low valley, low on high ground;
 *  - roughness is small on fields, larger in forests and largest on steep rock.
 * The large-scale noise fields are evaluated on a coarse 250 m lattice and interpolated.
 */
import { fbm2, smoothstep } from '../noise';
import { gridSlope, type Grid } from './grid';
import { valleyT, type Layout } from './layout';
import { FAR, type RiverField } from './river';
import type { AirbaseSite, RangePad } from './sites';

export interface Cover {
  forest: Uint8Array;
  farmland: Uint8Array;
  moisture: Uint8Array;
  roughness: Uint8Array;
}

const RAD = 180 / Math.PI;

/** Channels of the coarse lattice (smooth fields, evaluated every 250 m). */
const CH_VAR = 0;
const CH_WOODS = 1;
const CH_CLEAR = 2;
const CH_GRAZE = 3;
const CH_MOIST = 4;
const CH_EDGE = 5;
const CH_T = 6;
const CHANNELS = 7;

/** Bilinear weights of the current sample (module scratch). */
const W = new Float64Array(4);

/** Bilinear read of channel c of the lattice cell whose first corner is at offset o. */
function lerp4(lat: Float32Array, o: number, rowStride: number, c: number): number {
  return (
    lat[o + c] * W[0] +
    lat[o + CHANNELS + c] * W[1] +
    lat[o + rowStride + c] * W[2] +
    lat[o + rowStride + CHANNELS + c] * W[3]
  );
}

/** Bilinear 2× upsample of a 0..1 field (nh² samples) into a byte mask (n = 2·nh − 1). */
function upsampleTo8(src: Float32Array, nh: number, dst: Uint8Array, n: number): void {
  for (let j = 0; j < n; j++) {
    const j0 = j >> 1;
    const j1 = j & 1 ? j0 + 1 : j0;
    for (let i = 0; i < n; i++) {
      const i0 = i >> 1;
      const i1 = i & 1 ? i0 + 1 : i0;
      const v =
        0.25 * (src[j0 * nh + i0] + src[j0 * nh + i1] + src[j1 * nh + i0] + src[j1 * nh + i1]);
      dst[j * n + i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
    }
  }
}

export function makeCover(
  L: Layout,
  g: Grid,
  rf: RiverField,
  site: AirbaseSite,
  pads: RangePad[],
  seed: number,
): Cover {
  const { n, spacing, half, h } = g;
  const size = g.size;
  // Smooth fields (fBm σ ≈ 0.2, so thresholds sit within ±2σ) on a 250 m lattice; each grid
  // sample reads all channels with one set of bilinear weights.
  const C = 256;
  const m = C + 1;
  const step = size / C;
  const lat = new Float32Array(m * m * CHANNELS);
  for (let j = 0; j < m; j++) {
    const z = -half + j * step;
    for (let i = 0; i < m; i++) {
      const x = -half + i * step;
      const o = (j * m + i) * CHANNELS;
      lat[o + CH_VAR] = fbm2(x / 3200, z / 3200, 3, seed + 11);
      lat[o + CH_WOODS] = fbm2(x / 2400, z / 2400, 4, seed + 23);
      lat[o + CH_CLEAR] = fbm2(x / 1300, z / 1300, 3, seed + 37);
      lat[o + CH_GRAZE] = fbm2(x / 3500, z / 3500, 3, seed + 41);
      lat[o + CH_MOIST] = fbm2(x / 1600, z / 1600, 2, seed + 53);
      lat[o + CH_EDGE] = fbm2(x / 2200, z / 2200, 3, seed + 67);
      lat[o + CH_T] = valleyT(L, x, z);
    }
  }
  const ratio = C / (n - 1);
  const rowStride = m * CHANNELS;

  // The masks are evaluated on every second grid sample (125 m) and interpolated to the grid:
  // their content is that coarse anyway, and the terrain adds sub-cell forest-edge noise.
  const nh = (n - 1) / 2 + 1;
  const cf = new Float32Array(nh * nh);
  const ca = new Float32Array(nh * nh);
  const cm = new Float32Array(nh * nh);
  const cr = new Float32Array(nh * nh);
  const a = site.airfield;
  const ex = Math.sin(a.heading);
  const ez = -Math.cos(a.heading);
  const padX = pads.map((p) => p.x);
  const padZ = pads.map((p) => p.z);
  const padR = pads.map((p) => p.radius);

  for (let jh = 0; jh < nh; jh++) {
    const j = 2 * jh;
    const z = -half + j * spacing;
    const gz = j * ratio;
    let cj = Math.floor(gz);
    if (cj > C - 1) cj = C - 1;
    const fz = gz - cj;
    for (let ih = 0; ih < nh; ih++) {
      const i = 2 * ih;
      const x = -half + i * spacing;
      const k = j * n + i;
      const hh = h[k];
      const gx = i * ratio;
      let ci = Math.floor(gx);
      if (ci > C - 1) ci = C - 1;
      const fx = gx - ci;
      const o = (cj * m + ci) * CHANNELS;
      const w00 = (1 - fx) * (1 - fz);
      const w10 = fx * (1 - fz);
      const w01 = (1 - fx) * fz;
      const w11 = fx * fz;
      W[0] = w00;
      W[1] = w10;
      W[2] = w01;
      W[3] = w11;
      const slopeDeg = Math.atan(gridSlope(g, i, j)) * RAD;
      const edge = lerp4(lat, o, rowStride, CH_EDGE);
      // Valley-side coordinate, perturbed so the farmland / forest line wanders.
      const t = lerp4(lat, o, rowStride, CH_T) + 0.9 * edge;
      const dR = rf.dist[k];
      const hwR = dR < FAR ? rf.halfW[k] : 30;
      // Distance outside the airfield rectangle and the nearest range pad.
      const px = x - a.x;
      const pz = z - a.z;
      const al = Math.max(0, Math.abs(px * ex + pz * ez) - a.halfLength);
      const ac = Math.max(0, Math.abs(-px * ez + pz * ex) - a.halfWidth);
      const dA = Math.sqrt(al * al + ac * ac);
      let dP = Infinity;
      for (let p = 0; p < padX.length; p++) {
        const qx = x - padX[p];
        const qz = z - padZ[p];
        const d = Math.sqrt(qx * qx + qz * qz) - padR[p];
        if (d < dP) dP = d < 0 ? 0 : d;
      }

      // Curvature over ±125 m: > 0 in hollows and gullies (forest), < 0 on convex tops (open).
      const i0 = i > 1 ? i - 2 : 0;
      const i1 = i < n - 2 ? i + 2 : n - 1;
      const j0 = j > 1 ? j - 2 : 0;
      const j1 = j < n - 2 ? j + 2 : n - 1;
      const lap =
        (h[j * n + i0] + h[j * n + i1] + h[j0 * n + i] + h[j1 * n + i] - 4 * hh) /
        (4 * spacing * spacing);
      const curv = lap * 900 < -0.3 ? -0.3 : lap * 900 > 0.3 ? 0.3 : lap * 900;

      const mountain = smoothstep(0.78, 1.2, t);
      const woods = smoothstep(0.14, 0.3, lerp4(lat, o, rowStride, CH_WOODS)) * (1 - mountain);
      let f =
        mountain *
        (0.58 +
          0.9 * lerp4(lat, o, rowStride, CH_VAR) +
          0.28 * smoothstep(7, 18, slopeDeg) -
          0.18 * (1 - smoothstep(3, 8, slopeDeg)) +
          curv);
      f -= 0.7 * smoothstep(740, 860, hh);
      f -= 0.75 * smoothstep(30, 40, slopeDeg);
      if (woods > f) f = woods;
      f -= 0.9 * smoothstep(0.12, 0.3, lerp4(lat, o, rowStride, CH_CLEAR));
      f *= smoothstep(150, 350, dA) * smoothstep(80, 250, dP);
      if (dR < FAR) f *= smoothstep(hwR + 40, hwR + 140, dR);

      let fa = (1 - smoothstep(3.5, 7, slopeDeg)) * (1 - smoothstep(0.88, 1.12, t)) * (1 - woods);
      fa *= 1 - 0.9 * smoothstep(0.16, 0.32, lerp4(lat, o, rowStride, CH_GRAZE));
      if (dR < FAR) fa *= smoothstep(hwR + 30, hwR + 70, dR);
      fa *= smoothstep(200, 400, dA) * smoothstep(150, 300, dP);

      let wet =
        0.22 +
        0.62 * (dR < FAR ? Math.exp(-dR / 650) * (1 - smoothstep(900, 1300, dR)) : 0) +
        0.12 * (1 - smoothstep(0.3, 1.2, t)) -
        0.25 * smoothstep(450, 850, hh) +
        0.4 * lerp4(lat, o, rowStride, CH_MOIST);
      wet = wet < 0 ? 0 : wet > 1 ? 1 : wet;

      let r =
        0.12 +
        0.3 * Math.max(0, f) +
        0.75 * smoothstep(16, 36, slopeDeg) +
        0.12 * mountain -
        0.1 * fa;
      r *= smoothstep(0, 200, dA) * smoothstep(0, 150, dP);

      const kh = jh * nh + ih;
      cf[kh] = f;
      ca[kh] = fa;
      cm[kh] = wet;
      cr[kh] = r;
    }
  }
  const forest = new Uint8Array(n * n);
  const farmland = new Uint8Array(n * n);
  const moisture = new Uint8Array(n * n);
  const roughness = new Uint8Array(n * n);
  upsampleTo8(cf, nh, forest, n);
  upsampleTo8(ca, nh, farmland, n);
  upsampleTo8(cm, nh, moisture, n);
  upsampleTo8(cr, nh, roughness, n);
  return { forest, farmland, moisture, roughness };
}
