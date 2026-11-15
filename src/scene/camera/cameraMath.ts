/**
 * Pure camera maths: spherical offsets, critically damped smoothing, easing and pose blending.
 * No dependency on `sim`, the store or the DOM, so everything here is unit-testable.
 */
import type { Quaternion, Vector3 } from 'three';
import { wrapAngle } from '../../utils/math';

/** A critically damped follower: the smoothed value and its rate of change. */
export interface Spring {
  value: number;
  velocity: number;
}

export function makeSpring(value = 0): Spring {
  return { value, velocity: 0 };
}

/** Put a spring at rest on `value`. */
export function resetSpring(spring: Spring, value: number): void {
  spring.value = value;
  spring.velocity = 0;
}

/**
 * Advance a critically damped spring toward `target` (exact closed-form step, so it is
 * stable for any `dt` and never overshoots from rest). `smoothTime` is roughly the time the
 * value needs to cover most of the way; `dt = 0` leaves the spring untouched.
 */
export function springTo(spring: Spring, target: number, smoothTime: number, dt: number): number {
  if (dt <= 0) return spring.value;
  if (smoothTime <= 1e-4) {
    resetSpring(spring, target);
    return target;
  }
  const omega = 2 / smoothTime;
  const decay = Math.exp(-omega * dt);
  const offset = spring.value - target;
  const drive = spring.velocity + omega * offset;
  spring.value = target + (offset + drive * dt) * decay;
  spring.velocity = (spring.velocity - omega * drive * dt) * decay;
  return spring.value;
}

/**
 * Like `springTo` for an angle in radians: follows the shortest way round. The spring value
 * is left unwrapped (continuous), which keeps trigonometry on it free of jumps.
 */
export function springAngleTo(
  spring: Spring,
  target: number,
  smoothTime: number,
  dt: number,
): number {
  const nearest = spring.value + wrapAngle(target - spring.value);
  return springTo(spring, nearest, smoothTime, dt);
}

/**
 * Offset of an orbiting camera from its target.
 * `yaw` is the azimuth about world +Y (0 puts the camera on the +Z side, positive yaw moves it
 * toward +X); `pitch` is the elevation above the horizontal plane (positive = above the
 * target, negative = below it).
 */
export function sphericalOffset(
  yaw: number,
  pitch: number,
  distance: number,
  out: Vector3,
): Vector3 {
  const horizontal = Math.cos(pitch) * distance;
  return out.set(
    Math.sin(yaw) * horizontal,
    Math.sin(pitch) * distance,
    Math.cos(yaw) * horizontal,
  );
}

/**
 * Azimuth (same convention as `sphericalOffset`) of the point directly ASTERN of a ship whose
 * bow points along the horizontal direction (forwardX, forwardZ): a camera at this yaw looks
 * along the ship's heading.
 */
export function yawBehind(forwardX: number, forwardZ: number): number {
  return Math.atan2(-forwardX, -forwardZ);
}

/** Smooth ease-in / ease-out on [0, 1] with zero slope at both ends. */
export function easeInOutCubic(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Blend two camera poses: positions linearly, orientations along the shortest arc (slerp).
 * `t` = 0 gives the `from` pose, 1 the `to` pose. Outputs may alias the `to` inputs.
 */
export function blendPose(
  fromPosition: Vector3,
  fromQuaternion: Quaternion,
  toPosition: Vector3,
  toQuaternion: Quaternion,
  t: number,
  outPosition: Vector3,
  outQuaternion: Quaternion,
): void {
  outPosition.lerpVectors(fromPosition, toPosition, t);
  // slerpQuaternions copies its first argument into the output, which would destroy an aliased `to`
  if (outQuaternion === toQuaternion) outQuaternion.slerp(fromQuaternion, 1 - t);
  else outQuaternion.slerpQuaternions(fromQuaternion, toQuaternion, t);
}

/**
 * Multiplier for a framing distance so an object that fits a landscape view still fits a
 * narrow one: 1 for wide screens, growing as the aspect ratio drops below `fitAspect`.
 */
export function portraitFit(aspect: number, fitAspect = 1.3, maxFactor = 2.4): number {
  if (!(aspect > 0)) return 1;
  return Math.min(maxFactor, Math.max(1, fitAspect / aspect));
}
