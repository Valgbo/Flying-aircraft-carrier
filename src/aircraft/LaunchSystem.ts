/**
 * Launch system: the two bow catapults. Pure kinematics of the stroke plus the bookkeeping
 * of which jet holds which catapult, how many launch requests are waiting and when the next
 * stroke may fire.
 */
import { CATAPULTS } from '../config/layout';
import { OPS } from './opsConfig';
import { headingOf } from './railPath';

export interface CatapultTrack {
  /** Display number (1-based, from the layout). */
  id: number;
  startX: number;
  startZ: number;
  /** Unit direction of the stroke. */
  dirX: number;
  dirZ: number;
  length: number;
  /** Deck heading of the track, rad. */
  heading: number;
}

export const CATAPULT_TRACKS: readonly CatapultTrack[] = CATAPULTS.map((cat) => {
  const dx = cat.end[0] - cat.start[0];
  const dz = cat.end[2] - cat.start[2];
  const length = Math.hypot(dx, dz);
  return {
    id: cat.id,
    startX: cat.start[0],
    startZ: cat.start[2],
    dirX: dx / length,
    dirZ: dz / length,
    length,
    heading: headingOf(dx, dz),
  };
});

/** Constant acceleration that reaches the end speed exactly at the end of the track, m/s². */
export function strokeAcceleration(trackLength: number): number {
  return (OPS.catapultEndSpeed * OPS.catapultEndSpeed) / (2 * trackLength);
}

/** Duration of the stroke, s. */
export function strokeDuration(trackLength: number): number {
  return (2 * trackLength) / OPS.catapultEndSpeed;
}

export interface StrokeState {
  /** Distance travelled along the track, m (may exceed the track length on the last step). */
  distance: number;
  speed: number;
}

/** Position and speed `t` seconds into the stroke. */
export function strokeAt(trackLength: number, t: number, out: StrokeState): StrokeState {
  const a = strokeAcceleration(trackLength);
  out.distance = 0.5 * a * t * t;
  out.speed = a * t;
  return out;
}

export class LaunchSystem {
  /** Launch requests accepted but not yet given a jet and a catapult. */
  pending = 0;
  /** Jet id holding each catapult (0 = free). */
  readonly occupant: number[] = CATAPULT_TRACKS.map(() => 0);
  /** Time of the last stroke and time before which no stroke may fire. */
  private lastStroke = -Infinity;
  private holdUntil = -Infinity;

  reset(): void {
    this.pending = 0;
    this.occupant.fill(0);
    this.lastStroke = -Infinity;
    this.holdUntil = -Infinity;
  }

  /** Index of a free catapult, or -1. */
  freeCatapult(): number {
    return this.occupant.indexOf(0);
  }

  assign(catapult: number, jetId: number): void {
    this.occupant[catapult] = jetId;
  }

  release(catapult: number): void {
    this.occupant[catapult] = 0;
  }

  /** Keep the catapults quiet until `time` (a waved-off jet is passing over the bow). */
  hold(time: number): void {
    this.holdUntil = Math.max(this.holdUntil, time);
  }

  /** True when the launch interval and any hold have run out. */
  intervalClear(time: number): boolean {
    return time >= this.holdUntil && time - this.lastStroke >= OPS.launchInterval;
  }

  /**
   * Is the deck steady enough to fire? A shot that was already held needs a little more
   * margin, so it does not fire on the first flicker above the limit.
   */
  deckSteady(steadiness: number, held: boolean): boolean {
    return steadiness >= OPS.minSteadiness + (held ? OPS.steadinessHysteresis : 0);
  }

  fired(time: number): void {
    this.lastStroke = time;
  }
}
