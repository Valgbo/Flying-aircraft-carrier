/**
 * Thrust bookkeeping for the hangar demo readout: what the four turbines produce right now,
 * how much of it is lift and how that compares with the weight of the ship.
 * Pure functions over physics-config units (kN); covered by tests/unit/shell.test.ts.
 */
import { TURBINE_COUNT } from '../../config/layout';
import { PHYS, WEIGHT } from '../../config/physicsConfig';
import { DEG2RAD } from '../../utils/math';

/** All turbines at full power, kN. */
export const MAX_TOTAL_THRUST = TURBINE_COUNT * PHYS.maxThrust;

/** Lift within ±2 % of the weight reads as a hover — nobody holds a slider on an exact value. */
const HOVER_BAND = 0.02;

/** What the ship would do with this much lift: come down, hold her altitude, or go up. */
export type LiftState = 'sink' | 'hover' | 'climb';

export interface ThrustSummary {
  /** Sum of the thrust magnitudes of all turbines, kN. */
  totalKN: number;
  /** Vertical component (along the ship's up axis), kN — the part that fights the weight. */
  liftKN: number;
  /** Component along the bow direction, kN (negative when the nacelles lean aft). */
  forwardKN: number;
  /** liftKN / WEIGHT. 1 = exactly enough to hover. */
  liftRatio: number;
  state: LiftState;
}

export function liftStateFor(liftRatio: number): LiftState {
  if (liftRatio > 1 + HOVER_BAND) return 'climb';
  if (liftRatio < 1 - HOVER_BAND) return 'sink';
  return 'hover';
}

/**
 * Combine per-turbine thrust (kN) and tilt (degrees, 0 = straight up, positive = toward the
 * bow) into totals. Follows the thrust-axis convention of the flight model:
 * local thrust axis = (0, cos tilt, -sin tilt).
 */
export function summariseThrust(
  thrustKN: readonly number[],
  tiltDeg: readonly number[],
): ThrustSummary {
  let totalKN = 0;
  let liftKN = 0;
  let forwardKN = 0;
  for (let i = 0; i < thrustKN.length; i++) {
    const thrust = thrustKN[i];
    const tilt = (tiltDeg[i] ?? 0) * DEG2RAD;
    totalKN += thrust;
    liftKN += thrust * Math.cos(tilt);
    forwardKN += thrust * Math.sin(tilt);
  }
  const liftRatio = liftKN / WEIGHT;
  return { totalKN, liftKN, forwardKN, liftRatio, state: liftStateFor(liftRatio) };
}
