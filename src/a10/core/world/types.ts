/**
 * World contract: terrain, atmosphere and wind. Owned by the WORLD module (core/world).
 * Other modules use only what is declared here. See docs/a10/ARCHITECTURE.md §4.
 *
 * Frames: world metres, +X east, +Y up, -Z north; the map is the square
 * x, z ∈ [-size/2, size/2] centred on the origin, y = 0 at sea level.
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
  /**
   * Road-bed height of each centre-line vertex, m. The ground is exactly this flat across the
   * paved width (heightAt returns it), so a vehicle on the road sits level side to side.
   * Present on generated roads; hand-built test roads may omit it.
   */
  heights?: Float64Array;
  /** Cumulative distance along the centre line at each vertex, m (arc[0] = 0). */
  arc?: Float64Array;
  /** Total centre-line length, m. */
  length?: number;
  /** Index into `roads` of the road this one starts from (junction), or -1. */
  joinsStart?: number;
  /** Index into `roads` of the road this one ends on (junction), or -1. */
  joinsEnd?: number;
}

/** A river or stream: the water surface is flat across its width (heightAt = water level there). */
export interface RiverPolyline {
  id: number;
  /** Centre line (x, z) pairs, upstream → downstream, m. */
  points: Float64Array;
  /** Water width at each vertex, m. */
  widths: Float64Array;
  /** Water-surface height at each vertex, m (falls downstream). */
  levels: Float64Array;
  /** Cumulative distance along the centre line at each vertex, m. */
  arc: Float64Array;
  length: number;
  /** Width of the sand/gravel bank either side of the water, m. */
  bankWidth: number;
  /** Depth of the water at the centre line, m (for the renderer and splash effects). */
  depth: number;
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
  /**
   * Main axis, rad (compass: 0 = north, clockwise). Range areas: the run-in direction (aircraft
   * fly this way toward the target). Road areas: the road direction at the centre. Others: a
   * sensible facing for a parked group (toward the nearest road or along the tree line).
   */
  heading?: number;
  /** Ground height at the centre, m. */
  elevation?: number;
  /** Road areas: index into Terrain.roads of the road through the centre. */
  roadId?: number;
  /** Road areas: distance along that road (its `arc`) at the centre, m. */
  roadDistance?: number;
}

/** A paved rectangle of the airbase (runway, taxiway or apron). */
export interface PavedArea {
  kind: 'runway' | 'taxiway' | 'apron';
  /** Centre, m. */
  x: number;
  z: number;
  /** Direction of the long side, rad (compass). */
  heading: number;
  /** Long side, m. */
  length: number;
  /** Short side, m. */
  width: number;
}

export interface Airbase {
  x: number;
  z: number;
  /** Runway heading, rad. */
  heading: number;
  runwayLength: number;
  runwayWidth: number;
  elevation: number;
  /** Runway, parallel taxiway, link taxiways and apron (all flat and 'concrete'). */
  paved?: readonly PavedArea[];
}

/**
 * Transferable description of a generated world: everything needed to rebuild `Terrain`, made of
 * typed arrays and plain data only (structuredClone / postMessage safe). See `WorldExtra`.
 */
export interface TerrainData {
  seed: number;
  /** Edge length of the square world, m. */
  size: number;
  /** Samples per edge of the height grid (grid spacing = size / (resolution - 1)). */
  resolution: number;
  /**
   * Height grid, row-major: sample (col, row) is at index row * resolution + col, at
   * x = -size/2 + col * spacing (west → east) and z = -size/2 + row * spacing (north → south).
   * These are the CONTROL POINTS of the height surface (uniform cubic B-spline): always read the
   * ground with `Terrain.heightAt`, which adds micro-detail, roads, river banks and flat pads.
   */
  heights: Float32Array;
  /**
   * Generated worlds: a `WorldExtra` (read it with `worldExtra(data)` from core/world).
   * Hand-built test worlds may leave it empty.
   */
  extra: Record<string, unknown>;
}

/**
 * Layout of `TerrainData.extra` for a generated world (version 1). Every byte mask below has the
 * same size and row-major order as `TerrainData.heights` (index = row * resolution + col, row 0 =
 * north edge), except `surface` (surfaceResolution², same orientation). Byte masks are 0..255 and meant to be sampled bilinearly (except `surface`, which
 * is categorical: sample it nearest). Typed accessors: `worldExtra`, `maskAt`, `surfaceMaskAt`,
 * `SURFACE_KINDS` (core/world/extra.ts).
 */
