/**
 * Where things are DRAWN this frame (ARCHITECTURE §6 "Interpolation"). OWNED BY THE COCKPIT
 * MODULE. Pure math on the simulation state and `frameInfo.alpha` (no scene, no DOM), so it is
 * unit-tested (tests/unit/a10/cockpitInterpolation.test.ts).
 *
 * The simulation steps at 120 Hz while displays run at 60–165 Hz, so a frame takes 0, 1 or 2
 * steps. Placing a camera at the last step's pose makes the world stand still on frames without
 * a step and jump on frames with two (at 144 Hz one frame in six freezes). Every camera is
 * therefore placed from the pose interpolated between the start and the end of the last step —
 * `drawPose` (view/frame.ts), one step (≤ 8.3 ms) behind the simulation — and so is everything
 * the cockpit pass lights from the aircraft's attitude.
 */
import { Quaternion, Vector3 } from 'three';
import { SIM_DT } from '../../core/constants';
import type { Sim } from '../../core/types';
import type { StoreBody } from '../../core/weapons/types';
import { drawPose, frameInfo } from '../frame';

const _p = new Vector3();
const _q = new Quaternion();

/**
 * The world camera in the cockpit view: the aircraft's drawn pose ∘ the head pose (body frame:
 * the cockpit camera's position and quaternion).
 */
export function cockpitWorldCamera(
  sim: Sim,
  headPosition: Vector3,
  headQuaternion: Quaternion,
  outPosition: Vector3,
  outQuaternion: Quaternion,
): void {
  drawPose(sim, _p, _q);
  outPosition.copy(headPosition).applyQuaternion(_q).add(_p);
  outQuaternion.multiplyQuaternions(_q, headQuaternion);
}

/**
 * A store body's drawn position: the same instant as the aircraft's drawn pose, one step behind
 * minus the fraction `alpha` still in the accumulator. Bodies keep no previous state, so the
 * position is taken back along the body's velocity — exact for the straight path a body flies
 * within one 8.3 ms step.
 */
export function bodyDrawPosition(body: StoreBody, out: Vector3): Vector3 {
  const back = (1 - Math.min(1, Math.max(0, frameInfo.alpha))) * SIM_DT;
  return out.copy(body.position).addScaledVector(body.velocity, -back);
}
