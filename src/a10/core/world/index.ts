/**
 * WORLD module public API. FOUNDATION STAND-IN: a smooth procedural height field with correct
 * ray tests, so every other module can work before the real world generator lands. The world
 * module owner replaces the implementation but keeps these exports and their meaning.
 */
import { Vector3 } from 'three';
import { WORLD_SIZE } from '../constants';
import type { Sim } from '../types';
import type { Terrain, TerrainData, TerrainHit, WorldState } from './types';

export * from './atmosphere';
export type * from './types';

const _a = new Vector3();
const _b = new Vector3();
const _d = new Vector3();

/** Analytic stand-in height: gentle hills that rise toward the map edges, 150 m at the centre. */
function standInHeight(x: number, z: number): number {
  const r = Math.hypot(x, z) / (WORLD_SIZE / 2);
  return (
    150 +
    60 * Math.sin(x * 0.00031) * Math.cos(z * 0.00027) +
    25 * Math.sin(x * 0.0013 + 1.3) * Math.sin(z * 0.0011 + 0.4) +
    6 * Math.sin(x * 0.0071) * Math.cos(z * 0.0063) +
    400 * Math.max(0, r - 0.6) ** 2
  );
}

/**
 * Build a Terrain around any height function: ray marching with bisection refinement. The real
 * world module may reuse this or replace it with something faster.
 */
export function terrainFromHeightFunction(
  data: TerrainData,
  height: (x: number, z: number) => number,
  minHeight: number,
  maxHeight: number,
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

  function march(p0: Vector3, dir: Vector3, length: number, out: TerrainHit): boolean {
    // Above everything along the whole path: no hit possible.
    if (p0.y > maxHeight && p0.y + dir.y * length > maxHeight) return false;
    const step = Math.max(2, Math.min(25, length / 8));
    let prevS = 0;
    if (p0.y - heightAt(p0.x, p0.z) <= 0) {
      fill(out, p0, 0, length);
      return true;
    }
    for (let s = step; ; s += step) {
      if (s > length) s = length;
      const x = p0.x + dir.x * s;
      const y = p0.y + dir.y * s;
      const z = p0.z + dir.z * s;
      const h = y - heightAt(x, z);
      if (h <= 0) {
        // Bisect between prevS and s.
        let lo = prevS;
        let hi = s;
        for (let i = 0; i < 24; i++) {
          const mid = (lo + hi) / 2;
          const mh = p0.y + dir.y * mid - heightAt(p0.x + dir.x * mid, p0.z + dir.z * mid);
          if (mh > 0) lo = mid;
          else hi = mid;
        }
        _a.set(p0.x + dir.x * hi, p0.y + dir.y * hi, p0.z + dir.z * hi);
        fill(out, _a, hi, length);
        return true;
      }
      prevS = s;
      if (s >= length) return false;
    }
  }

  function fill(out: TerrainHit, p: Vector3, distance: number, length: number): void {
    out.point.set(p.x, heightAt(p.x, p.z), p.z);
    normalAt(p.x, p.z, out.normal);
    out.distance = distance;
    out.t = length > 0 ? distance / length : 0;
    out.surface = 'grass';
  }

  const terrain: Terrain = {
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
      _b.subVectors(b, a);
      const len = _b.length();
      if (len < 1e-6) return true;
      _b.multiplyScalar(1 / len);
      const hit: TerrainHit = {
        point: new Vector3(),
        normal: new Vector3(),
        distance: 0,
        t: 0,
        surface: 'grass',
      };
      // Stop 1 m short of the end point so a point on the ground can see itself.
      return !march(a, _b, Math.max(0, len - 1), hit);
    },
    roads: [],
    targetAreas: [
      { id: 0, name: 'ALPHA', kind: 'open', x: 0, z: -6000, radius: 600 },
      { id: 1, name: 'BRAVO', kind: 'open', x: 4000, z: -9000, radius: 600 },
      { id: 2, name: 'CHARLIE', kind: 'open', x: -5000, z: -11000, radius: 600 },
    ],
    airbase: null,
    start: { x: 0, z: 6000, heading: 0 },
    data,
  };
  return terrain;
}

/** Generate the world's data from a seed (pure, transferable). Stand-in: no grid needed. */
export function generateTerrainData(seed: number): TerrainData {
  return { seed, size: WORLD_SIZE, resolution: 0, heights: new Float32Array(0), extra: {} };
}

/** Rebuild the Terrain from its data (main thread, workers, tests). */
export function createTerrain(data: TerrainData): Terrain {
  return terrainFromHeightFunction(data, standInHeight, 0, 900);
}

/** A flat world at a fixed height: for tests. */
export function createFlatTerrain(height = 0, size = WORLD_SIZE): Terrain {
  const data: TerrainData = {
    seed: 0,
    size,
    resolution: 0,
    heights: new Float32Array(0),
    extra: {},
  };
  return terrainFromHeightFunction(data, () => height, height, height);
}

export function createWorldState(terrain: Terrain): WorldState {
  return {
    terrain,
    surfaceWind: new Vector3(0, 0, 0),
    turbulence: 0.15,
    timeOfDay: 10.5,
    visibilityKm: 30,
    isaDeviation: 0,
  };
}

/**
 * Wind at a world position (world m/s, the direction the air moves toward): the surface wind
 * growing with height above the ground (power law), without turbulence (the flight module adds
 * its own gusts from sim.rng.air).
 */
export function windAt(world: WorldState, position: Vector3, out: Vector3): Vector3 {
  const agl = Math.max(1, position.y - world.terrain.heightAt(position.x, position.z));
  const factor = Math.min(2.2, Math.pow(agl / 10, 1 / 7));
  return out.copy(world.surfaceWind).multiplyScalar(factor);
}

/** Per-step world update (weather changes). Stand-in: nothing changes. */
export function stepWorld(_sim: Sim, _dt: number): void {}
