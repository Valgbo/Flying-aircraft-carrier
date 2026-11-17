/**
 * Geometry shared by the targeting pod and the Maverick seekers: where each sensor sits on the
 * aircraft (BODY frame, from the station geometry), where a vehicle's visible centre is, how large
 * it looks from a direction, and cone limits. Allocation-free (module scratch).
 */
import { Vector3, type Quaternion } from 'three';
import { A10_GEOMETRY } from '../../data/geometry';
import { MAVERICK, MAVERICK_RAILS, TGP } from '../../data/sensors';
import { VEHICLE_SHAPES } from '../../data/vehicles';
import type { Vehicle } from '../targets/types';
import type { StoreType } from '../weapons/types';

// ---- stations ---------------------------------------------------------------------------------------

/** Suspension point of a station, BODY frame (station 6 for an unknown number). */
export function stationPoint(station: number, out: Vector3): Vector3 {
  const s = A10_GEOMETRY.stations[station] ?? A10_GEOMETRY.stations[6];
  return out.set(s?.x ?? 0, s?.y ?? 0, s?.z ?? 0);
}

/** Pylon pitch of a station (negative = nose down), rad. */
export function stationPitch(station: number): number {
  return A10_GEOMETRY.stationPitch[station] ?? 0;
}

/**
 * A point given in a store's frame on `station` (origin at the lugs, body-aligned, −Z forward;
 * the store hangs at the pylon's pitch), BODY frame.
 */
export function storePointBody(
  station: number,
  sx: number,
  sy: number,
  sz: number,
  out: Vector3,
): Vector3 {
  const p = stationPitch(station);
  const c = Math.cos(p);
  const s = Math.sin(p);
  stationPoint(station, out);
  // rotation about +X by the pitch (right-handed: a negative pitch tips the nose, −Z, down)
  out.x += sx;
  out.y += sy * c - sz * s;
  out.z += sy * s + sz * c;
  return out;
}

/** Forward axis of a store hanging on `station` (the pod's or a missile's boresight), BODY frame. */
export function storeAxisBody(station: number, out: Vector3): Vector3 {
  const p = stationPitch(station);
  return out.set(0, Math.sin(p), -Math.cos(p));
}

/** The pod's optical head on `station`, BODY frame. */
export function podHeadBody(station: number, out: Vector3): Vector3 {
  const h = TGP.headOffset;
  return storePointBody(station, h.x, h.y, h.z, out);
}

/** A Maverick's seeker window on `station`, rail `rail` of its launcher, BODY frame. */
export function seekerHeadBody(
  station: number,
  launcher: StoreType | null,
  rail: number,
  out: Vector3,
): Vector3 {
  const rails = launcher ? MAVERICK_RAILS[launcher] : undefined;
  const r = rails ? rails[Math.min(rail, rails.length - 1)] : undefined;
  const o = MAVERICK.seekerOffset;
  return storePointBody(station, (r?.x ?? 0) + o.x, (r?.y ?? 0) + o.y, o.z, out);
}

/** A BODY-frame point placed with the aircraft's pose, WORLD frame. */
export function bodyToWorldPoint(
  position: Vector3,
  orientation: Quaternion,
  body: Vector3,
  out: Vector3,
): Vector3 {
  return out.copy(body).applyQuaternion(orientation).add(position);
}

// ---- vehicles ---------------------------------------------------------------------------------------

/** Height of a vehicle's visible centre above its ground point, m (dug in: the exposed top). */
export function vehicleCentreHeight(v: Vehicle): number {
  const s = VEHICLE_SHAPES[v.kind];
  const turret = v.thrownTurret ? null : s.turret;
  if (v.dugIn) {
    const top = s.hullClearance + s.hullHeight;
    return turret ? top + turret.height * 0.5 : top - 0.1;
  }
  return s.hullClearance + (s.hullHeight + (turret ? turret.height : 0)) * 0.5;
}

