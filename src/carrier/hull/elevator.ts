/**
 * Aircraft-elevator schedule. The platform spends most of its time flush with the flight deck
 * and makes one eased trip down to the hangar deck and back per cycle. Pure functions of the
 * simulation time so every system (visuals, flight ops, cameras) agrees on where it is.
 */
import { ELEVATOR } from '../../config/layout';

/** Seconds: one full cycle = holdUp + travel (down) + holdDown + travel (up). */
export const ELEVATOR_CYCLE = {
  period: 60,
  holdUp: 38,
  travel: 8,
  holdDown: 6,
} as const;

/** Zero slope and curvature at both ends, so the platform starts and stops gently. */
function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 0 = raised (flush with the flight deck) … 1 = lowered (hangar deck). */
export function elevatorLoweredFraction(time: number): number {
  if (!Number.isFinite(time)) return 0;
  const { period, holdUp, travel, holdDown } = ELEVATOR_CYCLE;
  const t = ((time % period) + period) % period;
  if (t < holdUp) return 0;
  if (t < holdUp + travel) return smootherstep((t - holdUp) / travel);
  if (t < holdUp + travel + holdDown) return 1;
  return 1 - smootherstep((t - holdUp - travel - holdDown) / travel);
}

/** Carrier-local y of the elevator platform surface at simulation time `time` (seconds). */
export function elevatorHeightAt(time: number): number {
  return ELEVATOR.topY + (ELEVATOR.bottomY - ELEVATOR.topY) * elevatorLoweredFraction(time);
}
