/**
 * The debrief recorder (ARCHITECTURE §12.6): every step it takes in what the other systems
 * appended (bursts, releases, hits, kills, impact events) and derives the passes, the impact
 * log and the links of each hit and release to its pass and impact.
 *
 * A PASS runs from the roll-in to the pull-off (data/range.ts PASS_RULES):
 *  - it opens at a weapon event (a gun burst's first round, a store release or a simulated TRAIN
 *    release; jettison does not count) when none is open; its start is the roll-in: the moment
 *    the flight path last steepened past `rollInDive` (at most `maxRollIn` before the event), or
 *    the event itself for a level delivery;
 *  - it closes at the pull-off: no burst open and no release queued, at least `pullOffMinTime`
 *    after the last weapon event, and climbing at `pullOffClimb` or more; or `passTimeout` after
 *    the last weapon event (level deliveries); or in a crash.
 *
 * Rounds carry their burst through their ids (the first id of each burst is noted when it
 * opens); stores through their body ids (WeaponRecord.bodyId). An impact event has no round id,
 * so a hit is tied to the impact of the same step: a direct hit to the next strike on that
 * vehicle, a fragment or blast hit to the nearest HEI burst (or the store's detonation).
 *
 * Work per step without events is a handful of comparisons; records are allocated only when
 * something happens. Deterministic: no randomness, only the sim's own state and events.
 */
import { DEBRIEF_LIMITS, PASS_RULES } from '../../data/range';
import { findVehicle } from '../targets';
import type { Vehicle } from '../targets/types';
import type { Sim, SimEvent } from '../types';
import { shortOfLine } from './geometry';
import { findRangeLayout } from './layout';
import type {
  DebriefInternal,
  HitLink,
  ImpactKind,
  ImpactRecord,
  PassEnd,
  PassRecord,
  WeaponLink,
  WeaponRecord,
} from './types';

/** Round type names as the hit log writes them (RoundType 0, 1, 2). */
export const ROUND_NAMES: readonly string[] = ['API', 'HEI', 'TP'];

/** A hit or kill made by a 30 mm round (the targets module names them by round type). */
export function isRoundWeapon(weapon: string): boolean {
  return weapon === 'API' || weapon === 'HEI' || weapon === 'TP';
}

/** A hit made by the blast or fragments of a burst nearby, not by the round or store itself. */
export function isIndirect(outcome: string): boolean {
  return outcome === 'fragment' || outcome === 'blast';
}

export function createDebriefInternal(): DebriefInternal {
  return {
    eventIndex: 0,
    lastEvent: null,
    hitCount: 0,
    weaponCount: 0,
    killCount: 0,
    burstCount: 0,
    lastBurst: 0,
    totalFired: 0,
    burstFirstId: [],
    burstPass: [],
    burstHits: 0,
    open: -1,
    lastLevelTime: 0,
    pending: [],
    layout: null,
    dirty: true,
  };
}

/** Indices of the impacts already tied to a direct hit in this step (scratch, reused). */
const _used: number[] = [];

/** Take in one step's records and events (stepDebrief, after every other system). */
export function recordStep(sim: Sim, dt: number): void {
  const d = sim.debrief;
  const st = d.internal;
  const tEnd = sim.time + dt;
  if (!st.layout) st.layout = findRangeLayout(sim);
  if (sim.aircraft.flightPathAngle > -PASS_RULES.rollInDive) st.lastLevelTime = tEnd;

  takeBursts(sim);
  takeWeapons(sim);
  const impactStart = d.impacts.length;
  scanEvents(sim);
  takeHits(sim, impactStart);
  takeKills(sim);
  takePending(sim);
  if (d.bursts.length !== st.burstCount) {
    st.burstCount = d.bursts.length;
    st.dirty = true;
  }
  trackOpenPass(sim, tEnd);
}

// ---- passes -----------------------------------------------------------------------------------

