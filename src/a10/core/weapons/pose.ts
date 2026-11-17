/**
 * The aircraft's pose at an instant inside the last flight step (docs/a10/ARCHITECTURE.md §5,
 * "Rounds leave at exact times"): rounds and released stores start from the pose at their own
 * exact time, not from the state at the end of the step.
 */
import type { Quaternion, Vector3 } from 'three';
import type { AircraftState } from '../flight/types';

/**
 * The aircraft's position (cubic Hermite from the end positions and velocities), velocity
 * (linear) and orientation (slerp) at fraction f of the last flight step of length dt
 * (f = 0: `prev*`, the start of the step; f = 1: the present state).
 */
export function interpolatePose(
  ac: AircraftState,
  f: number,
  dt: number,
  outPos: Vector3,
  outVel: Vector3,
  outQ: Quaternion,
): void {
  const f2 = f * f;
  const f3 = f2 * f;
  const h01 = 3 * f2 - 2 * f3;
  const h10 = f - 2 * f2 + f3;
  const h11 = f3 - f2;
  outPos
    .copy(ac.prevPosition)
    .lerp(ac.position, h01)
    .addScaledVector(ac.prevVelocity, h10 * dt)
    .addScaledVector(ac.velocity, h11 * dt);
  outVel.copy(ac.prevVelocity).lerp(ac.velocity, f);
  outQ.slerpQuaternions(ac.prevOrientation, ac.orientation, f);
}
