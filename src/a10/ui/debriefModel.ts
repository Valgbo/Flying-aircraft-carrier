/**
 * The debrief screen's model (PLAN_A10.md §11.4): everything the screen shows, built from the
 * flight's record (sim.debrief, kept by core/debrief) as plain data. Pure functions, covered by
 * tests/unit/a10/ui-debrief-model.test.ts; DebriefScreen only lays it out.
 *
 * Per pass (roll-in to pull-off): what was fired or dropped and how (release conditions: dive,
 * speed, slant range, height above the ground, g), an overhead plot of every impact against the
 * target — drawn with the run-in UP, so long is up and short is down as a pilot reads a score —
 * with the target's outline, its heading and the aim point, then what each hit did and the
 * kills. The range events add their score tables.
 */
import {
  burstRecord,
  burstRounds,
  isIndirect,
  passRounds,
  toHeadingFrame,
  type FramePoint,
} from '../core/debrief';
import type {
  BombScore,
  DebriefState,
  HitRecord,
  ImpactRecord,
  LaneScores,
  PassRecord,
  RangeEvent,
  StrafePassScore,
  StrafeScores,
  WeaponRecord,
} from '../core/debrief/types';
import type { Vehicle } from '../core/targets/types';
import type { GunState } from '../core/weapons/types';
import { RANGE_RULES } from '../data/range';
import {
  classifyImpact,
  hitsByVehicle,
  strikeSummary,
  vehicleName,
  type ImpactClass,
  type VehicleHits,
} from './debriefData';
import { formatClockDirection, formatFeetFromM, formatInt, formatMiss, formatPct } from './format';
import { storeLabel } from './loadout';

/** What the model needs of the flight (a Sim fits). */
export interface DebriefSource {
  time: number;
  debrief: DebriefState;
  gun: GunState;
  targets: { vehicles: readonly Vehicle[] };
}

// ---- passes -----------------------------------------------------------------------------------

/** One weapon event of a pass: a burst or a release, with its conditions. */
export interface PassEventRow {
  kind: 'burst' | 'release';
  /** 'Burst 2', 'Mk-82 · STA 5'. */
  label: string;
  delivery: string;
  time: number;
  /** Dive angle (+ down), rad; speed m/s; slant range m (NaN unknown); height m; load g. */
  dive: number;
  speed: number;
  slantRange: number;
  agl: number;
  g: number;
  /** '84 rounds in 1.4 s, 12 struck' · 'Miss 12 m at 3 o'clock' · 'Simulated (TRAIN)' · 'Dud'. */
  detail: string;
}

/** A mark on a pass plot, in the run-in frame (x right, y long), m. */
export interface PassMark extends FramePoint {
  /** Rounds by what they did; stores by what they are. */
  cls: ImpactClass | 'bomb' | 'rocket' | 'missile' | 'smoke' | 'dud' | 'simulated';
  /** Store marks: their release number in the pass (1, 2 …); '' for rounds. */
  label: string;
  t: number;
}

export interface PassPlotModel {
  /** Half the plot's side and the grid step, m. */
  radius: number;
  step: number;
  /** The target's class and its heading relative to the run-in (0 = pointing up), rad. */
  target: { kind: string; name: string; rotation: number } | null;
  /** Where the pilot aimed, relative to the target (null unknown). */
  aim: FramePoint | null;
  marks: PassMark[];
  /** Impacts that fell outside the plot. */
  outside: number;
  /** Bombing circle: score rings, m. */
  rings: number[];
}

export interface HitRow {
  time: number;
  weapon: string;
  /** 'Top hull', 'Side tracks'. */
  plate: string;
  obliquity: number;
  speed: number;
  effectiveThicknessMm: number;
  penetrationMm: number;
  outcome: string;
  /** Blast or fragments of a burst nearby. */
  indirect: boolean;
  damaged: string[];
}

