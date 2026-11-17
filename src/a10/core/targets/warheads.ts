/**
 * Missile warheads against vehicles (ARCHITECTURE §12.4, PLAN §6.4 "a Maverick hit destroys any
 * vehicle"): the shaped charge of the AGM-65D/H.
 *
 * A direct hit is resolved here in full, in this order:
 *  1. the jet: it is spent plate by plate along its line from the hit point (spaced layers, then
 *     the main armour), and behind the armour it perforates the residual jet, a wide cone of
 *     behind-armour debris and the overpressure in the compartment hurt the interior
 *     (damage.ts resolveJet, SHAPED_CHARGE in data/vehicles.ts);
 *  2. the warhead's blast in contact with the struck vehicle (the class blast table, blast.ts);
 *  3. one hit record (weapon name, sourceId = the store body's id) and at most one kill;
 *  4. the blast and case fragments on every OTHER vehicle (applyBlast; the struck vehicle is
 *     marked so that blast, and any later applyBlast of the same burst, skips it).
 * A warhead that bursts on the ground beside a vehicle is not a hit: the weapons module applies
 * its blast and fragments only (applyBlast).
 *
 * Randomness comes only from sim.rng.damage.
 */
import { VEHICLE_MODELS } from '../../data/vehicles';
import type { Sim } from '../types';
import { applyBlast, blastOnVehicle } from './blast';
import { markBurst, resolveJet, type JetResult } from './damage';
import { partOfPlate } from './hit';
import { vehiclePose } from './pose';
import {
  alertGroup,
  emitDamaged,
  evaluateCondition,
  findVehicle,
  recordHit,
  sortDamaged,
  updateComponentHealth,
} from './state';
import type { ComponentId, VehicleHit } from './types';

/** A warhead that strikes a vehicle at a hit point found by segmentHitVehicle. */
export interface WarheadStrike {
  kind: 'shapedCharge';
  /** Penetration of the jet, mm of rolled homogeneous armour. */
  penetrationMm: number;
  /** TNT-equivalent charge, kg (its blast is applied too). */
  chargeKg: number;
  // ---- optional (maintenance, wave 2) ----
  /** Mass of the warhead's fragmenting case, kg: its fragments on the other vehicles (default 0). */
  caseKg?: number;
  /**
   * The weapon's velocity at impact (world, m/s; only its direction is needed): the jet's line,
   * and the speed in the hit log. Default: the velocity of the store body `sourceId`, else
   * straight into the struck plate.
   */
  direction?: { x: number; y: number; z: number };
}

const _list: ComponentId[] = [];
const _jet: JetResult = {
  outcome: 'stopped',
  plate: 0,
  obliquity: 0,
  effectiveThicknessMm: 0,
  residualMm: 0,
};
const _dir = { x: 0, y: 0, z: 0 };

/** Direction of the jet (unit, into _dir); returns the weapon's speed at impact (0: unknown). */
function strikeDirection(
  sim: Sim,
  hit: VehicleHit,
  warhead: WarheadStrike,
  sourceId: number,
): number {
  const d = warhead.direction;
  if (d) {
    const s = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
    if (s > 1e-9) {
      _dir.x = d.x / s;
      _dir.y = d.y / s;
      _dir.z = d.z / s;
      return s;
    }
  }
  const bodies = sim.projectiles.bodies;
  for (let i = bodies.length - 1; i >= 0; i--) {
    const b = bodies[i];
    if (b.id !== sourceId) continue;
    const s = b.velocity.length();
    if (s > 1e-6) {
      _dir.x = b.velocity.x / s;
      _dir.y = b.velocity.y / s;
      _dir.z = b.velocity.z / s;
      return s;
    }
    break;
  }
  _dir.x = -hit.normal.x;
  _dir.y = -hit.normal.y;
  _dir.z = -hit.normal.z;
  return 0;
}

/**
 * A missile warhead hitting a vehicle: the jet through the plates along its line, the effects
 * behind the armour, the warhead's blast on the struck vehicle and on its neighbours (see the
 * file comment). Logged as one hit (weapon name, sourceId = the store body's id).
 */
export function applyWarheadHit(
  sim: Sim,
  hit: VehicleHit,
  warhead: WarheadStrike,
  weapon: string,
  sourceId: number,
): void {
  const charge = Math.max(0, warhead.chargeKg);
  const caseKg = Math.max(0, warhead.caseKg ?? 0);
  const v = findVehicle(sim, hit.vehicleId);
  if (!v) {
    applyBlast(sim, hit.point, charge, caseKg, weapon, sourceId);
    return;
  }
  const model = VEHICLE_MODELS[v.kind];
  const pose = vehiclePose(v, model.turretZ);
  const speed = strikeDirection(sim, hit, warhead, sourceId);
  const list = _list;
  list.length = 0;
  v.hits++;
  v.lastHitTime = sim.time;
  v.internal.lastWeapon = weapon;
  alertGroup(sim, v.groupId);

  // 1. the jet
  if (warhead.penetrationMm > 0) {
    resolveJet(sim, v, pose, hit, _dir.x, _dir.y, _dir.z, warhead.penetrationMm, list, _jet);
  } else {
    const cosT = Math.max(
      1e-3,
      -(_dir.x * hit.normal.x + _dir.y * hit.normal.y + _dir.z * hit.normal.z),
    );
    _jet.outcome = 'stopped';
    _jet.plate = hit.plate;
    _jet.obliquity = Math.acos(Math.min(1, cosT));
    _jet.effectiveThicknessMm = model.plates[hit.plate].thicknessMm / cosT;
    _jet.residualMm = 0;
  }
  // 2. the warhead's blast, in contact with the struck vehicle
  blastOnVehicle(sim, v, pose, hit.point, charge, weapon, false, list);

  // 3. condition, events and the one hit record
  if (list.length > 0) {
    updateComponentHealth(v);
    evaluateCondition(sim, v, weapon);
    sortDamaged(list);
    emitDamaged(sim, v, list[0]);
  }
  const dp = model.plates[_jet.plate];
  recordHit(
    sim,
    v,
    sourceId,
    weapon,
    _jet.plate,
    dp.face,
    model.parts[partOfPlate(model, _jet.plate)].part,
    speed,
    _jet.obliquity,
    _jet.effectiveThicknessMm,
    warhead.penetrationMm,
    _jet.outcome,
    list,
  );

  // 4. the blast and case fragments on every other vehicle
  markBurst(sim, v, hit.point.x, hit.point.y, hit.point.z);
  applyBlast(sim, hit.point, charge, caseKg, weapon, sourceId);
}
