/**
 * The debrief's weapon records (ARCHITECTURE §12.6, PLAN §6.5 and §11): one WeaponRecord per
 * store released, opened at the release with its conditions and aim point, completed when the
 * body lands with the impact, the miss distance and clock, dud, and the fragment warning.
 *
 * Miss clock: the direction of the impact from the aim point on a clock face whose 12 is the
 * aircraft's ground track at release (12 = long, 6 = short, 3 = right of the run-in).
 *
 * Fragment envelope (safe escape): the distance from a burst at which the expected number of
 * hazardous fragments striking the aircraft falls to SAFE_ESCAPE.hitProbability. With N(>m) =
 * N0·exp(−√(m/μ)) Mott fragments (N0 = case / 2μ), each launched at the Gurney speed and slowed
 * by drag (v = v0·exp(−R/λ(m))), the fragments still hazardous at R are those heavier than the
 * m_min(R) whose kinetic energy there equals SAFE_ESCAPE.hazardousEnergy; half go into the
 * ground, the rest spread over 4πR² (the targets module's own fragment model). For the Mk 82
 * that is ≈350 m.
 */
import type { Vector3 } from 'three';
import { SAFE_ESCAPE } from '../../data/munitions';
import type { ReleaseConditions, WeaponRecord } from '../debrief/types';
import type { Sim } from '../types';
import { FRAGMENTS } from '../../data/vehicles';
import { fragmentSpeed, gurneyVelocity, mottScale } from '../targets';
import type { ReleaseDelivery, StoreBody, StoreType } from './types';

const TWO_PI = 2 * Math.PI;
const HOUR = Math.PI / 6;

/**
 * Clock direction (1..12) of the offset (dx east, dz south) from the aim point, relative to the
 * run-in heading (rad, compass); NaN for an offset under a millimetre.
 */
export function missClock(dx: number, dz: number, runIn: number): number {
  if (dx * dx + dz * dz < 1e-6) return NaN;
  const bearing = Math.atan2(dx, -dz);
  let rel = (bearing - runIn) % TWO_PI;
  if (rel < 0) rel += TWO_PI;
  const c = Math.round(rel / HOUR) % 12;
  return c === 0 ? 12 : c;
}

/** Kinetic energy at distance `range` of a fragment of mass m from a burst, J. */
function fragmentEnergy(v0: number, m: number, range: number, rho: number): number {
  const v = fragmentSpeed(v0, m, range, rho);
  return 0.5 * m * v * v;
}

/** Expected hazardous-fragment hits on the aircraft at distance R from a burst. */
function hazardousHits(chargeKg: number, caseKg: number, range: number, rho: number): number {
  const mu = mottScale(caseKg);
  const n0 = caseKg / (2 * mu);
  const v0 = gurneyVelocity(chargeKg, caseKg);
  const energy = SAFE_ESCAPE.hazardousEnergy;
  // Lightest fragment still hazardous at this range (heavier ones keep their speed better).
  let lo = 1e-6;
  let hi = 50;
  if (fragmentEnergy(v0, hi, range, rho) < energy) return 0;
  for (let k = 0; k < 60; k++) {
    const mid = Math.sqrt(lo * hi);
    if (fragmentEnergy(v0, mid, range, rho) >= energy) hi = mid;
    else lo = mid;
  }
  const count = n0 * Math.exp(-Math.sqrt(hi / mu));
  return (
    (FRAGMENTS.groundFactor * count * SAFE_ESCAPE.presentedArea) / (4 * Math.PI * range * range)
  );
}

/**
 * Radius of the fragment envelope of a burst of `chargeKg` TNT with a `caseKg` fragmenting case
 * in air of density `rho`, m (0 without fragments). Thinner air slows the fragments less, so the
 * envelope grows with the burst's height.
 */
export function fragmentEnvelope(chargeKg: number, caseKg: number, rho = 1.225): number {
  if (!(chargeKg > 0) || !(caseKg > 0)) return 0;
  let lo = 1;
  let hi = 5000;
  if (hazardousHits(chargeKg, caseKg, lo, rho) <= SAFE_ESCAPE.hitProbability) return 0;
  for (let k = 0; k < 50; k++) {
    const mid = 0.5 * (lo + hi);
    if (hazardousHits(chargeKg, caseKg, mid, rho) > SAFE_ESCAPE.hitProbability) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Everything a record needs from the release. */
export interface ReleaseInfo {
  store: StoreType;
  weapon: string;
  station: number;
  delivery: ReleaseDelivery;
  aim: Vector3;
  aimValid: boolean;
  bodyId: number;
  conditions: ReleaseConditions;
}

/** Append a WeaponRecord for a release; returns its index in debrief.weapons. */
export function openRecord(sim: Sim, r: ReleaseInfo): number {
  const list = sim.debrief.weapons;
  const record: WeaponRecord = {
    id: list.length + 1,
    weapon: r.weapon,
    release: { ...r.conditions },
    impactTime: NaN,
    missDistance: NaN,
    missClock: NaN,
    dud: false,
    fragmentWarning: false,
    store: r.store,
    station: r.station,
    delivery: r.delivery,
    aim: r.aimValid ? { x: r.aim.x, y: r.aim.y, z: r.aim.z } : { x: NaN, y: NaN, z: NaN },
    aimValid: r.aimValid,
    impact: { x: NaN, y: NaN, z: NaN },
    simulated: false,
    bodyId: r.bodyId,
  };
  list.push(record);
  return list.length - 1;
}

/** The record of a body (by its index, checked against the body id), or null. */
export function recordOf(sim: Sim, b: StoreBody): WeaponRecord | null {
  const list = sim.debrief.weapons;
  const r = b.record >= 0 ? list[b.record] : undefined;
  if (r && r.bodyId === b.id) return r;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].bodyId === b.id) return list[i];
  return null;
}

/**
 * Complete a body's record at its impact: time, point, horizontal miss from the aim point and
 * its clock (12 = along the run-in), dud, fragment warning. A body that never landed (it left
 * the map) keeps NaN impact values.
 */
export function closeRecord(
  sim: Sim,
  b: StoreBody,
  t: number,
  impact: Vector3 | null,
  dud: boolean,
  fragmentWarning: boolean,
): void {
  const r = recordOf(sim, b);
  if (!r) return;
  r.dud = dud;
  r.fragmentWarning = fragmentWarning;
  if (!impact) return;
  r.impactTime = t;
  r.impact = { x: impact.x, y: impact.y, z: impact.z };
  if (r.aimValid) {
    const dx = impact.x - r.aim.x;
    const dz = impact.z - r.aim.z;
    r.missDistance = Math.hypot(dx, dz);
    r.missClock = missClock(dx, dz, b.runIn);
  }
}
