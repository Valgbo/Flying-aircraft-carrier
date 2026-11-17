/**
 * World module: the generator's rules hold for every seed, not only for the world that
 * world.test.ts studies in detail. Seeds: the default world (1977), the smallest and the largest
 * seed the settings accept (0, 2^31), and 15, whose airbase access road once started 0.4 m off
 * the ground (its bed was laid on micro-relief the airfield flattens). Generation time per seed
 * is printed for the record (the budget itself is checked in worldPerf.test.ts).
 */
import { Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  RANGE_WORLD,
  createRoadPoint,
  createTerrain,
  generateTerrainData,
  nearestRoadPoint,
  pointAlongRoad,
  worldExtra,
  type Terrain,
  type TerrainData,
  type WorldExtra,
} from '../../../src/a10/core/world';
import {
  AREA_MAX_SLOPE,
  START_DISTANCE,
  areaGroundOk,
  areaSlopeAt,
} from '../../../src/a10/core/world/generate/areas';
import { headingOf, wrapPi } from '../../../src/a10/core/frames';
import { Rng } from '../../../src/a10/core/rng';

const SEEDS = [1977, 0, 15, 2 ** 31];

/** Distance outside the airfield's flat rectangle (0 inside), m. */
function airfieldDistance(a: NonNullable<WorldExtra['airfield']>, x: number, z: number): number {
  const ex = Math.sin(a.heading);
  const ez = -Math.cos(a.heading);
  const px = x - a.x;
  const pz = z - a.z;
  const along = Math.max(0, Math.abs(px * ex + pz * ez) - a.halfLength);
  const across = Math.max(0, Math.abs(-px * ez + pz * ex) - a.halfWidth);
  return Math.hypot(along, across);
}

