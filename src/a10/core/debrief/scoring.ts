/**
 * Range scores (PLAN_A10.md §11), derived from the records and the passes:
 *
 *  - Strafe pit, per pass and panel: rounds fired (the pass's bursts), rounds through each panel
 *    (distinct rounds: a round that passes through counts once however many records it left),
 *    open- and cease-fire slant ranges (burst records), and the fouls of data/range.ts: a round
 *    fired inside the foul line, or the aircraft below the minimum altitude between the first
 *    round and the pull-off. A fouled pass scores no hits.
 *  - Bombing circle, per store that landed: the miss from the bull's-eye on the ground and its
 *    clock direction from the run-in heading at release (12 = long); the session's mean and
 *    median (CEP) miss.
 *  - Tactical lane: kills by weapon and the time from the first shot of the pass to each kill.
 *
 * Recomputed only when a record changed (stepDebrief); `computeScores` is pure, so the screen
 * can also ask for a fresh copy.
 */
import { RANGE_RULES } from '../../data/range';
import type { GunState } from '../weapons/types';
import type { Sim } from '../types';
import { mean, median, missClock } from './geometry';
import { emptyLayout } from './layout';
import { isIndirect, isRoundWeapon } from './recorder';
import type {
  BombScore,
  BombScores,
  BurstRecord,
  DebriefState,
  LaneKill,
  LaneScores,
  LaneWeapon,
  PassRecord,
  RangeEvent,
  RangeLayout,
  RangeScores,
  StrafePassScore,
  StrafeScores,
} from './types';

export function createRangeScores(event: RangeEvent = 'none'): RangeScores {
  return { event, strafe: null, bombs: null, lane: null };
}

/** The record of burst number `b` (null while it is still open). */
export function burstRecord(d: DebriefState, b: number): BurstRecord | null {
  for (let i = d.bursts.length - 1; i >= 0; i--) if (d.bursts[i].burst === b) return d.bursts[i];
  return null;
}

/** Rounds fired in burst `b` (the open burst's count so far). */
export function burstRounds(d: DebriefState, gun: GunState, b: number): number {
  const r = burstRecord(d, b);
  if (r) return r.rounds;
  return gun.burstNumber === b ? gun.burstRounds : 0;
}

/** Rounds of burst `b` that struck a vehicle (weapons counts each round once). */
export function burstHits(d: DebriefState, gun: GunState, b: number): number {
  const r = burstRecord(d, b);
  if (r) return r.hits;
  return gun.burstNumber === b && gun.burstStart >= 0 ? gun.burstHits : 0;
}

/** Rounds fired in a pass and rounds of it that struck a vehicle. */
export function passRounds(
  d: DebriefState,
  gun: GunState,
  p: PassRecord,
): { rounds: number; hits: number } {
  let rounds = 0;
  let hits = 0;
  for (const b of p.bursts) {
    rounds += burstRounds(d, gun, b);
    hits += burstHits(d, gun, b);
  }
  return { rounds, hits };
}

/**
 * Distinct rounds (or stores) of a pass that struck vehicle `vehicleId` directly. Blast and
 * fragment hits of a burst nearby are not strikes; a round that left two records (a ricochet,
 * a spaced layer, an HEI burst on the plate) counts once.
 */
export function directStrikes(d: DebriefState, p: PassRecord, vehicleId: number): number {
  const seen = new Set<string>();
  for (const i of p.hits) {
    const h = d.hits[i];
    if (h.vehicleId !== vehicleId || isIndirect(h.outcome)) continue;
    seen.add(`${isRoundWeapon(h.weapon) ? 'r' : 's'}${h.sourceId}`);
  }
  return seen.size;
}

function strafeScores(d: DebriefState, gun: GunState, layout: RangeLayout): StrafeScores {
  const out: StrafeScores = {
    passes: [],
    rounds: 0,
    hits: 0,
    scored: 0,
    fouls: 0,
    foulLine: RANGE_RULES.strafeFoulLine,
    minAltitude: RANGE_RULES.strafeMinAltitude,
  };
  d.passes.forEach((p, index) => {
    if (p.bursts.length === 0) return;
    const panelHits = layout.panels.map((id) => directStrikes(d, p, id));
    let panelIndex = layout.panels.indexOf(p.targetId);
    if (panelIndex < 0 || panelHits[panelIndex] === 0) {
      // the panel most rounds went through, if the aim point named none (or another)
      let best = 0;
      panelHits.forEach((n, i) => {
        if (n > best) {
          best = n;
          panelIndex = i;
        }
      });
    }
    const first = burstRecord(d, p.bursts[0]);
    const last = burstRecord(d, p.bursts[p.bursts.length - 1]);
    const open =
      first?.openFireRange ?? (gun.burstNumber === p.bursts[0] ? gun.openFireRange : NaN);
    const foulLine = p.closestFiring < RANGE_RULES.strafeFoulLine;
    const minAltitude = p.minAgl < RANGE_RULES.strafeMinAltitude;
    const hits = panelIndex >= 0 ? panelHits[panelIndex] : 0;
    const fouled = foulLine || minAltitude;
    const s: StrafePassScore = {
      pass: index,
      panel: panelIndex >= 0 ? layout.panels[panelIndex] : -1,
      rounds: passRounds(d, gun, p).rounds,
      hits,
      panelHits,
      scored: fouled && RANGE_RULES.foulVoidsPass ? 0 : hits,
      openFireRange: open > 0 ? open : NaN,
      ceaseFireRange: last && last.ceaseFireRange > 0 ? last.ceaseFireRange : NaN,
      closestFiring: p.closestFiring,
      minAgl: p.minAgl,
      foulLine,
      minAltitude,
    };
    out.passes.push(s);
    out.rounds += s.rounds;
    out.hits += s.hits;
    out.scored += s.scored;
    if (fouled) out.fouls++;
  });
  return out;
}

