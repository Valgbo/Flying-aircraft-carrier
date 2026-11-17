/**
 * Instanced trees around the aircraft (main thread). Tree cells (treeCells.ts) are built in the
 * terrain worker for every cell within the preset's tree distance; their trees are copied into
 * one instance buffer — nearest cells first, cells in the view direction before those behind
 * the camera, and from each cell only the prefix (by rank) that the distance-based thinning can
 * show — up to the preset's tree count. The buffer is rebuilt (a few memcpy's, one upload) only
 * when the camera has moved or turned far enough or new cells arrived, never per frame. One
 * draw call.
 */
import {
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  PlaneGeometry,
  Sphere,
  Vector3,
  type ShaderMaterial,
} from 'three';
import { createTreeMaterial, treeUniforms } from './treeMaterial';
import { TREE_STRIDE, type TreeCell, type TreeCellSpec } from './treeCells';

/** Edge of a tree cell, m. */
export const TREE_CELL = 512;
/** Rebuild the instance buffer after the camera moved this far, m. */
const REBUILD_DISTANCE = 120;
/** Full tree density out to this share of the tree distance (when the budget allows). */
const FULL_DENSITY_SHARE = 0.3;
/** The full-density distance never shrinks below this to fit the budget, m. */
const MIN_FULL_DENSITY = 60;
/** Cells within ±100° of the view direction (or this close) are "in view" for the budget. */
const IN_VIEW_FACING = Math.cos((100 * Math.PI) / 180);
const IN_VIEW_NEAR = 300;
/** Seed of the tree placement (independent of the world seed's other uses). */
const TREE_SEED = 0x7a3e;
/**
 * How much farther a cell behind the camera counts when the tree budget is shared out (cells
 * to the side half of it): the trees in view are filled first when the budget is short.
 */
const BEHIND_PENALTY = 1.6;
/** Rebuild after the view turned this far (cos of the angle), at most every few frames. */
const TURN_REBUILD_COS = Math.cos((25 * Math.PI) / 180);
const TURN_REBUILD_FRAMES = 12;

interface CellState {
  key: number;
  ix: number;
  iz: number;
  cell: TreeCell | null;
  pending: boolean;
  /** Frame it was last within range. */
  lastUsed: number;
  /** Distance from the camera at the last update (sorting scratch). */
  d: number;
  /** Distance weighted by the view direction (budget order). */
  e: number;
}

const byWeighted = (a: CellState, b: CellState) => a.e - b.e;

export interface TreeRequestSink {
  /** Ask for a cell to be built; returns false when the workers are busy (try again later). */
  (spec: TreeCellSpec, priority: number): boolean;
}

export class TreeLayer {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly geometry: InstancedBufferGeometry;
  private readonly quad: PlaneGeometry;
  private buffer: InstancedInterleavedBuffer;
  private capacity = 0;
  private cells = new Map<number, CellState>();
  private frame = 0;
  private dirty = true;
  private builtAt = {
    x: Infinity,
    z: Infinity,
    distance: 0,
    capacity: 0,
    dirX: 0,
    dirZ: 0,
    frame: 0,
  };
  /** Reused per-frame scratch lists. */
  private wanted: CellState[] = [];
  private ready: CellState[] = [];
  /** Trees in the instance buffer (before the GPU's own thinning). */
  instances = 0;
  /**
   * Distance of full tree density the GPU draws with, m: the preset's, or less when the trees
   * in view would not fit the budget at that density (thinner everywhere instead of none far).
   */
  fullDensity = 0;

