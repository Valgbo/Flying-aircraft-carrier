/**
 * Missile warheads against vehicles (ARCHITECTURE §12.4): the Maverick's shaped charge.
 * FOUNDATION STAND-IN (wave 2): only the warhead's blast at the hit point; the maintenance module
 * replaces it with the jet's penetration and behind-armour effects.
 */
import type { Sim } from '../types';
import { applyBlast } from './blast';
import type { VehicleHit } from './types';

/** A warhead that strikes a vehicle at a hit point found by segmentHitVehicle. */
export interface WarheadStrike {
  kind: 'shapedCharge';
  /** Penetration of the jet, mm of rolled homogeneous armour. */
  penetrationMm: number;
  /** TNT-equivalent charge, kg (its blast is applied too). */
  chargeKg: number;
}

/**
 * A missile warhead hitting a vehicle: the jet through the plate it struck, the effects behind
 * it, and the warhead's blast. Logged as one hit (weapon name, sourceId = the store body's id).
 */
export function applyWarheadHit(
  sim: Sim,
  hit: VehicleHit,
  warhead: WarheadStrike,
  weapon: string,
  sourceId: number,
): void {
  applyBlast(sim, hit.point, warhead.chargeKg, 0, weapon, sourceId);
}
