/**
 * Mass, centre of gravity and inertia (data: A10_MASS in data/aircraft.ts).
 *
 * The empty aircraft (its CG is the body origin) plus point masses: the pilot, the ammunition
 * drum (complete rounds left plus the spent cases it keeps), four fuel tanks (the wing tanks
 * drain first, then the two fuselage mains equally) and the stores (total mass, lateral moment
 * Σm·x from the weapons module, a mean pylon height and a roll radius of gyration). Inertia is
 * summed about the body origin and moved to the CG with the parallel-axis theorem.
 *
 * Inertia is in AVIATION axes (x forward = −Z, y right = +X, z down = −Y): xx roll, yy pitch,
 * zz yaw, xz = ∫x·z dm.
 */
import { A10, A10_MASS as M, A10_WARNINGS } from '../../data/aircraft';
import type { Sim } from '../types';
import type { StoresState } from '../weapons/types';
import type { AircraftState } from './types';

/** Fuel the two fuselage main tanks hold together, kg. */
export const MAIN_TANK_CAPACITY = A10.internalFuel - 2 * M.wingTankCapacity;

/** Accumulator for point masses (contract body coordinates). */
const acc = { m: 0, mx: 0, my: 0, mz: 0, ixx: 0, iyy: 0, izz: 0, ixz: 0 };

function addPoint(m: number, x: number, y: number, z: number): void {
  if (m <= 0) return;
  acc.m += m;
  acc.mx += m * x;
  acc.my += m * y;
  acc.mz += m * z;
  // Aviation axes: x_a = -z, y_a = x, z_a = -y.
  acc.ixx += m * (x * x + y * y);
  acc.iyy += m * (z * z + y * y);
  acc.izz += m * (z * z + x * x);
  acc.ixz += m * z * y;
}

/**
 * Recompute mass, CG, inertia and g limits from fuel, ammunition and stores.
 * `rounds` complete rounds are in the drum, `spentCases` cases have been returned to it.
 */
export function computeMassProperties(
  ac: AircraftState,
  rounds: number,
  spentCases: number,
  stores: StoresState,
): void {
  acc.m = A10.emptyMass;
  acc.mx = acc.my = acc.mz = 0;
  const ei = M.emptyInertia;
  acc.ixx = ei.xx;
  acc.iyy = ei.yy;
  acc.izz = ei.zz;
  acc.ixz = ei.xz;

  const pp = M.pilotPosition;
  addPoint(M.pilotMass, pp.x, pp.y, pp.z);

  const ammo = Math.max(0, rounds) * M.roundMass + Math.max(0, spentCases) * M.spentCaseMass;
  const dp = M.drumPosition;
  addPoint(ammo, dp.x, dp.y, dp.z);

  const fuel = Math.max(0, ac.fuel);
  const mains = Math.min(fuel, MAIN_TANK_CAPACITY);
  const wings = Math.max(0, fuel - MAIN_TANK_CAPACITY) / 2;
  const wt = M.wingTankPosition;
  addPoint(wings, -wt.x, wt.y, wt.z);
  addPoint(wings, wt.x, wt.y, wt.z);
  const mf = M.mainTankForward;
  const ma = M.mainTankAft;
  addPoint(mains / 2, mf.x, mf.y, mf.z);
  addPoint(mains / 2, ma.x, ma.y, ma.z);

  const sm = Math.max(0, stores.mass);
  if (sm > 0) {
    const sx = stores.lateralMoment / sm;
    const sp = M.storesPosition;
    addPoint(sm, sx, sp.y, sp.z);
    // The stores are spread over the stations: their own roll (and yaw) inertia about the
    // centreline beyond what the single point at their lateral CG carries. The weapons module
    // reports Σm·x² over the stations; without it, an even spread at storesRollRadius.
    const sumMx2 =
      stores.rollInertia !== undefined
        ? stores.rollInertia
        : sm * M.storesRollRadius * M.storesRollRadius;
    const spread = Math.max(0, sumMx2 - sm * sx * sx);
    acc.ixx += spread;
    acc.izz += spread;
  }

  const mass = acc.m;
  const cx = acc.mx / mass;
  const cy = acc.my / mass;
  const cz = acc.mz / mass;
  ac.mass = mass;
  ac.cgBody.set(cx, cy, cz);
  // Parallel-axis shift to the CG (aviation components of the CG offset: -cz, cx, -cy).
  ac.inertia.xx = acc.ixx - mass * (cx * cx + cy * cy);
  ac.inertia.yy = acc.iyy - mass * (cz * cz + cy * cy);
  ac.inertia.zz = acc.izz - mass * (cz * cz + cx * cx);
  ac.inertia.xz = acc.ixz - mass * cz * cy;

  // Limit load factors: n·W constant as stores are added (clean: +7.33 / −3 g).
  const ref = M.gLimitReferenceMass;
  const factor = ref / (ref + sm);
  ac.gLimitPositive = Math.max(A10_WARNINGS.minPositiveGLimit, A10.gLimitPositive * factor);
  ac.gLimitNegative = A10.gLimitNegative * factor;
}

/**
 * Mass properties from the sim: fuel, the rounds left in the drum plus the spent cases it has
 * kept since loading, and the stores.
 */
export function updateMass(sim: Sim): void {
  const gun = sim.gun;
  const spent = Math.max(0, gun.roundsLoaded - gun.rounds);
  computeMassProperties(sim.aircraft, gun.rounds, spent, sim.stores);
}