/** The visible centre of a vehicle, world (what a sensor aims at and tracks). */
export function vehicleCentre(v: Vehicle, out: Vector3): Vector3 {
  return out.set(v.position.x, v.position.y + vehicleCentreHeight(v), v.position.z);
}

/**
 * Area of a vehicle projected across the unit direction (ux, uy, uz) of a sensor's line of sight,
 * m²: the hull as a box (top, side and end faces, each × |cos| of its angle to the line of sight)
 * with the turret's silhouette on the side and end faces. A dug-in vehicle shows only the top and
 * the turret with the last 0.25 m of hull above its pit.
 */
export function projectedArea(v: Vehicle, ux: number, uy: number, uz: number): number {
  const s = VEHICLE_SHAPES[v.kind];
  const turret = v.thrownTurret ? null : s.turret;
  const fx = Math.sin(v.heading);
  const fz = -Math.cos(v.heading);
  // right = forward turned 90° clockwise seen from above: (−fz, 0, fx)
  const along = Math.abs(ux * fx + uz * fz);
  const across = Math.abs(-ux * fz + uz * fx);
  const sideHeight = v.dugIn ? 0.25 : s.hullClearance + s.hullHeight;
  const turretSil = turret ? 2 * turret.radius * turret.height : 0;
  const top = s.hullLength * s.hullWidth;
  const side = s.hullLength * sideHeight + turretSil;
  const end = s.hullWidth * sideHeight + turretSil;
  return top * Math.abs(uy) + side * across + end * along;
}

/**
 * Angular size of a vehicle seen from `from` along the unit direction `u` (from → centre) at
 * `range`: √(projected area) / range, rad (the side of a square of the same area).
 */
export function angularSize(v: Vehicle, u: Vector3, range: number): number {
  return Math.sqrt(projectedArea(v, u.x, u.y, u.z)) / Math.max(1, range);
}

// ---- cones ------------------------------------------------------------------------------------------

/** Angle between two unit vectors, rad. */
export function angleBetween(a: Vector3, b: Vector3): number {
  const d = a.x * b.x + a.y * b.y + a.z * b.z;
  return Math.acos(d > 1 ? 1 : d < -1 ? -1 : d);
}

const _perp = new Vector3();

/**
 * Turn unit `dir` toward unit `axis` so that it lies within `maxAngle` of it (in place); returns
 * true when it had to be turned (the direction was beyond the cone).
 */
export function clampToCone(dir: Vector3, axis: Vector3, maxAngle: number): boolean {
  const a = angleBetween(dir, axis);
  if (a <= maxAngle) return false;
  // component of dir perpendicular to the axis
  const d = dir.dot(axis);
  _perp.copy(dir).addScaledVector(axis, -d);
  const len = _perp.length();
  if (len < 1e-9) {
    // exactly opposite the axis: pick any perpendicular
    _perp.set(axis.y, -axis.x, 0);
    if (_perp.lengthSq() < 1e-12) _perp.set(0, axis.z, -axis.y);
    _perp.normalize();
  } else _perp.multiplyScalar(1 / len);
  dir.copy(axis).multiplyScalar(Math.cos(maxAngle)).addScaledVector(_perp, Math.sin(maxAngle));
  return true;
}

/**
 * Screen axes of a sensor picture looking along unit `los` (world): `right` and `up` (both unit,
 * perpendicular to the line of sight). Up is the world vertical projected on the picture, so the
 * horizon stays level; looking straight down it is the aircraft's horizontal forward `fwd`.
 */
export function pictureAxes(los: Vector3, fwd: Vector3, right: Vector3, up: Vector3): void {
  // up = world up minus its component along the line of sight
  up.set(0, 1, 0).addScaledVector(los, -los.y);
  if (up.lengthSq() < 1e-6) {
    up.copy(fwd).addScaledVector(los, -fwd.dot(los));
    if (up.lengthSq() < 1e-12) up.set(0, 0, -1).addScaledVector(los, -los.z);
  }
  up.normalize();
  right.crossVectors(los, up).normalize();
}
