/**
 * The particle texture atlas, generated in code once (no downloads): 4 × 4 tiles of 128 px.
 *
 * Channels: A = coverage / density, R = detail (smoke shading variation, flame heat core),
 * G = thickness (1 at a puff's centre, used to darken thick smoke), B unused.
 * Every tile fades to zero at its border so mipmaps do not bleed between tiles.
 */
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, UnsignedByteType } from 'three';
import { CosmeticRandom, fbm } from './noise';

export const ATLAS_TILES_PER_ROW = 4;
const TILE_PX = 128;

/** Tile indices (see the generator below). */
export const TILE = {
  /** Four billowy smoke puffs (0..3). */
  smoke: 0,
  /** Two flame tongues pointing up (4..5). */
  flame: 4,
  /** Soft round glow. */
  glow: 6,
  /** Flash with rays. */
  star: 7,
  /** Two irregular solid debris chunks (8..9). */
  debris: 8,
  /** A cluster of dirt clods. */
  clods: 10,
  /** Water droplets and spray. */
  splash: 11,
  /** Smooth dust puff. */
  dust: 12,
  /** Small hot dot (sparks, embers). */
  spark: 13,
  /** Grass and leaf flecks. */
  flecks: 14,
  /** Streaky, wispy smoke. */
  wisp: 15,
} as const;

type TileFn = (x: number, y: number, out: Float32Array) => void;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function smokeTile(variant: number): TileFn {
  const rnd = new CosmeticRandom(101 + variant * 977);
  const blobs: number[] = [];
  const n = 7 + variant;
  for (let i = 0; i < n; i++) {
    const a = rnd.range(0, Math.PI * 2);
    const r = rnd.range(0, 0.32);
    blobs.push(Math.cos(a) * r, Math.sin(a) * r * 0.9, rnd.range(0.26, 0.46));
  }
  return (x, y, out) => {
    let inv = 1;
    for (let i = 0; i < blobs.length; i += 3) {
      const d = Math.hypot(x - blobs[i], y - blobs[i + 1]);
      const r = blobs[i + 2];
      inv *= 1 - smoothstep(r, r * 0.15, d);
    }
    const cover = 1 - inv;
    const detail = fbm(x * 3.2 + variant * 5.1, y * 3.2 - variant * 2.3, 4, 7 + variant);
    const d = Math.hypot(x, y);
    const a = cover * (0.55 + 0.6 * detail) * smoothstep(1.0, 0.8, d);
    out[0] = detail;
    out[1] = smoothstep(0.95, 0.0, d) * cover;
    out[3] = Math.min(1, a);
  };
}

function flameTile(variant: number): TileFn {
  return (x, y, out) => {
    // y up: a tongue with a round base at y ≈ -0.55 and a wavering tip near y ≈ 0.9
    const h = (y + 1) * 0.5;
    const wobble = (fbm(y * 2.2 + variant * 3.7, variant * 1.7, 3, 31) - 0.5) * 0.35 * h;
    const xs = x + wobble;
    const base = smoothstep(-0.95, -0.55, y);
    const width = 0.62 * Math.pow(Math.max(0, 1 - h), 0.75) * (0.6 + 0.4 * base) + 0.02;
    const body = smoothstep(width, width * 0.35, Math.abs(xs));
    const lick = 0.65 + 0.5 * fbm(xs * 4 + variant * 9, y * 3 - variant * 4, 3, 41);
    const a = body * base * smoothstep(1.0, 0.75, y) * lick;
    const core = smoothstep(width * 0.9, 0, Math.abs(xs)) * Math.pow(Math.max(0, 1 - h), 0.6);
    out[0] = Math.min(1, core * 1.3);
    out[1] = core;
    out[3] = Math.min(1, a);
  };
}

const glowTile: TileFn = (x, y, out) => {
  const d2 = x * x + y * y;
  const e = Math.exp(-5);
  const a = Math.max(0, (Math.exp(-d2 * 5) - e) / (1 - e));
  out[0] = 1;
  out[1] = a;
  out[3] = a;
};

const starTile: TileFn = (x, y, out) => {
  const d = Math.hypot(x, y);
  const t = Math.atan2(y, x);
  const rays =
    0.55 * Math.pow(Math.abs(Math.cos(t * 3 + 0.4)), 28) +
    0.4 * Math.pow(Math.abs(Math.cos(t * 2.5 + 1.3)), 40) +
    0.3 * Math.pow(Math.abs(Math.cos(t * 4 + 2.1)), 50);
  const core = Math.exp(-d * d * 16);
  const halo = Math.exp(-d * d * 4) * 0.35;
  const a = Math.min(1, core + halo + rays * Math.exp(-d * 2.6)) * smoothstep(1, 0.85, d);
  out[0] = 1;
  out[1] = core;
  out[3] = a;
};

function debrisTile(variant: number): TileFn {
  const rnd = new CosmeticRandom(503 + variant * 31);
  const n = 5 + variant * 2;
  const angles: number[] = [];
  const radii: number[] = [];
  for (let i = 0; i < n; i++) {
    angles.push((i / n) * Math.PI * 2 + rnd.signed(0.35));
    radii.push(rnd.range(0.35, 0.8));
  }
  return (x, y, out) => {
    const d = Math.hypot(x, y);
    let t = Math.atan2(y, x);
    if (t < angles[0]) t += Math.PI * 2;
    let i = 0;
    while (i < n - 1 && t > angles[i + 1]) i++;
    const a0 = angles[i];
    const a1 = i + 1 < n ? angles[i + 1] : angles[0] + Math.PI * 2;
    const r0 = radii[i];
    const r1 = radii[(i + 1) % n];
    const f = (t - a0) / (a1 - a0);
    // straight polygon edge between the two vertices (in polar form)
    const px0 = Math.cos(a0) * r0;
    const py0 = Math.sin(a0) * r0;
    const px1 = Math.cos(a1) * r1;
    const py1 = Math.sin(a1) * r1;
    const ex = px0 + (px1 - px0) * f;
    const ey = py0 + (py1 - py0) * f;
    const r = Math.hypot(ex, ey);
    const a = smoothstep(r + 0.04, r - 0.04, d);
    out[0] = 0.35 + 0.65 * ((i * 0.37 + variant * 0.21) % 1);
    out[1] = 1;
    out[3] = a;
  };
}

