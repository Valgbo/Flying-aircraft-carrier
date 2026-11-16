/**
 * The large-scale shape of the range: a broad valley crossing the map with a gentle bend, its
 * floor falling from ~235 m at the upstream end to ~105 m downstream, flanked by ridges rising to
 * ~900 m whose spurs (side ridges) run down toward the valley with side valleys between them.
 *
 * Valley coordinates: u along the valley axis direction (unit (cos a, sin a) in x/z), v across it.
 * The valley centre line is v = axisV(u); t = |v − axisV(u)| / halfWidth(u) measures how far up
 * the side a point is (t < 0.8 floor, ≈ 1 foot of the slopes, ≈ 1.9 ridge crests).
 */
import { Rng } from '../../rng';
import { erodedFbm2, fbm2, noise2, ridged2, smoothstep } from '../noise';
import { RANGE_WORLD } from '../params';

export interface Layout {
  size: number;
  half: number;
  /** Valley axis: math angle (rad) of +u in the x/z plane, and its cos/sin. */
  angle: number;
  ca: number;
  sa: number;
  /** +1: the valley floor rises toward +u (the river flows toward −u); −1: the opposite. */
  upstream: number;
  floorLow: number;
  floorHigh: number;
  /** Centre-line offset and its two bends (amplitude m, wavelength m, phase rad). */
  offset: number;
  a1: number;
  p1: number;
  f1: number;
  a2: number;
  p2: number;
  f2: number;
  /** Floor half width (m) and its variation along the valley. */
  w0: number;
  wA: number;
  wP: number;
  wF: number;
  /** Noise seeds. */
  sCrest: number;
  sSpur: number;
  sWarp: number;
  sErode: number;
  sHills: number;
  sFloor: number;
}

export function makeLayout(rng: Rng, size: number): Layout {
  const angle = rng.range(-0.42, 0.42);
  return {
    size,
    half: size / 2,
    angle,
    ca: Math.cos(angle),
    sa: Math.sin(angle),
    upstream: rng.chance(0.5) ? 1 : -1,
    floorLow: RANGE_WORLD.floorLow,
    floorHigh: RANGE_WORLD.floorHigh,
    offset: rng.range(-2500, 2500),
    a1: rng.range(1500, 3200),
    p1: rng.range(55000, 80000),
    f1: rng.range(0, Math.PI * 2),
    a2: rng.range(500, 1200),
    p2: rng.range(18000, 28000),
    f2: rng.range(0, Math.PI * 2),
    w0: rng.range(7600, 8800),
    wA: rng.range(0.08, 0.16),
    wP: rng.range(30000, 50000),
    wF: rng.range(0, Math.PI * 2),
    sCrest: rng.int(0, 0x7fffffff),
    sSpur: rng.int(0, 0x7fffffff),
    sWarp: rng.int(0, 0x7fffffff),
    sErode: rng.int(0, 0x7fffffff),
    sHills: rng.int(0, 0x7fffffff),
    sFloor: rng.int(0, 0x7fffffff),
  };
}

export function toU(L: Layout, x: number, z: number): number {
  return x * L.ca + z * L.sa;
}

export function toV(L: Layout, x: number, z: number): number {
  return -x * L.sa + z * L.ca;
}

/** World x of valley coordinates (u, v). */
export function fromUVx(L: Layout, u: number, v: number): number {
  return u * L.ca - v * L.sa;
}

/** World z of valley coordinates (u, v). */
export function fromUVz(L: Layout, u: number, v: number): number {
  return u * L.sa + v * L.ca;
}

/** v of the valley centre line at u. */
export function axisV(L: Layout, u: number): number {
  const k1 = (2 * Math.PI) / L.p1;
  const k2 = (2 * Math.PI) / L.p2;
  return L.offset + L.a1 * Math.sin(k1 * u + L.f1) + L.a2 * Math.sin(k2 * u + L.f2);
}

/** dv/du of the centre line. */
export function axisSlope(L: Layout, u: number): number {
  const k1 = (2 * Math.PI) / L.p1;
  const k2 = (2 * Math.PI) / L.p2;
  return L.a1 * k1 * Math.cos(k1 * u + L.f1) + L.a2 * k2 * Math.cos(k2 * u + L.f2);
}

/** Half width of the valley floor at u, m. */
export function halfWidth(L: Layout, u: number): number {
  return L.w0 * (1 + L.wA * Math.sin((2 * Math.PI * u) / L.wP + L.wF));
}

