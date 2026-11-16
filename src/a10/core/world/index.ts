/**
 * WORLD module public API (docs/a10/ARCHITECTURE.md §4): the generated range, THE terrain height
 * function and its queries, the standard atmosphere, wind and turbulence.
 *
 *   generateTerrainData(seed) → TerrainData   pure, deterministic, transferable (worker-safe)
 *   createTerrain(data)       → Terrain       heightAt, normals, surfaces, canopy, exact ray
 *                                             queries, line of sight, roads, areas, airbase …
 *   createFlatTerrain(h, size)                 flat test world
 *   createWorldState, windAt, gustAt, stepWorld, ISA functions
 */
import { Vector3 } from 'three';
import type { Sim } from '../types';
import { WIND } from './params';
import type { Terrain, WorldState } from './types';

export * from './atmosphere';
export type * from './types';
export { createTerrain, ROAD_QUERY_RANGE } from './terrain';
export { generateTerrainData } from './generate';
export { createFlatTerrain, terrainFromHeightFunction } from './flat';
export { windAt, gustAt, gustScales, windProfileFactor, type GustScales } from './wind';
export {
  SURFACE_KINDS,
  SURFACE_INDEX,
  worldExtra,
  maskAt,
  surfaceMaskAt,
  gridX,
  gridZ,
  type WorldMask,
} from './extra';
export {
  roadLength,
  pointAlongRoad,
  nearestRoadPoint,
  createRoadPoint,
  type RoadPoint,
} from './roads';
export { ISA, WIND, TURBULENCE, RANGE_WORLD } from './params';

export function createWorldState(terrain: Terrain): WorldState {
  return {
    terrain,
    surfaceWind: new Vector3(0, 0, 0),
    turbulence: 0.15,
    timeOfDay: 10.5,
    visibilityKm: 30,
    isaDeviation: 0,
    windVeer: WIND.veer,
    boundaryLayerHeight: WIND.boundaryLayerHeight,
  };
}

/**
 * Per-step world update. Weather is constant during a flight in version 1 (wind, turbulence,
 * haze and the time of day are set before the flight); the gust field is a pure function of
 * position and time (gustAt), so nothing needs stepping.
 */
export function stepWorld(_sim: Sim, _dt: number): void {}