export interface WorldExtra {
  version: 1;
  /** Grid spacing, m (= size / (resolution - 1)). */
  spacing: number;
  /** Seed of the deterministic micro-detail, forest-edge and field noise. */
  noiseSeed: number;
  /** Samples per edge of `surface` (every second height-grid sample: 513, spacing 125 m). */
  surfaceResolution: number;
  /**
   * Surface class (index into SURFACE_KINDS) at each sample of a surfaceResolution² grid over
   * the map, baked from Terrain.surfaceAt at the sample point — for distant terrain colouring.
   * Near the eye call surfaceAt / fieldAt, which resolve roads, banks and field edges exactly.
   */
  surface: Uint8Array;
  /** Forest stand density (0 none … 255 closed forest). Trees stand where canopyAt > 0. */
  forest: Uint8Array;
  /** Farmland suitability (0 … 255); farmed fields exist where it is high (see fieldAt). */
  farmland: Uint8Array;
  /** Ground moisture (0 dry … 255 wet): wet near the river and in hollows, dry on ridges. */
  moisture: Uint8Array;
  /** Micro-relief roughness (0 smooth fields … 255 broken rock): scales heightAt's micro-detail. */
  roughness: Uint8Array;
  /** Generated roads (RoadPolyline with heights, arc and length). */
  roads: RoadPolyline[];
  /** The river (and any streams), upstream → downstream. */
  rivers: RiverPolyline[];
  airbase: Airbase | null;
  /**
   * Flattened pads (range areas): a circle of radius `radius` that is exactly the plane
   * y = elevation + gx·(x - cx) + gz·(z - cz), blending into the terrain over `blend` metres.
   */
  pads: Array<{
    x: number;
    z: number;
    radius: number;
    blend: number;
    elevation: number;
    gx: number;
    gz: number;
  }>;
  /** Flattened airbase footprint (rectangle in runway axes), plane as for pads. */
  airfield: {
    x: number;
    z: number;
    heading: number;
    halfLength: number;
    halfWidth: number;
    blend: number;
    elevation: number;
    gx: number;
    gz: number;
  } | null;
  targetAreas: TargetArea[];
  start: { x: number; z: number; heading: number };
  /**
   * Field-system regions (Voronoi cells on a jittered grid): per region 6 numbers
   * [siteX, siteZ, rowAngle (rad, math angle of the row direction in the x/z plane),
   * rowHeight m, fieldLength m, hash seed]; `fieldGrid` = [cellSize, originX, originZ, nx, nz].
   */
  fieldRegions: Float64Array;
  fieldGrid: Float64Array;
  /** Height range of the surface, m (including micro-detail bounds). */
  minHeight: number;
  maxHeight: number;
  /** The valley: axis angle (rad, math angle in x/z), and the floor heights at both ends. */
  valley: { angle: number; floorLow: number; floorHigh: number };
}

/** Crop on a farmed field. */
export type CropKind = 'cereal' | 'greenCrop' | 'rapeseed' | 'ploughed' | 'pasture' | 'fallow';

/** What `fieldAt` reports about the field at a point. */
export interface FieldSample {
  /** Stable id of the field (same for every point of the field). */
  id: number;
  /** 0..255 colour/texture variant, stable per field. */
  variant: number;
  crop: CropKind;
  /** Direction of the crop rows / furrows, rad (compass, 0 = north). */
  rowHeading: number;
  /** Distance to the nearest field boundary, m. */
  edgeDistance: number;
  /** The nearest boundary carries a hedgerow / tree line. */
  hedge: boolean;
  /** The nearest boundary carries a farm track (bare earth). */
  track: boolean;
}

