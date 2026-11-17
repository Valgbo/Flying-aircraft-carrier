/**
 * Debrief contract: what every release and impact did, for scoring and the debrief screen.
 * Owned by the DEBRIEF module (core/debrief, wave 2); systems append records as things happen.
 * See docs/a10/ARCHITECTURE.md §4 and §12.6, PLAN_A10.md §11.
 *
 * Appended by other modules: `bursts` and `weapons` (weapons; avionics adds simulated releases),
 * `hits` and `kills` (targets). Everything else is derived by `stepDebrief` (debrief module):
 * the passes, the impact log, the links of each hit and release to its pass and impact, and the
 * range scores.
 */
import type { RoundOutcome } from '../targets/types';

/** A plain world point (x east, y up, z south), m. */
export interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** Conditions at the moment of a release or the start of a burst. */
export interface ReleaseConditions {
  time: number;
  /** Dive angle, rad (+ = nose/flight path below the horizon). */
  dive: number;
  /** True airspeed, m/s. */
  speed: number;
  /** Height above the ground, m. */
  agl: number;
  /** Slant range to the aim point, m (0 if unknown). */
  slantRange: number;
  gLoad: number;
  /** Bank, rad. */
  bank: number;
}

export interface BurstRecord {
  burst: number;
  start: ReleaseConditions;
  /** Seconds the trigger was held at the second detent. */
  duration: number;
  rounds: number;
  /** Rounds that hit a vehicle. */
  hits: number;
  /** Open-fire slant range to the pipper point, m. */
  openFireRange: number;
  /** Cease-fire slant range, m. */
  ceaseFireRange: number;
}

export interface HitRecord {
  time: number;
  /** Round id, or store body id for weapons. */
  sourceId: number;
  weapon: string;
  vehicleId: number;
  vehicleKind: string;
  plate: number;
  face: string;
  part: string;
  /** Impact speed, m/s. */
  speed: number;
  obliquity: number;
  effectiveThicknessMm: number;
  penetrationMm: number;
  outcome: RoundOutcome | 'blast' | 'fragment';
  damaged: string[];
  /** Vehicle condition after the hit. */
  condition: string;
}

export interface WeaponRecord {
  id: number;
  weapon: string;
  release: ReleaseConditions;
  /** Impact point and miss distance from the aim point, m (NaN while in flight). */
  impactTime: number;
  missDistance: number;
  /** Clock direction of the miss from the aim point (1..12, 12 = along the run-in heading). */
  missClock: number;
  dud: boolean;
  /** Released inside the fragment envelope. */
  fragmentWarning: boolean;

  // ---- wave 2 (ARCHITECTURE §12.6) ----
  /** Store type, station and how it was delivered. */
  store: string;
  station: number;
  delivery: 'CCIP' | 'CCRP' | 'MAV' | 'ROCKET' | 'JETTISON';
  /** Aim point of the release and the impact point (NaN while in flight). */
  aim: XYZ;
  aimValid: boolean;
  impact: XYZ;
  /** A Master Arm TRAIN release: nothing left the aircraft. */
  simulated: boolean;
  /** The store body's id (0 for a simulated release). */
  bodyId: number;
}

/** A vehicle destroyed (appended once per vehicle by the targets module). */
export interface KillRecord {
  time: number;
  vehicleId: number;
  kind: string;
  weapon: string;
  catastrophic: boolean;
}

// ---- wave 2: derived by stepDebrief (debrief module) ------------------------------------------

/** Why a pass ended: the pull-off climb, a quiet spell after the last weapon event, a crash. */
export type PassEnd = '' | 'pullOff' | 'timeout' | 'crash';

/**
 * One attack: from the roll-in to the pull-off (data/range.ts PASS_RULES). Only weapon events
 * open a pass (a gun burst, a store release or a simulated TRAIN release; jettison does not).
 */
