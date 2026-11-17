/**
 * Weapons contract: the GAU-8/A, live rounds, stores on stations and released store bodies.
 * Owned by the WEAPONS module (core/weapons). See docs/a10/ARCHITECTURE.md §4 and PLAN_A10.md §6.
 */
import type { Quaternion, Vector3 } from 'three';
import type { ReleaseConditions } from '../debrief/types';

/** 30 mm round types. Numeric so they fit in typed arrays. */
export const RoundType = {
  /** PGU-14/B armour-piercing incendiary (depleted-uranium core). */
  API: 0,
  /** PGU-13/B high-explosive incendiary. */
  HEI: 1,
  /** PGU-15/B target practice (inert). */
  TP: 2,
} as const;
export type RoundType = (typeof RoundType)[keyof typeof RoundType];

export type AmmoLoad = 'combatMix' | 'allHEI' | 'allAPI' | 'targetPractice';

export interface GunState {
  /** Rounds remaining in the drum. */
  rounds: number;
  /** Rounds at the start of the flight (for the debrief). */
  roundsLoaded: number;
  /** Belt order of the load (the type of round n is belt[n % belt.length]). */
  load: AmmoLoad;
  /** Index of the next round to leave in the belt sequence. */
  beltIndex: number;
  /** Barrel rotation speed as a fraction of full rate, 0..1 (spin-up/down). */
  spin: number;
  /** Barrel cluster angle, rad (for the visual model; advances with spin). */
  barrelAngle: number;
  /**
   * Rounds per second the mechanism is cycling at: GAU8.rate × spin, also during spin-up and
   * spin-down (the drive whine follows it). Rounds leave only while `firing`.
   */
  rate: number;
  /** True while rounds are leaving the gun (a burst is open and the trigger still fires). */
  firing: boolean;
  /**
   * Fraction of the cycle from the last firing position, 0..1: the next round fires when the
   * rotating barrels have turned the rest of the way (exact emission timing).
   */
  phase: number;
  /** Sim time the first round of the current burst left, s (-1 when no burst is open). */
  burstStart: number;
  /** Rounds fired in the current or most recent burst. */
  burstRounds: number;
  /** Total rounds fired this flight. */
  totalFired: number;
  /** Recoil force this step along the gun line, N (for camera shake and sound). */
  recoil: number;

  // ---- added by the weapons module ----
  /** Scale on the round-to-round dispersion: 1 the real gun, 0 none (boresight checks, tests). */
  dispersionScale: number;
  /** Number of the current or most recent burst (1, 2, …; 0 before the first). */
  burstNumber: number;
  /** Sim time of the last round of the current or most recent burst, s. */
  lastRoundTime: number;
  /** The fire command (trigger, switches, ammunition) was on during the last step. */
  commanded: boolean;
  /** Sim time the present fire command began, s (-1 when not commanded). */
  commandTime: number;
  /** Rounds of the open burst that have hit a vehicle so far. */
  burstHits: number;
  /** Slant range to the pipper point when the open burst's first round left, m (NaN unknown). */
  openFireRange: number;
  /** Conditions at the open burst's first round (copied into its BurstRecord). */
  burstConditions: ReleaseConditions;
  /** Rounds that left while the round pool was full and were not simulated (should stay 0). */
  dropped: number;
}

/**
 * Pool of live 30 mm rounds, structure-of-arrays for speed. A slot is live while alive[i] = 1.
 * Positions/velocities are world frame, float64. Allocation and release are O(1) through the
 * `free` stack; slots are reused, ids are not.
 */
export interface RoundPool {
  capacity: number;
  alive: Uint8Array;
  type: Uint8Array;
  px: Float64Array;
  py: Float64Array;
  pz: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  vz: Float64Array;
  /** Sim time the round left the muzzle, s. */
  fireTime: Float64Array;
  /** Unique id (increasing), for the debrief. */
  id: Uint32Array;
  /** Burst number the round belongs to. */
  burst: Uint32Array;
  /** Number of ground skips so far. */
  bounces: Uint8Array;
  /** Count of live slots. */
  live: number;
  nextId: number;

  // ---- added by the weapons module ----
  /** Number of armour ricochets so far. */
  ricochets: Uint8Array;
  /** Mean wind at the round, world m/s (refreshed every few steps: it changes slowly). */
  wx: Float64Array;
  wy: Float64Array;
  wz: Float64Array;
  /** Per-round flags (ROUND_FLAG_*). */
  flags: Uint8Array;
  /** Stack of free slot indices; the top `freeCount` entries are free. */
  free: Int32Array;
  freeCount: number;
}

/** Every store the aircraft can carry. */
export type StoreType =
  | 'AGM-65D'
  | 'AGM-65H'
  | 'AGM-65G'
  | 'AGM-65K'
  | 'MK-82'
  | 'MK-82AIR'
  | 'GBU-12'
  | 'LAU-131-M151'
  | 'LAU-131-M156'
  | 'LAU-68-M151'
  | 'LAU-68-M156'
  | 'CBU-97'
  | 'AN/AAQ-28'
  | 'AN/ALQ-184'
  | 'AIM-9M'
  | 'TER-9A'
  | 'LAU-117'
  | 'LAU-88'
  /** Dual-rail adapter with two LAU-114/A rails for a pair of AIM-9s (the asset model 'lau114'). */
  | 'LAU-114';

/** One of the 11 stations, numbered 1 (left wing tip) to 11 (right wing tip), 6 = centreline. */
export interface StationState {
  station: number;
  /** What hangs there (rack or launcher first, then what it carries). */
  rack: StoreType | null;
  /** Stores still on this station, in release order. */
  stores: StoreType[];
}

export interface StoresState {
  stations: StationState[];
  /** Id of the loadout preset or 'custom'. */
  loadoutId: string;
  /** Mass of everything on the stations now, kg. */
  mass: number;
  /** Total drag area of the stores, m² (CdA), for the flight model. */
  dragArea: number;
  /** Rolling-moment arm of an asymmetric load: Σ mass·x, kg·m (body x). */
  lateralMoment: number;
  /** Roll inertia of the stores about the centreline: Σ m·x², kg·m² (body x of each station). */
  rollInertia?: number;
  /** Yawing-moment arm of the stores drag: Σ CdA·x, m³ (+ = more drag on the right wing). */
  dragMoment?: number;
}

export type StoreBodyKind =
  'bomb' | 'rocket' | 'missile' | 'laserBomb' | 'dispenser' | 'submunition';

/** A store in free flight (bomb, rocket, missile…). */
export interface StoreBody {
  id: number;
  type: StoreType;
  kind: StoreBodyKind;
  alive: boolean;
  /** Station it left, 0 if none. */
  station: number;
  releaseTime: number;
  position: Vector3;
  velocity: Vector3;
  orientation: Quaternion;
  /** Motor burn time remaining, s. */
  motorTime: number;
  /** Fuze armed (arming time elapsed). */
  armed: boolean;
  /** Free-form per-weapon state owned by the weapons module (guidance, seeker…). */
  data: Record<string, number>;
}

export interface ProjectileState {
  rounds: RoundPool;
  bodies: StoreBody[];
  nextBodyId: number;
}
