/**
 * Debrief data (PLAN_A10.md §11.4, first version): summaries of sim.debrief and sim.targets for
 * the debrief screen, and the impact recorder behind its overhead plots. Pure helpers plus one
 * small recorder object; covered by tests/unit/a10/ui-debrief.test.ts.
 *
 * HitRecord carries no impact position, so the plots are fed from the 'roundImpact' events of
 * the flight: each impact on or near a vehicle is stored in that vehicle's frame (x right,
 * y forward, metres) at the moment it happens.
 */
import type { BurstRecord, DebriefState, HitRecord } from '../core/debrief/types';
import type { Sim, SimEvent } from '../core/types';
import type { Vehicle, VehicleKind } from '../core/targets/types';

/** How the vehicles are named on screen (the range's targets are generic classes, PLAN §9). */
export const VEHICLE_NAMES: Record<VehicleKind, string> = {
  mbt: 'T-72',
  ifv: 'BMP',
  apc: 'BTR',
  truckCargo: 'Cargo truck',
  truckFuel: 'Fuel truck',
  truckAmmo: 'Ammunition truck',
  hulk: 'Tank hulk',
  panel: 'Strafe panel',
};

export function vehicleName(kind: string): string {
  return VEHICLE_NAMES[kind as VehicleKind] ?? kind;
}

/** A point in a vehicle's own frame: x to its right, y ahead of it, metres. */
export interface LocalPoint {
  x: number;
  y: number;
}

/**
 * World (x east, z south) → the frame of a vehicle at (vx, vz) with compass heading `heading`
 * (0 = north, clockwise). Forward is (sin h, −cos h) in world x/z, right is (cos h, sin h).
 */
export function toVehicleLocal(
  px: number,
  pz: number,
  vx: number,
  vz: number,
  heading: number,
  out: LocalPoint = { x: 0, y: 0 },
): LocalPoint {
  const dx = px - vx;
  const dz = pz - vz;
  const s = Math.sin(heading);
  const c = Math.cos(heading);
  out.x = dx * c + dz * s;
  out.y = dx * s - dz * c;
  return out;
}

/** What an impact did, folded into the plot's four marks. */
export type ImpactClass = 'penetrated' | 'defeated' | 'burst' | 'ground';

export function classifyImpact(outcome: string, onVehicle: boolean): ImpactClass {
  if (!onVehicle) return 'ground';
  if (outcome === 'penetrated' || outcome === 'passedThrough') return 'penetrated';
  if (outcome === 'burst') return 'burst';
  return 'defeated';
}

export const IMPACT_CLASS_LABEL: Record<ImpactClass, string> = {
  penetrated: 'Penetrated',
  defeated: 'Stopped or ricocheted',
  burst: 'HEI burst on the outside',
  ground: 'Missed: ground nearby',
};

export interface ImpactMark extends LocalPoint {
  cls: ImpactClass;
  /** RoundType (0 API, 1 HEI, 2 TP). */
  round: number;
  t: number;
}

/** Ground impacts further than this from every vehicle are not plotted, m. */
export const NEAR_MISS_RADIUS = 40;
/** Cap of stored marks per flight (a full drum is 1,150 rounds). */
export const MAX_MARKS = 6000;

/**
 * Collects impact marks around vehicles during a flight. One instance lives in the bridge; it
 * restarts by itself when a new flight (a new Sim object) begins.
 */
export class ImpactRecorder {
  private sim: Sim | null = null;
  private marks = new Map<number, ImpactMark[]>();
  private count = 0;
  private readonly scratch: LocalPoint = { x: 0, y: 0 };

  reset(sim: Sim | null = null): void {
    this.sim = sim;
    this.marks.clear();
    this.count = 0;
  }

  /** Feed one frame's events. */
  record(events: readonly SimEvent[], sim: Sim): void {
    if (sim !== this.sim) this.reset(sim);
    for (const e of events) {
      if (e.type !== 'roundImpact' || this.count >= MAX_MARKS) continue;
      let vehicle: Vehicle | undefined;
      if (e.target.kind === 'vehicle') {
        const id = e.target.vehicleId;
        vehicle = sim.targets.vehicles.find((v) => v.id === id);
      } else {
        vehicle = nearestVehicle(
          sim.targets.vehicles,
          e.position.x,
          e.position.z,
          NEAR_MISS_RADIUS,
        );
      }
      if (!vehicle) continue;
      const p = toVehicleLocal(
        e.position.x,
        e.position.z,
        vehicle.position.x,
        vehicle.position.z,
        vehicle.heading,
        this.scratch,
      );
      const list = this.marks.get(vehicle.id) ?? [];
      list.push({
        x: p.x,
        y: p.y,
        cls: classifyImpact(e.outcome, e.target.kind === 'vehicle'),
        round: e.round,
        t: e.t,
      });
      this.marks.set(vehicle.id, list);
      this.count++;
    }
  }

