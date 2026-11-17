/**
 * Weapons contract: the GAU-8/A, live rounds, stores on stations and released store bodies.
 * Owned by the WEAPONS module (core/weapons). See docs/a10/ARCHITECTURE.md §4 and PLAN_A10.md §6.
 */
import type { Quaternion, Vector3 } from 'three';
import type { FuzeOption } from '../avionics/types';
import type { ReleaseConditions } from '../debrief/types';
import type { Vec3Like } from '../types';

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
  /** Rocket pods: rockets left in the pod (the pod stays when they are gone). Wave 2. */
  rockets?: number;
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
  /**
   * Releases decided by the avionics, waiting for the weapons module (ARCHITECTURE §12.1).
   * Avionics pushes; `stepStores` executes each at its exact time and removes it.
   */
  releaseQueue: ReleaseRequest[];
}

/** How a store was released (ARCHITECTURE §12.1). */
export type ReleaseDelivery = 'CCIP' | 'CCRP' | 'MAV' | 'ROCKET' | 'JETTISON';

/** One store to release, decided by the avionics and executed by the weapons module (§12.1). */
export interface ReleaseRequest {
  /** Sim time of the release, s (now or later: ripple pulses are queued ahead). */
  time: number;
  station: number;
  /** The store that leaves (for rocket pods the pod type: one rocket per request). */
  store: StoreType;
  /** Weapon profile id ('' for jettison). */
  profile: string;
  delivery: ReleaseDelivery;
  /** Aim point: the CCIP pipper's ground point, the designated point, the SPI or a lock point. */
  aim: Vec3Like;
  aimValid: boolean;
  /** Fuze option and arming time (s) from the profile. */
  fuze: FuzeOption;
  armingTime: number;
  /** Mk-82 AIR: the ballute opens (high-drag delivery). */
  highDrag: boolean;
  /** GBU-12: the seeker's laser code. */
  laserCode: number;
  /** Maverick: the vehicle the seeker is locked on (-1 none). */
  lockVehicle: number;
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
  /** Motor burn time remaining, s (0 for bodies without a motor, and after burn-out). */
  motorTime: number;
  /** Fuze armed (arming time elapsed). */
  armed: boolean;
  /** Free-form per-weapon state owned by the weapons module (guidance, seeker…). */
  data: Record<string, number>;

  // ---- wave 2 (ARCHITECTURE §12.2) ----
  delivery: ReleaseDelivery;
  /** Aim point of the release (debrief miss distance; guidance start). */
  aim: Vector3;
  aimValid: boolean;
  /** Mk-82 AIR: the ballute is open (after its delay on a high-drag release). */
  highDrag: boolean;
  /** The fuze arms at releaseTime + armingTime. */
  armingTime: number;
  /** GBU-12: the seeker's laser code. */
  laserCode: number;
  /** Guidance target kept by the guided module (§12.3); valid while it has one. */
  guidance: {
    mode: 'NONE' | 'LASER' | 'TV' | 'IR';
    vehicleId: number;
    point: Vector3;
    valid: boolean;
  };
  /** Index of its record in debrief.weapons (-1 none). */
  record: number;

  // ---- added by the stores module (wave 2) ----
  /**
   * Position and attitude at the start of the last step (at release for a body released in
   * it): views draw `prev` → current by frameInfo.alpha, as drawPose does for the aircraft.
   */
  prevPosition: Vector3;
  prevOrientation: Quaternion;
  /** The free-flight model the body flies with (storeModels.ts); null only while pooled. */
  flight: StoreFlightSpec | null;
  /** Fuze option of the release (bombs: NOSE instantaneous, TAIL short delay, N/T both). */
  fuze: FuzeOption;
  /** Ground-track heading of the aircraft at release, rad: the run-in of the miss clock. */
  runIn: number;
  /** A jettisoned rack, launcher or pod: the stores it still carried (empty otherwise). */
  carried: StoreType[];
  /** A jettisoned rocket pod: rockets still in it (0 otherwise). */
  rockets: number;
  /** Mass now, kg (a rocket loses its propellant as it burns). */
  mass: number;
}

/**
 * A store's free-flight model (storeModels.ts): a point mass with drag against Mach number,
 * gravity, the wind, and a ballute or a rocket motor. The live bodies and the fire-control
 * computer's registered model integrate it with the same function (PLAN §6.1 rule 2).
 */
export interface StoreFlightSpec {
  /** Registry key: the store type, `${store}/HD`, a missile type, or 'JETTISON'. */
  key: string;
  /** Mass when it leaves the aircraft, kg (a rocket: after the burn in its launch tube). */
  mass: number;
  /** Reference area of the drag table, m². */
  area: number;
  /** Drag coefficient on `area` against Mach, on a uniform grid of FLIGHT_MACH_STEP. */
  cd: Float64Array;
  /** Constant drag area added (a tumbling rack or pod), m². */
  extraDragArea: number;
  /** Ballute (Mk 82 AIR high drag): inflated drag area, m² (0 = none)… */
  balluteArea: number;
  /** …and the times after release it starts and finishes filling, s. */
  balluteStart: number;
  balluteFull: number;
  /** Rocket motor (Hydra 70), or null. */
  motor: RocketMotor | null;
  /** Motor time at release (the burn in the launch tube), s. */
  motorOffset: number;
  /**
   * Times after release at which the forcing has a kink or a jump (ballute, thrust-curve knots,
   * burn-out), ascending: the integrator steps exactly onto them, at any step length.
   */
  breaks: Float64Array;
  /** Time constant of the drawn axis turning into the relative wind, s (views only). */
  weathercockTime: number;
}

/** A solid rocket motor: a piecewise-linear thrust curve and the propellant it burns. */
export interface RocketMotor {
  /** Knots of the thrust curve: time since ignition (s) and thrust (N). */
  time: Float64Array;
  thrust: Float64Array;
  /** Impulse delivered up to each knot, N·s. */
  impulse: Float64Array;
  totalImpulse: number;
  burnTime: number;
  /** Mass at ignition and propellant burnt, kg (the mass falls in proportion to the impulse). */
  ignitionMass: number;
  propellant: number;
  /** Drag factor while the motor burns. */
  plumeDrag: number;
}

export interface ProjectileState {
  rounds: RoundPool;
  bodies: StoreBody[];
  nextBodyId: number;
  /** Store bodies kept for reuse (added by the stores module: no allocation per release). */
  bodyPool: StoreBody[];
}
