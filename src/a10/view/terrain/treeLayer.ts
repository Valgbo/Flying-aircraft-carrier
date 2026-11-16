/**
 * Instanced trees around the aircraft (main thread). Tree cells (treeCells.ts) are built in the
 * terrain worker for every cell within the preset's tree distance; their trees are copied into
 * one instance buffer — nearest cells first, and from each cell only the prefix (by rank) that
 * the distance-based thinning can show — up to the preset's tree count. The buffer is rebuilt
 * (a few memcpy's, one upload) only when the aircraft has moved a cell's worth or new cells
 * arrived, never per frame. One draw call.
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
/** Full tree density out to this share of the tree distance. */
const FULL_DENSITY_SHARE = 0.3;
/** Seed of the tree placement (independent of the world seed's other uses). */
const TREE_SEED = 0x7a3e;

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
}

const byDistance = (a: CellState, b: CellState) => a.d - b.d;

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
  private builtAt = { x: Infinity, z: Infinity, distance: 0, capacity: 0 };
  /** Reused per-frame scratch lists. */
  private wanted: CellState[] = [];
  private ready: CellState[] = [];
  /** Trees in the instance buffer (before the GPU's own thinning). */
  instances = 0;

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
   * the instances when needed. `aboveGround` is the camera's height over the ground below it.
   */
  update(
    camX: number,
    camZ: number,
    aboveGround: number,
    treeCount: number,
    treeDistance: number,
    request: TreeRequestSink,
  ): void {
    this.frame++;
    if (treeCount !== this.capacity) {
      this.geometry.dispose();
      this.buffer = this.allocate(treeCount);
    }
    const full = treeDistance * FULL_DENSITY_SHARE;
    treeUniforms.uTreeFade.value.set(full, treeDistance);
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
            state = { key, ix, iz, cell: null, pending: false, lastUsed: this.frame, d };
            this.cells.set(key, state);
          }
          state.lastUsed = this.frame;
          state.d = d;
          if (!state.cell && !state.pending) wanted.push(state);
        }
      }
    }
    wanted.sort(byDistance);
    for (const w of wanted) {
      const ok = request(
        { key: w.key, x0: w.ix * TREE_CELL, z0: w.iz * TREE_CELL, size: TREE_CELL, seed: TREE_SEED },
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

    const moved = Math.hypot(camX - this.builtAt.x, camZ - this.builtAt.z);
    if (
      this.dirty ||
      moved > REBUILD_DISTANCE ||
      this.builtAt.distance !== treeDistance ||
      this.builtAt.capacity !== this.capacity
    ) {
      this.rebuild(camX, camZ, radius, full);
      this.builtAt.x = camX;
      this.builtAt.z = camZ;
      this.builtAt.distance = treeDistance;
      this.builtAt.capacity = this.capacity;
      this.dirty = false;
    }
  }

  private rebuild(camX: number, camZ: number, radius: number, full: number): void {
    const list = this.ready;
    list.length = 0;
    if (radius > 0) {
      for (const state of this.cells.values()) {
        if (!state.cell || state.cell.count === 0) continue;
        state.d = cellDistance(camX, camZ, state.ix, state.iz);
        if (state.d <= radius + REBUILD_DISTANCE) list.push(state);
      }
    }
    list.sort(byDistance);
    const target = this.buffer.array as Float32Array;
    let n = 0;
    for (const state of list) {
      const cell = state.cell!;
      const d = state.d;
      // the GPU draws rank < (full / d)²: copy only what can be drawn (with a margin)
      const nearest = Math.max(1, d - REBUILD_DISTANCE);
      const density = Math.min(1, (full / nearest) ** 2 * 1.2 + 0.02);
      let k = cell.count;
      if (density < 1) {
        // ranks are sorted ascending: binary search the prefix
        let lo = 0;
        let hi = cell.count;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cell.data[mid * TREE_STRIDE + 7] < density) lo = mid + 1;
          else hi = mid;
        }
        k = lo;
      }
      k = Math.min(k, this.capacity - n);
      if (k <= 0) break;
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

/** Horizontal distance from (x, z) to the nearest point of a tree cell. */
function cellDistance(x: number, z: number, ix: number, iz: number): number {
  const x0 = ix * TREE_CELL;
  const z0 = iz * TREE_CELL;
  const dx = x < x0 ? x0 - x : x > x0 + TREE_CELL ? x - x0 - TREE_CELL : 0;
  const dz = z < z0 ? z0 - z : z > z0 + TREE_CELL ? z - z0 - TREE_CELL : 0;
  return Math.sqrt(dx * dx + dz * dz);
}
