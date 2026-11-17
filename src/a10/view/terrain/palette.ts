/**
 * Ground colours and the per-texel bake of a tile's albedo + detail class (worker side).
 *
 * Every tile carries a (T+1)² RGBA8 texture: RGB = the ground's albedo (sRGB-encoded, so the
 * GPU decodes it before filtering), A = the detail class for close-range texturing (fetched
 * unfiltered): bits 0–2 the class (DETAIL), bits 3–7 the row direction (32 steps over 180°) of
 * crops and furrows. Colours follow the world's surface classes and field information when the
 * terrain provides them (Terrain.fieldAt, moistureAt, forestDensityAt), with field-to-field and
 * within-field variation, margins, tramlines and slope rock — so a valley reads as farmland
 * from 3,000 m and never repeats.
 */
import { maskAt, worldExtra } from '../../core/world';
import type { FieldSample, SurfaceKind, Terrain, WorldExtra } from '../../core/world/types';
import { fbm, hash01, valueNoise } from './noise';

/** Close-range detail classes (index into the detail texture array). */
export const DETAIL = {
  grass: 0,
  crop: 1,
  ploughed: 2,
  rock: 3,
  sand: 4,
  forest: 5,
  paved: 6,
  mud: 7,
} as const;
export const DETAIL_LAYERS = 8;

