/**
 * Recovery system: the arrested landing. Pure kinematics of the arrestment, the decision at
 * the ramp, and the landing-interval bookkeeping that spaces jets out on the approach.
 */
import { OPS } from './opsConfig';
import { approachDuration, approachPath } from './pattern';
import type { RailPath } from './railPath';

/** Constant deceleration that stops a jet arriving at `entrySpeed` within the arrest distance. */
export function arrestDeceleration(entrySpeed: number): number {
  return (entrySpeed * entrySpeed) / (2 * OPS.arrestDistance);
}

export interface ArrestState {
  /** Distance run out along the strip since the wire, m. */
  distance: number;
  speed: number;
  done: boolean;
}

/** Position and speed `t` seconds after the hook caught the wire. */
export function arrestAt(entrySpeed: number, t: number, out: ArrestState): ArrestState {
  const a = arrestDeceleration(entrySpeed);
  const stopTime = a > 0 ? entrySpeed / a : 0;
  if (t >= stopTime) {
    out.distance = a > 0 ? OPS.arrestDistance : 0;
    out.speed = 0;
    out.done = true;
  } else {
    out.distance = entrySpeed * t - 0.5 * a * t * t;
    out.speed = entrySpeed - a * t;
    out.done = false;
  }
  return out;
}

export type RampDecision = 'trap' | 'waveoff';

/** The call at the ramp: continue to the wires or go around. */
export function rampDecision(steadiness: number, deckFouled: boolean): RampDecision {
  return deckFouled || steadiness < OPS.minSteadiness ? 'waveoff' : 'trap';
}

export interface ApproachPlan {
  path: RailPath;
  /** Time of touchdown if the approach is flown as planned. */
  touchdownTime: number;
}

const NOMINAL_APPROACH = approachPath(0);

export class RecoverySystem {
  /** Earliest time the landing area is free for the next touchdown. */
  private nextSlot = -Infinity;

  reset(): void {
    this.nextSlot = -Infinity;
  }

  /**
   * Plan an approach for a jet at the decision point at `time`. Returns the path to fly —
   * with the downwind leg extended just enough to keep the landing interval behind the jet
   * ahead — or null when even the longest extension is not enough (fly another circuit).
   */
  plan(time: number): ApproachPlan | null {
    const earliest = time + approachDuration(NOMINAL_APPROACH.length);
    let path = NOMINAL_APPROACH;
    if (earliest < this.nextSlot) {
      // An extension lengthens the downwind leg, the base turn and the final — roughly twice
      // its own length in all. Refine the estimate against the path it actually produces.
      let extension = 0;
      for (let i = 0; i < 3; i++) {
        const late = this.nextSlot - (time + approachDuration(path.length));
        extension += (late * OPS.approachSpeed) / 2;
        if (extension > OPS.maxDownwindExtension) return null;
        path = approachPath(Math.max(0, extension));
      }
    }
    const touchdownTime = time + approachDuration(path.length);
    this.nextSlot = touchdownTime + OPS.landingInterval;
    return { path, touchdownTime };
  }
}
