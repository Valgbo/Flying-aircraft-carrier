/**
 * World module: the generated range obeys its rules (PLAN_A10.md §10, the world brief).
 * One generated world (seed 1) is shared by the tests in this file; determinism and the worker
 * rebuild compare fresh copies.
 */
import { Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  RANGE_WORLD,
  SURFACE_INDEX,
  SURFACE_KINDS,
  createFlatTerrain,
  createTerrain,
  generateTerrainData,
  gridX,
  gridZ,
  maskAt,
  nearestRoadPoint,
  createRoadPoint,
  pointAlongRoad,
  surfaceMaskAt,
  worldExtra,
  type FieldSample,
  type Terrain,
  type TerrainData,
} from '../../../src/a10/core/world';
import {
  areaGroundOk,
  areaSlopeAt,
  AREA_MAX_SLOPE,
  START_DISTANCE,
} from '../../../src/a10/core/world/generate/areas';
import { headingOf, wrapPi } from '../../../src/a10/core/frames';
import { Rng } from '../../../src/a10/core/rng';

const SEED = 1;
let data: TerrainData;
let terrain: Terrain;

beforeAll(() => {
  data = generateTerrainData(SEED);
  terrain = createTerrain(data);
}, 60000);

/** Deterministic sample points over the map. */
function points(count: number, seed: number, margin = 0): Array<[number, number]> {
  const r = new Rng(seed);
  const h = terrain.size / 2 - margin;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) out.push([r.range(-h, h), r.range(-h, h)]);
  return out;
}

