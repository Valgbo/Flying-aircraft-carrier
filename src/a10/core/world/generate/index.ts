/**
 * generateTerrainData(seed): the whole fictional 64 × 64 km live-fire range from one seed
 * (PLAN_A10.md §10). Pure and deterministic: every random draw comes from Rng streams derived
 * from the seed, every noise field is hash-based, so the same seed gives identical arrays.
 *
 * Order: valley landform → river and flood plain → airbase and range pads (flattened into the
 * grid) → land-cover masks → road network → field system → (provisional terrain) → target areas
 * and start → baked surface mask.
 */
import { WORLD_SIZE } from '../../constants';
import { Rng, hashSeed } from '../../rng';
import { SURFACE_INDEX } from '../extra';
import { buildFieldSystem } from '../fields';
import { MICRO_PEAK, MICRO_ROUGH_GAIN, microRelief, microSeeds } from '../micro';
import { RANGE_WORLD } from '../params';
import { createTerrain } from '../terrain';
import type { TerrainData, WorldExtra } from '../types';
import { placeAreas } from './areas';
import { makeCover } from './cover';
import { createGrid, gridBSpline, sampleBilinear, upsample } from './grid';
import { downValleyAngle, macroHeight, makeLayout, toU } from './layout';
import { carveFloodPlain, makeRiver, riverField } from './river';
import { buildRoads } from './roads';
import { placeAirbase, placeRange } from './sites';

/** Recently generated worlds by seed (each caller gets its own copy). */
const cache = new Map<number, TerrainData>();
const CACHE_SIZE = 2;

export interface GenerateOptions {
  /** Reuse a world generated earlier in this thread for the same seed (default true). */
  cache?: boolean;
}

/**
 * Generate the world's data from a seed (pure, deterministic, transferable). The last two worlds
 * are kept, so asking again for the same seed (a restart, a test) returns a fresh copy at once.
 */
export function generateTerrainData(seed: number, options: GenerateOptions = {}): TerrainData {
  if (options.cache !== false) {
    const hit = cache.get(seed);
    if (hit) return structuredClone(hit);
  }
  const data = generate(seed);
  if (options.cache !== false) {
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as number);
    cache.set(seed, structuredClone(data));
  }
  return data;
}

function generate(seed: number): TerrainData {
  const size = WORLD_SIZE;
  const n = RANGE_WORLD.gridResolution;
  const stream = (name: string) => new Rng(hashSeed(seed, 'world', name));
  const noiseSeed = hashSeed(seed, 'world', 'noise') | 0;
  const L = makeLayout(stream('layout'), size);

  // Landform: the macro function on a half-resolution lattice, Catmull-Rom up to the grid.
  const nc = (n - 1) / 2 + 1;
  const coarse = new Float32Array(nc * nc);
  const cs = size / (nc - 1);
  for (let j = 0; j < nc; j++) {
    for (let i = 0; i < nc; i++) coarse[j * nc + i] = macroHeight(L, -size / 2 + i * cs, -size / 2 + j * cs);
  }
  const g = createGrid(n, size);
  upsample(coarse, nc, g);

  // River and flood plain.
  const river = makeRiver(L, stream('river'), noiseSeed);
  const rf = riverField(g, river, 1300);
  carveFloodPlain(g, rf, noiseSeed ^ 0x55);

  // Airbase and range complex.
  const sitesRng = stream('sites');
  const site = placeAirbase(L, g, rf, sitesRng);
  const pads = placeRange(L, g, rf, site, sitesRng);

  // Land cover.
  const cover = makeCover(L, g, rf, site, pads, noiseSeed ^ 0x77);

  // Roads, laid on the natural ground the terrain will show (grid surface + micro-relief).
  const ms = microSeeds(noiseSeed);
  const natural = (x: number, z: number) =>
    gridBSpline(g, x, z) +
    microRelief(x, z, ms.s0, ms.s1, ms.s2) *
      (1 + (MICRO_ROUGH_GAIN / 255) * sampleBilinear(g, cover.roughness, x, z));
  const { roads, trackEnds } = buildRoads(
    L,
    g,
    rf,
    site,
    pads,
    river,
    stream('roads'),
    (x, z) => sampleBilinear(g, cover.forest, x, z) / 255,
    natural,
  );

  // Field patchwork regions, rows roughly along the valley.
  const fieldSystem = buildFieldSystem(size, 4000, noiseSeed ^ 0x99, (x, z) =>
    downValleyAngle(L, toU(L, x, z)),
  );

  const extra: WorldExtra = {
    version: 1,
    spacing: size / (n - 1),
    noiseSeed,
    surfaceResolution: (n - 1) / 2 + 1,
    surface: new Uint8Array(((n - 1) / 2 + 1) ** 2),
    forest: cover.forest,
    farmland: cover.farmland,
    moisture: cover.moisture,
    roughness: cover.roughness,
    roads,
    rivers: [river],
    airbase: site.airbase,
    pads: pads.map((p) => ({
      x: p.x,
      z: p.z,
      radius: p.radius,
      blend: 80,
      elevation: p.plane.elevation,
      gx: p.plane.gx,
      gz: p.plane.gz,
    })),
    airfield: site.airfield,
    targetAreas: [],
    start: { x: 0, z: 0, heading: 0 },
    fieldRegions: fieldSystem.regions,
    fieldGrid: new Float64Array([
      fieldSystem.cell,
      fieldSystem.ox,
      fieldSystem.oz,
      fieldSystem.nx,
      fieldSystem.nz,
    ]),
    minHeight: 0,
    maxHeight: 0,
    valley: { angle: L.angle, floorLow: L.floorLow, floorHigh: L.floorHigh },
  };
  const data: TerrainData = {
    seed,
    size,
    resolution: n,
    heights: g.h,
    extra: extra as unknown as Record<string, unknown>,
  };

  // The finished surface, for placing the areas and baking the surface mask (no rays needed).
  const terrain = createTerrain(data, { lazyRayQueries: true });
  const plan = placeAreas(L, terrain, roads, trackEnds, site, pads, stream('areas'));
  extra.targetAreas = plan.areas;
  extra.start = plan.start;
  // Height range: grid control points ± the largest micro-relief, and the road beds.
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < g.h.length; k++) {
    const v = g.h[k];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  for (const r of roads) for (const v of r.heights!) hi = Math.max(hi, v);
  const microMax = MICRO_PEAK * (1 + MICRO_ROUGH_GAIN);
  extra.minHeight = lo - microMax;
  extra.maxHeight = hi + microMax;
  // Surface classes on every second grid sample (125 m), for distant ground.
  const ns = extra.surfaceResolution;
  const ss = size / (ns - 1);
  for (let j = 0; j < ns; j++) {
    const z = -size / 2 + j * ss;
    for (let i = 0; i < ns; i++) {
      extra.surface[j * ns + i] = SURFACE_INDEX[terrain.surfaceAt(-size / 2 + i * ss, z)];
    }
  }
  return data;
}
