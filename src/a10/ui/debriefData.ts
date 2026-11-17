/**
 * Debrief data (PLAN_A10.md §11.4): summaries of sim.debrief for the debrief screen and the
 * marks of its overhead plots. Pure helpers over the records the simulation keeps; covered by
 * tests/unit/a10/ui-debrief.test.ts.
 *
 * Counting: a hit RECORD is not a hit. One round can leave several records (an API round that
 * ricochets and strikes again, or passes a spaced layer and strikes the armour behind; an HEI
 * round that bursts on a plate is resolved and then blasts), and an HEI round that bursts on the
 * ground hurts vehicles around it with fragments without touching them. The screens therefore
 * count ROUNDS that struck (the gun's burst records, or distinct round ids among the direct
 * strikes) and show fragment and blast hits apart.
 *
 * Plots: the core debrief logs every impact and ties each hit to the impact that made it in the
 * same step, with its offset from the hit vehicle (core/debrief). A vehicle's plot shows the
 * impact behind each of its hits — also a ground burst that was nearer another vehicle — and
 * the near misses logged in its frame.
 */
import { isIndirect, isRoundWeapon, toHeadingFrame } from '../core/debrief';
import type { BurstRecord, DebriefState, HitRecord } from '../core/debrief/types';
import type { VehicleKind } from '../core/targets/types';

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
  return toHeadingFrame(px - vx, pz - vz, heading, out);
}

/** What an impact did, folded into the plot's marks. */
export type ImpactClass = 'penetrated' | 'defeated' | 'burst' | 'fragments' | 'ground';

/** The class of a strike on a vehicle (by its outcome) or of a ground impact. */
export function classifyImpact(outcome: string, onVehicle: boolean): ImpactClass {
  if (!onVehicle) return 'ground';
  if (outcome === 'penetrated' || outcome === 'passedThrough') return 'penetrated';
  if (outcome === 'burst') return 'burst';
  if (outcome === 'fragment' || outcome === 'blast') return 'fragments';
  return 'defeated';
}

export const IMPACT_CLASS_LABEL: Record<ImpactClass, string> = {
  penetrated: 'Penetrated',
  defeated: 'Stopped or ricocheted',
  burst: 'HEI burst on the outside',
  fragments: 'Burst nearby: blast or fragments',
  // not "missed": a round through a scoring panel (or a thin outer layer) lands behind it too
  ground: 'Ground impacts nearby',
};

export interface ImpactMark extends LocalPoint {
  cls: ImpactClass;
  /** RoundType (0 API, 1 HEI, 2 TP), or -1 for a store. */
  round: number;
  t: number;
}

/** Cap of near-miss marks per plot (a full drum is 1,150 rounds). */
export const MAX_MARKS = 1500;

const ROUND_INDEX: Record<string, number> = { API: 0, HEI: 1, TP: 2 };

/** Precedence when one impact is behind several hits: the strike itself wins. */
const CLASS_RANK: Record<ImpactClass, number> = {
  penetrated: 4,
  burst: 3,
  defeated: 2,
  fragments: 1,
  ground: 0,
};

/**
 * The marks of one vehicle's plot, in its own frame (x right, y ahead): the impact behind each
 * of its hits, then the near misses logged in its frame. Each impact appears once.
 */
export function vehicleMarks(d: DebriefState, vehicleId: number): ImpactMark[] {
  const byImpact = new Map<number, ImpactMark>();
  const p: LocalPoint = { x: 0, y: 0 };
  const n = Math.min(d.hits.length, d.hitLinks.length);
  for (let i = 0; i < n; i++) {
    const h = d.hits[i];
    const link = d.hitLinks[i];
    if (h.vehicleId !== vehicleId || link.impact < 0 || !Number.isFinite(link.dx)) continue;
    const imp = d.impacts[link.impact];
    const cls = classifyImpact(h.outcome, true);
    const prev = byImpact.get(link.impact);
    if (prev) {
      if (CLASS_RANK[cls] > CLASS_RANK[prev.cls]) prev.cls = cls;
      continue;
    }
    toHeadingFrame(link.dx, link.dz, link.heading, p);
    byImpact.set(link.impact, {
      x: p.x,
      y: p.y,
      cls,
      round: imp ? (ROUND_INDEX[imp.weapon] ?? -1) : -1,
      t: imp ? imp.t : h.time,
    });
  }
  const marks = [...byImpact.values()];
  let near = 0;
  for (let k = 0; k < d.impacts.length && near < MAX_MARKS; k++) {
    const imp = d.impacts[k];
    if (imp.ref !== vehicleId || byImpact.has(k) || !Number.isFinite(imp.dx)) continue;
    toHeadingFrame(imp.dx, imp.dz, imp.refHeading, p);
    marks.push({
      x: p.x,
      y: p.y,
      cls: classifyImpact(imp.outcome, imp.vehicleId === vehicleId),
      round: ROUND_INDEX[imp.weapon] ?? -1,
      t: imp.t,
    });
    near++;
  }
  return marks;
}