/** Valley-floor height at u (the floor rises linearly upstream), m. */
export function floorAt(L: Layout, u: number): number {
  let f = (u * L.upstream + L.half) / L.size;
  f = f < 0 ? 0 : f > 1 ? 1 : f;
  return L.floorLow + (L.floorHigh - L.floorLow) * f;
}

/** Valley-side coordinate t (0 on the axis, ≈ 1.9 at the crests) of a world point. */
export function valleyT(L: Layout, x: number, z: number): number {
  const u = toU(L, x, z);
  return Math.abs(toV(L, x, z) - axisV(L, u)) / halfWidth(L, u);
}

/** Compass-free direction of the valley at u: math angle (rad) of the down-valley direction. */
export function downValleyAngle(L: Layout, u: number): number {
  const du = -L.upstream;
  const dv = du * axisSlope(L, u);
  // (du, dv) in valley axes → world x/z.
  const wx = du * L.ca - dv * L.sa;
  const wz = du * L.sa + dv * L.ca;
  return Math.atan2(wz, wx);
}

/**
 * The natural large-scale height (before the river, airfield, pads and roads are cut in), m.
 * Valley floor + gentle side rise + foothills + main slopes to the crest + spurs (anisotropic
 * ridged noise, elongated across the valley so ridges run down into it) + eroded detail.
 */
export function macroHeight(L: Layout, x: number, z: number): number {
  const u = toU(L, x, z);
  const v = toV(L, x, z);
  const W = halfWidth(L, u);
  const dv = v - axisV(L, u);
  const side = dv >= 0 ? 1 : -1;
  const t = Math.abs(dv) / W;
  const floor = floorAt(L, u);

  // Domain warp shared by the mountain terms: bends the spurs and breaks straight lines.
  const wx = fbm2(x / 9000, z / 9000, 3, L.sWarp);
  const wz = fbm2(x / 9000 + 7.3, z / 9000 - 3.1, 3, L.sWarp + 1);

  let h = floor;
  // The floor rises a little toward its edges (alluvial fans), then the foothills.
  h += 14 * smoothstep(0.3, 1.0, t);
  h += 60 * smoothstep(0.72, 1.18, t);
  // Main slope to the crest line; crest base varies along the valley and by side.
  const crest = 590 + 150 * (0.5 + 0.5 * noise2(u / 11000, side * 3.7, L.sCrest));
  h += (crest - floor - 74) * smoothstep(0.95, 1.95, t + 0.12 * wx);
  // Beyond the crest the land falls to a dissected upland toward the map edge.
  h -= 210 * smoothstep(2.1, 3.3, t + 0.2 * wz);

  // Mountain mask: 0 on the floor, 1 from the upper foothills up.
  const M = smoothstep(0.82, 1.5, t + 0.08 * wz);
  if (M > 0) {
    // Spurs: ridged noise stretched across the valley (ridge lines run down toward the floor).
    const su = u / 3100 + 0.7 * wx;
    const sv = v / 5400 + 0.7 * wz;
    const r = ridged2(su, sv, 4, L.sSpur, 0.5);
    // Eroded detail: smooth gullies, sharp crests.
    const e = erodedFbm2(x / 4600 + wx * 0.3, z / 4600 + wz * 0.3, 5, L.sErode);
    // Spurs grow with height up the slope; the crest zone is the most broken (crags).
    const g = 0.4 + 0.6 * smoothstep(1.0, 1.75, t) + 0.25 * smoothstep(1.5, 2.0, t);
    h += M * g * ((r - 0.42) * 470 + e * 150);
  }
  // Rolling foothills.
  const F = smoothstep(0.45, 0.95, t) * (1 - 0.6 * M);
  if (F > 0) h += F * 38 * fbm2(x / 2600, z / 2600, 4, L.sHills);
  // Gentle floor undulation (old terraces, fans).
  const fl = 1 - smoothstep(0.55, 0.95, t);
  if (fl > 0) h += fl * 6 * fbm2(x / 1900, z / 1900, 3, L.sFloor);

  // Soft cap: ridges top out near 900 m.
  const cap = RANGE_WORLD.ridgeTop - 80;
  if (h > cap) h = cap + (h - cap) / (1 + (h - cap) / 110);
  return h;
}