describe('generation', () => {
  it('is deterministic: the same seed gives identical data, another seed differs', () => {
    const a = generateTerrainData(SEED, { cache: false });
    expect(a.heights).toEqual(data.heights);
    const ea = worldExtra(a)!;
    const eb = worldExtra(data)!;
    expect(ea.surface).toEqual(eb.surface);
    expect(ea.forest).toEqual(eb.forest);
    expect(ea.farmland).toEqual(eb.farmland);
    expect(ea.moisture).toEqual(eb.moisture);
    expect(ea.roughness).toEqual(eb.roughness);
    expect(ea.roads.length).toBe(eb.roads.length);
    ea.roads.forEach((r, i) => {
      expect(r.points).toEqual(eb.roads[i].points);
      expect(r.heights).toEqual(eb.roads[i].heights);
    });
    expect(ea.rivers[0].points).toEqual(eb.rivers[0].points);
    expect(ea.targetAreas).toEqual(eb.targetAreas);
    expect(ea.start).toEqual(eb.start);
    const other = generateTerrainData(SEED + 1, { cache: false });
    let diff = 0;
    for (let i = 0; i < other.heights.length; i += 97)
      if (other.heights[i] !== data.heights[i]) diff++;
    expect(diff).toBeGreaterThan(1000);
  }, 60000);

  it('rebuilds bit-identically from a structured clone (Web Worker transfer)', () => {
    const clone = structuredClone(data);
    const t2 = createTerrain(clone);
    const n1 = new Vector3();
    const n2 = new Vector3();
    for (const [x, z] of points(4000, 11)) {
      expect(t2.heightAt(x, z)).toBe(terrain.heightAt(x, z));
      expect(t2.surfaceAt(x, z)).toBe(terrain.surfaceAt(x, z));
      expect(t2.canopyAt(x, z)).toBe(terrain.canopyAt(x, z));
      expect(t2.normalAt(x, z, n2).toArray()).toEqual(terrain.normalAt(x, z, n1).toArray());
    }
    // Near roads too, where the feature layer works.
    for (const road of terrain.roads) {
      for (let i = 0; i < road.points.length / 2; i += 37) {
        const x = road.points[2 * i] + 3;
        const z = road.points[2 * i + 1] - 2;
        expect(t2.heightAt(x, z)).toBe(terrain.heightAt(x, z));
      }
    }
    expect(t2.start).toEqual(terrain.start);
    expect(t2.maxHeight).toBe(terrain.maxHeight);
  }, 30000);

  it('gives the renderer typed access to the masks: worldExtra, maskAt, surfaceMaskAt, gridX/gridZ', () => {
    const e = worldExtra(data)!;
    expect(e).not.toBeNull();
    expect(worldExtra(createFlatTerrain(10).data)).toBeNull();
    const n = data.resolution;
    expect(gridX(data, 0)).toBe(-data.size / 2);
    expect(gridX(data, n - 1)).toBe(data.size / 2);
    expect(gridZ(data, (n - 1) / 2)).toBe(0);
    const r = new Rng(21);
    // At a grid sample a mask reads its stored byte; anywhere it is the terrain's smooth value.
    for (let k = 0; k < 500; k++) {
      const col = r.int(0, n - 1);
      const row = r.int(0, n - 1);
      const x = gridX(data, col);
      const z = gridZ(data, row);
      expect(maskAt(data, e.forest, x, z)).toBeCloseTo(e.forest[row * n + col] / 255, 9);
      expect(maskAt(data, e.roughness, x, z)).toBeCloseTo(e.roughness[row * n + col] / 255, 9);
    }
    for (const [x, z] of points(2000, 23)) {
      expect(maskAt(data, e.forest, x, z)).toBeCloseTo(terrain.forestDensityAt!(x, z), 9);
      expect(maskAt(data, e.moisture, x, z)).toBeCloseTo(terrain.moistureAt!(x, z), 9);
    }
    // The baked surface classes are surfaceAt at the surface-grid samples.
    const ns = e.surfaceResolution;
    const ss = data.size / (ns - 1);
    for (let k = 0; k < 500; k++) {
      const x = -data.size / 2 + r.int(0, ns - 1) * ss;
      const z = -data.size / 2 + r.int(0, ns - 1) * ss;
      const s = terrain.surfaceAt(x, z);
      expect(surfaceMaskAt(data, e, x, z)).toBe(s);
      expect(SURFACE_KINDS[SURFACE_INDEX[s]]).toBe(s);
    }
  });

  it('fills the map: valley floor, ridges to about 900 m, height grid and masks of the right size', () => {
    const e = worldExtra(data)!;
    const n = data.resolution;
    expect(data.heights.length).toBe(n * n);
    for (const m of [e.forest, e.farmland, e.moisture, e.roughness]) expect(m.length).toBe(n * n);
    expect(e.surface.length).toBe(e.surfaceResolution ** 2);
    expect(terrain.maxHeight).toBeGreaterThan(800);
    expect(terrain.maxHeight).toBeLessThan(960);
    expect(terrain.minHeight).toBeGreaterThan(80);
    // The river runs on the valley floor (100–250 m).
    const river = terrain.rivers![0];
    for (let i = 0; i < river.levels.length; i += 50) {
      expect(river.levels[i]).toBeGreaterThan(95);
      expect(river.levels[i]).toBeLessThan(250);
    }
  });
});

describe('height function', () => {
  it('is continuous (no steps between neighbouring points)', () => {
    let worst = 0;
    for (const [x, z] of points(20000, 3)) {
      const d = Math.abs(terrain.heightAt(x + 0.05, z) - terrain.heightAt(x, z));
      worst = Math.max(worst, d);
    }
    // 5 cm apart: even a 45° cut slope changes by 5 cm.
    expect(worst).toBeLessThan(0.08);
  });

  it('has micro-relief: not flat over a few tens of metres on open ground', () => {
    let rms = 0;
    let count = 0;
    for (const [x, z] of points(3000, 5, 2000)) {
      if (terrain.surfaceAt(x, z) !== 'grass' && terrain.surfaceAt(x, z) !== 'forest') continue;
      // Deviation from the straight line between points 60 m apart.
      const mid = terrain.heightAt(x, z);
      const lin = 0.5 * (terrain.heightAt(x - 30, z) + terrain.heightAt(x + 30, z));
      rms += (mid - lin) ** 2;
      count++;
    }
    expect(Math.sqrt(rms / count)).toBeGreaterThan(0.1);
  });

  it('keeps the edge value outside the map', () => {
    const h = terrain.size / 2;
    expect(terrain.heightAt(h + 5000, 1234)).toBe(terrain.heightAt(h, 1234));
    expect(terrain.heightAt(-h - 1, -h - 1)).toBe(terrain.heightAt(-h, -h));
  });
});

