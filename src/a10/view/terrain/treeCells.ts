/**
 * Individual trees for the area around the aircraft, generated per square cell in the terrain
 * worker (pure, deterministic: the same cell always gets the same trees).
 *
 * Trees stand where the world says there is canopy (Terrain.canopyAt > 0: forest stands,
 * hedgerows, riverside bands), on a jittered grid, with a height from the canopy height and a
 * species from the ground (conifers higher up and in dense stands, broadleaves and poplars
 * where it is wet). Every tree gets a RANK in [0, 1): the renderer draws the trees whose rank
 * is below a density that falls with distance, so thinning is smooth and needs no rebuild.
 * Trees on a stand's edge get low ranks: they shape the silhouettes and are drawn farthest.
 */
import type { FieldSample, Terrain } from '../../core/world/types';
import { hash01 } from './noise';

/** Edge of a tree cell, m. */
export const TREE_CELL_SIZE = 256;
/** Floats per tree: x, y, z, height, crown radius, species, colour variation, rank. */
export const TREE_STRIDE = 8;
/** Species codes (shader). */
export const SPECIES = { broadleaf: 0, conifer: 1, poplar: 2 } as const;

/** Spacing of the candidate grid, m (one candidate per cell of this size). */
const CANDIDATE_SPACING = 7.5;
/** Canopy below this is not a tree, m. */
const MIN_CANOPY = 3;
/** Distance at which the edge test looks for open ground, m. */
const EDGE_PROBE = 11;
/** Below this forest density a canopy is a tree line, not a stand (as tileBuilder's shell). */
const LINE_DENSITY = 0.25;
/** Rank scale of tree-line and stand-edge trees: drawn first and farthest. */
const LINE_RANK = 0.12;
const EDGE_RANK = 0.35;
const _field: FieldSample = {
  id: 0,
  variant: 0,
  crop: 'pasture',
  rowHeading: 0,
  edgeDistance: 0,
  hedge: false,
  track: false,
};

export interface TreeCellSpec {
  key: number;
  x0: number;
  z0: number;
  size: number;
  seed: number;
}

export interface TreeCell {
  key: number;
  count: number;
  /** count × TREE_STRIDE floats, sorted by rank (ascending). */
  data: Float32Array;
}

/** Build the trees of one cell. */
export function buildTreeCell(terrain: Terrain, spec: TreeCellSpec): TreeCell {
  const n = Math.max(1, Math.round(spec.size / CANDIDATE_SPACING));
  const step = spec.size / n;
  const tmp: number[] = [];
  const cellI = Math.round(spec.x0 / step);
  const cellJ = Math.round(spec.z0 / step);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gi = cellI + i;
      const gj = cellJ + j;
      const jx = hash01(gi, gj, spec.seed);
      const jz = hash01(gi, gj, spec.seed + 1);
      const x = spec.x0 + (i + 0.1 + 0.8 * jx) * step;
      const z = spec.z0 + (j + 0.1 + 0.8 * jz) * step;
      const canopy = terrain.canopyAt(x, z);
      if (canopy < MIN_CANOPY) continue;
      const r1 = hash01(gi, gj, spec.seed + 2);
      const r2 = hash01(gi, gj, spec.seed + 3);
      const r3 = hash01(gi, gj, spec.seed + 4);
      const density = terrain.forestDensityAt ? terrain.forestDensityAt(x, z) : 0.8;
      // not every candidate in a thin stand or hedge is a tree
      if (r3 > 0.35 + 0.65 * Math.max(density, 0.55)) continue;
      const moisture = terrain.moistureAt ? terrain.moistureAt(x, z) : 0.5;
      const ground = terrain.heightAt(x, z);
      // species: wet ground → broadleaves and poplars; high, dense stands → conifers
      let species: number = SPECIES.broadleaf;
      const coniferChance =
        0.15 + 0.5 * Math.min(1, Math.max(0, (ground - 250) / 400)) + 0.2 * density;
      if (moisture > 0.72 && r1 < 0.25) species = SPECIES.poplar;
      else if (r1 < coniferChance * (1 - 0.6 * moisture)) species = SPECIES.conifer;
      const height =
        Math.max(6, canopy * (0.82 + 0.36 * r2)) * (species === SPECIES.poplar ? 1.25 : 1);
      const radius =
        species === SPECIES.conifer
          ? height * (0.17 + 0.06 * r1)
          : species === SPECIES.poplar
            ? height * 0.12
            : height * (0.26 + 0.1 * r2);
      // hedgerows and riverside lines have no canopy shell under them (tileBuilder): their
      // trees come first; then the trees on a stand's edge (open ground within EDGE_PROBE)
      const line =
        density < LINE_DENSITY || (terrain.fieldAt !== undefined && terrain.fieldAt(x, z, _field));
      const edge =
        line ||
        terrain.canopyAt(x + EDGE_PROBE, z) < MIN_CANOPY ||
        terrain.canopyAt(x - EDGE_PROBE, z) < MIN_CANOPY ||
        terrain.canopyAt(x, z + EDGE_PROBE) < MIN_CANOPY ||
        terrain.canopyAt(x, z - EDGE_PROBE) < MIN_CANOPY;
      const rank = hash01(gi, gj, spec.seed + 5) * (line ? LINE_RANK : edge ? EDGE_RANK : 1);
      tmp.push(x, ground, z, height, radius, species, hash01(gi, gj, spec.seed + 6), rank);
    }
  }
  const count = tmp.length / TREE_STRIDE;
  // sort by rank so a prefix is always the most important trees
  const order = new Array<number>(count);
  for (let k = 0; k < count; k++) order[k] = k;
  order.sort((a, b) => tmp[a * TREE_STRIDE + 7] - tmp[b * TREE_STRIDE + 7]);
  const data = new Float32Array(count * TREE_STRIDE);
  for (let k = 0; k < count; k++) {
    const src = order[k] * TREE_STRIDE;
    for (let q = 0; q < TREE_STRIDE; q++) data[k * TREE_STRIDE + q] = tmp[src + q];
  }
  return { key: spec.key, count, data };
}