/** Ground track of the aircraft (its heading when nearly still), rad. */
function trackOf(sim: Sim): number {
  const ac = sim.aircraft;
  return ac.groundSpeed > 1 ? ac.track : ac.heading;
}

function openPass(sim: Sim, t: number): number {
  const d = sim.debrief;
  const st = d.internal;
  const ac = sim.aircraft;
  const diving = ac.flightPathAngle <= -PASS_RULES.rollInDive;
  const start = diving ? Math.max(st.lastLevelTime, t - PASS_RULES.maxRollIn) : t;
  const pass: PassRecord = {
    number: d.passes.length + 1,
    start: Math.min(start, t),
    firstEvent: t,
    lastEvent: t,
    end: NaN,
    endReason: '',
    runIn: trackOf(sim),
    aim: { x: NaN, y: NaN, z: NaN },
    aimValid: false,
    targetId: -1,
    targetX: NaN,
    targetZ: NaN,
    targetHeading: NaN,
    bursts: [],
    weapons: [],
    hits: [],
    kills: [],
    impacts: [],
    minAgl: ac.agl,
    maxG: ac.gLoad,
    closestFiring: NaN,
  };
  d.passes.push(pass);
  st.open = d.passes.length - 1;
  st.dirty = true;
  return st.open;
}

/** A weapon event at time t: the open pass, or a new one. Returns the pass index. */
function weaponEvent(sim: Sim, t: number): number {
  const st = sim.debrief.internal;
  if (st.open < 0) return openPass(sim, t);
  const p = sim.debrief.passes[st.open];
  if (t > p.lastEvent) p.lastEvent = t;
  return st.open;
}

/** The vehicle nearest a point within `radius` (only panels when `panels` is given), or null. */
function nearestVehicle(
  sim: Sim,
  x: number,
  z: number,
  radius: number,
  panels?: readonly number[],
): Vehicle | null {
  let best: Vehicle | null = null;
  let bestD = radius * radius;
  const list = sim.targets.vehicles;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (panels && !panels.includes(v.id)) continue;
    const dx = v.position.x - x;
    const dz = v.position.z - z;
    const dd = dx * dx + dz * dz;
    if (dd <= bestD) {
      bestD = dd;
      best = v;
    }
  }
  return best;
}

/** Give a pass its aim point and target (once; a later event fills what the first lacked). */
function aimPass(sim: Sim, p: PassRecord, aim: { x: number; y: number; z: number } | null, lock: number): void {
  if (!p.aimValid && aim && Number.isFinite(aim.x) && Number.isFinite(aim.z)) {
    p.aim.x = aim.x;
    p.aim.y = aim.y;
    p.aim.z = aim.z;
    p.aimValid = true;
  }
  if (p.targetId >= 0) return;
  const layout = sim.debrief.internal.layout;
  let v: Vehicle | null = null;
  if (layout?.event === 'bombCircle' && layout.centreId >= 0) v = findVehicle(sim, layout.centreId);
  if (!v && lock >= 0) v = findVehicle(sim, lock);
  if (!v && p.aimValid) {
    const panels = layout?.event === 'strafePit' && layout.panels.length ? layout.panels : undefined;
    v = nearestVehicle(sim, p.aim.x, p.aim.z, DEBRIEF_LIMITS.targetRadius, panels);
    if (!v && panels) v = nearestVehicle(sim, p.aim.x, p.aim.z, DEBRIEF_LIMITS.targetRadius);
  }
  if (!v) return;
  p.targetId = v.id;
  p.targetX = v.position.x;
  p.targetZ = v.position.z;
  p.targetHeading = v.heading;
}

/**
 * New gun bursts open (or join) a pass; rounds leaving advance it and feed the foul check. Round
 * ids count up by one per round, so the newest burst's first id is the pool's next id less the
 * rounds it has fired so far.
 */