export interface PassVehicle {
  vehicleId: number;
  kind: string;
  name: string;
  /** Condition after the pass's last hit on it. */
  condition: string;
  /** '7 rounds · 2 blast or fragment hits'. */
  strikes: string;
  rows: HitRow[];
}

export interface KillRow {
  time: number;
  name: string;
  weapon: string;
  catastrophic: boolean;
}

export interface PassView {
  index: number;
  number: number;
  start: number;
  end: number;
  open: boolean;
  /** 'GAU-8 · 2 bursts · 84 rounds', 'Mk-82 × 2 · CCIP'. */
  weapons: string;
  /** 'Strafe panel 2', 'T-72 #18', 'No target'. */
  target: string;
  /** The pass in one line: '12 of 84 rounds struck' · 'T-72 #18 destroyed' · 'Bomb 19 m at 2 o'clock'. */
  result: string;
  /** Strafe pit fouls in words (empty when clean or not a strafe pass). */
  fouls: string[];
  events: PassEventRow[];
  plot: PassPlotModel;
  vehicles: PassVehicle[];
  kills: KillRow[];
  /** Lowest height above the ground and highest load over the pass, m and g. */
  minAgl: number;
  maxG: number;
}

/** Display name of a weapon string of the records ('API' → '30 mm API', 'MK-82' → 'Mk-82'). */
export function weaponName(weapon: string): string {
  if (weapon === 'API' || weapon === 'HEI' || weapon === 'TP') return `30 mm ${weapon}`;
  if (weapon === 'GUN') return 'GAU-8/A';
  return storeLabel(weapon).short;
}

/** The short form for table cells: 'API', 'HEI', 'Mk-82'. */
export function weaponShort(weapon: string): string {
  if (weapon === 'API' || weapon === 'HEI' || weapon === 'TP') return weapon;
  return weaponName(weapon);
}

function plateName(h: HitRecord): string {
  const face = h.face ? h.face[0].toUpperCase() + h.face.slice(1) : '';
  const part = h.part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return `${face} ${part}`.trim();
}

/** A hit record as a table row (display names, the outcome kept for its pill). */
export function hitRow(h: HitRecord): HitRow {
  return {
    time: h.time,
    weapon: weaponShort(h.weapon),
    plate: plateName(h),
    obliquity: h.obliquity,
    speed: h.speed,
    effectiveThicknessMm: h.effectiveThicknessMm,
    penetrationMm: h.penetrationMm,
    outcome: h.outcome,
    indirect: isIndirect(h.outcome),
    damaged: h.damaged.slice(),
  };
}

function vehicleOf(src: DebriefSource, id: number): Vehicle | undefined {
  return src.targets.vehicles.find((v) => v.id === id);
}

/** 'Strafe panel 2' for the scoring panels (numbered left to right), else 'T-72 #18'. */
export function targetName(src: DebriefSource, id: number): string {
  if (id < 0) return 'No target';
  const panels = src.debrief.internal.layout?.panels ?? [];
  const k = panels.indexOf(id);
  if (k >= 0) return `Strafe panel ${k + 1}`;
  const layout = src.debrief.internal.layout;
  if (layout?.event === 'bombCircle' && layout.centreId === id) return "Bull's-eye";
  const v = vehicleOf(src, id);
  return v ? `${vehicleName(v.kind)} #${id}` : `Vehicle #${id}`;
}

function storeKindOf(w: WeaponRecord): string {
  return storeLabel(w.store || w.weapon).short;
}

