/**
 * Simple terrains for tests: a flat plane (exact plane intersections) and a terrain around any
 * analytic height function (Lipschitz-bounded ray marching). Other modules build their test
 * worlds with these, so their target areas and start stay as the foundation stand-in had them.
 */
import { Vector3 } from 'three';
import { WORLD_SIZE } from '../constants';
import type { SurfaceKind, Terrain, TerrainData, TerrainHit, TargetArea } from './types';

/** The stand-in's three open target areas (kept for other modules' tests). */
function testAreas(): TargetArea[] {
  return [
    { id: 0, name: 'ALPHA', kind: 'open', x: 0, z: -6000, radius: 600, heading: 0 },
    { id: 1, name: 'BRAVO', kind: 'open', x: 4000, z: -9000, radius: 600, heading: 0 },
    { id: 2, name: 'CHARLIE', kind: 'open', x: -5000, z: -11000, radius: 600, heading: 0 },
  ];
}

function emptyData(size: number): TerrainData {
  return { seed: 0, size, resolution: 0, heights: new Float32Array(0), extra: {} };
}

/** A flat world at a fixed height, surface 'grass', no trees: for tests. */
export function createFlatTerrain(height = 0, size = WORLD_SIZE): Terrain {
  const data = emptyData(size);
  const surface: SurfaceKind = 'grass';
  function fill(out: TerrainHit, x: number, z: number, s: number, len: number): void {
    out.point.set(x, height, z);
    out.normal.set(0, 1, 0);
    out.distance = s;
    out.t = len > 0 ? Math.min(1, s / len) : 0;
    out.surface = surface;
  }
  return {
    seed: 0,
    size,
    minHeight: height,
    maxHeight: height,
    heightAt: () => height,
    normalAt: (_x, _z, out) => out.set(0, 1, 0),
    surfaceAt: () => surface,
    canopyAt: () => 0,
    segmentHit(p0, p1, out) {
      const a = p0.y - height;
      if (a <= 0) {
        fill(out, p0.x, p0.z, 0, p0.distanceTo(p1));
        return true;
      }
      const b = p1.y - height;
      if (b > 0) return false;
      const t = a / (a - b);
      const len = p0.distanceTo(p1);
      fill(out, p0.x + (p1.x - p0.x) * t, p0.z + (p1.z - p0.z) * t, t * len, len);
      return true;
    },
    raycast(origin, dir, maxDistance, out) {
      const l = dir.length();
      if (l < 1e-12) return false;
      const dy = dir.y / l;
      const a = origin.y - height;
      if (a <= 0) {
        fill(out, origin.x, origin.z, 0, maxDistance);
        return true;
      }
      if (dy >= 0) return false;
      const s = a / -dy;
      if (s > maxDistance) return false;
      fill(out, origin.x + (dir.x / l) * s, origin.z + (dir.z / l) * s, s, maxDistance);
      return true;
    },
    lineOfSight(a, b) {
      // Both ends at or above the plane: a straight line between them never dips below it.
      return a.y >= height - 1e-9 && b.y >= height - 1e-9;
    },
    roads: [],
    targetAreas: testAreas(),
    airbase: null,
    start: { x: 0, z: 6000, heading: 0 },
    data,
    rivers: [],
    waterLevelAt: () => -Infinity,
    waterDepthAt: () => 0,
    forestDensityAt: () => 0,
    moistureAt: () => 0.5,
    roadDistanceAt: () => Infinity,
    fieldAt: () => false,
    fieldVariantAt: () => -1,
    slopeAt: () => 0,
    sampleAt(_x, _z, out) {
      out.height = height;
      out.normal.set(0, 1, 0);
      out.surface = surface;
      out.canopy = 0;
      out.waterLevel = -Infinity;
      out.forestDensity = 0;
      out.moisture = 0.5;
      out.roadDistance = Infinity;
      out.fieldVariant = -1;
      return out;
    },
    heightGrid(_x0, _z0, _step, n, out) {
      out.fill(height, 0, n * n);
      return out;
    },
  };
}

