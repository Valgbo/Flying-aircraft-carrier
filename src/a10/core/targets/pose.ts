/**
 * Vehicle poses: the hull frame (heading, pitch and roll composed exactly as the renderer does,
 * with quaternionFromAttitude) and the turret frame (the hull frame turned by turretYaw about the
 * ring axis, + clockwise from the bow, as the vehicle shader turns the turret).
 *
 * All transforms write into module-level scratch objects or caller-provided ones: no allocation.
 */
import { Matrix4, Quaternion } from 'three';
import { quaternionFromAttitude } from '../frames';
import type { Vehicle } from './types';

const _q = new Quaternion();
const _m = new Matrix4();

/** A vehicle's pose: position, hull→world rotation (row-major), turret yaw and ring axis. */
export interface Pose {
  px: number;
  py: number;
  pz: number;
  /** Hull→world rotation matrix, row-major: world = R · hull. */
  r00: number;
  r01: number;
  r02: number;
  r10: number;
  r11: number;
  r12: number;
  r20: number;
  r21: number;
  r22: number;
  /** cos and sin of -turretYaw (the shader's angle) and the ring axis position along z. */
  tc: number;
  ts: number;
  tz: number;
}

export function createPose(): Pose {
  return {
    px: 0,
    py: 0,
    pz: 0,
    r00: 1,
    r01: 0,
    r02: 0,
    r10: 0,
    r11: 1,
    r12: 0,
    r20: 0,
    r21: 0,
    r22: 1,
    tc: 1,
    ts: 0,
    tz: 0,
  };
}

/** Fill `out` with the current pose of `v` (turret ring axis at `turretZ` along the hull). */
export function poseOf(v: Vehicle, turretZ: number, out: Pose): Pose {
  quaternionFromAttitude(v.heading, v.pitch, v.roll, _q);
  _m.makeRotationFromQuaternion(_q);
  const e = _m.elements; // column-major
  out.r00 = e[0];
  out.r01 = e[4];
  out.r02 = e[8];
  out.r10 = e[1];
  out.r11 = e[5];
  out.r12 = e[9];
  out.r20 = e[2];
  out.r21 = e[6];
  out.r22 = e[10];
  out.px = v.position.x;
  out.py = v.position.y;
  out.pz = v.position.z;
  out.tc = Math.cos(v.turretYaw);
  out.ts = -Math.sin(v.turretYaw);
  out.tz = turretZ;
  return out;
}

/**
 * The pose of `v`, cached on the vehicle and recomputed only when its position, attitude or
 * turret yaw changed (so code that moves a vehicle by hand needs no notification).
 */
export function vehiclePose(v: Vehicle, turretZ: number): Pose {
  const rt = v.internal;
  const k = rt.poseKey;
  const p = v.position;
  if (
    k[0] !== v.heading ||
    k[1] !== v.pitch ||
    k[2] !== v.roll ||
    k[3] !== v.turretYaw ||
    k[4] !== p.x ||
    k[5] !== p.y ||
    k[6] !== p.z
  ) {
    poseOf(v, turretZ, rt.pose);
    k[0] = v.heading;
    k[1] = v.pitch;
    k[2] = v.roll;
    k[3] = v.turretYaw;
    k[4] = p.x;
    k[5] = p.y;
    k[6] = p.z;
  }
  return rt.pose;
}

/** A plain 3-vector for the transforms below. */
export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** World point → hull frame. */
export function worldToHull(p: Pose, x: number, y: number, z: number, out: V3): V3 {
  const dx = x - p.px;
  const dy = y - p.py;
  const dz = z - p.pz;
  out.x = p.r00 * dx + p.r10 * dy + p.r20 * dz;
  out.y = p.r01 * dx + p.r11 * dy + p.r21 * dz;
  out.z = p.r02 * dx + p.r12 * dy + p.r22 * dz;
  return out;
}

/** World direction → hull frame. */
export function worldDirToHull(p: Pose, x: number, y: number, z: number, out: V3): V3 {
  out.x = p.r00 * x + p.r10 * y + p.r20 * z;
  out.y = p.r01 * x + p.r11 * y + p.r21 * z;
  out.z = p.r02 * x + p.r12 * y + p.r22 * z;
  return out;
}

/** Hull point → world. */
export function hullToWorld(p: Pose, x: number, y: number, z: number, out: V3): V3 {
  out.x = p.px + p.r00 * x + p.r01 * y + p.r02 * z;
  out.y = p.py + p.r10 * x + p.r11 * y + p.r12 * z;
  out.z = p.pz + p.r20 * x + p.r21 * y + p.r22 * z;
  return out;
}

/** Hull direction → world. */
export function hullDirToWorld(p: Pose, x: number, y: number, z: number, out: V3): V3 {
  out.x = p.r00 * x + p.r01 * y + p.r02 * z;
  out.y = p.r10 * x + p.r11 * y + p.r12 * z;
  out.z = p.r20 * x + p.r21 * y + p.r22 * z;
  return out;
}

/** Hull point → turret frame (the turret drawn facing the bow). */
export function hullToTurret(p: Pose, x: number, y: number, z: number, out: V3): V3 {
  const qz = z - p.tz;
  out.x = p.tc * x - p.ts * qz;
  out.y = y;
  out.z = p.tz + p.ts * x + p.tc * qz;
  return out;
}

/** Hull direction → turret frame. */
export function hullDirToTurret(p: Pose, x: number, y: number, z: number, out: V3): V3 {
  out.x = p.tc * x - p.ts * z;
  out.y = y;
  out.z = p.ts * x + p.tc * z;
  return out;
}

/** Turret point → hull frame (the vehicle shader's turret rotation). */
export function turretToHull(p: Pose, x: number, y: number, z: number, out: V3): V3 {
  const qz = z - p.tz;
  out.x = p.tc * x + p.ts * qz;
  out.y = y;
  out.z = p.tz - p.ts * x + p.tc * qz;
  return out;
}

/** Turret direction → hull frame. */
export function turretDirToHull(p: Pose, x: number, y: number, z: number, out: V3): V3 {
  out.x = p.tc * x + p.ts * z;
  out.y = y;
  out.z = -p.ts * x + p.tc * z;
  return out;
}