/** 'GAU-8 · 2 bursts · 84 rounds · Mk-82 × 2 (CCIP)'. */
function weaponsLine(src: DebriefSource, p: PassRecord): string {
  const parts: string[] = [];
  if (p.bursts.length > 0) {
    const { rounds } = passRounds(src.debrief, src.gun, p);
    parts.push(
      `GAU-8 · ${p.bursts.length} ${p.bursts.length === 1 ? 'burst' : 'bursts'} · ${formatInt(rounds)} rounds`,
    );
  }
  const stores = new Map<string, { n: number; delivery: string; simulated: boolean }>();
  for (const j of p.weapons) {
    const w = src.debrief.weapons[j];
    const key = `${storeKindOf(w)}|${w.delivery}|${w.simulated}`;
    const e = stores.get(key) ?? { n: 0, delivery: w.delivery, simulated: w.simulated };
    e.n++;
    stores.set(key, e);
  }
  for (const [key, e] of stores) {
    const name = key.split('|')[0];
    const how = e.delivery === 'MAV' || e.delivery === 'ROCKET' ? '' : ` (${e.delivery})`;
    parts.push(`${name}${e.n > 1 ? ` × ${e.n}` : ''}${how}${e.simulated ? ' simulated' : ''}`);
  }
  return parts.join(' · ') || '—';
}

function eventRows(src: DebriefSource, p: PassRecord, bombs: BombScore[] | null): PassEventRow[] {
  const d = src.debrief;
  const rows: PassEventRow[] = [];
  for (const b of p.bursts) {
    const r = burstRecord(d, b);
    const c = r ? r.start : src.gun.burstConditions;
    const rounds = burstRounds(d, src.gun, b);
    const struck = r ? r.hits : src.gun.burstHits;
    const length = r ? r.duration : NaN;
    rows.push({
      kind: 'burst',
      label: `Burst ${b}`,
      delivery: 'GUN',
      time: c.time,
      dive: c.dive,
      speed: c.speed,
      slantRange: c.slantRange > 0 ? c.slantRange : NaN,
      agl: c.agl,
      g: c.gLoad,
      detail: `${formatInt(rounds)} rounds${Number.isFinite(length) ? ` in ${length.toFixed(1)} s` : ''}, ${formatInt(struck)} struck`,
    });
  }
  for (const j of p.weapons) {
    const w = d.weapons[j];
    const score = bombs?.find((s) => s.record === j);
    let detail: string;
    if (w.simulated)
      detail = Number.isFinite(w.missDistance)
        ? `Simulated (TRAIN): ${formatMiss(w.missDistance)} from the aim point, ${formatClockDirection(w.missClock)}`
        : 'Simulated release (Master Arm TRAIN)';
    else if (score)
      detail = `${formatMiss(score.miss)} from the bull, ${formatClockDirection(score.clock)}`;
    else if (Number.isFinite(w.missDistance))
      detail = `${formatMiss(w.missDistance)} from the aim point, ${formatClockDirection(w.missClock)}`;
    else if (Number.isFinite(w.impactTime)) detail = 'Impact';
    else detail = 'In flight';
    if (w.dud) detail += ' · dud';
    if (w.fragmentWarning) detail += ' · inside the fragment envelope';
    rows.push({
      kind: 'release',
      label: `${storeKindOf(w)}${w.station > 0 ? ` · STA ${w.station}` : ''}`,
      delivery: w.delivery,
      time: w.release.time,
      dive: w.release.dive,
      speed: w.release.speed,
      slantRange: w.release.slantRange > 0 ? w.release.slantRange : NaN,
      agl: w.release.agl,
      g: w.release.gLoad,
      detail,
    });
  }
  rows.sort((a, b) => a.time - b.time);
  return rows;
}

const STORE_MARK: Record<string, PassMark['cls']> = {
  bomb: 'bomb',
  rocket: 'rocket',
  missile: 'missile',
  whitePhosphorus: 'smoke',
  dud: 'dud',
};

/** Rounds further than this from the target are counted, not drawn, m. */
const ROUND_PLOT_LIMIT = 250;
/** Stores further than this are counted, not drawn, m. */
const STORE_PLOT_LIMIT = 1200;

function niceStep(r: number): number {
  for (const s of [2, 5, 10, 25, 50, 100, 250]) if (r / s <= 6) return s;
  return 500;
}