function takeBursts(sim: Sim): void {
  const d = sim.debrief;
  const st = d.internal;
  const gun = sim.gun;
  if (gun.burstNumber > st.lastBurst) {
    const sol = sim.avionics.gun;
    const firstId = sim.projectiles.rounds.nextId - gun.burstRounds;
    for (let b = st.lastBurst + 1; b <= gun.burstNumber; b++) {
      st.burstFirstId[b] = firstId;
      const t = gun.burstConditions.time;
      const p = weaponEvent(sim, Number.isFinite(t) ? t : sim.time);
      st.burstPass[b] = p;
      const pass = d.passes[p];
      pass.bursts.push(b);
      aimPass(sim, pass, sol.valid ? sol.impact : null, -1);
    }
    st.lastBurst = gun.burstNumber;
  }
  if (gun.totalFired > st.totalFired) {
    const p = st.burstPass[gun.burstNumber] ?? -1;
    if (p >= 0) {
      const pass = d.passes[p];
      if (gun.lastRoundTime > pass.lastEvent) pass.lastEvent = gun.lastRoundTime;
      foulLineCheck(sim, pass);
    }
  }
  st.totalFired = gun.totalFired;
}

/** Strafe pit: how far short of the panel line the aircraft is while a round leaves. */
function foulLineCheck(sim: Sim, pass: PassRecord): void {
  const layout = sim.debrief.internal.layout;
  if (!layout || layout.event !== 'strafePit' || layout.panels.length === 0) return;
  const p = sim.aircraft.position;
  const short = shortOfLine(p.x, p.z, layout.x, layout.z, layout.runIn);
  if (!(short >= pass.closestFiring)) pass.closestFiring = short;
}

/** The vehicle a guided store's seeker had at the release (-1 none). */
function guidedTarget(sim: Sim, w: WeaponRecord): number {
  if (w.bodyId <= 0) return -1;
  const bodies = sim.projectiles.bodies;
  for (let i = bodies.length - 1; i >= 0; i--) {
    const b = bodies[i];
    if (b.id !== w.bodyId) continue;
    return b.guidance && b.guidance.valid ? b.guidance.vehicleId : -1;
  }
  return -1;
}

/** New releases (weapons, avionics TRAIN): their pass, run-in and target. */
function takeWeapons(sim: Sim): void {
  const d = sim.debrief;
  const st = d.internal;
  for (let j = st.weaponCount; j < d.weapons.length; j++) {
    const w = d.weapons[j];
    const link: WeaponLink = { pass: -1, runIn: trackOf(sim), impact: -1, target: -1 };
    d.weaponLinks.push(link);
    if (w.delivery !== 'JETTISON') {
      const t = Number.isFinite(w.release.time) ? w.release.time : sim.time;
      const p = weaponEvent(sim, t);
      link.pass = p;
      const pass = d.passes[p];
      pass.weapons.push(j);
      const lock = guidedTarget(sim, w);
      aimPass(sim, pass, w.aimValid ? w.aim : null, lock);
      if (lock >= 0) link.target = lock;
      else if (w.aimValid) {
        const v = nearestVehicle(sim, w.aim.x, w.aim.z, DEBRIEF_LIMITS.targetRadius);
        link.target = v ? v.id : -1;
      }
    }
    if (!w.simulated) st.pending.push(j);
    st.dirty = true;
  }
  st.weaponCount = d.weapons.length;
}

/** Close the open pass at the pull-off; follow its lowest height and highest load until then. */
function trackOpenPass(sim: Sim, tEnd: number): void {
  const d = sim.debrief;
  const st = d.internal;
  if (st.open < 0) return;
  const p = d.passes[st.open];
  const ac = sim.aircraft;
  if (ac.agl < p.minAgl) p.minAgl = ac.agl;
  if (ac.gLoad > p.maxG) p.maxG = ac.gLoad;
  const since = tEnd - p.lastEvent;
  let reason: PassEnd = '';
  if (ac.crashed) reason = 'crash';
  else if (sim.gun.burstStart < 0 && sim.stores.releaseQueue.length === 0) {
    if (since >= PASS_RULES.pullOffMinTime && ac.flightPathAngle >= PASS_RULES.pullOffClimb)
      reason = 'pullOff';
    else if (since >= PASS_RULES.passTimeout) reason = 'timeout';
  }
  if (!reason) return;
  p.end = tEnd;
  p.endReason = reason;
  st.open = -1;
  st.dirty = true;
}

