/**
 * Broadphase for the vehicle hit tests: a spatial hash of 32 m cells over the map. Each vehicle
 * is entered in every cell its bounding circle touches (at most four); a query visits the cells
 * of the segment's bounding box and tests each vehicle once (per-query stamps). Rebuilt lazily
 * when vehicles were added or moved (`internal.dirty`), with typed arrays: no allocation.
 */
import { VEHICLE_MODELS } from '../../data/vehicles';
import type { TargetsInternal, TargetsState } from './types';

/** Cell edge, m. */
export const CELL = 32;
const SLOTS = 2048; // power of two, ≥ 3× the most entries
const MAX_ENTRIES = 4096;
const OFFSET = 2048; // cell coordinates are offset to stay positive in the key
/** Above this many cells a query tests every vehicle instead (long segments). */
const MAX_QUERY_CELLS = 64;

export function createTargetsInternal(): TargetsInternal {
  return {
    dirty: true,
    keys: new Int32Array(SLOTS).fill(-1),
    heads: new Int32Array(SLOTS).fill(-1),
    entryVehicle: new Int32Array(MAX_ENTRIES),
    entryNext: new Int32Array(MAX_ENTRIES),
    entryCount: 0,
    stamps: new Int32Array(256),
    stamp: 0,
    eventIndex: 0,
    lastEvent: null,
    paths: [],
  };
}

const keyOf = (cx: number, cz: number): number => (cx + OFFSET) * 4096 + (cz + OFFSET);

function slotOf(g: TargetsInternal, key: number, insert: boolean): number {
  let h = Math.imul(key, 0x9e3779b1) >>> 0;
  h &= SLOTS - 1;
  for (let i = 0; i < SLOTS; i++) {
    const k = g.keys[h];
    if (k === key) return h;
    if (k === -1) {
      if (!insert) return -1;
      g.keys[h] = key;
      g.heads[h] = -1;
      return h;
    }
    h = (h + 1) & (SLOTS - 1);
  }
  return -1;
}

/** Rebuild the hash from the vehicles' current positions. */
export function rebuildGrid(t: TargetsState): void {
  const g = t.internal;
  g.keys.fill(-1);
  g.entryCount = 0;
  const list = t.vehicles;
  if (g.stamps.length < list.length) g.stamps = new Int32Array(Math.max(list.length, g.stamps.length * 2));
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    const r = VEHICLE_MODELS[v.kind].sphereR + 0.5;
    const cx0 = Math.floor((v.position.x - r) / CELL);
    const cx1 = Math.floor((v.position.x + r) / CELL);
    const cz0 = Math.floor((v.position.z - r) / CELL);
    const cz1 = Math.floor((v.position.z + r) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        if (g.entryCount >= MAX_ENTRIES) break;
        const s = slotOf(g, keyOf(cx, cz), true);
        if (s < 0) continue;
        const e = g.entryCount++;
        g.entryVehicle[e] = i;
        g.entryNext[e] = g.heads[s];
        g.heads[s] = e;
      }
    }
  }
  g.dirty = false;
}

/**
 * Call `visit(vehicleIndex)` once for each vehicle whose cells overlap the box
 * [x0, x1] × [z0, z1]. `visit` returns false to stop early.
 */
export function forEachNear(
  t: TargetsState,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  visit: (index: number) => boolean,
): void {
  const g = t.internal;
  if (g.dirty) rebuildGrid(t);
  const cx0 = Math.floor(Math.min(x0, x1) / CELL);
  const cx1 = Math.floor(Math.max(x0, x1) / CELL);
  const cz0 = Math.floor(Math.min(z0, z1) / CELL);
  const cz1 = Math.floor(Math.max(z0, z1) / CELL);
  const n = t.vehicles.length;
  if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > MAX_QUERY_CELLS) {
    for (let i = 0; i < n; i++) if (!visit(i)) return;
    return;
  }
  g.stamp = (g.stamp + 1) | 0;
  if (g.stamp === 0x7fffffff) {
    g.stamps.fill(0);
    g.stamp = 1;
  }
  const stamp = g.stamp;
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const s = slotOf(g, keyOf(cx, cz), false);
      if (s < 0) continue;
      for (let e = g.heads[s]; e >= 0; e = g.entryNext[e]) {
        const vi = g.entryVehicle[e];
        if (vi >= n || g.stamps[vi] === stamp) continue;
        g.stamps[vi] = stamp;
        if (!visit(vi)) return;
      }
    }
  }
}
