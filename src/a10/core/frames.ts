/**
 * Coordinate frames (docs/a10/ARCHITECTURE.md §2).
 *
 * WORLD: metres, +Y up, +X east, -Z north, origin at the centre of the map, y = 0 at sea level.
 * BODY (aircraft): +X right wing, +Y up, -Z nose. Origin at the aircraft reference point (the
 *   centre of gravity of the empty aircraft; see data/aircraft.ts). A body→world rotation is a
 *   three.js Quaternion. Body angular velocity follows the right-hand rule about these axes:
 *   ω.x > 0 pitches the nose UP, ω.y > 0 yaws the nose LEFT, ω.z > 0 rolls LEFT (right wing up).
 *   Use the aviation-style accessors below (p, q, r) when writing flight equations.
 *
 * Attitude: heading ψ (0 = north, clockwise, [0, 2π)), pitch θ (+ nose up), bank φ (+ right
 * wing down). HUD angles: azimuth (+ right) and elevation (+ up) of a direction relative to the
 * boresight (body -Z).
 *
 * All helpers write into `out` and allocate nothing.
 */
import { Euler, Quaternion, Vector3 } from 'three';

const _q = new Quaternion();
const _e = new Euler(0, 0, 0, 'YXZ');

export interface Attitude {
  /** rad, [0, 2π), 0 = north, π/2 = east. */
  heading: number;
  /** rad, + nose up. */
  pitch: number;
  /** rad, + right wing down. */
  bank: number;
}

export interface HudAngles {
  /** rad, + right of the boresight. */
  az: number;
  /** rad, + above the boresight. */
  el: number;
}

/** Rotate a body-frame vector into the world frame. */
export function bodyToWorld(q: Quaternion, v: Vector3, out: Vector3): Vector3 {
  return out.copy(v).applyQuaternion(q);
}

/** Rotate a world-frame vector into the body frame. */
export function worldToBody(q: Quaternion, v: Vector3, out: Vector3): Vector3 {
  _q.copy(q).invert();
  return out.copy(v).applyQuaternion(_q);
}

/** Heading, pitch and bank of a body→world rotation. */
export function attitudeFromQuaternion(q: Quaternion, out: Attitude): Attitude {
  _e.setFromQuaternion(q, 'YXZ');
  let h = -_e.y;
  if (h < 0) h += Math.PI * 2;
  if (h >= Math.PI * 2) h -= Math.PI * 2;
  out.heading = h;
  out.pitch = _e.x;
  out.bank = -_e.z;
  return out;
}

/** Body→world rotation from heading, pitch and bank (radians). */
export function quaternionFromAttitude(
  heading: number,
  pitch: number,
  bank: number,
  out: Quaternion,
): Quaternion {
  _e.set(pitch, -heading, -bank, 'YXZ');
  return out.setFromEuler(_e);
}

/** Aviation roll rate p (rad/s, + right wing going down) from body angular velocity. */
export function rollRate(omegaBody: Vector3): number {
  return -omegaBody.z;
}

/** Aviation pitch rate q (rad/s, + nose going up) from body angular velocity. */
export function pitchRate(omegaBody: Vector3): number {
  return omegaBody.x;
}

/** Aviation yaw rate r (rad/s, + nose going right) from body angular velocity. */
export function yawRate(omegaBody: Vector3): number {
  return -omegaBody.y;
}

/** Body angular velocity from aviation rates p, q, r. */
export function omegaFromRates(p: number, q: number, r: number, out: Vector3): Vector3 {
  return out.set(q, -r, -p);
}

/** HUD azimuth/elevation of a body-frame direction (need not be unit length). */
export function hudAnglesFromBodyDir(d: Vector3, out: HudAngles): HudAngles {
  out.az = Math.atan2(d.x, -d.z);
  out.el = Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z));
  return out;
}

/** Unit body-frame direction from HUD azimuth/elevation. */
export function bodyDirFromHudAngles(az: number, el: number, out: Vector3): Vector3 {
  const c = Math.cos(el);
  return out.set(Math.sin(az) * c, Math.sin(el), -Math.cos(az) * c);
}

/**
 * Gnomonic (flat HUD plane) coordinates of a body-frame direction: where it lands on a plane one
 * unit in front of the eye, + right / + up. Equal to (tan az, tan el / cos az) and ≈ (az, el)
 * for small angles. Returns false if the direction points behind the eye.
 */
export function hudPlaneFromBodyDir(d: Vector3, out: { x: number; y: number }): boolean {
  if (d.z >= -1e-9) return false;
  out.x = d.x / -d.z;
  out.y = d.y / -d.z;
  return true;
}

/** Wrap an angle to (-π, π]. */
export function wrapPi(a: number): number {
  const TAU = Math.PI * 2;
  a = (a + Math.PI) % TAU;
  if (a <= 0) a += TAU;
  return a - Math.PI;
}

/** Compass heading (rad, [0, 2π)) of a horizontal world direction. */
export function headingOf(dx: number, dz: number): number {
  let h = Math.atan2(dx, -dz);
  if (h < 0) h += Math.PI * 2;
  return h;
}