/** The pass plot: impacts in the run-in frame around the target (or the aim point). */
export function passPlot(src: DebriefSource, p: PassRecord): PassPlotModel {
  const d = src.debrief;
  const layout = d.internal.layout;
  const hasTarget = p.targetId > 0 && Number.isFinite(p.targetX);
  // the plot's centre: the target at the first weapon event, else the aim point
  let cx = hasTarget ? p.targetX : p.aim.x;
  let cz = hasTarget ? p.targetZ : p.aim.z;
  if (!Number.isFinite(cx) || !Number.isFinite(cz)) {
    // neither: the mean of the impacts
    let n = 0;
    cx = 0;
    cz = 0;
    for (const k of p.impacts) {
      cx += d.impacts[k].x;
      cz += d.impacts[k].z;
      n++;
    }
    cx = n ? cx / n : 0;
    cz = n ? cz / n : 0;
  }
  const bull = layout?.event === 'bombCircle';
  if (bull && layout) {
    cx = layout.x;
    cz = layout.z;
  }
  const marks: PassMark[] = [];
  let outside = 0;
  const q: FramePoint = { x: 0, y: 0 };
  const storeNumber = new Map<number, number>();
  p.weapons.forEach((j, n) => storeNumber.set(j, n + 1));
  for (const k of p.impacts) {
    const imp: ImpactRecord = d.impacts[k];
    // offset from the target where it was when this landed (moving targets), else from the centre
    let dx: number;
    let dz: number;
    if (hasTarget && !bull && imp.ref === p.targetId && Number.isFinite(imp.dx)) {
      dx = imp.dx;
      dz = imp.dz;
    } else {
      dx = imp.x - cx;
      dz = imp.z - cz;
    }
    toHeadingFrame(dx, dz, p.runIn, q);
    const store = imp.kind !== 'round';
    const limit = store ? STORE_PLOT_LIMIT : ROUND_PLOT_LIMIT;
    if (Math.abs(q.x) > limit || Math.abs(q.y) > limit) {
      outside++;
      continue;
    }
    const cls: PassMark['cls'] = store
      ? (STORE_MARK[imp.kind] ?? 'bomb')
      : classifyImpact(imp.outcome, imp.vehicleId > 0);
    marks.push({
      x: q.x,
      y: q.y,
      cls,
      label: store ? String(storeNumber.get(imp.record) ?? '') : '',
      t: imp.t,
    });
  }
  // simulated (TRAIN) releases: where the computer predicted the store would have landed
  for (const j of p.weapons) {
    const w = d.weapons[j];
    if (!w.simulated || !Number.isFinite(w.impact.x) || !Number.isFinite(w.impact.z)) continue;
    toHeadingFrame(w.impact.x - cx, w.impact.z - cz, p.runIn, q);
    if (Math.abs(q.x) > STORE_PLOT_LIMIT || Math.abs(q.y) > STORE_PLOT_LIMIT) {
      outside++;
      continue;
    }
    marks.push({
      x: q.x,
      y: q.y,
      cls: 'simulated',
      label: String(storeNumber.get(j) ?? ''),
      t: w.impactTime,
    });
  }
  const target = hasTarget
    ? {
        kind: vehicleOf(src, p.targetId)?.kind ?? 'hulk',
        name: targetName(src, p.targetId),
        rotation: p.targetHeading - p.runIn,
      }
    : null;
  let aim: FramePoint | null = null;
  if (p.aimValid && !bull) aim = toHeadingFrame(p.aim.x - cx, p.aim.z - cz, p.runIn);
  else if (bull) aim = { x: 0, y: 0 };
  // extent: the target, the aim point and every mark, on a whole grid step
  let r = 12;
  for (const m of marks) r = Math.max(r, Math.abs(m.x), Math.abs(m.y));
  if (aim) r = Math.max(r, Math.abs(aim.x), Math.abs(aim.y));
  r *= 1.12;
  const rings: number[] = [];
  if (bull) {
    r = Math.max(r, 60);
    for (const ring of [10, 25, 50, 100, 200, 400, 800]) if (ring < r) rings.push(ring);
  }
  const step = niceStep(r);
  return { radius: Math.ceil(r / step) * step, step, target, aim, marks, outside, rings };
}