/** sRGB (0..255) → linear. */
function lin(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
/** linear → sRGB byte. */
export function srgbByte(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

type Rgb = [number, number, number];
const rgb = (r: number, g: number, b: number): Rgb => [lin(r), lin(g), lin(b)];

/** Base colours (linear), tuned to read as late-spring farmland under haze. */
export const GROUND = {
  meadow: rgb(98, 114, 66),
  meadowDry: rgb(134, 128, 88),
  meadowWet: rgb(80, 100, 60),
  pasture: rgb(94, 116, 64),
  cerealYoung: rgb(92, 114, 62),
  cerealRipe: rgb(156, 146, 98),
  greenCrop: rgb(112, 108, 76),
  rapeseedBloom: rgb(178, 166, 84),
  rapeseedGreen: rgb(90, 110, 60),
  ploughed: rgb(116, 102, 86),
  ploughedDark: rgb(90, 80, 68),
  fallow: rgb(134, 126, 96),
  margin: rgb(104, 114, 72),
  dirt: rgb(124, 108, 86),
  track: rgb(140, 124, 100),
  sand: rgb(172, 160, 130),
  gravel: rgb(150, 144, 132),
  rock: rgb(122, 118, 110),
  rockLight: rgb(148, 142, 132),
  canopy: rgb(58, 76, 44),
  canopyDark: rgb(40, 56, 34),
  asphalt: rgb(92, 92, 94),
  concrete: rgb(160, 158, 152),
  water: rgb(52, 66, 64),
  mud: rgb(90, 76, 62),
} as const;

const _c: Rgb = [0, 0, 0];

function set(out: Rgb, c: Rgb): Rgb {
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
  return out;
}
function mixInto(out: Rgb, c: Rgb, t: number): Rgb {
  out[0] += (c[0] - out[0]) * t;
  out[1] += (c[1] - out[1]) * t;
  out[2] += (c[2] - out[2]) * t;
  return out;
}
function scale(out: Rgb, k: number): Rgb {
  out[0] *= k;
  out[1] *= k;
  out[2] *= k;
  return out;
}

/** Row direction (compass rad) → 5-bit index over 180°. */
export function rowIndex(heading: number): number {
  let h = heading % Math.PI;
  if (h < 0) h += Math.PI;
  return Math.round((h / Math.PI) * 32) & 31;
}

/** Scratch shared by `bakeTexel` calls (one per worker and terrain). */
export interface BakeScratch {
  field: FieldSample;
  seed: number;
  terrain: Terrain | null;
  extra: WorldExtra | null;
}

export function createBakeScratch(seed: number, terrain: Terrain | null = null): BakeScratch {
  return {
    field: {
      id: 0,
      variant: 0,
      crop: 'pasture',
      rowHeading: 0,
      edgeDistance: Infinity,
      hedge: false,
      track: false,
    },
    seed,
    terrain,
    extra: terrain ? worldExtra(terrain.data) : null,
  };
}

/** Texels larger than this use the quick classification (no exact road/bank/edge queries), m. */
export const QUICK_TEXEL = 7.9;

/**
 * Surface class at a texel. Fine texels ask the world exactly (Terrain.surfaceAt: roads, banks,
 * field edges to the centimetre); coarse texels classify from the world's own masks and field
 * system, which costs a quarter as much and differs only in details smaller than the texel.
 */
function texelSurface(
  terrain: Terrain,
  s: BakeScratch,
  x: number,
  z: number,
  ny: number,
  footprint: number,
  field: FieldSample,
): { kind: SurfaceKind; onField: boolean } {
  if (footprint < QUICK_TEXEL || !terrain.fieldAt) {
    const kind = terrain.surfaceAt(x, z);
    const onField =
      (kind === 'field' || kind === 'dirt' || kind === 'grass') && terrain.fieldAt
        ? terrain.fieldAt(x, z, field)
        : false;
    _ts.kind = kind;
    _ts.onField = onField;
    return _ts;
  }
  const forest = s.extra
    ? maskAt(terrain.data, s.extra.forest, x, z)
    : terrain.forestDensityAt
      ? terrain.forestDensityAt(x, z)
      : 0;
  if (ny < 0.8) _ts.kind = 'rock';
  else if (forest > 0.5) _ts.kind = 'forest';
  else if (terrain.fieldAt(x, z, field)) {
    _ts.kind = field.crop === 'ploughed' ? 'dirt' : field.crop === 'pasture' ? 'grass' : 'field';
    _ts.onField = true;
    return _ts;
  } else _ts.kind = 'grass';
  _ts.onField = false;
  return _ts;
}
const _ts: { kind: SurfaceKind; onField: boolean } = { kind: 'grass', onField: false };

/** Colour of a farmed field by crop and variant (linear, into `out`); returns the detail class. */
function fieldColor(f: FieldSample, out: Rgb): number {
  const v = f.variant / 255;
  switch (f.crop) {
    case 'cereal':
      set(out, GROUND.cerealYoung);
      mixInto(out, GROUND.cerealRipe, 0.25 + 0.7 * v);
      return DETAIL.crop;
    case 'greenCrop':
      set(out, GROUND.greenCrop);
      mixInto(out, GROUND.cerealYoung, 0.35 * v);
      return DETAIL.crop;
    case 'rapeseed':
      // a third of the rapeseed in bloom: striking from the air, but not every other field
      set(out, v > 0.66 ? GROUND.rapeseedBloom : GROUND.rapeseedGreen);
      mixInto(out, GROUND.cerealYoung, 0.25 * (1 - v));
      return DETAIL.crop;
    case 'ploughed':
      set(out, GROUND.ploughed);
      mixInto(out, GROUND.ploughedDark, v);
      return DETAIL.ploughed;
    case 'fallow':
      set(out, GROUND.fallow);
      mixInto(out, GROUND.meadowDry, 0.4 * v);
      return DETAIL.grass;
    case 'pasture':
    default:
      set(out, GROUND.pasture);
      mixInto(out, GROUND.meadowDry, 0.35 * v);
      return DETAIL.grass;
  }
}

/** Surface class → base colour and detail class (non-field surfaces). */
function surfaceColor(kind: SurfaceKind, moisture: number, n: number, out: Rgb): number {
  switch (kind) {
    case 'forest':
      set(out, GROUND.canopy);
      mixInto(out, GROUND.canopyDark, n);
      return DETAIL.forest;
    case 'dirt':
      set(out, GROUND.dirt);
      mixInto(out, GROUND.mud, moisture * 0.6);
      return DETAIL.ploughed;
    case 'sand':
      set(out, GROUND.sand);
      mixInto(out, GROUND.gravel, n);
      return DETAIL.sand;
    case 'rock':
      set(out, GROUND.rock);
      mixInto(out, GROUND.rockLight, n);
      return DETAIL.rock;
    case 'road':
      set(out, GROUND.asphalt);
      return DETAIL.paved;
    case 'concrete':
      set(out, GROUND.concrete);
      return DETAIL.paved;
    case 'water':
      set(out, GROUND.water);
      return DETAIL.mud;
    case 'mud':
      set(out, GROUND.mud);
      return DETAIL.mud;
    case 'field':
    case 'grass':
    default:
      // meadow: drier on the ridges, lusher in the wet hollows
      set(out, GROUND.meadow);
      if (moisture < 0.5) mixInto(out, GROUND.meadowDry, (0.5 - moisture) * 1.5);
      else mixInto(out, GROUND.meadowWet, (moisture - 0.5) * 1.4);
      return DETAIL.grass;
  }
}

/**
 * Bake one texel at world (x, z) with ground normal y-component `ny` into out[o..o+3].
 * `footprint` is the texel size in metres (details finer than it are faded out).
 */
export function bakeTexel(
  terrain: Terrain,
  x: number,
  z: number,
  ny: number,
  footprint: number,
  s: BakeScratch,
  out: Uint8Array,
  o: number,
): void {
  const seed = s.seed;
  const field = s.field;
  const { kind, onField } = texelSurface(terrain, s, x, z, ny, footprint, field);
  const moisture = s.extra
    ? maskAt(terrain.data, s.extra.moisture, x, z)
    : terrain.moistureAt
      ? terrain.moistureAt(x, z)
      : 0.45;
  // large, slow variation: soil, moisture and sun-bleaching patches that break any repetition
  const macro = fbm(x / 900, z / 900, 3, seed);
  const mid = valueNoise(x / 140, z / 140, seed + 77);
  let cls: number;
  let dir = 0;
  const c = _c;

  if (onField) {
    cls = fieldColor(field, c);
    dir = rowIndex(field.rowHeading);
    // the field's own tint, stable per field
    const tint = hash01(field.id, 7, seed);
    scale(c, 0.9 + 0.2 * tint);
    // within-field patches of soil, moisture and growth at two scales (the terrain shader
    // draws the tramlines)
    const patch =
      valueNoise(x / 55, z / 55, seed + 301) * 0.45 +
      valueNoise(x / 190, z / 190, seed + 303) * 0.55;
    scale(c, 0.84 + 0.32 * patch);
    // greener in the damp patches, yellower on the dry ones
    c[0] *= 1.04 - 0.08 * mid;
    c[2] *= 0.96 + 0.08 * mid;
    // field margins: a grass strip, a farm track or the foot of a hedge
    const edge = field.edgeDistance;
    const band = Math.max(2.5, footprint * 0.75);
    if (edge < band) {
      const t = 1 - edge / band;
      if (field.track) mixInto(c, GROUND.track, 0.85 * t);
      else if (field.hedge) mixInto(c, GROUND.canopyDark, 0.7 * t);
      else mixInto(c, GROUND.margin, 0.7 * t);
    }
  } else {
    cls = surfaceColor(kind, moisture, mid, c);
    scale(c, 0.9 + 0.2 * mid);
    if (kind === 'forest' && footprint > 2) {
      // crowns in clusters: the mottled texture a forest shows from altitude
      const crowns =
        valueNoise(x / 23, z / 23, seed + 191) * 0.6 + valueNoise(x / 61, z / 61, seed + 193) * 0.4;
      scale(c, 0.72 + 0.56 * crowns);
    }
  }

  // steep ground shows rock and bare earth whatever the class says
  if (ny < 0.9 && cls !== DETAIL.rock && kind !== 'water') {
    const steep = Math.min(1, (0.9 - ny) / 0.22);
    mixInto(c, macro > 0.5 ? GROUND.rock : GROUND.dirt, steep * 0.75);
    if (steep > 0.6) cls = DETAIL.rock;
  }

  // the slow macro variation, in luminance and a little in hue
  const k = 0.84 + 0.32 * macro;
  c[0] *= k * (0.97 + 0.06 * mid);
  c[1] *= k;
  c[2] *= k * (1.03 - 0.06 * macro);

  out[o] = srgbByte(c[0]);
  out[o + 1] = srgbByte(c[1]);
  out[o + 2] = srgbByte(c[2]);
  out[o + 3] = cls | (dir << 3);
}