// ---- impacts ----------------------------------------------------------------------------------

/** The pass a round landing at time t belongs to: the latest gun pass still within the window. */
function roundPass(sim: Sim, t: number): number {
  const passes = sim.debrief.passes;
  for (let i = passes.length - 1; i >= 0; i--) {
    const p = passes[i];
    if (p.bursts.length === 0) continue;
    if (t >= p.firstEvent - 1e-6 && t <= p.lastEvent + PASS_RULES.roundWindow) return i;
    if (t > p.lastEvent + PASS_RULES.roundWindow) return -1;
  }
  return -1;
}

/** Tie an impact to a vehicle frame: the vehicle struck, else the pass target, else the nearest. */
function setReference(sim: Sim, rec: ImpactRecord, targetId: number, targetRange: number): void {
  let v: Vehicle | null = rec.vehicleId > 0 ? findVehicle(sim, rec.vehicleId) : null;
  if (!v && targetId > 0) {
    const t = findVehicle(sim, targetId);
    if (t && Math.hypot(t.position.x - rec.x, t.position.z - rec.z) <= targetRange) v = t;
  }
  if (!v) v = nearestVehicle(sim, rec.x, rec.z, DEBRIEF_LIMITS.nearMissRadius);
  if (!v) return;
  rec.ref = v.id;
  rec.dx = rec.x - v.position.x;
  rec.dz = rec.z - v.position.z;
  rec.refHeading = v.heading;
}

function pushImpact(sim: Sim, rec: ImpactRecord): number {
  const d = sim.debrief;
  if (d.impacts.length >= DEBRIEF_LIMITS.maxImpacts) return -1;
  d.impacts.push(rec);
  const index = d.impacts.length - 1;
  if (rec.pass >= 0) d.passes[rec.pass].impacts.push(index);
  return index;
}

/** The newest record of the store body `bodyId` (-1 none). */
export function recordOfBody(sim: Sim, bodyId: number): number {
  if (!(bodyId > 0)) return -1;
  const w = sim.debrief.weapons;
  for (let j = w.length - 1; j >= 0; j--) if (w[j].bodyId === bodyId && !w[j].simulated) return j;
  return -1;
}

function addRoundImpact(sim: Sim, e: Extract<SimEvent, { type: 'roundImpact' }>): void {
  const pass = roundPass(sim, e.t);
  const rec: ImpactRecord = {
    t: e.t,
    kind: 'round',
    weapon: ROUND_NAMES[e.round] ?? 'API',
    x: e.position.x,
    y: e.position.y,
    z: e.position.z,
    vehicleId: e.target.kind === 'vehicle' ? e.target.vehicleId : -1,
    outcome: e.outcome,
    pass,
    record: -1,
    ref: -1,
    dx: NaN,
    dz: NaN,
    refHeading: NaN,
  };
  const target = pass >= 0 ? sim.debrief.passes[pass].targetId : -1;
  setReference(sim, rec, target, DEBRIEF_LIMITS.targetFrameRadius);
  pushImpact(sim, rec);
}

const STORE_KINDS: readonly string[] = ['bomb', 'rocket', 'missile', 'whitePhosphorus', 'dud'];

