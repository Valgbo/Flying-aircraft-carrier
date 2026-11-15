/**
 * Flight-ops tuning: every number that shapes how the air wing behaves lives here.
 * Units: metres, seconds, radians (names ending in `Deg` are degrees). Distances on the deck
 * are in the carrier-local frame; flight speeds are measured RELATIVE TO THE SHIP (the
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
} as const;

export const OPS = {
  jetCount: PARKING_SPOTS.length,

  // ---- deck steadiness and scoring -------------------------------------------------------
  /** Below this steadiness an approach is waved off and a catapult shot is held. */
  minSteadiness: 0.4,
  /** A held catapult fires again once the steadiness is back above min + this margin. */
  steadinessHysteresis: 0.05,
  /** Response rate (1/s) of the smoothed steadiness: about one second of memory. */
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
  reverseSpeed: 3.5,
  taxiAccel: 2.4,
  taxiBrake: 3.2,
  /** Heading rate limit on deck, rad/s — the speed in a turn is this × the turn radius. */
  taxiTurnRate: 0.6,
  /**
   * Taxi lane: a line parallel to the centreline, inboard of the island. A jet on it clears
   * the island, the elevator and the noses of the parked aircraft by a couple of metres.
   * Abeam the parking spots the lane lies inside the landing area, which is why deck traffic
   * and recoveries are interlocked (see FlightOpsSim).
   */
  laneX: ISLAND.centerX - ISLAND.width / 2 - JET_DIMS.halfSpan - 4,
  pullOutRadius: 8,
  catapultJoinRadius: 12,
  /** Straight run on the catapult centreline before the shuttle. */
  catapultAlignRun: 16,
  exitRadius: 9,
  /** Roll along the strip after the arrestment before turning off it. */
  exitRun: 14,
  parkRadius: 8,
  /** An outbound jet may leave its spot once the previous one has taxied this far. */
  taxiSpacing: 30,

  // ---- catapult --------------------------------------------------------------------------
  /** Speed at the end of the catapult track (relative to the deck). */
  catapultEndSpeed: 75,
  /** Engine spool-up hold on the catapult before the stroke. */
  spoolTime: 2,
  /** Minimum time between two catapult strokes (keeps launches apart in the pattern). */
  launchInterval: 7,
  /** No catapult stroke for this long after a wave-off (that jet is climbing out over the bow). */
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
  finalLength: 1400,
  /** Longest downwind extension a jet will fly to open the landing interval. */
  maxDownwindExtension: 2200,
  /** Minimum time between two touchdowns: arrestment, rollout, taxi back and parking. */
  landingInterval: 62,
  climbAngle: 10 * DEG2RAD,
  glideSlope: 3.5 * DEG2RAD,
  maxBank: 55 * DEG2RAD,
  rollRate: 70 * DEG2RAD,
  /** The bank leads the turn by this much time so the jet is established when the arc starts. */
  bankLead: 0.35,
  maxDescent: 7 * DEG2RAD,
  /** Flight-path angle rate (smooth pitch changes). */
  gammaRate: 6 * DEG2RAD,
  /** Body pitch rate limit, rad/s. */
  pitchRate: 14 * DEG2RAD,
  /** Time constant with which a height error is flown out. */
  heightTime: 3,
  accel: 4,
  decel: 2.5,
  /** Time constant of the pattern frame's heading (low-passed ship heading). */
  frameHeadingTime: 2.5,
  /** Deck-relative guidance fades in between these distances from the touchdown point. */
  couplingFar: 1000,
  couplingNear: 80,
  /** Fastest change of the deck coupling, 1/s (after launch and wave-off it fades out). */
  couplingRate: 0.5,
  /** The glide path is captured exactly between these distances from the touchdown point. */
  captureFar: 600,
  captureNear: 200,
  captureRate: 6,
  /** Angle of attack at approach speed and at pattern speed (adds to the flight-path angle). */
  approachAlpha: 8 * DEG2RAD,
  cruiseAlpha: 2.5 * DEG2RAD,
  gearUpDelay: 1.3,
  /** Gear and hook come down this long after the jet commits to the approach. */
  gearDownDelay: 5,

  // ---- recovery --------------------------------------------------------------------------
  /** Distance from the wire to a full stop. */
  arrestDistance: 95,
  /** Pause on the strip after the arrestment before taxiing clear. */
  rolloutPause: 1.4,

  // ---- camera shake ----------------------------------------------------------------------
  catapultShake: 0.35,
  trapShake: 0.55,
} as const;