describe.each(SEEDS)('seed %i', (seed) => {
  let data: TerrainData;
  let terrain: Terrain;
  let extra: WorldExtra;

  beforeAll(() => {
    const t0 = performance.now();
    data = generateTerrainData(seed, { cache: false });
    const t1 = performance.now();
    terrain = createTerrain(data);
    const t2 = performance.now();
    extra = worldExtra(data)!;
    console.log(
      `world seed ${seed}: generateTerrainData ${(t1 - t0).toFixed(0)} ms, createTerrain ${(t2 - t1).toFixed(0)} ms`,
    );
  }, 60000);

  it('spans a valley floor and ridges to about 900 m, with a river flowing downhill', () => {
    expect(terrain.maxHeight).toBeGreaterThan(800);
    expect(terrain.maxHeight).toBeLessThan(960);
    expect(terrain.minHeight).toBeGreaterThan(80);
    const river = terrain.rivers![0];
    for (let i = 1; i < river.levels.length; i++) {
      expect(river.levels[i]).toBeLessThanOrEqual(river.levels[i - 1] + 1e-9);
    }
    expect(river.levels[0]).toBeLessThan(250);
  });

  it('places 12–16 target areas of the four kinds and the three range areas by the rules', () => {
    const areas = terrain.targetAreas;
    const nonRange = areas.filter((a) => a.kind !== 'range');
    expect(nonRange.length).toBeGreaterThanOrEqual(12);
    expect(nonRange.length).toBeLessThanOrEqual(16);
    expect(new Set(nonRange.map((a) => a.kind))).toEqual(
      new Set(['open', 'treeline', 'road', 'dugIn']),
    );
    const names = areas
      .filter((a) => a.kind === 'range')
      .map((a) => a.name)
      .sort();
    expect(names).toEqual(['BOMB CIRCLE', 'STRAFE PIT', 'TACTICAL LANE']);
    const p = createRoadPoint();
    for (const a of areas) {
      // Centre on open ground; slope < 6° everywhere within the radius (rings every 1/7 radius).
      expect(['water', 'forest']).not.toContain(terrain.surfaceAt(a.x, a.z));
      expect(terrain.canopyAt(a.x, a.z)).toBe(0);
      if (a.kind !== 'range') expect(areaGroundOk(terrain, a.x, a.z, a.radius)).toBe(true);
      for (let r = 0; r <= a.radius; r += a.radius / 7) {
        for (let k = 0; k < 36; k++) {
          const ang = (k / 36) * Math.PI * 2;
          expect(
            areaSlopeAt(terrain, a.x + Math.cos(ang) * r, a.z + Math.sin(ang) * r),
          ).toBeLessThan(AREA_MAX_SLOPE);
        }
      }
      if (a.kind === 'road') {
        expect(terrain.roadDistanceAt!(a.x, a.z)).toBeLessThan(1);
        pointAlongRoad(terrain.roads[a.roadId!], a.roadDistance!, p);
        expect(Math.hypot(p.x - a.x, p.z - a.z)).toBeLessThan(0.5);
      }
      if (a.kind === 'range') {
        // Flat (on the pad's plane), clear of trees, no road through it.
        const pad = extra.pads.find((q) => Math.hypot(q.x - a.x, q.z - a.z) < 1)!;
        expect(pad).toBeDefined();
        for (let r = 0; r <= a.radius; r += a.radius / 6) {
          for (let k = 0; k < 24; k++) {
            const ang = (k / 24) * Math.PI * 2;
            const x = a.x + Math.cos(ang) * r;
            const z = a.z + Math.sin(ang) * r;
            const plane = pad.elevation + pad.gx * (x - pad.x) + pad.gz * (z - pad.z);
            expect(Math.abs(terrain.heightAt(x, z) - plane)).toBeLessThan(0.01);
            expect(terrain.canopyAt(x, z)).toBe(0);
          }
        }
        nearestRoadPoint(terrain.roads, a.x, a.z, p);
        expect(p.offset).toBeGreaterThan(a.radius + 10);
      }
    }
  });

  it('starts ~12 km from ALPHA, the nearest area, heading to it over the valley', () => {
    const s = terrain.start;
    const nonRange = terrain.targetAreas.filter((a) => a.kind !== 'range');
    const byDistance = [...nonRange].sort(
      (a, b) => Math.hypot(a.x - s.x, a.z - s.z) - Math.hypot(b.x - s.x, b.z - s.z),
    );
    const nearest = byDistance[0];
    expect(nearest.name).toBe('ALPHA');
    expect(Math.abs(Math.hypot(nearest.x - s.x, nearest.z - s.z) - START_DISTANCE)).toBeLessThan(
      600,
    );
    expect(Math.abs(wrapPi(s.heading - headingOf(nearest.x - s.x, nearest.z - s.z)))).toBeLessThan(
      0.01,
    );
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      for (const r of [0, 1000, 2000]) {
        expect(terrain.heightAt(s.x + Math.cos(ang) * r, s.z + Math.sin(ang) * r)).toBeLessThan(
          400,
        );
      }
    }
  });

  it('keeps roads flat across the pavement, on their published bed and within their design grade', () => {
    const p = createRoadPoint();
    const q = createRoadPoint();
    let worstCross = 0;
    let worstBed = 0;
    let worstGrade = 0;
    let checked = 0;
    for (const road of terrain.roads) {
      const hw = road.width / 2;
      const others = terrain.roads.filter((r) => r !== road);
      for (let s = 7; s < road.length!; s += 61) {
        pointAlongRoad(road, s, p);
        // Junctions and crossings belong to the earthworks of the higher-ranked road.
        if (nearestRoadPoint(others, p.x, p.z, q) && q.offset < 45) continue;
        checked++;
        const ex = Math.cos(p.heading);
        const ez = Math.sin(p.heading);
        let lo = Infinity;
        let hi = -Infinity;
        for (let k = -4; k <= 4; k++) {
          const off = (k / 4) * hw;
          const h = terrain.heightAt(p.x + ex * off, p.z + ez * off);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
        worstCross = Math.max(worstCross, hi - lo);
        // The bed is the ground: within the few centimetres a 15 m polyline bends on a curve.
        worstBed = Math.max(worstBed, Math.abs(terrain.heightAt(p.x, p.z) - p.y));
      }
      const limit =
        road.kind === 'highway'
          ? RANGE_WORLD.highwayMaxGrade
          : road.kind === 'road'
            ? RANGE_WORLD.roadMaxGrade
            : RANGE_WORLD.trackMaxGrade;
      const h = road.heights!;
      const a = road.arc!;
      for (let i = 1; i < h.length; i++) {
        worstGrade = Math.max(
          worstGrade,
          Math.abs(h[i] - h[i - 1]) / Math.max(1e-6, a[i] - a[i - 1]) / limit,
        );
      }
    }
    expect(checked).toBeGreaterThan(1500);
    expect(worstCross).toBeLessThan(0.3);
    expect(worstBed).toBeLessThan(0.15);
    expect(worstGrade).toBeLessThanOrEqual(1.0001);
  });

  it('has a flat concrete airfield, and the access road leaves the apron flush with it', () => {
    const ab = terrain.airbase!;
    const f = extra.airfield!;
    expect(ab.runwayLength).toBe(2400);
    for (const pv of ab.paved!) {
      const ex = Math.sin(pv.heading);
      const ez = -Math.cos(pv.heading);
      for (let a = -0.48; a <= 0.48; a += 0.12) {
        for (let b = -0.45; b <= 0.45; b += 0.45) {
          const x = pv.x + ex * a * pv.length - ez * b * pv.width;
          const z = pv.z + ez * a * pv.length + ex * b * pv.width;
          const plane = f.elevation + f.gx * (x - f.x) + f.gz * (z - f.z);
          expect(Math.abs(terrain.heightAt(x, z) - plane)).toBeLessThan(0.01);
          expect(terrain.surfaceAt(x, z)).toBe('concrete');
        }
      }
    }
    // Every road point within the airfield's flattening (its rectangle and blend zone) lies on
    // its published bed, and that bed is the airfield plane inside the rectangle.
    const p = createRoadPoint();
    let onAirfield = 0;
    for (const road of terrain.roads) {
      for (let s = 0; s < road.length!; s += 5) {
        pointAlongRoad(road, s, p);
        const d = airfieldDistance(f, p.x, p.z);
        if (d >= f.blend) continue;
        onAirfield++;
        const h = terrain.heightAt(p.x, p.z);
        expect(Math.abs(h - p.y)).toBeLessThan(0.02);
        if (d === 0)
          expect(
            Math.abs(h - (f.elevation + f.gx * (p.x - f.x) + f.gz * (p.z - f.z))),
          ).toBeLessThan(0.01);
      }
    }
    expect(onAirfield).toBeGreaterThan(5);
  });

  it('keeps water low and in the river, rock on steep slopes, trees off roads', () => {
    const r = new Rng(seed ^ 0x5eed);
    const h = terrain.size / 2;
    let rock = 0;
    for (let i = 0; i < 20000; i++) {
      const x = r.range(-h, h);
      const z = r.range(-h, h);
      const s = terrain.surfaceAt(x, z);
      if (s === 'water') {
        expect(terrain.heightAt(x, z)).toBeLessThan(250);
        expect(terrain.waterLevelAt!(x, z)).toBeGreaterThan(-Infinity);
      } else if (s === 'rock') {
        rock++;
        expect(terrain.slopeAt!(x, z)).toBeGreaterThan((15 * Math.PI) / 180);
      } else if (s === 'forest') {
        expect(terrain.canopyAt(x, z)).toBeGreaterThan(0);
      }
    }
    expect(rock).toBeGreaterThan(20);
    // On a road the ground is never steeper than the steepest design grade (+15 % for curves).
    const minNormalY = 1 / Math.hypot(1, RANGE_WORLD.trackMaxGrade * 1.15);
    const p = createRoadPoint();
    const n = new Vector3();
    for (const road of terrain.roads) {
      for (let s = 5; s < road.length!; s += 307) {
        pointAlongRoad(road, s, p);
        expect(terrain.canopyAt(p.x, p.z)).toBe(0);
        expect(terrain.normalAt(p.x, p.z, n).y).toBeGreaterThan(minNormalY);
      }
    }
  });
});