  constructor(capacity: number) {
    this.quad = new PlaneGeometry(2, 2);
    this.geometry = new InstancedBufferGeometry();
    this.geometry.setIndex(this.quad.getIndex());
    this.geometry.setAttribute('position', this.quad.getAttribute('position'));
    this.buffer = this.allocate(capacity);
    this.geometry.instanceCount = 0;
    // the impostors move every frame relative to the camera; culling per tree happens in the shader
    this.geometry.boundingSphere = new Sphere(new Vector3(), 1e7);
    this.mesh = new Mesh(this.geometry, createTreeMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'TerrainTrees';
  }

  private allocate(capacity: number): InstancedInterleavedBuffer {
    this.capacity = Math.max(1, capacity);
    const buffer = new InstancedInterleavedBuffer(
      new Float32Array(this.capacity * TREE_STRIDE),
      TREE_STRIDE,
    );
    buffer.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('iA', new InterleavedBufferAttribute(buffer, 4, 0));
    this.geometry.setAttribute('iB', new InterleavedBufferAttribute(buffer, 4, 4));
    this.dirty = true;
    return buffer;
  }

  /** A cell arrived from the worker. */
  receive(cell: TreeCell): void {
    const state = this.cells.get(cell.key);
    if (!state) return;
    state.cell = cell;
    state.pending = false;
    this.dirty = true;
  }

  /** A request failed: allow it again. */
  fail(key: number): void {
    const state = this.cells.get(key);
    if (state) state.pending = false;
  }

  /**
   * Per frame: request the cells in range (nearest first, while the sink accepts) and rebuild
   * the instances when needed. `aboveGround` is the camera's height over the ground below it;
   * (dirX, dirZ) its horizontal view direction (unit, or zero looking straight down).
   */
  update(
    camX: number,
    camZ: number,
    aboveGround: number,
    treeCount: number,
    treeDistance: number,
    request: TreeRequestSink,
    dirX = 0,
    dirZ = 0,
  ): void {
    this.frame++;
    if (treeCount !== this.capacity) {
      this.geometry.dispose();
      this.buffer = this.allocate(treeCount);
    }
    const full = treeDistance * FULL_DENSITY_SHARE;
    // above the trees' range nothing is drawn (from 5 km up the canopy shell does it alone)
    const reach = treeDistance * treeDistance - aboveGround * aboveGround;
    const radius = reach > 0 ? Math.sqrt(reach) : 0;
    const c0x = Math.floor((camX - radius) / TREE_CELL);
    const c1x = Math.floor((camX + radius) / TREE_CELL);
    const c0z = Math.floor((camZ - radius) / TREE_CELL);
    const c1z = Math.floor((camZ + radius) / TREE_CELL);
    const wanted = this.wanted;
    wanted.length = 0;
    if (radius > 0) {
      for (let iz = c0z; iz <= c1z; iz++) {
        for (let ix = c0x; ix <= c1x; ix++) {
          const d = cellDistance(camX, camZ, ix, iz);
          if (d > radius) continue;
          const key = (iz + 4096) * 8192 + (ix + 4096);
          let state = this.cells.get(key);
          if (!state) {
            state = { key, ix, iz, cell: null, pending: false, lastUsed: this.frame, d, e: d };
            this.cells.set(key, state);
          }
          state.lastUsed = this.frame;
          state.d = d;
          state.e = weightedDistance(camX, camZ, ix, iz, d, dirX, dirZ);
          if (!state.cell && !state.pending) wanted.push(state);
        }
      }
    }
    wanted.sort(byWeighted);
    for (const w of wanted) {
      const ok = request(
        {
          key: w.key,
          x0: w.ix * TREE_CELL,
          z0: w.iz * TREE_CELL,
          size: TREE_CELL,
          seed: TREE_SEED,
        },
        w.d,
      );
      if (!ok) break;
      w.pending = true;
    }
    // forget cells far out of range
    if (this.frame % 120 === 0) {
      for (const [key, state] of this.cells) {
        if (this.frame - state.lastUsed > 240 && !state.pending) this.cells.delete(key);
      }
    }

    const b = this.builtAt;
    const moved = Math.hypot(camX - b.x, camZ - b.z);
    const turned =
      dirX * b.dirX + dirZ * b.dirZ < TURN_REBUILD_COS &&
      this.frame - b.frame >= TURN_REBUILD_FRAMES;
    if (
      this.dirty ||
      moved > REBUILD_DISTANCE ||
      turned ||
      b.distance !== treeDistance ||
      b.capacity !== this.capacity
    ) {
      this.rebuild(camX, camZ, aboveGround, radius, full, dirX, dirZ);
      b.x = camX;
      b.z = camZ;
      b.dirX = dirX;
      b.dirZ = dirZ;
      b.frame = this.frame;
      b.distance = treeDistance;
      b.capacity = this.capacity;
      this.dirty = false;
    }
    treeUniforms.uTreeFade.value.set(this.fullDensity || full, treeDistance);
  }

  private rebuild(
    camX: number,
    camZ: number,
    height: number,
    radius: number,
    full: number,
    dirX: number,
    dirZ: number,
  ): void {
    const list = this.ready;
    list.length = 0;
    if (radius > 0) {
      for (const state of this.cells.values()) {
        if (!state.cell || state.cell.count === 0) continue;
        state.d = cellDistance(camX, camZ, state.ix, state.iz);
        state.e = weightedDistance(camX, camZ, state.ix, state.iz, state.d, dirX, dirZ);
        if (state.d <= radius + REBUILD_DISTANCE) list.push(state);
      }
    }
    // the budget goes to near cells first, and to the cells in view before those behind
    list.sort(byWeighted);
    // thin the trees evenly (a shorter full-density distance) until those in view fit
    let f = full;
    if (inViewCount(list, f, height, dirX, dirZ, camX, camZ) > this.capacity) {
      let lo = MIN_FULL_DENSITY;
      let hi = full;
      for (let it = 0; it < 10; it++) {
        const mid = (lo + hi) / 2;
        if (inViewCount(list, mid, height, dirX, dirZ, camX, camZ) > this.capacity) hi = mid;
        else lo = mid;
      }
      f = lo;
    }
    this.fullDensity = f;
    const target = this.buffer.array as Float32Array;
    let n = 0;
    for (const state of list) {
      if (n >= this.capacity) break;
      const cell = state.cell!;
      const k = Math.min(drawablePrefix(cell, state.d, height, f), this.capacity - n);
      if (k <= 0) continue;
      target.set(cell.data.subarray(0, k * TREE_STRIDE), n * TREE_STRIDE);
      n += k;
    }
    this.instances = n;
    this.geometry.instanceCount = n;
    this.buffer.clearUpdateRanges();
    this.buffer.addUpdateRange(0, n * TREE_STRIDE);
    this.buffer.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.quad.dispose();
    this.mesh.material.dispose();
    this.cells.clear();
  }
}

/**
 * How many of a cell's trees (a prefix, by rank) the GPU can draw at horizontal distance `d`
 * from a camera `height` m above the ground, with full density out to `full` m: it draws
 * rank < (full / distance)², so copy that prefix, with a margin for the camera moving until
 * the next rebuild.
 */
function drawablePrefix(cell: TreeCell, d: number, height: number, full: number): number {
  const nearest = Math.max(1, Math.hypot(Math.max(0, d - REBUILD_DISTANCE), height));
  const density = Math.min(1, (full / nearest) ** 2 * 1.2 + 0.02);
  if (density >= 1) return cell.count;
  // ranks are sorted ascending: binary search the prefix
  let lo = 0;
  let hi = cell.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cell.data[mid * TREE_STRIDE + 7] < density) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Trees the cells in view would need at full density out to `full` m. */
function inViewCount(
  list: readonly CellState[],
  full: number,
  height: number,
  dirX: number,
  dirZ: number,
  camX: number,
  camZ: number,
): number {
  let sum = 0;
  for (const state of list) {
    if (state.d > IN_VIEW_NEAR && (dirX !== 0 || dirZ !== 0)) {
      const cx = (state.ix + 0.5) * TREE_CELL - camX;
      const cz = (state.iz + 0.5) * TREE_CELL - camZ;
      const l = Math.hypot(cx, cz);
      if (l > 1 && (cx * dirX + cz * dirZ) / l < IN_VIEW_FACING) continue;
    }
    sum += drawablePrefix(state.cell!, state.d, height, full);
  }
  return sum;
}

/**
 * A cell's distance for sharing out the tree budget: its real distance, stretched for cells to
 * the side of and behind the view direction (dirX, dirZ) (unchanged when the direction is zero).
 */
function weightedDistance(
  x: number,
  z: number,
  ix: number,
  iz: number,
  d: number,
  dirX: number,
  dirZ: number,
): number {
  const cx = (ix + 0.5) * TREE_CELL - x;
  const cz = (iz + 0.5) * TREE_CELL - z;
  const l = Math.hypot(cx, cz);
  if (l < 1) return d;
  const facing = (cx * dirX + cz * dirZ) / l;
  return d * (1 + BEHIND_PENALTY * 0.5 * (1 - facing));
}

/** Horizontal distance from (x, z) to the nearest point of a tree cell. */
function cellDistance(x: number, z: number, ix: number, iz: number): number {
  const x0 = ix * TREE_CELL;
  const z0 = iz * TREE_CELL;
  const dx = x < x0 ? x0 - x : x > x0 + TREE_CELL ? x - x0 - TREE_CELL : 0;
  const dz = z < z0 ? z0 - z : z > z0 + TREE_CELL ? z - z0 - TREE_CELL : 0;
  return Math.sqrt(dx * dx + dz * dz);
}