function addStoreImpact(sim: Sim, e: Extract<SimEvent, { type: 'detonation' }>): void {
  const d = sim.debrief;
  const j = recordOfBody(sim, e.bodyId ?? 0);
  const link = j >= 0 ? d.weaponLinks[j] : undefined;
  if (link && link.impact >= 0) return;
  const pass = link ? link.pass : -1;
  const w = j >= 0 ? d.weapons[j] : undefined;
  const rec: ImpactRecord = {
    t: e.t,
    kind: e.kind as ImpactKind,
    weapon: w ? w.store || w.weapon : '',
    x: e.position.x,
    y: e.position.y,
    z: e.position.z,
    vehicleId: e.vehicleId > 0 ? e.vehicleId : -1,
    outcome: e.kind,
    pass,
    record: j,
    ref: -1,
    dx: NaN,
    dz: NaN,
    refHeading: NaN,
  };
  const target = pass >= 0 ? d.passes[pass].targetId : (link?.target ?? -1);
  setReference(sim, rec, target, DEBRIEF_LIMITS.targetFrameRadius);
  const index = pushImpact(sim, rec);
  if (link) link.impact = index;
  d.internal.dirty = true;
}

/** Impact events since the last step (drain-safe scan of sim.events). */
function scanEvents(sim: Sim): void {
  const st = sim.debrief.internal;
  const ev = sim.events;
  let start = st.eventIndex;
  if (start > ev.length || (start > 0 && ev[start - 1] !== st.lastEvent)) start = 0;
  for (let i = start; i < ev.length; i++) {
    const e = ev[i];
    if (e.type === 'roundImpact') addRoundImpact(sim, e);
    else if (e.type === 'detonation' && (e.bodyId ?? 0) > 0 && STORE_KINDS.includes(e.kind))
      addStoreImpact(sim, e);
  }
  st.eventIndex = ev.length;
  st.lastEvent = ev.length > 0 ? ev[ev.length - 1] : null;
}

/** Stores that landed without a detonation event seen (a lost event): log their impact point. */
function takePending(sim: Sim): void {
  const d = sim.debrief;
  const st = d.internal;
  if (st.pending.length === 0) return;
  for (let k = st.pending.length - 1; k >= 0; k--) {
    const j = st.pending[k];
    const w = d.weapons[j];
    const link = d.weaponLinks[j];
    if (link.impact < 0 && !Number.isFinite(w.impactTime)) continue;
    if (link.impact < 0 && Number.isFinite(w.impact?.x)) {
      const rec: ImpactRecord = {
        t: w.impactTime,
        kind: w.dud ? 'dud' : storeImpactKind(w),
        weapon: w.store || w.weapon,
        x: w.impact.x,
        y: w.impact.y,
        z: w.impact.z,
        vehicleId: -1,
        outcome: w.dud ? 'dud' : storeImpactKind(w),
        pass: link.pass,
        record: j,
        ref: -1,
        dx: NaN,
        dz: NaN,
        refHeading: NaN,
      };
      const target = link.pass >= 0 ? d.passes[link.pass].targetId : link.target;
      setReference(sim, rec, target, DEBRIEF_LIMITS.targetFrameRadius);
      link.impact = pushImpact(sim, rec);
    }
    st.pending.splice(k, 1);
    st.dirty = true;
  }
}

function storeImpactKind(w: WeaponRecord): ImpactKind {
  if (w.delivery === 'ROCKET') return 'rocket';
  if (w.delivery === 'MAV') return 'missile';
  return 'bomb';
}

// ---- hits and kills ---------------------------------------------------------------------------

/** The burst a round id belongs to (0 before the first burst of the record). */
export function burstOfRound(burstFirstId: readonly number[], id: number): number {
  let lo = 1;
  let hi = burstFirstId.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const first = burstFirstId[mid];
    if (first === undefined || first > id) hi = mid - 1;
    else {
      found = mid;
      lo = mid + 1;
    }
  }
  return found;
}

