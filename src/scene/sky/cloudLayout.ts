/**
 * Cloud layer layout — pure data, no scene objects.
 *
 * The layer is one square TILE of scattered cumulus that repeats endlessly in X and Z. Every
 * cloud and sprite is stored in tile space (x, z in [0, tileSize)); where it appears in the
 * world is decided per frame by wrapping it to the copy nearest the camera (`wrapCentered`).
 * A copy can only switch sides at half a tile from the camera, and everything fades out
 * before that distance (`edgeFade`), so the wrap is never seen.
 *
 * A cloud is an ellipsoid-like cluster (flat base, heaped top) of a few large soft sprites.
 * The same clusters drive `cloudCoverAt`, the "how deep is the camera inside cloud" value that
 * thickens the fog.
 */
import { clamp, lerp, mulberry32, smoothstep } from '../../utils/math';

/** Seed of the layer: the sky is the same on every run. */
export const CLOUD_SEED = 0x5eed_c10d;

/** Cloud bases, m above sea level. */
export const CLOUD_BASE_MIN = 900;
export const CLOUD_BASE_MAX = 1300;
/** No cloud top reaches above this, m above sea level. */
export const CLOUD_TOP_MAX = 2400;

/** Side of the grid cell each cloud is scattered in, m (sets the density of the layer). */
const CLOUD_SPACING = 2700;
/** Horizontal radius of a cluster, m. */
const CLOUD_RADIUS_MIN = 430;
const CLOUD_RADIUS_MAX = 1050;

/** Sprites per cloud on average, and the hard cap for the whole layer. */
const SPRITES_PER_CLOUD = 8.75;
const MAX_SPRITES = 700;
const MIN_SPRITES_PER_CLOUD = 5;

/** Constant wind that carries the layer, m/s (toward the south-east). */
export const CLOUD_WIND_X = 7;
export const CLOUD_WIND_Z = 3.5;

/** Floats per cloud in `CloudLayout.clouds`: x, base, z, radius, height. */
export const CLOUD_STRIDE = 5;
/**
 * Floats per sprite in `CloudLayout.sprites`:
 *   0..2  centre (x, y, z) — x / z in tile space
 *   3     size (edge of the square billboard, m)
 *   4     rotation of the noise pattern, rad
 *   5..6  offset of the noise pattern (texture units)
 *   7..9  position inside its cloud, each axis normalised to -1..1
 *   10    base of its cloud, m above sea level
 *   11    1 / height of its cloud
 *   12    1 / radius of its cloud
 */
export const SPRITE_STRIDE = 13;

export interface CloudLayout {
  /** Side of the repeating tile, m. */
  tileSize: number;
  cloudCount: number;
  /** `cloudCount` × CLOUD_STRIDE floats. */
  clouds: Float32Array;
  spriteCount: number;
  /** `spriteCount` × SPRITE_STRIDE floats. */
  sprites: Float32Array;
}

/** Number of sprites the whole layer may use for a given number of clouds. */
export function spriteBudget(cloudCount: number): number {
  return Math.min(MAX_SPRITES, Math.round(cloudCount * SPRITES_PER_CLOUD));
}

/**
 * Build the layer: `cloudCount` clouds on a jittered grid (even coverage, no clumps, no
 * regular pattern), each filled with sprites in proportion to its size.
 */
