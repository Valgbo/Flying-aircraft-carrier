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
 * A SENSOR'S PICTURE (the targeting pod, a Maverick seeker: a narrow camera that magnifies) has
 * its own selection, `selectFocusTiles`: the same rule with every distance divided by the
 * sensor's magnification (its pixels are that much finer than the outside view's, so its ground
 * must be as fine as the outside view draws it that much closer), restricted to the picture's
 * pyramid — a node wholly outside one of its four side planes is neither drawn nor requested.
 * The terrain system shows that selection only around the sensor's own render
 * (terrainFocus.ts), so the outside view's tiles stay exactly what `selectTiles` chose.
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
 * A sensor's picture for the selection: the camera, its (square) picture's pyramid, and how much
 * finer its pixels are than the outside view's.
 */
export interface LodFocus {
  /** Camera position, m. */
  x: number;
  y: number;
  z: number;
  /** Unit direction of the line of sight (the picture's centre). */
  dx: number;
  dy: number;
  dz: number;
  /** Unit right and up of the picture (perpendicular to the line of sight). */
  rx: number;
  ry: number;
  rz: number;
  ux: number;
  uy: number;
  uz: number;
  /** Tangent of half the picture's field (square: both axes). */
  tanHalf: number;
  /** Magnification over the outside view (≥ 1): distances count 1 / scale. */
  scale: number;
}

export function createLodFocus(): LodFocus {
  return {
    x: 0,
    y: 0,
    z: 0,
    dx: 0,
    dy: 0,
    dz: -1,
    rx: 1,
    ry: 0,
    rz: 0,
    ux: 0,
    uy: 1,
    uz: 0,
    tanHalf: 0.01,
    scale: 1,
  };
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
  picture = null;
  lodScale = 1;
  visit(host, root, cx, cy, cz, detail, maxLevel, out);
  return out;
}

/**
 * Select the tiles of a sensor's picture (see LodFocus and the file comment): ready nodes that
 * cover, without overlap, all the ground inside the picture, refined as the outside view would
 * refine them at 1 / scale of their distance. Fills `out` (cleared); requests the missing nodes
 * in the picture with those magnified distances. `maxDistance` is a true distance.
 */
export function selectFocusTiles<N extends LodNode>(
  host: LodSelectionHost<N>,
  focus: LodFocus,
  detail: number,
  out: N[],
  maxDistance = MAX_DRAW_DISTANCE,
): N[] {
  out.length = 0;
  const maxLevel = MAX_LEVEL_BY_DETAIL[Math.max(0, Math.min(2, detail))];
  const root = host.node(0, 0, 0, null);
  drawLimit = Math.min(maxDistance, MAX_DRAW_DISTANCE);
  // inward normals of the picture pyramid's four side planes (through the camera)
  const t = focus.tanHalf;
  for (let i = 0; i < 4; i++) {
    const a = i === 0 ? 1 : i === 1 ? -1 : 0;
    const b = i === 2 ? 1 : i === 3 ? -1 : 0;
    planes[i * 3] = a * focus.rx + b * focus.ux + t * focus.dx;
    planes[i * 3 + 1] = a * focus.ry + b * focus.uy + t * focus.dy;
    planes[i * 3 + 2] = a * focus.rz + b * focus.uz + t * focus.dz;
  }
  picture = focus;
  lodScale = Math.max(1, focus.scale);
  try {
    visit(host, root, focus.x, focus.y, focus.z, detail, maxLevel, out);
  } finally {
    picture = null;
    lodScale = 1;
  }
  return out;
}

/** Farthest distance drawn in the current selection (set by selectTiles). */
let drawLimit = MAX_DRAW_DISTANCE;
/** The current selection's focus (a sensor's picture), or null for the outside view. */
let picture: LodFocus | null = null;
/** The current selection's distance divisor (1 for the outside view). */
let lodScale = 1;
/** Inward normals (x, y, z) of the focus picture's four side planes (set by selectFocusTiles). */
const planes = new Float64Array(12);

/**
 * Whether the box [x0, x0+size] × [minY, maxY] × [z0, z0+size] may show in the focus's picture:
 * not wholly outside any of its pyramid's side planes (conservative near the pyramid's edges).
 */
function inPicture(
  f: LodFocus,
  x0: number,
  z0: number,
  size: number,
  minY: number,
  maxY: number,
): boolean {
  for (let i = 0; i < 12; i += 3) {
    const nx = planes[i];
    const ny = planes[i + 1];
    const nz = planes[i + 2];
    // the box's corner farthest along the inward normal
    const px = (nx >= 0 ? x0 + size : x0) - f.x;
    const py = (ny >= 0 ? maxY : minY) - f.y;
    const pz = (nz >= 0 ? z0 + size : z0) - f.z;
    if (nx * px + ny * py + nz * pz < 0) return false;
  }
  return true;
}

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
  // a sensor's picture: nothing outside it is drawn or wanted
  if (picture !== null && !inPicture(picture, x0, z0, size, node.minY, node.maxY)) return;
  const reach = boxDistance(cx, cy, cz, x0, z0, size, node.minY, node.maxY);
  if (reach > drawLimit) return;
  // the distance the split rule sees (a magnifying sensor's: 1 / scale of the true one)
  const distance = reach / lodScale;
  if (node.level < maxLevel && distance < splitDistance(node.level, detail)) {
    const level = node.level + 1;
    const cs = size / 2;
    // children that can show (all four, but for a sensor's picture those in the picture)
    let wanted = 0;
    let ready = 0;
    for (let k = 0; k < 4; k++) {
      const child = host.node(level, node.ix * 2 + (k & 1), node.iz * 2 + (k >> 1), node);
      const kx = x0 + (k & 1) * cs;
      const kz = z0 + (k >> 1) * cs;
      if (picture !== null && !inPicture(picture, kx, kz, cs, child.minY, child.maxY)) continue;
      wanted++;
      if (child.ready) ready++;
      else {
        const cd = boxDistance(cx, cy, cz, kx, kz, cs, child.minY, child.maxY);
        host.request(child, cd / lodScale);
      }
    }
    // go down when the children can cover the node — or when the node itself is not there yet
    if (ready === wanted || !node.ready) {
      for (let k = 0; k < 4; k++) {
        const child = host.node(level, node.ix * 2 + (k & 1), node.iz * 2 + (k >> 1), node);
        if (ready === wanted || child.ready) visit(host, child, cx, cy, cz, detail, maxLevel, out);
      }
      if (ready === wanted) return;
      if (!node.ready) {
        host.request(node, distance);
        return;
      }
    }
  }
  if (node.ready) out.push(node);
  else host.request(node, distance);
}