/** Everything about a ground point in one query (`Terrain.sampleAt`). */
export interface TerrainSample {
  height: number;
  /** Unit ground normal. */
  normal: Vector3;
  surface: SurfaceKind;
  /** Tree canopy height above the ground, m (0 = no trees). */
  canopy: number;
  /** Water-surface height, or -Infinity where there is no water. */
  waterLevel: number;
  /** 0..1 */
  forestDensity: number;
  /** 0..1 */
  moisture: number;
  /** Distance to the nearest road centre line, m (Infinity when farther than ROAD_QUERY_RANGE). */
  roadDistance: number;
  /** Field variant 0..255, or -1 where this is not a farmed field. */
  fieldVariant: number;
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
  /**
   * Ground height above sea level at (x, z), m. Outside the map: the edge value. Over water it
   * is the flat WATER SURFACE (rounds splash there; surfaceAt says 'water').
   */
  heightAt(x: number, z: number): number;
  /** Unit ground normal at (x, z). */
  normalAt(x: number, z: number, out: Vector3): Vector3;
  surfaceAt(x: number, z: number): SurfaceKind;
  /** Tree canopy height above the ground at (x, z), m; 0 where there are no trees. */
  canopyAt(x: number, z: number): number;
  /**
   * First intersection of the segment p0→p1 with the ground (trees ignored); the hit point lies
   * on heightAt within a few millimetres. A segment that starts below the ground hits at p0.
   */
  segmentHit(p0: Vector3, p1: Vector3, out: TerrainHit): boolean;
  /**
   * First intersection of origin + dir·s, 0 < s ≤ maxDistance. `dir` need not be unit: it is
   * normalised, and s, `maxDistance` and `out.distance` are metres.
   */
  raycast(origin: Vector3, dir: Vector3, maxDistance: number, out: TerrainHit): boolean;
  /**
   * True if nothing blocks the straight line a→b: the ground, and the tree canopy volume
   * (ground … ground + canopyAt) if includeTrees. The last metre at each end is not tested, so
   * a point on the ground (a vehicle, a sensor on the ground) can be seen.
   */
  lineOfSight(a: Vector3, b: Vector3, includeTrees?: boolean): boolean;
  readonly roads: readonly RoadPolyline[];
  readonly targetAreas: readonly TargetArea[];
  readonly airbase: Airbase | null;
  /** Suggested air-start point and heading (rad) toward the first target area. */
  readonly start: { x: number; z: number; heading: number };
  /** The data this terrain was built from (for the renderer's workers). */
  readonly data: TerrainData;

  // ---- Optional queries (implemented by every terrain the world module builds) ----

  /** Rivers and streams. */
  readonly rivers?: readonly RiverPolyline[];
  /** Water-surface height at (x, z), or -Infinity where there is no water. */
  waterLevelAt?(x: number, z: number): number;
  /** Water depth below the surface at (x, z), m (0 where dry). */
  waterDepthAt?(x: number, z: number): number;
  /** Forest stand density 0..1 (smooth). */
  forestDensityAt?(x: number, z: number): number;
  /** Ground moisture 0..1 (texturing, dust, the thermal picture). */
  moistureAt?(x: number, z: number): number;
  /** Distance to the nearest road centre line, m (Infinity farther than ROAD_QUERY_RANGE). */
  roadDistanceAt?(x: number, z: number): number;
  /** Farmed-field information; false where the point is not on a field. */
  fieldAt?(x: number, z: number, out: FieldSample): boolean;
  /** Field variant 0..255, or -1 where the point is not on a field. */
  fieldVariantAt?(x: number, z: number): number;
  /** Slope of the ground, rad (0 = level), from the large-scale surface (no micro-detail). */
  slopeAt?(x: number, z: number): number;
  /** Everything at a point in one call. */
  sampleAt?(x: number, z: number, out: TerrainSample): TerrainSample;
  /**
   * Fill `out` (n × n, row-major, row = z) with heightAt on a regular square grid: sample (i, j)
   * at (x0 + i·step, z0 + j·step). Faster than n² heightAt calls (renderer tiles).
   */
  heightGrid?(x0: number, z0: number, step: number, n: number, out: Float32Array): Float32Array;
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
  /**
   * Turning of the wind with height, rad: the direction at the top of the boundary layer minus
   * the direction at 10 m (+ = veers clockwise, the northern-hemisphere Ekman turn). Default 20°.
   */
  windVeer?: number;
  /** Height of the atmospheric boundary layer above the ground, m. Default 1,000 m. */
  boundaryLayerHeight?: number;
}
