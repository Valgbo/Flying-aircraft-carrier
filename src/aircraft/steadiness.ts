/**
 * Deck steadiness: how good a platform the flight deck is right now, 0 (wild) .. 1 (rock
 * steady), and what a recovery is worth on it. Pure functions — no sim, no store.
 */
import type { Quaternion, Vector3 } from 'three';
import type { RecoveryResult } from '../state/types';
import { RAD2DEG, clamp, clamp01, damp, lerp } from '../utils/math';
import { OPS } from './opsConfig';

/** The part of the ship state the air wing needs (CarrierSim satisfies it). */
export interface ShipState {
  position: Vector3;
  quaternion: Quaternion;
  /** World angular velocity, rad/s. */
  angularVelocity: Vector3;
  /** Rad, positive = bow up. */
  pitch: number;
  /** Rad, positive = starboard side down. */
  roll: number;
  /** m/s, positive = climbing. */
  verticalSpeed: number;
  /** Felt acceleration along the ship's up axis, g. */
  gLoad: number;
}

/** What disturbs a deck, as magnitudes. */
export interface DeckMotion {
  /** Angle between the deck normal and the vertical, rad. */
  tilt: number;
  /** Pitch / roll rate, rad/s. */
  tiltRate: number;
  /** Vertical speed, m/s. */
  heave: number;
  /** |g-load − 1|. */
  gDeviation: number;
  /** Yaw rate, rad/s. */
  turnRate: number;
}

export function makeDeckMotion(): DeckMotion {
  return { tilt: 0, tiltRate: 0, heave: 0, gDeviation: 0, turnRate: 0 };
}

/** Extract the deck motion from the ship state (allocation-free). */
export function deckMotionOf(ship: ShipState, out: DeckMotion): DeckMotion {
  out.tilt = Math.acos(clamp(Math.cos(ship.pitch) * Math.cos(ship.roll), -1, 1));
  out.tiltRate = Math.hypot(ship.angularVelocity.x, ship.angularVelocity.z);
  out.heave = Math.abs(ship.verticalSpeed);
  out.gDeviation = Math.abs(ship.gLoad - 1);
  out.turnRate = Math.abs(ship.angularVelocity.y);
  return out;
}

/**
 * Combined disturbance: each component is measured against the limit at which it alone makes
 * the deck unusable, and the components add like independent errors (root sum of squares).
 */
export function deckDisturbance(m: DeckMotion): number {
  return Math.hypot(
    m.tilt / OPS.tiltLimit,
    m.tiltRate / OPS.tiltRateLimit,
    m.heave / OPS.heaveLimit,
    m.gDeviation / OPS.gLimit,
    m.turnRate / OPS.turnRateLimit,
  );
}

/** Instantaneous steadiness 0..1 for a deck motion: 1 when level and still. */
export function steadinessOf(m: DeckMotion): number {
  return 1 - clamp01(deckDisturbance(m));
}

const _motion = makeDeckMotion();

/** Instantaneous steadiness 0..1 of a ship state. */
export function shipSteadiness(ship: ShipState): number {
  return steadinessOf(deckMotionOf(ship, _motion));
}

/** Advance the smoothed steadiness (about one second of memory) toward the instantaneous one. */
export function smoothSteadiness(current: number, instantaneous: number, dt: number): number {
  return clamp01(damp(current, instantaneous, OPS.steadinessRate, dt));
}

/** Points for a recovery at the given steadiness: 100..1000, a multiple of ten. */
export function recoveryPoints(steadiness: number): number {
  return Math.round(lerp(OPS.minPoints, OPS.maxPoints, clamp01(steadiness)) / 10) * 10;
}

export type RecoveryGrade = 'PERFECT' | 'GOOD' | 'FAIR' | 'ROUGH';

export function recoveryGrade(steadiness: number): RecoveryGrade {
  if (steadiness >= OPS.gradePerfect) return 'PERFECT';
  if (steadiness >= OPS.gradeGood) return 'GOOD';
  if (steadiness >= OPS.gradeFair) return 'FAIR';
  return 'ROUGH';
}

export const WAVE_OFF_GRADE = 'WAVE-OFF';

/** The record of a recovery (or, with `trapped` false, of a wave-off) for the HUD. */
export function recoveryResult(
  jetId: number,
  steadiness: number,
  motion: DeckMotion,
  trapped: boolean,
): RecoveryResult {
  return {
    jetId,
    points: trapped ? recoveryPoints(steadiness) : 0,
    grade: trapped ? recoveryGrade(steadiness) : WAVE_OFF_GRADE,
    deckTiltDeg: motion.tilt * RAD2DEG,
    deckHeave: motion.heave,
  };
}