function bombScores(d: DebriefState, layout: RangeLayout): BombScores {
  const scores: BombScore[] = [];
  d.weapons.forEach((w, j) => {
    if (w.simulated || w.delivery === 'JETTISON') return;
    const link = d.weaponLinks[j];
    let x = w.impact?.x;
    let z = w.impact?.z;
    let time = w.impactTime;
    if (link && link.impact >= 0) {
      const imp = d.impacts[link.impact];
      x = imp.x;
      z = imp.z;
      time = imp.t;
    }
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(time)) return;
    const dx = x - layout.x;
    const dz = z - layout.z;
    const runIn = link ? link.runIn : layout.runIn;
    scores.push({
      record: j,
      pass: link ? link.pass : -1,
      store: w.store || w.weapon,
      time,
      miss: Math.hypot(dx, dz),
      clock: missClock(dx, dz, runIn),
      runIn,
      dud: w.dud,
      fragmentWarning: w.fragmentWarning,
    });
  });
  const misses = scores.map((s) => s.miss);
  return {
    centreX: layout.x,
    centreZ: layout.z,
    scores,
    mean: mean(misses),
    cep: median(misses),
    best: misses.length ? Math.min(...misses) : NaN,
  };
}

/** How the lane names a weapon: 'GUN' for every 30 mm round, else the store's own name. */
export function weaponFamily(weapon: string): string {
  return isRoundWeapon(weapon) ? 'GUN' : weapon;
}

function laneScores(d: DebriefState, gun: GunState, layout: RangeLayout): LaneScores {
  const byWeapon = new Map<string, LaneWeapon>();
  const entry = (weapon: string): LaneWeapon => {
    let e = byWeapon.get(weapon);
    if (!e) {
      e = { weapon, released: 0, hits: 0, kills: 0 };
      byWeapon.set(weapon, e);
    }
    return e;
  };
  if (gun.totalFired > 0) entry('GUN').released = gun.totalFired;
  for (const w of d.weapons) {
    if (w.simulated || w.delivery === 'JETTISON') continue;
    entry(w.store || w.weapon).released++;
  }
  // direct strikes: one per round or store, whatever it hit
  const struck = new Set<string>();
  d.hits.forEach((h, i) => {
    if (isIndirect(h.outcome)) return;
    const key = `${isRoundWeapon(h.weapon) ? 'r' : 's'}${h.sourceId}`;
    if (struck.has(key)) return;
    struck.add(key);
    const link = d.hitLinks[i];
    const record = link && link.record >= 0 ? d.weapons[link.record] : undefined;
    entry(record ? record.store || record.weapon : weaponFamily(h.weapon)).hits++;
  });
  const kills: LaneKill[] = [];
  d.kills.forEach((k, index) => {
    const pass = d.passes.findIndex((p) => p.kills.includes(index));
    const family = weaponFamily(k.weapon);
    entry(family).kills++;
    kills.push({
      kill: index,
      vehicleId: k.vehicleId,
      kind: k.kind,
      weapon: family,
      time: k.time,
      pass,
      timeToKill: pass >= 0 ? k.time - d.passes[pass].firstEvent : NaN,
    });
  });
  return {
    vehicles: layout.vehicles.length,
    kills,
    byWeapon: [...byWeapon.values()],
    meanTimeToKill: mean(kills.map((k) => k.timeToKill).filter((t) => Number.isFinite(t))),
  };
}

/** Fresh range scores for the flight (pure: reads the records, writes nothing). */
export function computeScores(sim: Sim): RangeScores {
  const d = sim.debrief;
  const layout = d.internal.layout ?? emptyLayout();
  const out = createRangeScores(layout.event);
  if (layout.event === 'strafePit') out.strafe = strafeScores(d, sim.gun, layout);
  else if (layout.event === 'bombCircle') out.bombs = bombScores(d, layout);
  else if (layout.event === 'tacticalLane') out.lane = laneScores(d, sim.gun, layout);
  return out;
}

/** The scores as plain numbers (DebriefState.range: the summary any screen can list). */
export function rangeNumbers(d: DebriefState, scores: RangeScores): Record<string, number> {
  const out: Record<string, number> = { passes: d.passes.length };
  if (scores.strafe) {
    out.strafeRounds = scores.strafe.rounds;
    out.strafeHits = scores.strafe.hits;
    out.strafeScored = scores.strafe.scored;
    out.strafeFouls = scores.strafe.fouls;
  }
  if (scores.bombs) {
    out.bombs = scores.bombs.scores.length;
    if (scores.bombs.scores.length > 0) {
      out.bombMeanMiss = scores.bombs.mean;
      out.bombCep = scores.bombs.cep;
    }
  }
  if (scores.lane) {
    out.laneKills = scores.lane.kills.length;
    out.laneVehicles = scores.lane.vehicles;
    if (Number.isFinite(scores.lane.meanTimeToKill))
      out.laneMeanTimeToKill = scores.lane.meanTimeToKill;
  }
  return out;
}