function strafeFouls(s: StrafePassScore | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  if (s.foulLine)
    out.push(
      `Fired inside the foul line: ${formatInt(s.closestFiring)} m short of the panels (line ${formatInt(RANGE_RULES.strafeFoulLine)} m)`,
    );
  if (s.minAltitude)
    out.push(
      `Below the minimum altitude: lowest ${formatFeetFromM(s.minAgl)} (minimum ${formatFeetFromM(RANGE_RULES.strafeMinAltitude)})`,
    );
  return out;
}

function passResult(
  src: DebriefSource,
  p: PassRecord,
  strafe: StrafePassScore | undefined,
  bombs: BombScore[],
  kills: KillRow[],
): string {
  if (strafe) {
    const rate = strafe.rounds > 0 ? ` (${formatPct(strafe.hits / strafe.rounds)})` : '';
    const scored = strafe.scored !== strafe.hits ? ' · FOUL: scores 0' : '';
    return `${formatInt(strafe.hits)} of ${formatInt(strafe.rounds)} rounds through the panel${rate}${scored}`;
  }
  if (kills.length > 0) return kills.map((k) => `${k.name} destroyed`).join(' · ');
  if (bombs.length > 0)
    return bombs
      .map((b) => `${storeLabel(b.store).short} ${formatMiss(b.miss)} ${formatClockDirection(b.clock)}`)
      .join(' · ');
  const parts: string[] = [];
  if (p.bursts.length > 0) {
    const { rounds, hits } = passRounds(src.debrief, src.gun, p);
    parts.push(`${formatInt(hits)} of ${formatInt(rounds)} rounds struck`);
  }
  const hitVehicles = new Set(p.hits.map((i) => src.debrief.hits[i].vehicleId));
  if (hitVehicles.size > 0)
    parts.push(`${hitVehicles.size} ${hitVehicles.size === 1 ? 'vehicle' : 'vehicles'} hit`);
  return parts.join(' · ') || 'No hit';
}

/** Every pass of the flight, as the screen shows it (newest last). */
export function passViews(src: DebriefSource): PassView[] {
  const d = src.debrief;
  const strafe = d.scores.strafe;
  const bombs = d.scores.bombs?.scores ?? null;
  return d.passes.map((p, index) => {
    const s = strafe?.passes.find((x) => x.pass === index);
    const passBombs = bombs?.filter((b) => b.pass === index) ?? [];
    const hits = p.hits.map((i) => d.hits[i]);
    const vehicles: PassVehicle[] = hitsByVehicle(hits).map((g: VehicleHits) => ({
      vehicleId: g.vehicleId,
      kind: g.kind,
      name: targetName(src, g.vehicleId),
      condition: g.condition,
      strikes: strikeSummary(g),
      rows: g.hits.map(hitRow),
    }));
    const kills: KillRow[] = p.kills.map((k) => {
      const kill = d.kills[k];
      return {
        time: kill.time,
        name: targetName(src, kill.vehicleId),
        weapon: weaponName(kill.weapon),
        catastrophic: kill.catastrophic,
      };
    });
    return {
      index,
      number: p.number,
      start: p.start,
      end: p.end,
      open: !Number.isFinite(p.end),
      weapons: weaponsLine(src, p),
      target: targetName(src, p.targetId),
      result: passResult(src, p, s, passBombs, kills),
      fouls: strafeFouls(s),
      events: eventRows(src, p, bombs),
      plot: passPlot(src, p),
      vehicles,
      kills,
      minAgl: p.minAgl,
      maxG: p.maxG,
    };
  });
}

