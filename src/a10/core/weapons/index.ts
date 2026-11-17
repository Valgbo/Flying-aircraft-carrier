/**
 * WEAPONS module public API (docs/a10/ARCHITECTURE.md §4, PLAN_A10.md §6):
 *
 *   gun.ts          createGunState, roundTypeAt, stepGun, muzzleState, gunLineBody
 *   ballistics.ts   roundMass, dragFactor, integrateRound, predictRoundImpact (+ drag, ranges)
 *   penetration.ts  penetrationMm and the fit derived from the ballistic model
 *   pool.ts         createRoundPool and O(1) slot allocation
 *   projectiles.ts  stepProjectiles: rounds in flight, impacts on vehicles and the ground
 *   stores.ts       LOADOUTS, createStoresState, legality, rearm, jettisonStores, stepStores
 *
 * Test bed (tests and sandboxes, import directly): testbed.ts — a kinematic aircraft over flat
 * ground with only the weapons steps running.
 */
import type { ProjectileState } from './types';
import { createRoundPool } from './pool';

export * from './ballistics';
export * from './penetration';
export {
  createGunState,
  roundTypeAt,
  stepGun,
  muzzleState,
  gunLineBody,
  RECOIL_IMPULSE,
  DISPERSION_SIGMA,
} from './gun';
export {
  createRoundPool,
  allocRound,
  freeRound,
  clearRoundPool,
  ROUND_FLAG_HIT_VEHICLE,
} from './pool';
export { stepProjectiles } from './projectiles';
export {
  LOADOUTS,
  STATION_COUNT,
  createStoresState,
  updateStoresTotals,
  isRackType,
  stationAccepts,
  stationIssue,
  loadoutIssues,
  rearm,
  jettisonStores,
  stepStores,
} from './stores';
export { RoundType } from './types';
export type * from './types';

export function createProjectileState(): ProjectileState {
  return { rounds: createRoundPool(), bodies: [], nextBodyId: 1 };
}