/** This step's strike on `vehicleId` not yet tied to a hit (the n-th hit ↔ the n-th strike). */
function directImpact(sim: Sim, from: number, vehicleId: number): number {
  const imps = sim.debrief.impacts;
  for (let k = from; k < imps.length; k++) {
    if (imps[k].vehicleId === vehicleId && imps[k].kind === 'round' && !_used.includes(k)) {
      _used.push(k);
      return k;
    }
  }
  // not in this step (should not happen): the latest strike on that vehicle
  for (let k = from - 1; k >= 0 && k >= from - 256; k--)
    if (imps[k].vehicleId === vehicleId && imps[k].kind === 'round') return k;
  return -1;
}

/** The HEI burst of this step nearest the vehicle (fragments and blast of a round). */
function burstImpact(sim: Sim, from: number, v: Vehicle | null, time: number): number {
  const imps = sim.debrief.impacts;
  let best = -1;
  let bestD = Infinity;
  const lo = Math.max(0, from - 64);
  for (let k = imps.length - 1; k >= lo; k--) {
    const imp = imps[k];
    if (imp.kind !== 'round' || imp.weapon !== 'HEI') continue;
    if (k < from && Math.abs(imp.t - time) > 0.05) continue;
    const dd = v ? (imp.x - v.position.x) ** 2 + (imp.z - v.position.z) ** 2 : 0;
    if (dd < bestD) {
      bestD = dd;
      best = k;
    }
  }
  return best;
}

/** Tie every new hit to its pass and impact, with the impact's offset from the hit vehicle. */
function takeHits(sim: Sim, impactStart: number): void {
  const d = sim.debrief;
  const st = d.internal;
  if (st.hitCount === d.hits.length) return;
  _used.length = 0;
  for (let i = st.hitCount; i < d.hits.length; i++) {
    const h = d.hits[i];
    const link: HitLink = {
      pass: -1,
      impact: -1,
      dx: NaN,
      dz: NaN,
      heading: NaN,
      direct: !isIndirect(h.outcome),
      burst: 0,
      record: -1,
    };
    const v = findVehicle(sim, h.vehicleId);
    if (isRoundWeapon(h.weapon)) {
      link.burst = burstOfRound(st.burstFirstId, h.sourceId);
      link.pass = link.burst > 0 ? (st.burstPass[link.burst] ?? -1) : -1;
      link.impact = link.direct
        ? directImpact(sim, impactStart, h.vehicleId)
        : burstImpact(sim, impactStart, v, h.time);
    } else {
      const j = recordOfBody(sim, h.sourceId);
      link.record = j;
      link.pass = j >= 0 ? d.weaponLinks[j].pass : st.open;
      link.impact = j >= 0 ? d.weaponLinks[j].impact : -1;
    }
    if (link.impact >= 0 && v) {
      const imp = d.impacts[link.impact];
      link.dx = imp.x - v.position.x;
      link.dz = imp.z - v.position.z;
      link.heading = v.heading;
    }
    d.hitLinks.push(link);
    if (link.pass >= 0) {
      const pass = d.passes[link.pass];
      pass.hits.push(i);
      // no aim point named a target: the first vehicle struck is the one attacked
      if (pass.targetId < 0 && link.direct && v) {
        pass.targetId = v.id;
        pass.targetX = v.position.x;
        pass.targetZ = v.position.z;
        pass.targetHeading = v.heading;
      }
    }
  }
  st.hitCount = d.hits.length;
  st.dirty = true;
}

/** New kills go to the pass whose weapon last struck the vehicle. */
function takeKills(sim: Sim): void {
  const d = sim.debrief;
  const st = d.internal;
  for (let k = st.killCount; k < d.kills.length; k++) {
    const kill = d.kills[k];
    let pass = -1;
    for (let i = Math.min(d.hits.length, d.hitLinks.length) - 1; i >= 0; i--) {
      if (d.hits[i].vehicleId !== kill.vehicleId || d.hits[i].time > kill.time) continue;
      pass = d.hitLinks[i].pass;
      break;
    }
    if (pass < 0) pass = st.open;
    if (pass >= 0) d.passes[pass].kills.push(k);
    st.dirty = true;
  }
  st.killCount = d.kills.length;
}