// ---- range scores -----------------------------------------------------------------------------

export interface StrafeRow {
  pass: number;
  panel: string;
  rounds: number;
  hits: number;
  scored: number;
  openFireRange: number;
  ceaseFireRange: number;
  closestFiring: number;
  minAgl: number;
  fouls: string;
}

export interface BombRow {
  n: number;
  pass: number;
  store: string;
  miss: number;
  clock: number;
  notes: string;
}

export interface RangeView {
  event: RangeEvent;
  title: string;
  /** One line under the title: the rules or the session summary. */
  line: string;
  strafe: { rows: StrafeRow[]; total: StrafeScores } | null;
  bombs: { rows: BombRow[]; mean: number; cep: number; best: number } | null;
  lane: LaneScores | null;
}

export function rangeView(src: DebriefSource): RangeView | null {
  const d = src.debrief;
  const s = d.scores;
  if (s.event === 'none') return null;
  if (s.event === 'strafePit') {
    const total = s.strafe ?? {
      passes: [],
      rounds: 0,
      hits: 0,
      scored: 0,
      fouls: 0,
      foulLine: RANGE_RULES.strafeFoulLine,
      minAltitude: RANGE_RULES.strafeMinAltitude,
    };
    const rows: StrafeRow[] = total.passes.map((p) => ({
      pass: d.passes[p.pass]?.number ?? p.pass + 1,
      panel: p.panel > 0 ? targetName(src, p.panel).replace('Strafe panel', 'Panel') : '—',
      rounds: p.rounds,
      hits: p.hits,
      scored: p.scored,
      openFireRange: p.openFireRange,
      ceaseFireRange: p.ceaseFireRange,
      closestFiring: p.closestFiring,
      minAgl: p.minAgl,
      fouls: [p.foulLine && 'Foul line', p.minAltitude && 'Minimum altitude']
        .filter(Boolean)
        .join(', '),
    }));
    return {
      event: 'strafePit',
      title: 'Strafe pit',
      line: `Foul line ${formatInt(total.foulLine)} m (${formatFeetFromM(total.foulLine)}) short of the panels · minimum altitude ${formatFeetFromM(total.minAltitude)} · a fouled pass scores no hits`,
      strafe: { rows, total },
      bombs: null,
      lane: null,
    };
  }
  if (s.event === 'bombCircle') {
    const b = s.bombs;
    const rows: BombRow[] = (b?.scores ?? []).map((x, i) => ({
      n: i + 1,
      pass: x.pass >= 0 ? d.passes[x.pass].number : 0,
      store: storeLabel(x.store).short,
      miss: x.miss,
      clock: x.clock,
      notes: [x.dud && 'Dud', x.fragmentWarning && 'Inside the fragment envelope']
        .filter(Boolean)
        .join(' · '),
    }));
    return {
      event: 'bombCircle',
      title: 'Bombing circle',
      line: 'Miss from the bull on the ground; clock from your run-in heading (12 = long, 6 = short)',
      strafe: null,
      bombs: { rows, mean: b?.mean ?? NaN, cep: b?.cep ?? NaN, best: b?.best ?? NaN },
      lane: null,
    };
  }
  return {
    event: 'tacticalLane',
    title: 'Tactical lane',
    line: 'Kills by weapon; time to kill from the first shot of the pass',
    strafe: null,
    bombs: null,
    lane: s.lane,
  };
}

// ---- the whole screen -------------------------------------------------------------------------

export interface DebriefModel {
  passes: PassView[];
  range: RangeView | null;
  /** Whole-flight hits by vehicle, strikes counted once per round or store. */
  vehicles: VehicleHits[];
}

export function buildDebriefModel(src: DebriefSource): DebriefModel {
  return {
    passes: passViews(src),
    range: rangeView(src),
    vehicles: hitsByVehicle(src.debrief.hits),
  };
}