export function createCloudLayout(cloudCount: number, seed: number = CLOUD_SEED): CloudLayout {
  const count = Math.max(1, Math.floor(cloudCount));
  const random = mulberry32(seed);
  const grid = Math.ceil(Math.sqrt(count));
  const tileSize = grid * CLOUD_SPACING;

  // pick `count` distinct grid cells (partial Fisher–Yates shuffle)
  const cells = new Uint16Array(grid * grid);
  for (let i = 0; i < cells.length; i++) cells[i] = i;
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (cells.length - i));
    const picked = cells[j];
    cells[j] = cells[i];
    cells[i] = picked;
  }

  const clouds = new Float32Array(count * CLOUD_STRIDE);
  let radiusSum = 0;
  for (let i = 0; i < count; i++) {
    const cellX = cells[i] % grid;
    const cellZ = Math.floor(cells[i] / grid);
    // squaring the random number makes small clouds common and big ones rare
    const radius = lerp(CLOUD_RADIUS_MIN, CLOUD_RADIUS_MAX, random() ** 1.6);
    const base = lerp(CLOUD_BASE_MIN, CLOUD_BASE_MAX, random());
    const height = Math.min(radius * lerp(0.8, 1.25, random()), CLOUD_TOP_MAX - base);
    const o = i * CLOUD_STRIDE;
    clouds[o] = (cellX + 0.15 + 0.7 * random()) * CLOUD_SPACING;
    clouds[o + 1] = base;
    clouds[o + 2] = (cellZ + 0.15 + 0.7 * random()) * CLOUD_SPACING;
    clouds[o + 3] = radius;
    clouds[o + 4] = height;
    radiusSum += radius;
  }

  // share the sprite budget in proportion to cloud size
  const budget = spriteBudget(count);
  const perCloud = new Uint8Array(count);
  let spriteCount = 0;
  for (let i = 0; i < count; i++) {
    const share = Math.floor((budget * clouds[i * CLOUD_STRIDE + 3]) / radiusSum);
    perCloud[i] = Math.max(MIN_SPRITES_PER_CLOUD, share);
    spriteCount += perCloud[i];
  }

  const sprites = new Float32Array(spriteCount * SPRITE_STRIDE);
  let s = 0;
  for (let i = 0; i < count; i++) {
    const o = i * CLOUD_STRIDE;
    const cx = clouds[o];
    const base = clouds[o + 1];
    const cz = clouds[o + 2];
    const radius = clouds[o + 3];
    const height = clouds[o + 4];
    const n = perCloud[i];
    const lower = Math.ceil((n - 1) * 0.6);
    const ringPhase = random() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      let dx = 0;
      let dz = 0;
      let size: number;
      let centreHeight: number;
      if (k === 0) {
        // the core: one big puff that gives the cloud its body
        size = radius * 1.55;
        centreHeight = height * 0.42;
      } else if (k <= lower) {
        // a ring of puffs around the core, sitting on the flat base
        const angle = ringPhase + ((k - 1 + 0.6 * (random() - 0.5)) / lower) * Math.PI * 2;
        const r = radius * lerp(0.42, 0.68, random());
        dx = Math.cos(angle) * r;
        dz = Math.sin(angle) * r;
        size = radius * lerp(0.85, 1.2, random());
        centreHeight = height * lerp(0.24, 0.4, random());
      } else {
        // smaller puffs heaped on top
        const angle = random() * Math.PI * 2;
        const r = radius * 0.4 * Math.sqrt(random());
        dx = Math.cos(angle) * r;
        dz = Math.sin(angle) * r;
        size = radius * lerp(0.62, 0.95, random());
        centreHeight = height * lerp(0.56, 0.8, random());
      }
      // keep the visible part of the puff (≈ 0.38 of its edge) between base and top
      const reach = size * 0.38;
      centreHeight = clamp(centreHeight, Math.min(reach, height * 0.5), height - reach * 0.6);

      const p = s * SPRITE_STRIDE;
      sprites[p] = (((cx + dx) % tileSize) + tileSize) % tileSize;
      sprites[p + 1] = base + centreHeight;
      sprites[p + 2] = (((cz + dz) % tileSize) + tileSize) % tileSize;
      sprites[p + 3] = size;
      sprites[p + 4] = random() * Math.PI * 2;
      sprites[p + 5] = random();
      sprites[p + 6] = random();
      sprites[p + 7] = dx / radius;
      sprites[p + 8] = (centreHeight / height) * 2 - 1;
      sprites[p + 9] = dz / radius;
      sprites[p + 10] = base;
      sprites[p + 11] = 1 / height;
      sprites[p + 12] = 1 / radius;
      s++;
    }
  }

  return { tileSize, cloudCount: count, clouds, spriteCount, sprites };
}

/**
 * Offset from `reference` to the nearest periodic copy of `value` (period `tileSize`),
 * in [-tileSize / 2, tileSize / 2).
 */
export function wrapCentered(value: number, reference: number, tileSize: number): number {
  const half = tileSize * 0.5;
  const d = (value - reference + half) % tileSize;
  return (d < 0 ? d + tileSize : d) - half;
}

/** Horizontal distance from the camera at which the layer starts / finishes fading out. */
export function edgeFadeStart(tileSize: number): number {
  return tileSize * 0.39;
}
export function edgeFadeEnd(tileSize: number): number {
  return tileSize * 0.485;
}

/**
 * Opacity factor that hides the edge of the tile: 1 near the camera, exactly 0 from a little
 * less than half a tile outward — i.e. everywhere a wrap can happen.
 */
export function edgeFade(horizontalDistance: number, tileSize: number): number {
  return 1 - smoothstep(edgeFadeStart(tileSize), edgeFadeEnd(tileSize), horizontalDistance);
}

/** Normalised distance from a cluster centre at which the camera starts to be "in cloud". */
const COVER_EDGE = 1.05;
/** …and at which it is fully inside. */
const COVER_CORE = 0.5;

/**
 * 0..1 — how deep the point (x, y, z) is inside cloud: 0 in clear air, 1 near the middle of a
 * cluster, continuous in between. `driftX` / `driftZ` is how far the wind has carried the
 * layer so far.
 */
export function cloudCoverAt(
  layout: CloudLayout,
  x: number,
  y: number,
  z: number,
  driftX: number,
  driftZ: number,
): number {
  if (y < CLOUD_BASE_MIN - 200 || y > CLOUD_TOP_MAX + 200) return 0;
  const { clouds, cloudCount, tileSize } = layout;
  let cover = 0;
  for (let i = 0; i < cloudCount; i++) {
    const o = i * CLOUD_STRIDE;
    const radius = clouds[o + 3];
    const halfHeight = clouds[o + 4] * 0.5;
    const dy = (y - clouds[o + 1] - halfHeight) / halfHeight;
    if (dy > COVER_EDGE || dy < -COVER_EDGE) continue;
    const dx = wrapCentered(clouds[o] + driftX, x, tileSize) / radius;
    const dz = wrapCentered(clouds[o + 2] + driftZ, z, tileSize) / radius;
    const q = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (q >= COVER_EDGE) continue;
    const inside = 1 - smoothstep(COVER_CORE, COVER_EDGE, q);
    if (inside > cover) cover = inside;
  }
  return cover;
}
