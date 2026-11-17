/**
 * Helpers for walking the road network (vehicle columns, map drawing): arc length, the point and
 * direction at a distance along a road, and the nearest road point to a position. They work on
 * generated roads (with `arc`) and on hand-built test roads (arc computed once and cached).
 */
import { headingOf } from '../frames';
import type { RoadPolyline } from './types';

/** A point on a road centre line. */
export interface RoadPoint {
  x: number;
  z: number;
  /** Road-bed height there, m (NaN if the road has no heights). */
  y: number;
  /** Direction of travel (increasing distance), rad, compass. */
  heading: number;
  /** Distance along the road, m. */
  distance: number;
  /** Index of the segment (vertex i → i + 1). */
  segment: number;
  /** nearestRoadPoint only: index into the roads array and the distance from (x, z), m. */
  roadIndex: number;
  offset: number;
}

export function createRoadPoint(): RoadPoint {
  return { x: 0, z: 0, y: NaN, heading: 0, distance: 0, segment: 0, roadIndex: -1, offset: 0 };
}

const arcCache = new WeakMap<RoadPolyline, Float64Array>();

function arcOf(road: RoadPolyline): Float64Array {
  if (road.arc) return road.arc;
  let a = arcCache.get(road);
  if (!a) {
    const p = road.points;
    const n = p.length / 2;
    a = new Float64Array(n);
    for (let i = 1; i < n; i++)
      a[i] = a[i - 1] + Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
    arcCache.set(road, a);
  }
  return a;
}

/** Centre-line length of a road, m. */
export function roadLength(road: RoadPolyline): number {
  const a = arcOf(road);
  return a.length ? a[a.length - 1] : 0;
}

/** The point `distance` metres along a road (clamped to its ends). */
export function pointAlongRoad(road: RoadPolyline, distance: number, out: RoadPoint): RoadPoint {
  const a = arcOf(road);
  const p = road.points;
  const n = a.length;
  if (n < 2) {
    out.x = p[0] ?? 0;
    out.z = p[1] ?? 0;
    out.y = road.heights ? road.heights[0] : NaN;
    out.heading = 0;
    out.distance = 0;
    out.segment = 0;
    return out;
  }
  const d = distance < 0 ? 0 : distance > a[n - 1] ? a[n - 1] : distance;
  // Binary search for the segment.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= d) lo = mid;
    else hi = mid;
  }
  const len = a[hi] - a[lo];
  const t = len > 0 ? (d - a[lo]) / len : 0;
  const ax = p[2 * lo];
  const az = p[2 * lo + 1];
  const dx = p[2 * hi] - ax;
  const dz = p[2 * hi + 1] - az;
  out.x = ax + dx * t;
  out.z = az + dz * t;
  out.y = road.heights ? road.heights[lo] + (road.heights[hi] - road.heights[lo]) * t : NaN;
  out.heading = headingOf(dx, dz);
  out.distance = d;
  out.segment = lo;
  return out;
}

/** Nearest point on any of `roads` to (x, z). Returns false if there are no roads. */
export function nearestRoadPoint(
  roads: readonly RoadPolyline[],
  x: number,
  z: number,
  out: RoadPoint,
): boolean {
  let best = Infinity;
  for (let r = 0; r < roads.length; r++) {
    const road = roads[r];
    const p = road.points;
    const a = arcOf(road);
    for (let i = 0; i < p.length / 2 - 1; i++) {
      const ax = p[2 * i];
      const az = p[2 * i + 1];
      const dx = p[2 * i + 2] - ax;
      const dz = p[2 * i + 3] - az;
      // Cheap reject by bounding box.
      const minX = (dx < 0 ? ax + dx : ax) - best;
      const maxX = (dx < 0 ? ax : ax + dx) + best;
      if (x < minX || x > maxX) continue;
      const minZ = (dz < 0 ? az + dz : az) - best;
      const maxZ = (dz < 0 ? az : az + dz) + best;
      if (z < minZ || z > maxZ) continue;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + dx * t;
      const qz = az + dz * t;
      const d = Math.hypot(x - qx, z - qz);
      if (d < best) {
        best = d;
        out.x = qx;
        out.z = qz;
        out.y = road.heights ? road.heights[i] + (road.heights[i + 1] - road.heights[i]) * t : NaN;
        out.heading = headingOf(dx, dz);
        out.distance = a[i] + t * Math.sqrt(l2);
        out.segment = i;
        out.roadIndex = r;
        out.offset = d;
      }
    }
  }
  return best < Infinity;
}
