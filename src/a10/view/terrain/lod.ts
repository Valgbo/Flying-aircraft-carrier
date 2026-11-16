/**
 * Terrain level of detail: a quadtree of square tiles over a 131 km root (the 64 km map plus a
 * ring beyond it that carries the ground out to the haze limit). Every tile is the same grid of
 * TILE_QUADS × TILE_QUADS quads, so a tile of level L has a vertex spacing of
 * ROOT_SIZE / 2^L / TILE_QUADS: 4 km at the root, 16 m at level 8, 8 m at level 9, 4 m at 10.
 *
 * Selection (per frame, allocation-light): a node SPLITS into its four children when the camera
 * is closer than SPLIT_K × its size to the node's box (3D, heights included) — so from 3,000 m
 * up nothing finer than 32 m is selected, and on a strafing pass the ground is drawn at 8 m
 * within ~770 m and 16 m within ~1.5 km (the world's finest relief is 23 m, so vehicles placed
 * with heightAt sit on the drawn ground to a few centimetres). Each level then covers a ring
 * of the same angular size: ~14 tiles in view per level, every vertex ≈ 1/48 of its distance
 * and every texel ≈ 3 px. A node splits only when all four children are built; until then it
 * stays (coarser for a moment, never a hole). Coarse tiles are requested first.
 *
 * Pure: no three.js objects, no worker; unit-tested.
 */

/** Quads per tile edge (the grid is (TILE_QUADS + 1)² vertices plus skirts). */
export const TILE_QUADS = 32;
/** Edge of the quadtree root, m (2^17: exact binary subdivisions). */
export const ROOT_SIZE = 131072;
/** Finest level per terrain-detail preset: 16 m (low), 8 m (medium), 4 m (high). */
export const MAX_LEVEL_BY_DETAIL = [8, 9, 10] as const;
/** Nothing farther than this from the camera is drawn (it is all haze), m. */
export const MAX_DRAW_DISTANCE = 72000;

/**
 * Split distance as a multiple of the node's size, per level (index = level, 1 km nodes and
 * finer from index 7 on): fine near the aircraft, coarser far out where haze has taken most of
 * the contrast.
 */
const SPLIT_K = [Infinity, 0.95, 0.95, 0.95, 1.05, 1.2, 1.35, 1.5];
/** Scale of the split distances per terrain-detail preset (low, medium, high). */
const DETAIL_SCALE = [0.8, 1, 1.12] as const;

export function nodeSize(level: number): number {
  return ROOT_SIZE / 2 ** level;
}

export function vertexSpacing(level: number): number {
  return nodeSize(level) / TILE_QUADS;
}

/** Distance below which a node of `level` splits into its children (detail 0..2). */
export function splitDistance(level: number, detail: number): number {
  if (level === 0) return Infinity;
  const k = SPLIT_K[Math.min(level, SPLIT_K.length - 1)];
  return nodeSize(level) * k * DETAIL_SCALE[Math.max(0, Math.min(2, detail))];
}

/**
 * Where a node of `level` blends its odd vertices toward its parent's surface (geomorphing),
 * as [start, end] distances: complete just before the parent would be selected instead, so a
 * split or merge never pops.
 */
export function morphRange(level: number, detail: number, out: [number, number]): [number, number] {
  const parentSplit = level > 0 ? splitDistance(level - 1, detail) : Infinity;
  if (!Number.isFinite(parentSplit)) {
    out[0] = 1e9;
    out[1] = 2e9;
  } else {
    out[0] = parentSplit * 0.62;
    out[1] = parentSplit * 0.92;
  }
  return out;
}

/** Unique numeric key of a node (level ≤ 15, indices < 2^20). */
export function nodeKey(level: number, ix: number, iz: number): number {
  return level * 2 ** 40 + iz * 2 ** 20 + ix;
}

/** World x (or z) of the west (north) edge of node index `i` at `level`. */
export function nodeOrigin(level: number, i: number): number {
  return -ROOT_SIZE / 2 + i * nodeSize(level);
}

