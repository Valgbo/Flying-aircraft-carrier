/**
 * Typed access to `TerrainData.extra` (layout: `WorldExtra` in world/types.ts). The terrain
 * renderer reads the masks directly for texturing distant ground; these helpers keep it from
 * depending on the generator's internals. Everything here is pure and worker-safe.
 */
import type { SurfaceKind, TerrainData, WorldExtra } from './types';

/** Index order of `WorldExtra.surface` (never reorder: baked data and shaders depend on it). */
export const SURFACE_KINDS: readonly SurfaceKind[] = [
  'grass',
  'field',
  'dirt',
  'sand',
  'rock',
  'forest',
  'road',
  'concrete',
  'water',
  'mud',
];

/** SurfaceKind → index in SURFACE_KINDS. */
export const SURFACE_INDEX: Readonly<Record<SurfaceKind, number>> = {
  grass: 0,
  field: 1,
  dirt: 2,
  sand: 3,
  rock: 4,
  forest: 5,
  road: 6,
  concrete: 7,
  water: 8,
  mud: 9,
};

/** The generated-world extras of `data`, or null for hand-built worlds (flat test terrain). */
export function worldExtra(data: TerrainData): WorldExtra | null {
  const e = data.extra as Partial<WorldExtra>;
  if (e && e.version === 1 && e.surface instanceof Uint8Array) return e as WorldExtra;
  return null;
}

/** Names of the byte masks in WorldExtra. */
export type WorldMask = 'forest' | 'farmland' | 'moisture' | 'roughness';

/**
 * Bilinear sample of a byte mask at world (x, z), 0..1 (clamped to the map edge).
 * `data.resolution` and `data.size` define the grid (WorldExtra layout).
 */
export function maskAt(data: TerrainData, mask: Uint8Array, x: number, z: number): number {
  const n = data.resolution;
  const half = data.size / 2;
  const inv = (n - 1) / data.size;
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
  const a = mask[k] + (mask[k + 1] - mask[k]) * fx;
  const b = mask[k + n] + (mask[k + n + 1] - mask[k + n]) * fx;
  return (a + (b - a) * fz) / 255;
}

/** Nearest-sample surface class from the baked mask at world (x, z). */
export function surfaceMaskAt(
  data: TerrainData,
  extra: WorldExtra,
  x: number,
  z: number,
): SurfaceKind {
  const n = extra.surfaceResolution;
  const half = data.size / 2;
  const inv = (n - 1) / data.size;
  let i = Math.round((x + half) * inv);
  let j = Math.round((z + half) * inv);
  if (i < 0) i = 0;
  else if (i > n - 1) i = n - 1;
  if (j < 0) j = 0;
  else if (j > n - 1) j = n - 1;
  return SURFACE_KINDS[extra.surface[j * n + i]] ?? 'grass';
}

/** World x of grid column `col` / world z of grid row `row`. */
export function gridX(data: TerrainData, col: number): number {
  return -data.size / 2 + (col * data.size) / (data.resolution - 1);
}
export function gridZ(data: TerrainData, row: number): number {
  return -data.size / 2 + (row * data.size) / (data.resolution - 1);
}