export interface PassRecord {
  /** 1, 2, … in flight order. */
  number: number;
  /** Roll-in: the start of the dive that carried the first weapon event (that event for a level delivery), s. */
  start: number;
  /** First and last weapon event: first round or release, last round or release, s. */
  firstEvent: number;
  lastEvent: number;
  /** Pull-off, s (NaN while the pass is open). */
  end: number;
  endReason: PassEnd;
  /** Ground track at the first weapon event: the run-in heading, rad (compass). */
  runIn: number;
  /** Aim point at the first weapon event (gun: the pipper's ground point; a store: its aim point). */
  aim: XYZ;
  aimValid: boolean;
  /** The vehicle (or scoring panel) the pass attacked, -1 none. */
  targetId: number;
  /** The target's ground point and heading at the first weapon event (plots), m and rad. */
  targetX: number;
  targetZ: number;
  targetHeading: number;
  /** Gun bursts (BurstRecord.burst numbers) fired in the pass. */
  bursts: number[];
  /** Indices into `weapons` of the releases (simulated ones included). */
  weapons: number[];
  /** Indices into `hits` of the hits its weapons made (on any vehicle). */
  hits: number[];
  /** Indices into `kills` of the vehicles it destroyed (also later, by a fire it started). */
  kills: number[];
  /** Indices into `impacts` of its rounds' and stores' impacts. */
  impacts: number[];
  /** Lowest height above the ground from the first weapon event to the pull-off, m. */
  minAgl: number;
  /** Highest load factor over the same span. */
  maxG: number;
  /**
   * Strafe pit: the closest the aircraft was to the panel line, along the run-in, while a round
   * left (the foul-line check), m; NaN when no round left near the panels.
   */
  closestFiring: number;
}

/** What landed: a 30 mm round, or a store by its detonation kind. */
export type ImpactKind = 'round' | 'bomb' | 'rocket' | 'missile' | 'whitePhosphorus' | 'dud';

/** One impact on the ground or a vehicle (rounds, skips, bombs, rockets, missiles). */
export interface ImpactRecord {
  /** Sim time of the impact, s. */
  t: number;
  kind: ImpactKind;
  /** The round type ('API', 'HEI', 'TP') or the store type ('MK-82' …). */
  weapon: string;
  x: number;
  y: number;
  z: number;
  /** The vehicle struck (or, for a store, the vehicle it detonated on or beside), -1 the ground. */
  vehicleId: number;
  /** The round's outcome ('penetrated' … 'ground', 'skip', 'water') or the store's detonation kind. */
  outcome: string;
  /** Index into `passes` (-1: outside every pass, e.g. a jettisoned store). */
  pass: number;
  /** Index into `weapons` of the store's record (-1 for rounds). */
  record: number;
  /**
   * Reference vehicle of the offset below: the vehicle struck, else the pass's target nearby,
   * else the nearest vehicle within DEBRIEF_LIMITS.nearMissRadius; -1 none.
   */
  ref: number;
  /** Offset of the impact from the reference vehicle's ground point when it landed, world x/z, m. */
  dx: number;
  dz: number;
  /** The reference vehicle's heading then, rad. */
  refHeading: number;
}

/** How a hit record ties in (index-aligned with `hits`). */
export interface HitLink {
  /** Pass of the weapon that made the hit (-1 none). */
  pass: number;
  /** The round's strike, or the burst whose blast and fragments reached the vehicle (-1 unknown). */
  impact: number;
  /** Offset of that impact from the hit vehicle's ground point when it happened, world x/z, m. */
  dx: number;
  dz: number;
  /** The hit vehicle's heading then, rad. */
  heading: number;
  /** A strike of the round or store itself (not the blast or fragments of a burst nearby). */
  direct: boolean;
  /** Gun burst number of the round (0 for a store). */
  burst: number;
  /** Index into `weapons` of the store that made it (-1 for rounds). */
  record: number;
}

/** How a release ties in (index-aligned with `weapons`). */
export interface WeaponLink {
  /** Pass of the release (-1: jettison or outside a pass). */
  pass: number;
  /** Ground track of the aircraft at the release: the run-in of the score, rad. */
  runIn: number;
  /** Index into `impacts` of where it landed (-1 in flight, simulated or lost). */
  impact: number;
  /** The vehicle its seeker or aim point was on at the release (-1 none). */
  target: number;
}

/** Which weapons-range event the flight is (SimOptions.scenario). */
export type RangeEvent = 'strafePit' | 'bombCircle' | 'tacticalLane' | 'none';

/** Where the event's targets are, found once at the start of the flight. */
export interface RangeLayout {
  event: RangeEvent;
  /** Centre of the event's area (the bombing circle's bull's-eye), world, m. */
  x: number;
  z: number;
  /** Run-in heading of the range, rad (compass). */
  runIn: number;
  /** Strafe pit: the scoring panels (vehicle ids), left to right across the run-in. */
  panels: number[];
  /** The event's own vehicles (panels, hulks, the lane column). */
  vehicles: number[];
  /** Bombing circle: the hulk on the bull's-eye (-1 none). */
  centreId: number;
}