function scatterTile(seed: number, count: number, rMin: number, rMax: number, spread: number, elong: number): TileFn {
  const rnd = new CosmeticRandom(seed);
  const items: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = rnd.range(0, Math.PI * 2);
    const r = Math.sqrt(rnd.next()) * spread;
    items.push(Math.cos(a) * r, Math.sin(a) * r, rnd.range(rMin, rMax), rnd.range(0, Math.PI), rnd.range(0.3, 1));
  }
  return (x, y, out) => {
    let a = 0;
    let shade = 0;
    for (let i = 0; i < items.length; i += 5) {
      const dx = x - items[i];
      const dy = y - items[i + 1];
      const c = Math.cos(items[i + 3]);
      const s = Math.sin(items[i + 3]);
      const u = dx * c + dy * s;
      const v = (-dx * s + dy * c) * elong;
      const d = Math.hypot(u, v);
      const r = items[i + 2];
      const k = smoothstep(r, r * 0.55, d);
      if (k > a) {
        a = k;
        shade = items[i + 4];
      }
    }
    out[0] = shade;
    out[1] = a;
    out[3] = a * smoothstep(1, 0.85, Math.hypot(x, y));
  };
}

const splashTile: TileFn = (() => {
  const drops = scatterTile(907, 46, 0.025, 0.07, 0.85, 1);
  return (x: number, y: number, out: Float32Array) => {
    drops(x, y, out);
    const d = Math.hypot(x, y);
    const mist = 0.45 * smoothstep(0.95, 0.1, d) * (0.6 + 0.4 * fbm(x * 3, y * 3, 3, 77));
    out[3] = Math.min(1, Math.max(out[3], mist));
    out[0] = 1;
    out[1] = smoothstep(0.9, 0, d);
  };
})();

const dustTile: TileFn = (x, y, out) => {
  const d = Math.hypot(x, y);
  const n = fbm(x * 2.1 + 3, y * 2.1 - 1, 4, 53);
  const a = Math.pow(smoothstep(1.0, 0.05, d), 1.4) * (0.55 + 0.6 * n);
  out[0] = n;
  out[1] = smoothstep(0.9, 0, d);
  out[3] = Math.min(1, a);
};

const sparkTile: TileFn = (x, y, out) => {
  const d2 = x * x + y * y;
  const a = Math.min(1, Math.exp(-d2 * 28) + 0.25 * Math.exp(-d2 * 6)) * smoothstep(1, 0.8, Math.sqrt(d2));
  out[0] = 1;
  out[1] = 1;
  out[3] = a;
};

const wispTile: TileFn = (x, y, out) => {
  const d = Math.hypot(x * 0.8, y);
  const n = fbm(x * 1.4 + 11, y * 5.5, 4, 61);
  const a = smoothstep(1.0, 0.25, d) * smoothstep(0.25, 0.75, n) * 1.3;
  out[0] = n;
  out[1] = smoothstep(1, 0, d);
  out[3] = Math.min(1, a);
};

const TILE_FNS: TileFn[] = [
  smokeTile(0),
  smokeTile(1),
  smokeTile(2),
  smokeTile(3),
  flameTile(0),
  flameTile(1),
  glowTile,
  starTile,
  debrisTile(0),
  debrisTile(1),
  scatterTile(313, 9, 0.1, 0.2, 0.6, 1.2),
  splashTile,
  dustTile,
  sparkTile,
  scatterTile(719, 12, 0.05, 0.12, 0.75, 3.2),
  wispTile,
];

let cached: DataTexture | null = null;

/** The shared atlas texture (built on first use; dispose with `disposeAtlas`). */
export function getParticleAtlas(): DataTexture {
  if (cached) return cached;
  const size = TILE_PX * ATLAS_TILES_PER_ROW;
  const data = new Uint8Array(size * size * 4);
  const px = new Float32Array(4);
  for (let t = 0; t < TILE_FNS.length; t++) {
    const fn = TILE_FNS[t];
    const ox = (t % ATLAS_TILES_PER_ROW) * TILE_PX;
    const oy = Math.floor(t / ATLAS_TILES_PER_ROW) * TILE_PX;
    for (let j = 0; j < TILE_PX; j++) {
      const y = ((j + 0.5) / TILE_PX) * 2 - 1;
      for (let i = 0; i < TILE_PX; i++) {
        const x = ((i + 0.5) / TILE_PX) * 2 - 1;
        px[0] = 0;
        px[1] = 0;
        px[2] = 0;
        px[3] = 0;
        fn(x, y, px);
        // zero at the tile border so mip levels do not bleed into neighbours
        const edge = smoothstep(1.0, 0.9, Math.max(Math.abs(x), Math.abs(y)));
        const o = ((oy + j) * size + ox + i) * 4;
        data[o] = Math.round(Math.min(1, Math.max(0, px[0])) * 255);
        data[o + 1] = Math.round(Math.min(1, Math.max(0, px[1])) * 255);
        data[o + 2] = 0;
        data[o + 3] = Math.round(Math.min(1, Math.max(0, px[3] * edge)) * 255);
      }
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}

export function disposeAtlas(): void {
  cached?.dispose();
  cached = null;
}