describe('roads', () => {
  it('has a highway along the valley, secondary roads and dirt tracks', () => {
    const kinds = new Set(terrain.roads.map((r) => r.kind));
    expect(kinds.has('highway')).toBe(true);
    expect(kinds.has('road')).toBe(true);
    expect(kinds.has('track')).toBe(true);
    const highway = terrain.roads.find((r) => r.kind === 'highway')!;
    expect(highway.length!).toBeGreaterThan(50000);
    for (const r of terrain.roads) {
      expect(r.heights!.length).toBe(r.points.length / 2);
      expect(r.arc![r.arc!.length - 1]).toBeCloseTo(r.length!, 6);
    }
  });

  it('are flat across the paved width (< 0.3 m) and laid at their design grade', () => {
    let worst = 0;
    let worstGrade = 0;
    let checked = 0;
    const p = createRoadPoint();
    const q = createRoadPoint();
    for (const road of terrain.roads) {
      const hw = road.width / 2;
      const len = road.length!;
      const others = terrain.roads.filter((r) => r !== road);
      for (let s = 7; s < len; s += 53) {
        pointAlongRoad(road, s, p);
        // Junctions and crossings belong to the earthworks of the higher-ranked road.
        if (nearestRoadPoint(others, p.x, p.z, q) && q.offset < 45) continue;
        checked++;
        const ex = Math.cos(p.heading);
        const ez = Math.sin(p.heading); // right-hand normal of the travel direction
        let lo = Infinity;
        let hi = -Infinity;
        for (let k = -4; k <= 4; k++) {
          const off = (k / 4) * hw;
          const h = terrain.heightAt(p.x + ex * off, p.z + ez * off);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
        worst = Math.max(worst, hi - lo);
        // The centre line is the road bed.
        expect(Math.abs(terrain.heightAt(p.x, p.z) - p.y)).toBeLessThan(0.25);
      }
      const h = road.heights!;
      const a = road.arc!;
      const limit =
        road.kind === 'highway'
          ? RANGE_WORLD.highwayMaxGrade
          : road.kind === 'road'
            ? RANGE_WORLD.roadMaxGrade
            : RANGE_WORLD.trackMaxGrade;
      for (let i = 1; i < h.length; i++) {
        const g = Math.abs(h[i] - h[i - 1]) / Math.max(1e-6, a[i] - a[i - 1]);
        worstGrade = Math.max(worstGrade, g / limit);
      }
    }
    expect(checked).toBeGreaterThan(2000);
    expect(worst).toBeLessThan(0.3);
    expect(worstGrade).toBeLessThanOrEqual(1.0001);
  });

  it('report road surfaces on the pavement and the distance to the centre line', () => {
    const p = createRoadPoint();
    const q = createRoadPoint();
    for (const road of terrain.roads) {
      const others = terrain.roads.filter((r) => r !== road);
      for (let s = 13; s < road.length!; s += 997) {
        pointAlongRoad(road, s, p);
        if (nearestRoadPoint(others, p.x, p.z, q) && q.offset < 12) continue;
        const surf = terrain.surfaceAt(p.x, p.z);
        // At junctions another road may own the point; it is still a road or track surface.
        expect(['road', 'dirt', 'concrete']).toContain(surf);
        if (road.kind !== 'track') expect(['road', 'concrete']).toContain(surf);
        expect(terrain.roadDistanceAt!(p.x, p.z)).toBeLessThan(0.5);
      }
    }
  });
});

describe('river', () => {
  it('flows downhill, with a flat water surface and sand banks', () => {
    const river = terrain.rivers![0];
    for (let i = 1; i < river.levels.length; i++) {
      expect(river.levels[i]).toBeLessThanOrEqual(river.levels[i - 1] + 1e-9);
    }
    const p = river.points;
    let checked = 0;
    for (let i = 10; i < p.length / 2 - 10; i += 40) {
      const x = p[2 * i];
      const z = p[2 * i + 1];
      if (Math.abs(x) > 31000 || Math.abs(z) > 31000) continue;
      // Skip crossings (a causeway carries the road over the water).
      if (terrain.roadDistanceAt!(x, z) < 80) continue;
      const dx = p[2 * i + 2] - p[2 * i - 2];
      const dz = p[2 * i + 3] - p[2 * i - 1];
      const l = Math.hypot(dx, dz);
      const nx = -dz / l;
      const nz = dx / l;
      const hw = river.widths[i] / 2;
      expect(terrain.surfaceAt(x, z)).toBe('water');
      expect(terrain.waterLevelAt!(x, z)).toBeCloseTo(river.levels[i], 1);
      const h0 = terrain.heightAt(x, z);
      for (const f of [-0.8, -0.4, 0.4, 0.8]) {
        expect(Math.abs(terrain.heightAt(x + nx * hw * f, z + nz * hw * f) - h0)).toBeLessThan(
          0.05,
        );
      }
      // Just outside the water: sand bank, above the water.
      const bx = x + nx * (hw + 3);
      const bz = z + nz * (hw + 3);
      expect(terrain.surfaceAt(bx, bz)).toBe('sand');
      expect(terrain.heightAt(bx, bz)).toBeGreaterThan(h0);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('airbase', () => {
  it('has one 2,400 m runway on flat ground, with a taxiway and an apron, all concrete', () => {
    const ab = terrain.airbase!;
    expect(ab).not.toBeNull();
    expect(ab.runwayLength).toBe(2400);
    const paved = ab.paved!;
    expect(paved.filter((p) => p.kind === 'runway').length).toBe(1);
    expect(paved.some((p) => p.kind === 'taxiway')).toBe(true);
    expect(paved.some((p) => p.kind === 'apron')).toBe(true);
    const e = worldExtra(data)!;
    const f = e.airfield!;
    for (const p of paved) {
      const ex = Math.sin(p.heading);
      const ez = -Math.cos(p.heading);
      for (let a = -0.48; a <= 0.48; a += 0.06) {
        for (let b = -0.45; b <= 0.45; b += 0.3) {
          const x = p.x + ex * a * p.length - ez * b * p.width;
          const z = p.z + ez * a * p.length + ex * b * p.width;
          const plane = f.elevation + f.gx * (x - f.x) + f.gz * (z - f.z);
          expect(Math.abs(terrain.heightAt(x, z) - plane)).toBeLessThan(0.01);
          expect(terrain.surfaceAt(x, z)).toBe('concrete');
          expect(terrain.canopyAt(x, z)).toBe(0);
        }
      }
    }
    // Along the runway the plane is gentle (≤ 0.6 %).
    expect(Math.hypot(f.gx, f.gz)).toBeLessThanOrEqual(0.0061);
  });
});

describe('target areas', () => {
  it('has 12–16 areas of the four kinds plus the three range areas', () => {
    const areas = terrain.targetAreas;
    const nonRange = areas.filter((a) => a.kind !== 'range');
    expect(nonRange.length).toBeGreaterThanOrEqual(12);
    expect(nonRange.length).toBeLessThanOrEqual(16);
    for (const a of nonRange) expect(['open', 'treeline', 'road', 'dugIn']).toContain(a.kind);
    const kinds = new Set(nonRange.map((a) => a.kind));
    expect(kinds.size).toBe(4);
    const names = areas
      .filter((a) => a.kind === 'range')
      .map((a) => a.name)
      .sort();
    expect(names).toEqual(['BOMB CIRCLE', 'STRAFE PIT', 'TACTICAL LANE']);
    expect(new Set(areas.map((a) => a.name)).size).toBe(areas.length);
    areas.forEach((a, i) => expect(a.id).toBe(i));
  });

  it('every area centre is on ground with slope < 6° over its radius, not in water or forest', () => {
    for (const a of terrain.targetAreas) {
      expect(['water', 'forest']).not.toContain(terrain.surfaceAt(a.x, a.z));
      expect(terrain.canopyAt(a.x, a.z)).toBe(0);
      if (a.kind !== 'range') expect(areaGroundOk(terrain, a.x, a.z, a.radius)).toBe(true);
      // Independent check on a finer ring grid (slope over a 30 m baseline: the scale of a
      // vehicle group; single road verges and furrows are steeper locally).
      for (let r = 0; r <= a.radius; r += a.radius / 7) {
        for (let k = 0; k < 36; k++) {
          const ang = (k / 36) * Math.PI * 2;
          const s = areaSlopeAt(terrain, a.x + Math.cos(ang) * r, a.z + Math.sin(ang) * r);
          expect(s).toBeLessThan(AREA_MAX_SLOPE);
        }
      }
    }
  });

  it('road areas lie on a road', () => {
    const p = createRoadPoint();
    const road = terrain.targetAreas.filter((a) => a.kind === 'road');
    expect(road.length).toBeGreaterThan(0);
    for (const a of road) {
      expect(terrain.roadDistanceAt!(a.x, a.z)).toBeLessThan(1);
      const r = terrain.roads[a.roadId!];
      pointAlongRoad(r, a.roadDistance!, p);
      expect(Math.hypot(p.x - a.x, p.z - a.z)).toBeLessThan(0.5);
      expect(['road', 'dirt']).toContain(terrain.surfaceAt(a.x, a.z));
    }
  });

  it('range areas are flat, clear of trees, and no road crosses them', () => {
    const e = worldExtra(data)!;
    const range = terrain.targetAreas.filter((a) => a.kind === 'range');
    for (const a of range) {
      const pad = e.pads.find((p) => Math.hypot(p.x - a.x, p.z - a.z) < 1)!;
      expect(pad).toBeDefined();
      for (let r = 0; r <= a.radius; r += a.radius / 8) {
        for (let k = 0; k < 32; k++) {
          const ang = (k / 32) * Math.PI * 2;
          const x = a.x + Math.cos(ang) * r;
          const z = a.z + Math.sin(ang) * r;
          const plane = pad.elevation + pad.gx * (x - pad.x) + pad.gz * (z - pad.z);
          expect(Math.abs(terrain.heightAt(x, z) - plane)).toBeLessThan(0.01);
          expect(terrain.canopyAt(x, z)).toBe(0);
          expect(['dirt', 'grass']).toContain(terrain.surfaceAt(x, z));
        }
      }
      expect(Math.hypot(pad.gx, pad.gz)).toBeLessThan(0.0125);
      // No road centre line enters the area (plus the road's own half width).
      const q = createRoadPoint();
      nearestRoadPoint(terrain.roads, a.x, a.z, q);
      expect(q.offset).toBeGreaterThan(a.radius + 10);
    }
  });

  it('the start is ~12 km from the nearest non-range area, heading to it, over low ground', () => {
    const s = terrain.start;
    const nonRange = terrain.targetAreas.filter((a) => a.kind !== 'range');
    let nearest = nonRange[0];
    let best = Infinity;
    for (const a of nonRange) {
      const d = Math.hypot(a.x - s.x, a.z - s.z);
      if (d < best) {
        best = d;
        nearest = a;
      }
    }
    expect(Math.abs(best - START_DISTANCE)).toBeLessThan(600);
    expect(Math.abs(wrapPi(s.heading - headingOf(nearest.x - s.x, nearest.z - s.z)))).toBeLessThan(
      0.01,
    );
    expect(nearest.name).toBe('ALPHA');
    // Not over high ground: the valley, well below the ridges, within 2 km.
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      for (const r of [0, 1000, 2000]) {
        expect(terrain.heightAt(s.x + Math.cos(ang) * r, s.z + Math.sin(ang) * r)).toBeLessThan(
          400,
        );
      }
    }
  });
});

describe('surfaces and trees', () => {
  it('uses every surface class, in plausible places', () => {
    const seen = new Set<string>();
    const n = new Vector3();
    let rockSlope = 0;
    let rock = 0;
    for (const [x, z] of points(60000, 7)) {
      const s = terrain.surfaceAt(x, z);
      seen.add(s);
      if (s === 'water') {
        // Water only at low elevation, in the river.
        expect(terrain.heightAt(x, z)).toBeLessThan(250);
        expect(terrain.waterLevelAt!(x, z)).toBeGreaterThan(-Infinity);
      }
      if (s === 'rock') {
        rock++;
        rockSlope += terrain.slopeAt!(x, z);
        // Large-scale slope over 15°.
        expect(terrain.slopeAt!(x, z)).toBeGreaterThan((15 * Math.PI) / 180);
        terrain.normalAt(x, z, n);
      }
      if (s === 'forest') expect(terrain.canopyAt(x, z)).toBeGreaterThan(0);
    }
    expect(rock).toBeGreaterThan(50);
    expect(rockSlope / rock).toBeGreaterThan((22 * Math.PI) / 180);
    // The big classes appear in a random sample; the narrow ones are checked where they live.
    for (const k of ['grass', 'field', 'dirt', 'rock', 'forest'] as const)
      expect(seen.has(k)).toBe(true);
    const ab = terrain.airbase!;
    expect(terrain.surfaceAt(ab.x, ab.z)).toBe('concrete');
    const e = worldExtra(data)!;
    const counts = new Map<string, number>();
    for (const v of e.surface)
      counts.set(SURFACE_KINDS[v], (counts.get(SURFACE_KINDS[v]) ?? 0) + 1);
    for (const k of ['grass', 'field', 'dirt', 'rock', 'forest', 'water'] as const) {
      expect(counts.get(k) ?? 0).toBeGreaterThan(0);
    }
    // Mud near the water on the flood plain.
    const river = terrain.rivers![0];
    let mud = 0;
    for (let i = 0; i < river.points.length / 2; i += 5) {
      const x = river.points[2 * i];
      const z = river.points[2 * i + 1];
      for (const off of [-1, 1]) {
        const d = river.widths[i] / 2 + river.bankWidth + 8;
        if (terrain.surfaceAt(x + off * d, z + off * d * 0.01) === 'mud') mud++;
      }
    }
    expect(mud).toBeGreaterThan(0);
  });

  it('canopy heights are 12–22 m in forests, lower in hedgerows, zero on roads and water', () => {
    let forest = 0;
    for (const [x, z] of points(30000, 9)) {
      const c = terrain.canopyAt(x, z);
      expect(
        c === 0 || (c >= RANGE_WORLD.hedgeMin - 1e-9 && c <= RANGE_WORLD.canopyMax + 1e-9),
      ).toBe(true);
      if (terrain.forestDensityAt!(x, z) > 0.8 && c > 0) {
        forest++;
        expect(c).toBeGreaterThanOrEqual(RANGE_WORLD.canopyMin * 0.72 - 1e-9);
      }
    }
    expect(forest).toBeGreaterThan(100);
    const p = createRoadPoint();
    for (const road of terrain.roads) {
      for (let s = 5; s < road.length!; s += 211) {
        pointAlongRoad(road, s, p);
        expect(terrain.canopyAt(p.x, p.z)).toBe(0);
      }
    }
  });

  it('farmed fields have stable ids, crops and edges', () => {
    const f1: FieldSample = {
      id: 0,
      variant: 0,
      crop: 'cereal',
      rowHeading: 0,
      edgeDistance: 0,
      hedge: false,
      track: false,
    };
    const f2: FieldSample = { ...f1 };
    let fields = 0;
    for (const [x, z] of points(20000, 13)) {
      if (!terrain.fieldAt!(x, z, f1)) continue;
      fields++;
      // A point 1 m away inside the same field reports the same field.
      if (f1.edgeDistance > 3 && terrain.fieldAt!(x + 0.7, z + 0.7, f2)) expect(f2.id).toBe(f1.id);
      expect(terrain.fieldVariantAt!(x, z)).toBe(f1.variant);
    }
    expect(fields).toBeGreaterThan(500);
  });

  it('flat test terrain still works for other modules', () => {
    const flat = createFlatTerrain(50);
    expect(flat.heightAt(1234, -999)).toBe(50);
    expect(flat.targetAreas.length).toBe(3);
    const hit = {
      point: new Vector3(),
      normal: new Vector3(),
      distance: 0,
      t: 0,
      surface: 'grass' as const,
    };
    expect(flat.segmentHit(new Vector3(0, 60, 0), new Vector3(10, 40, 0), hit)).toBe(true);
    expect(hit.point.x).toBeCloseTo(5, 9);
    expect(hit.point.y).toBe(50);
    expect(flat.raycast(new Vector3(0, 100, 0), new Vector3(0, -2, 0), 1000, hit)).toBe(true);
    expect(hit.distance).toBeCloseTo(50, 9);
    expect(flat.lineOfSight(new Vector3(0, 51, 0), new Vector3(5000, 50, 0))).toBe(true);
  });
});