/** Strafe pit: one pass on the panels. */
export interface StrafePassScore {
  /** Index into `passes`. */
  pass: number;
  /** The panel attacked (vehicle id, -1 none). */
  panel: number;
  /** Rounds fired in the pass. */
  rounds: number;
  /** Rounds through the attacked panel, and through every panel. */
  hits: number;
  panelHits: number[];
  /** Hits that count (0 when the pass fouled). */
  scored: number;
  /** Open-fire slant range of the first burst, cease-fire of the last (burst records), m. */
  openFireRange: number;
  ceaseFireRange: number;
  /** See PassRecord.closestFiring and PassRecord.minAgl, m. */
  closestFiring: number;
  minAgl: number;
  foulLine: boolean;
  minAltitude: boolean;
}

export interface StrafeScores {
  passes: StrafePassScore[];
  rounds: number;
  hits: number;
  scored: number;
  fouls: number;
  /** The rules in force (data/range.ts), m. */
  foulLine: number;
  minAltitude: number;
}

/** Bombing circle: one store's impact. */
export interface BombScore {
  /** Index into `weapons`. */
  record: number;
  pass: number;
  store: string;
  /** Impact time, s. */
  time: number;
  /** Horizontal miss from the bull's-eye, m. */
  miss: number;
  /** Clock direction of the miss, 1..12 (12 = long, along the run-in). */
  clock: number;
  runIn: number;
  dud: boolean;
  fragmentWarning: boolean;
}

export interface BombScores {
  /** The bull's-eye, world, m. */
  centreX: number;
  centreZ: number;
  scores: BombScore[];
  /** Mean and median (CEP: half the impacts lie inside it) of the misses, m; NaN with no impact. */
  mean: number;
  cep: number;
  best: number;
}

/** Tactical lane: one kill. */
export interface LaneKill {
  /** Index into `kills`. */
  kill: number;
  vehicleId: number;
  kind: string;
  /** Weapon family: 'GUN' or the store type. */
  weapon: string;
  time: number;
  pass: number;
  /** From the pass's first weapon event to the kill, s (NaN without a pass). */
  timeToKill: number;
}

export interface LaneWeapon {
  /** 'GUN' or the store type. */
  weapon: string;
  /** Rounds fired (gun) or stores released. */
  released: number;
  /** Rounds or stores that struck a vehicle directly. */
  hits: number;
  kills: number;
}

export interface LaneScores {
  /** Vehicles on the lane. */
  vehicles: number;
  kills: LaneKill[];
  byWeapon: LaneWeapon[];
  meanTimeToKill: number;
}

export interface RangeScores {
  event: RangeEvent;
  strafe: StrafeScores | null;
  bombs: BombScores | null;
  lane: LaneScores | null;
}

/** Bookkeeping of the recorder (debrief module only; other modules must not read it). */
export interface DebriefInternal {
  /** sim.events scan: index reached and the last event seen (detects the frame loop's drain). */
  eventIndex: number;
  lastEvent: unknown;
  /** Records of each list already taken in. */
  hitCount: number;
  weaponCount: number;
  killCount: number;
  burstCount: number;
  /** The last gun burst number seen and the gun's rounds fired, after the last step. */
  lastBurst: number;
  totalFired: number;
  /** By burst number: the id of its first round and its pass (-1 none). */
  burstFirstId: number[];
  burstPass: number[];
  /** Σ hits of the burst records (they grow as rounds land). */
  burstHits: number;
  /** The open pass (-1 none). */
  open: number;
  /** Last time the flight path was not a dive (the roll-in search), s. */
  lastLevelTime: number;
  /** Weapon records still in flight. */
  pending: number[];
  layout: RangeLayout | null;
  /** The scores must be recomputed. */
  dirty: boolean;
}

export interface DebriefState {
  bursts: BurstRecord[];
  hits: HitRecord[];
  weapons: WeaponRecord[];
  kills: KillRecord[];
  /** Range scoring summary as numbers (also in `scores`, typed). */
  range: Record<string, number>;

  // ---- wave 2: derived by stepDebrief ----
  passes: PassRecord[];
  impacts: ImpactRecord[];
  /** Index-aligned with `hits` and `weapons`. */
  hitLinks: HitLink[];
  weaponLinks: WeaponLink[];
  scores: RangeScores;
  internal: DebriefInternal;
}