/** Vehicles with marks in their frame but no hit (near misses only), in first-impact order. */
export function nearMissVehicles(d: DebriefState): number[] {
  const hit = new Set(d.hits.map((h) => h.vehicleId));
  const out: number[] = [];
  for (const imp of d.impacts) {
    if (imp.ref > 0 && !hit.has(imp.ref) && !out.includes(imp.ref)) out.push(imp.ref);
  }
  return out;
}

// ---- summaries ------------------------------------------------------------------------------

/** One vehicle's hits, with strikes counted once per round or store. */
export interface VehicleHits {
  vehicleId: number;
  kind: string;
  hits: HitRecord[];
  /** Rounds and stores that struck it (distinct sources of the direct records). */
  rounds: number;
  stores: number;
  /** Blast and fragment hits of bursts nearby. */
  indirect: number;
  /** Condition after the last hit. */
  condition: string;
}

/** Hits grouped by vehicle, in the order each vehicle was first hit. */
export function hitsByVehicle(hits: readonly HitRecord[]): VehicleHits[] {
  const groups = new Map<number, VehicleHits & { seen: Set<string> }>();
  for (const h of hits) {
    let g = groups.get(h.vehicleId);
    if (!g) {
      g = {
        vehicleId: h.vehicleId,
        kind: h.vehicleKind,
        hits: [],
        rounds: 0,
        stores: 0,
        indirect: 0,
        condition: h.condition,
        seen: new Set(),
      };
      groups.set(h.vehicleId, g);
    }
    g.hits.push(h);
    g.condition = h.condition;
    if (isIndirect(h.outcome)) {
      g.indirect++;
      continue;
    }
    const round = isRoundWeapon(h.weapon);
    const key = `${round ? 'r' : 's'}${h.sourceId}`;
    if (g.seen.has(key)) continue;
    g.seen.add(key);
    if (round) g.rounds++;
    else g.stores++;
  }
  return [...groups.values()].map(({ seen: _seen, ...g }) => g);
}

/** "7 rounds · 2 fragment hits" — how a vehicle's hits are counted on screen. */
export function strikeSummary(g: Pick<VehicleHits, 'rounds' | 'stores' | 'indirect'>): string {
  const parts: string[] = [];
  if (g.rounds > 0) parts.push(`${g.rounds} ${g.rounds === 1 ? 'round' : 'rounds'}`);
  if (g.stores > 0) parts.push(`${g.stores} direct ${g.stores === 1 ? 'hit' : 'hits'}`);
  if (g.indirect > 0)
    parts.push(`${g.indirect} blast or fragment ${g.indirect === 1 ? 'hit' : 'hits'}`);
  return parts.join(' · ') || 'no hit';
}

export interface DebriefSummary {
  roundsLoaded: number;
  roundsFired: number;
  /** Rounds that struck a vehicle (each round once; burst records). */
  gunHits: number;
  bursts: number;
  vehiclesHit: number;
  kills: number;
  vehiclesTotal: number;
  weaponsReleased: number;
  passes: number;
}

/** What the summary reads of the gun (GunState fits). */
export interface GunCounts {
  roundsLoaded: number;
  totalFired: number;
  rounds: number;
  /** The open burst, if any: its hits so far (weapons counts each round once). */
  burstStart?: number;
  burstHits?: number;
}

/** @deprecated kept for old callers: a hit made by a 30 mm round. */
export function isGunHit(h: HitRecord): boolean {
  return isRoundWeapon(h.weapon);
}

/** Rounds that struck a vehicle: Σ BurstRecord.hits, plus the open burst's so far. */
export function roundsThatHit(bursts: readonly BurstRecord[], gun?: GunCounts): number {
  let n = 0;
  for (const b of bursts) n += b.hits;
  if (gun && (gun.burstStart ?? -1) >= 0) n += gun.burstHits ?? 0;
  return n;
}

export function summarize(
  debrief: DebriefState,
  gun: GunCounts,
  vehiclesTotal: number,
): DebriefSummary {
  const fired = Math.max(gun.totalFired, gun.roundsLoaded - gun.rounds, 0);
  const burstRounds = debrief.bursts.reduce((s, b) => s + b.rounds, 0);
  return {
    roundsLoaded: gun.roundsLoaded,
    roundsFired: Math.max(fired, burstRounds),
    gunHits: roundsThatHit(debrief.bursts, gun),
    bursts: debrief.bursts.length,
    vehiclesHit: new Set(debrief.hits.map((h) => h.vehicleId)).size,
    kills: debrief.kills.length,
    vehiclesTotal,
    weaponsReleased: debrief.weapons.filter((w) => !w.simulated && w.delivery !== 'JETTISON')
      .length,
    passes: debrief.passes?.length ?? 0,
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
  const step = r <= 8 ? 2 : r <= 20 ? 5 : r <= 60 ? 10 : r <= 150 ? 25 : r <= 400 ? 50 : 100;
  return { radius: Math.ceil(r / step) * step, step };
}
