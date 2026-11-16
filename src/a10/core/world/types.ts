/**
 * World contract: terrain, atmosphere and wind. Owned by the WORLD module (core/world).
 * Other modules use only what is declared here. See docs/a10/ARCHITECTURE.md §4.
 */
import type { Vector3 } from 'three';

/** What the ground is made of at a point. Drives impact effects, dust, ricochet and colour. */
export type SurfaceKind =
  'grass' | 'field' | 'dirt' | 'sand' | 'rock' | 'forest' | 'road' | 'concrete' | 'water' | 'mud';

export interface TerrainHit {
  /** World point of the hit. */
  point: Vector3;
  /** Unit ground normal at the hit (world). */
  normal: Vector3;
  /** Distance from the segment/ray start, m. */
  distance: number;
  /** Fraction along the segment, 0..1 (for raycast: distance / maxDistance). */
  t: number;
  surface: SurfaceKind;
}

export type RoadKind = 'highway' | 'road' | 'track';

export interface RoadPolyline {
  id: number;
  kind: RoadKind;
  /** Centre line as consecutive (x, z) pairs, world metres. */
  points: Float64Array;
  /** Paved / driven width, m. */
  width: number;
}

export type TargetAreaKind = 'open' | 'treeline' | 'road' | 'dugIn' | 'village' | 'range';

/** A place where vehicle groups can be put. */
export interface TargetArea {
  id: number;
  name: string;
  kind: TargetAreaKind;
  x: number;
  z: number;
  /** Radius within which vehicles may be placed, m. */
  radius: number;
}

export interface Airbase {
  x: number;
  z: number;
  /** Runway heading, rad. */
  heading: number;
  runwayLength: number;
  runwayWidth: number;
  elevation: number;
}

/** Transferable description of a generated world: everything needed to rebuild `Terrain`. */
export interface TerrainData {
  seed: number;
  /** Edge length of the square world, m. */
  size: number;
  /** Samples per edge of the height grid (grid spacing = size / (resolution - 1)). */
  resolution: number;
  /** Height grid, row-major, z rows (north→south... see world module docs), metres. */
  heights: Float32Array;
  /** Any further typed arrays or JSON-able data the world module needs (masks, roads…). */
  extra: Record<string, unknown>;
}

/**
 * The terrain as seen by every other module. ONE height function: the simulation (collision,
 * ranging, line of sight, vehicle placement) and the renderer read the same numbers.
 */
export interface Terrain {
  readonly seed: number;
  /** Edge length, m. x and z lie in [-size/2, size/2]. */
  readonly size: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  /** Ground height above sea level at (x, z), m. Outside the map: the edge value. */
  heightAt(x: number, z: number): number;
  /** Unit ground normal at (x, z). */
  normalAt(x: number, z: number, out: Vector3): Vector3;
  surfaceAt(x: number, z: number): SurfaceKind;
  /** Tree canopy height above the ground at (x, z), m; 0 where there are no trees. */
  canopyAt(x: number, z: number): number;
  /** First intersection of the segment p0→p1 with the ground (trees ignored). */
  segmentHit(p0: Vector3, p1: Vector3, out: TerrainHit): boolean;
  /** First intersection of origin + dir·s, 0 < s ≤ maxDistance (dir need not be unit). */
  raycast(origin: Vector3, dir: Vector3, maxDistance: number, out: TerrainHit): boolean;
  /** True if nothing blocks the straight line a→b: the ground, and tree canopies if includeTrees. */
  lineOfSight(a: Vector3, b: Vector3, includeTrees?: boolean): boolean;
  readonly roads: readonly RoadPolyline[];
  readonly targetAreas: readonly TargetArea[];
  readonly airbase: Airbase | null;
  /** Suggested air-start point and heading (rad) toward the first target area. */
  readonly start: { x: number; z: number; heading: number };
  /** The data this terrain was built from (for the renderer's workers). */
  readonly data: TerrainData;
}

/** Weather and air, owned by the world module, read by flight, weapons, sensors and view. */
export interface WorldState {
  terrain: Terrain;
  /** Mean wind at 10 m above ground, world m/s, the direction the air MOVES toward. */
  surfaceWind: Vector3;
  /** 0 = still air, 1 = strong low-level turbulence. */
  turbulence: number;
  /** Local time of day, hours 0..24. Drives the sun, the thermal picture and TV sensors. */
  timeOfDay: number;
  /** Meteorological visibility, km (haze). Limits eyes, TV sensors and TV Mavericks. */
  visibilityKm: number;
  /** Sea-level temperature offset from ISA, K. */
  isaDeviation: number;
}