/** Distance from (cx, cy, cz) to the box [x0, x0+size] × [minY, maxY] × [z0, z0+size]. */
export function boxDistance(
  cx: number,
  cy: number,
  cz: number,
  x0: number,
  z0: number,
  size: number,
  minY: number,
  maxY: number,
): number {
  const dx = cx < x0 ? x0 - cx : cx > x0 + size ? cx - x0 - size : 0;
  const dz = cz < z0 ? z0 - cz : cz > z0 + size ? cz - z0 - size : 0;
  const dy = cy < minY ? minY - cy : cy > maxY ? cy - maxY : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** What the selection needs to know about a node; the caller stores the rest. */
export interface LodNode {
  key: number;
  level: number;
  ix: number;
  iz: number;
  /** Height bounds of the node's ground (from its build, or inherited until then), m. */
  minY: number;
  maxY: number;
  /** The tile is built and can be drawn. */
  ready: boolean;
}

export interface LodSelectionHost<N extends LodNode> {
  /** The node (created on first use with bounds inherited from `parent`). */
  node(level: number, ix: number, iz: number, parent: N | null): N;
  /** Ask for a node's tile to be built (called every frame while it is wanted and missing). */
  request(node: N, distance: number): void;
}

/**
 * Select the tiles to draw for a camera at (cx, cy, cz). Fills `out` (cleared) with ready
 * nodes that cover the ground without overlap; requests every missing node it would like.
 */
export function selectTiles<N extends LodNode>(
  host: LodSelectionHost<N>,
  cx: number,
  cy: number,
  cz: number,
  detail: number,
  out: N[],
  maxDistance = MAX_DRAW_DISTANCE,
): N[] {
  out.length = 0;
  const maxLevel = MAX_LEVEL_BY_DETAIL[Math.max(0, Math.min(2, detail))];
  const root = host.node(0, 0, 0, null);
  drawLimit = Math.min(maxDistance, MAX_DRAW_DISTANCE);
  visit(host, root, cx, cy, cz, detail, maxLevel, out);
  return out;
}

/** Farthest distance drawn in the current selection (set by selectTiles). */
let drawLimit = MAX_DRAW_DISTANCE;

function visit<N extends LodNode>(
  host: LodSelectionHost<N>,
  node: N,
  cx: number,
  cy: number,
  cz: number,
  detail: number,
  maxLevel: number,
  out: N[],
): void {
  const size = nodeSize(node.level);
  const x0 = nodeOrigin(node.level, node.ix);
  const z0 = nodeOrigin(node.level, node.iz);
  const distance = boxDistance(cx, cy, cz, x0, z0, size, node.minY, node.maxY);
  if (distance > drawLimit) return;
  if (node.level < maxLevel && distance < splitDistance(node.level, detail)) {
    const level = node.level + 1;
    let ready = 0;
    for (let k = 0; k < 4; k++) {
      const child = host.node(level, node.ix * 2 + (k & 1), node.iz * 2 + (k >> 1), node);
      if (child.ready) ready++;
      else {
        const cs = size / 2;
        const cd = boxDistance(
          cx,
          cy,
          cz,
          x0 + (k & 1) * cs,
          z0 + (k >> 1) * cs,
          cs,
          child.minY,
          child.maxY,
        );
        host.request(child, cd);
      }
    }
    // go down when the children can cover the node — or when the node itself is not there yet
    if (ready === 4 || !node.ready) {
      for (let k = 0; k < 4; k++) {
        const child = host.node(level, node.ix * 2 + (k & 1), node.iz * 2 + (k >> 1), node);
        if (ready === 4 || child.ready) visit(host, child, cx, cy, cz, detail, maxLevel, out);
      }
      if (ready === 4) return;
      if (!node.ready) {
        host.request(node, distance);
        return;
      }
    }
  }
  if (node.ready) out.push(node);
  else host.request(node, distance);
}
