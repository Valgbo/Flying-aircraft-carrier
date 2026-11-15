/**
 * Flight-ops tuning: every number that shapes how the air wing behaves lives here.
 * Units: metres, seconds, radians (names ending in `Deg` are degrees). Distances along the
 * deck are in the carrier-local frame; flight speeds are measured RELATIVE TO THE SHIP (the
 * pattern is flown in a frame that translates with the carrier, so it is flown identically
 * whether the ship hovers or cruises).
 */
import { ISLAND, JET, PARKING_SPOTS } from '../config/layout';
import { DEG2RAD } from '../utils/math';

/** Aircraft footprint used for deck spacing (the visual model is built to these numbers). */
export const JET_DIMS = {
  /** Nose tip ahead of the model origin (the origin sits on the deck under the centre of gravity). */
  nose: 8.4,
  /** Nozzle end behind the model origin. */
  tail: JET.length - 8.4,
  halfSpan: JET.wingspan / 2,
  /** Half span with the outer wing panels folded (the fold hinge line). */
  halfSpanFolded: 3,
} as const;

export const OPS = {
  jetCount: PARKING_SPOTS.length,

  // ---- deck steadiness and scoring -------------------------------------------------------
  /** Below this steadiness an approach is waved off and a catapult shot is held. */
  minSteadiness: 0.4,
  /** A held catapult fires again once the steadiness is back above min + this margin. */
  steadinessHysteresis: 0.05,
  /** Response rate (1/s) of the smoothed steadiness: ≈ one second of memory. */
  steadinessRate: 1.1,
  /** Disturbance that, alone, drives the steadiness to zero. */
  tiltLimit: 6 * DEG2RAD,
  tiltRateLimit: 5 * DEG2RAD,
  heaveLimit: 6,
  gLimit: 0.4,
  turnRateLimit: 6 * DEG2RAD,
  /** Points for a recovery: minPoints at steadiness 0 rising linearly to maxPoints at 1. */
  minPoints: 100,
  maxPoints: 1000,
  launchPoints: 50,
  gradePerfect: 0.9,
  gradeGood: 0.72,
  gradeFair: 0.55,

  // ---- taxiing ---------------------------------------------------------------------------
  taxiSpeed: 9,
  reverseSpeed: 2.6,
  taxiAccel: 2.4,
  taxiBrake: 3.2,
  /** Heading rate limit on deck, rad/s — the speed in a turn is this × the turn radius. */
  taxiTurnRate: 0.6,
  /**
   * Taxi lane: a line parallel to the centreline, just inboard of the island. A folded-wing
   * jet on it clears the island, the noses of the parked aircraft and the landing strip.
   */
  laneX: ISLAND.centerX - ISLAND.width / 2 - JET_DIMS.halfSpanFolded - 4.5,
  pullOutRadius: 8,
  catapultJoinRadius: 12,
  /** Straight run on the catapult centreline before the shuttle. */
  catapultAlignRun: 16,
  exitRadius: 9,
  /** Roll along the strip after the arrestment before turning off it. */
  exitRun: 14,
  parkRadius: 8,
  /** An outbound jet may leave its spot once the previous one is this far past the merge point. */
  taxiSpacing: 25,
  /** Wing fold / spread time. */
  wingFoldTime: 1.6,

  // ---- catapult --------------------------------------------------------------------------
  /** Speed at the end of the catapult track (relative to the deck). */
  catapultEndSpeed: 75,
  /** Engine spool-up hold on the catapult before the stroke. */
  spoolTime: 2,
  /** Minimum time between two catapult strokes (keeps launches apart in the pattern). */
  launchInterval: 7,
  /** No catapult stroke for this long after a wave-off (the jet is climbing out over the bow). */
  waveOffLaunchHold: 8,
  /** No new taxi-out while a recovering jet is closer than this to touchdown (path distance). */
  recoveryHoldDistance: 2000,

  // ---- flight ----------------------------------------------------------------------------
  patternSpeed: 90,
  approachSpeed: 68,
  /** Pattern height above the flight deck. */
  patternHeight: 250,
  /** Downwind leg offset to port of the ship's centreline. */
  abeamDistance: 1500,
  /** The crosswind turn starts this far ahead of the ship's origin. */
  upwindDistance: 1000,
  /** Length of the straight final approach when the base turn starts at the nominal point. */
  finalLength: 1500,
  /** Longest downwind extension a jet will fly to open the landing interval. */
  maxDownwindExtension: 2600,
  /** Minimum path distance between a jet turning base and the one ahead of it (≈ 23 s on final). */
  landingSeparation: 1700,
  climbAngle: 10 * DEG2RAD,
  glideSlope: 3.5 * DEG2RAD,
  maxBank: 55 * DEG2RAD,
  rollRate: 70 * DEG2RAD,
  /** Flight-path angle limits and rate (smooth pitch changes). */
  maxClimb: 14 * DEG2RAD,
  maxDescent: 7 * DEG2RAD,
  gammaRate: 6 * DEG2RAD,
  /** Body pitch / heading-attitude rate limit, rad/s. */
  pitchRate: 14 * DEG2RAD,
  accel: 4,
  decel: 2.5,
  /** Pursuit look-ahead time along the pattern path. */
  lookAheadTime: 3.5,
  /** Look-ahead distance on the final approach line. */
  finalLookAhead: 240,
  /** Time constant of the ship-velocity feed-forward the airborne jets ride on. */
  carryTime: 2,
  /** Time constant of the pattern frame's heading (low-passed ship heading). */
  frameHeadingTime: 2.5,
  /** Deck-relative guidance fades in between these distances from the touchdown point. */
  couplingFar: 1000,
  couplingNear: 250,
  /** Angle of attack at approach speed (adds to the flight-path angle for the body attitude). */
  approachAlpha: 8 * DEG2RAD,
  gearUpDelay: 1.3,

  // ---- recovery --------------------------------------------------------------------------
  /** Distance from the wire to a full stop. */
  arrestDistance: 95,
  /** Pause on the strip after the arrestment (hook up) before taxiing clear. */
  rolloutPause: 1.4,
} as const;
