/**
 * The live-round pool: structure-of-arrays storage for up to 1,024 rounds (PLAN_A10.md §14).
 * Allocation and release are O(1) through a stack of free slot indices, and nothing is ever
 * allocated after creation. Slots are reused; ids are not (RoundPool.id is unique per round).
 */
import { ROUND_BEHAVIOUR } from '../../data/gun';
import type { RoundPool } from './types';

/** RoundPool.flags bit: the round has hit a vehicle (counted once in its burst's hits). */
export const ROUND_FLAG_HIT_VEHICLE = 1;

export function createRoundPool(capacity: number = ROUND_BEHAVIOUR.poolCapacity): RoundPool {
  const free = new Int32Array(capacity);
  // Popped from the top: slot 0 is handed out first.
  for (let i = 0; i < capacity; i++) free[i] = capacity - 1 - i;
  return {
    capacity,
    alive: new Uint8Array(capacity),
    type: new Uint8Array(capacity),
    px: new Float64Array(capacity),
    py: new Float64Array(capacity),
    pz: new Float64Array(capacity),
    vx: new Float64Array(capacity),
    vy: new Float64Array(capacity),
    vz: new Float64Array(capacity),
    fireTime: new Float64Array(capacity),
    id: new Uint32Array(capacity),
    burst: new Uint32Array(capacity),
    bounces: new Uint8Array(capacity),
    live: 0,
    nextId: 1,
    ricochets: new Uint8Array(capacity),
    wx: new Float64Array(capacity),
    wy: new Float64Array(capacity),
    wz: new Float64Array(capacity),
    flags: new Uint8Array(capacity),
    free,
    freeCount: capacity,
  };
}

/**
 * Take a free slot and give it a new id (O(1)). Returns the slot index, or -1 when the pool is
 * full. The caller fills type, position, velocity, fire time and burst.
 */
export function allocRound(pool: RoundPool): number {
  if (pool.freeCount === 0) return -1;
  const i = pool.free[--pool.freeCount];
  pool.alive[i] = 1;
  pool.live++;
  pool.id[i] = pool.nextId;
  pool.nextId = (pool.nextId + 1) >>> 0 || 1;
  pool.bounces[i] = 0;
  pool.ricochets[i] = 0;
  pool.flags[i] = 0;
  return i;
}

/** Return a slot to the pool (O(1)); a slot that is not live is left alone. */
export function freeRound(pool: RoundPool, i: number): void {
  if (pool.alive[i] === 0) return;
  pool.alive[i] = 0;
  pool.live--;
  pool.free[pool.freeCount++] = i;
}

/** Remove every live round (rearm on the ground, tests). Ids keep counting up. */
export function clearRoundPool(pool: RoundPool): void {
  for (let i = 0; i < pool.capacity; i++) freeRound(pool, i);
}
