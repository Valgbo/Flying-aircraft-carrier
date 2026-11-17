/**
 * TARGETS module public API (docs/a10/ARCHITECTURE.md §4, PLAN_A10.md §9): ground vehicles, their
 * armour and components, the 30 mm damage model, blast and fragments, behaviour and scenarios.
 *
 *   createTargetsState()                              empty state
 *   createVehicle(sim, kind, x, z, heading, groupId)  a vehicle on the ground
 *   populateScenario(sim)                             the scenario's groups (createSim)
 *   stepTargets(sim, dt)                              movement, behaviour, heat, fires, cook-offs
 *   segmentHitVehicle(sim, p0, p1, out)               nearest armour plate crossed by a segment
 *   resolveRoundHit(sim, hit, type, velocity, out)    what a 30 mm round does to that plate
 *   applyBlast(sim, position, chargeKg, fragmentKg?)  blast and fragments of a detonation
 *   VEHICLE_SHAPES, VEHICLE_MODELS                    shapes, armour plates, components
 */
import { VEHICLE_MODELS, VEHICLE_SHAPES } from '../../data/vehicles';
import { createTargetsInternal } from './grid';
import type { TargetsState } from './types';

export type * from './types';
export { VEHICLE_MODELS, VEHICLE_SHAPES };
export { createVehicle, findVehicle, isAlive } from './state';
export { populateScenario, digIn, spawnGroup, type Placement } from './scenario';
export { stepTargets } from './behaviour';
export { segmentHitVehicle, segmentHitVehicleAll } from './hit';
export { resolveRoundHit } from './damage';
export {
  applyBlast,
  blastImpulse,
  blastLevel,
  fragmentCount,
  fragmentPenetration,
  fragmentSpeed,
  gurneyVelocity,
  mottScale,
} from './blast';

export function createTargetsState(): TargetsState {
  return {
    vehicles: [],
    groups: [],
    nextVehicleId: 1,
    nextGroupId: 1,
    killed: 0,
    damaged: 0,
    huntGroups: 0,
    respawnTime: -1,
    internal: createTargetsInternal(),
  };
}

/**
 * Tell the targets module that vehicles were moved or turned by hand (tests, sandboxes), so the
 * spatial index is rebuilt before the next hit test.
 */
export function markTargetsMoved(t: TargetsState): void {
  t.internal.dirty = true;
}
