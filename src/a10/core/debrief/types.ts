/**
 * Debrief contract: what every release and impact did, for scoring and the debrief screen.
 * Owned by the DEBRIEF module (core/debrief, wave 2); systems append records as things happen.
 * See docs/a10/ARCHITECTURE.md §4 and PLAN_A10.md §11.
 */
import type { RoundOutcome } from '../targets/types';

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
  aim: { x: number; y: number; z: number };
  aimValid: boolean;
  impact: { x: number; y: number; z: number };
  /** A Master Arm TRAIN release: nothing left the aircraft. */
  simulated: boolean;
  /** The store body's id (0 for a simulated release). */
  bodyId: number;
}

export interface DebriefState {
  bursts: BurstRecord[];
  hits: HitRecord[];
  weapons: WeaponRecord[];
  kills: { time: number; vehicleId: number; kind: string; weapon: string; catastrophic: boolean }[];
  /** Range scoring events (strafe pit, bombing circle…), free-form per event. */
  range: Record<string, number>;
}