const _d = new Vector3();
const _hit: TerrainHit = {
  point: new Vector3(),
  normal: new Vector3(),
  distance: 0,
  t: 0,
  surface: 'grass',
};

/**
 * A terrain around any height function (tests, tools). Ray queries march with steps bounded by
 * `maxSlope` (|∇height| must not exceed it), so they never step over the ground, and refine the
 * crossing by bisection to a millimetre.
 */
export function terrainFromHeightFunction(
  data: TerrainData,
  height: (x: number, z: number) => number,
  minHeight: number,
  maxHeight: number,
  maxSlope = 1,
): Terrain {
  const half = data.size / 2;
  const clampX = (v: number) => (v < -half ? -half : v > half ? half : v);
  const heightAt = (x: number, z: number) => height(clampX(x), clampX(z));
  const eps = 0.5;
  const normalAt = (x: number, z: number, out: Vector3) => {
    const hx = heightAt(x + eps, z) - heightAt(x - eps, z);
    const hz = heightAt(x, z + eps) - heightAt(x, z - eps);
    return out.set(-hx, 2 * eps, -hz).normalize();
  };

  /** First crossing along p0 + dir·s, s ∈ [s0, length] (dir unit). */
  function march(p0: Vector3, dir: Vector3, length: number, out: TerrainHit, s0 = 0): boolean {
    const gapAt = (s: number) =>
      p0.y + dir.y * s - heightAt(p0.x + dir.x * s, p0.z + dir.z * s);
    if (p0.y + dir.y * s0 > maxHeight && p0.y + dir.y * length > maxHeight) return false;
    const hx = Math.hypot(dir.x, dir.z);
    const rate = maxSlope * hx - dir.y;
    let s = s0;
    let f = gapAt(s);
    if (f <= 0) {
      fill(out, p0, dir, s, length);
      return true;
    }
    for (let iter = 0; iter < 100000; iter++) {
      if (rate <= 0) return false;
      const step = Math.max(f / rate, 1e-4);
      const next = Math.min(length, s + step);
      const fn = gapAt(next);
      if (fn <= 0.001) {
        // Bisect to a millimetre between the last clear point and the crossing.
        let lo = s;
        let hi = next;
        for (let i = 0; i < 40 && hi - lo > 1e-3; i++) {
          const mid = (lo + hi) / 2;
          if (gapAt(mid) > 0) lo = mid;
          else hi = mid;
        }
        fill(out, p0, dir, hi, length);
        return true;
      }
      if (next >= length) return false;
      s = next;
      f = fn;
    }
    return false;
  }

  function fill(out: TerrainHit, p0: Vector3, dir: Vector3, s: number, length: number): void {
    const x = p0.x + dir.x * s;
    const z = p0.z + dir.z * s;
    out.point.set(x, heightAt(x, z), z);
    normalAt(x, z, out.normal);
    out.distance = s;
    out.t = length > 0 ? s / length : 0;
    out.surface = 'grass';
  }

  return {
    seed: data.seed,
    size: data.size,
    minHeight,
    maxHeight,
    heightAt,
    normalAt,
    surfaceAt: () => 'grass',
    canopyAt: () => 0,
    segmentHit(p0, p1, out) {
      _d.subVectors(p1, p0);
      const len = _d.length();
      if (len < 1e-9) return false;
      _d.multiplyScalar(1 / len);
      return march(p0, _d, len, out);
    },
    raycast(origin, dir, maxDistance, out) {
      _d.copy(dir).normalize();
      return march(origin, _d, maxDistance, out);
    },
    lineOfSight(a, b) {
      _d.subVectors(b, a);
      const len = _d.length();
      if (len <= 2) return true;
      _d.multiplyScalar(1 / len);
      return !march(a, _d, len - 1, _hit, 1);
    },
    roads: [],
    targetAreas: testAreas(),
    airbase: null,
    start: { x: 0, z: 6000, heading: 0 },
    data,
  };
}