  /** Marks around one vehicle in the flight `sim` (empty for another flight). */
  marksFor(sim: Sim | null, vehicleId: number): readonly ImpactMark[] {
    if (!sim || sim !== this.sim) return [];
    return this.marks.get(vehicleId) ?? [];
  }

  /** Ids of the vehicles that have marks, in the flight `sim`. */
  vehicleIds(sim: Sim | null): number[] {
    if (!sim || sim !== this.sim) return [];
    return [...this.marks.keys()];
  }
}

export function nearestVehicle(
  vehicles: readonly Vehicle[],
  x: number,
  z: number,
  radius: number,
): Vehicle | undefined {
  let best: Vehicle | undefined;
  let bestD = radius * radius;
  for (const v of vehicles) {
    const dx = v.position.x - x;
    const dz = v.position.z - z;
    const d = dx * dx + dz * dz;
    if (d <= bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

// ---- summaries ------------------------------------------------------------------------------

export interface VehicleHits {
  vehicleId: number;
  kind: string;
  hits: HitRecord[];
  /** Condition after the last hit. */
  condition: string;
}

/** Hits grouped by vehicle, in the order each vehicle was first hit. */
export function hitsByVehicle(hits: readonly HitRecord[]): VehicleHits[] {
  const groups = new Map<number, VehicleHits>();
  for (const h of hits) {
    let g = groups.get(h.vehicleId);
    if (!g) {
      g = { vehicleId: h.vehicleId, kind: h.vehicleKind, hits: [], condition: h.condition };
      groups.set(h.vehicleId, g);
    }
    g.hits.push(h);
    g.condition = h.condition;
  }
  return [...groups.values()];
}

export interface DebriefSummary {
  roundsLoaded: number;
  roundsFired: number;
  /** Hits on vehicles by gun rounds (from the hit log). */
  gunHits: number;
  bursts: number;
  vehiclesHit: number;
  kills: number;
  vehiclesTotal: number;
  weaponsReleased: number;
}

const GUN_WEAPON = /^(?:API|HEI|TP|PGU|GAU|gun|30)/i;

export function isGunHit(h: HitRecord): boolean {
  return GUN_WEAPON.test(h.weapon);
}

export function summarize(
  debrief: DebriefState,
  gun: { roundsLoaded: number; totalFired: number; rounds: number },
  vehiclesTotal: number,
): DebriefSummary {
  const fired = Math.max(gun.totalFired, gun.roundsLoaded - gun.rounds, 0);
  const burstRounds = debrief.bursts.reduce((s, b) => s + b.rounds, 0);
  return {
    roundsLoaded: gun.roundsLoaded,
    roundsFired: Math.max(fired, burstRounds),
    gunHits: debrief.hits.filter(isGunHit).length,
    bursts: debrief.bursts.length,
    vehiclesHit: new Set(debrief.hits.map((h) => h.vehicleId)).size,
    kills: debrief.kills.length,
    vehiclesTotal,
    weaponsReleased: debrief.weapons.length,
  };
}

/** Hits per round of a burst, 0..1 (NaN for a burst without rounds). */
export function burstHitRate(b: BurstRecord): number {
  return b.rounds > 0 ? b.hits / b.rounds : NaN;
}

/**
 * Extent and grid step of a plot around a vehicle: it covers the vehicle and its farthest
 * mark with a margin, rounded up to a whole grid step so the scale bar reads cleanly, m.
 */
export function plotScale(
  marks: readonly LocalPoint[],
  vehicleHalfSize: number,
): { radius: number; step: number } {
  let r = vehicleHalfSize * 1.5;
  for (const m of marks) r = Math.max(r, Math.abs(m.x), Math.abs(m.y));
  r *= 1.1;
  const step = r <= 8 ? 2 : r <= 20 ? 5 : 10;
  return { radius: Math.ceil(r / step) * step, step };
}
