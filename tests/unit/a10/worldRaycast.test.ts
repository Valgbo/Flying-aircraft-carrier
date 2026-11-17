/**
 * World module: segmentHit / raycast / lineOfSight are exact against the height function.
 * Every answer is compared with brute-force fine sampling of heightAt along the same line.
 */
import { Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createTerrain,
  generateTerrainData,
  type Terrain,
  type TerrainHit,
} from '../../../src/a10/core/world';
import { Rng } from '../../../src/a10/core/rng';

let terrain: Terrain;

beforeAll(() => {
  terrain = createTerrain(generateTerrainData(4));
}, 60000);

const hit = (): TerrainHit => ({
  point: new Vector3(),
  normal: new Vector3(),
  distance: 0,
  t: 0,
  surface: 'grass',
});

interface Brute {
  /** First crossing (refined to 0.1 mm), or -1. */
  s: number;
  /** Smallest clearance seen along the line, m. */
  minGap: number;
}

/** Brute force: sample every `step` metres, refine the first sign change by bisection. */
function brute(t: Terrain, p: Vector3, d: Vector3, len: number, step: number): Brute {
  const gap = (s: number) => p.y + d.y * s - t.heightAt(p.x + d.x * s, p.z + d.z * s);
  let minGap = gap(0);
  if (minGap <= 0) return { s: 0, minGap };
  let prev = 0;
  const n = Math.ceil(len / step);
  for (let k = 1; k <= n; k++) {
    const s = Math.min(len, k * step);
    const g = gap(s);
    if (g < minGap) minGap = g;
    if (g <= 0) {
      let lo = prev;
      let hi = s;
      for (let i = 0; i < 40; i++) {
        const m = 0.5 * (lo + hi);
        if (gap(m) > 0) lo = m;
        else hi = m;
      }
      return { s: hi, minGap };
    }
    prev = s;
  }
  return { s: -1, minGap };
}

/** Compare one segment query with brute force. Returns false when the case is tangent. */
function check(t: Terrain, p0: Vector3, p1: Vector3, step: number): boolean {
  const d = new Vector3().subVectors(p1, p0);
  const len = d.length();
  d.multiplyScalar(1 / len);
  const b = brute(t, p0, d, len, step);
  const h = hit();
  const got = t.segmentHit(p0, p1, h);
  // A line that only touches the ground within millimetres is a tie either way.
  if (Math.abs(b.minGap) < 0.003 && b.s < 0) return false;
  if (b.s < 0) {
    if (got) {
      // We may report a touch the sampling stepped over: it must really touch.
      const g = h.point.y - t.heightAt(h.point.x, h.point.z);
      expect(Math.abs(g)).toBeLessThan(0.01);
      const ray = p0.y + d.y * h.distance;
      expect(ray - h.point.y).toBeLessThan(0.003);
      return true;
    }
    return true;
  }
  expect(got).toBe(true);
  // On the surface (< 5 cm), and not before the first crossing nor after it.
  expect(Math.abs(h.point.y - t.heightAt(h.point.x, h.point.z))).toBeLessThan(0.05);
  const ray = p0.y + d.y * h.distance;
  expect(Math.abs(ray - h.point.y)).toBeLessThan(0.05);
  expect(h.distance).toBeLessThanOrEqual(b.s + 0.05);
  // Earlier than the sampled crossing only where the sampling stepped over a thin dip.
  if (h.distance < b.s - 0.05) {
    expect(
      Math.abs(ray - t.heightAt(p0.x + d.x * h.distance, p0.z + d.z * h.distance)),
    ).toBeLessThan(0.005);
  }
  expect(h.t).toBeCloseTo(h.distance / len, 9);
  return true;
}

describe('segmentHit', () => {
  it('matches brute force on random short segments near the ground (rounds, bombs)', () => {
    const r = new Rng(21);
    let compared = 0;
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      const x = r.range(-30000, 30000);
      const z = r.range(-30000, 30000);
      const g = terrain.heightAt(x, z);
      const p0 = new Vector3(x, g + r.range(0.2, 25), z);
      const el = r.range(-1.2, 0.2);
      const az = r.range(0, Math.PI * 2);
      const len = r.range(2, 60);
      const p1 = new Vector3(
        x + Math.cos(el) * Math.sin(az) * len,
        p0.y + Math.sin(el) * len,
        z + Math.cos(el) * Math.cos(az) * len,
      );
      if (check(terrain, p0, p1, 0.01)) compared++;
      if (terrain.segmentHit(p0, p1, hit())) hits++;
    }
    expect(compared).toBeGreaterThan(380);
    expect(hits).toBeGreaterThan(100);
  });

  it('is exact for grazing segments (shallow angles, centimetres above the ground)', () => {
    const r = new Rng(22);
    let compared = 0;
    for (let i = 0; i < 160; i++) {
      const x = r.range(-30000, 30000);
      const z = r.range(-30000, 30000);
      const az = r.range(0, Math.PI * 2);
      const len = r.range(20, 150);
      const x1 = x + Math.sin(az) * len;
      const z1 = z + Math.cos(az) * len;
      // Both ends just above the ground: the line skims the micro-relief.
      const p0 = new Vector3(x, terrain.heightAt(x, z) + r.range(0.01, 0.6), z);
      const p1 = new Vector3(x1, terrain.heightAt(x1, z1) + r.range(0.01, 0.6), z1);
      if (check(terrain, p0, p1, 0.005)) compared++;
    }
    expect(compared).toBeGreaterThan(140);
  });

  it('is exact across roads, river banks, the airfield and range pads', () => {
    const r = new Rng(23);
    const spots: Array<[number, number]> = [];
    for (const road of terrain.roads) {
      for (let k = 0; k < road.points.length / 2; k += 97)
        spots.push([road.points[2 * k], road.points[2 * k + 1]]);
    }
    const river = terrain.rivers![0];
    for (let k = 0; k < river.points.length / 2; k += 61)
      spots.push([river.points[2 * k], river.points[2 * k + 1]]);
    for (const a of terrain.targetAreas) if (a.kind === 'range') spots.push([a.x + a.radius, a.z]);
    const ab = terrain.airbase!;
    spots.push([ab.x, ab.z], [ab.x + 300, ab.z + 300]);
    let compared = 0;
    for (const [sx, sz] of spots) {
      const x = sx + r.range(-30, 30);
      const z = sz + r.range(-30, 30);
      const az = r.range(0, Math.PI * 2);
      const el = r.range(-0.6, 0.05);
      const len = r.range(10, 80);
      const p0 = new Vector3(x, terrain.heightAt(x, z) + r.range(0.05, 6), z);
      const p1 = new Vector3(
        x + Math.cos(el) * Math.sin(az) * len,
        p0.y + Math.sin(el) * len,
        z + Math.cos(el) * Math.cos(az) * len,
      );
      if (check(terrain, p0, p1, 0.01)) compared++;
    }
    expect(compared).toBeGreaterThan(spots.length * 0.9);
  });

  it('a segment starting under the ground hits at its start; one far above never hits', () => {
    const h = hit();
    const x = 1234;
    const z = -4321;
    const g = terrain.heightAt(x, z);
    expect(terrain.segmentHit(new Vector3(x, g - 0.5, z), new Vector3(x + 10, g + 50, z), h)).toBe(
      true,
    );
    expect(h.distance).toBe(0);
    expect(terrain.segmentHit(new Vector3(x, 2000, z), new Vector3(x + 8, 1999, z + 3), h)).toBe(
      false,
    );
  });

  it('works outside the map, where the edge height continues', () => {
    const h = hit();
    const half = terrain.size / 2;
    const p0 = new Vector3(half + 500, 1500, 100);
    const p1 = new Vector3(half + 600, -100, 150);
    expect(terrain.segmentHit(p0, p1, h)).toBe(true);
    expect(Math.abs(h.point.y - terrain.heightAt(h.point.x, h.point.z))).toBeLessThan(0.05);
    check(
      terrain,
      new Vector3(half - 40, terrain.heightAt(half, 0) + 3, 0),
      new Vector3(half + 60, terrain.heightAt(half, 0) - 2, 5),
      0.01,
    );
  });
});

describe('raycast', () => {
  it('from 3,000 m down to the ground matches brute force', () => {
    const r = new Rng(31);
    for (let i = 0; i < 60; i++) {
      const o = new Vector3(r.range(-30000, 30000), 3000, r.range(-30000, 30000));
      const el = r.range(-Math.PI / 2, -0.12);
      const az = r.range(0, Math.PI * 2);
      const dir = new Vector3(
        Math.cos(el) * Math.sin(az),
        Math.sin(el),
        Math.cos(el) * Math.cos(az),
      );
      const h = hit();
      const got = terrain.raycast(o, dir.clone().multiplyScalar(7), 40000, h);
      // Brute force from where the ray first reaches the terrain's height range.
      const s0 = (3000 - terrain.maxHeight) / -dir.y;
      const start = o.clone().addScaledVector(dir, s0);
      const b = brute(terrain, start, dir, 40000 - s0, 0.05);
      if (b.s < 0) {
        expect(got).toBe(false);
        continue;
      }
      expect(got).toBe(true);
      expect(Math.abs(h.distance - (s0 + b.s))).toBeLessThan(0.05);
      expect(h.t).toBeCloseTo(h.distance / 40000, 9);
      expect(Math.abs(h.point.y - terrain.heightAt(h.point.x, h.point.z))).toBeLessThan(0.05);
    }
  });

  it('straight down hits under the origin; upward never hits', () => {
    const h = hit();
    const o = new Vector3(-7000, 2500, 8000);
    expect(terrain.raycast(o, new Vector3(0, -1, 0), 5000, h)).toBe(true);
    expect(h.point.x).toBeCloseTo(-7000, 6);
    expect(h.point.z).toBeCloseTo(8000, 6);
    expect(h.distance).toBeCloseTo(2500 - terrain.heightAt(-7000, 8000), 2);
    expect(terrain.raycast(o, new Vector3(0.3, 1, 0), 50000, h)).toBe(false);
  });
});

describe('lineOfSight', () => {
  /** Brute-force line of sight (ground only, or with the canopy volume), 1 m kept clear at both ends. */
  function bruteLos(a: Vector3, b: Vector3, trees: boolean): boolean {
    const d = new Vector3().subVectors(b, a);
    const len = d.length();
    d.multiplyScalar(1 / len);
    for (let s = 1; s <= len - 1; s += 0.5) {
      const x = a.x + d.x * s;
      const z = a.z + d.z * s;
      const y = a.y + d.y * s;
      const g = terrain.heightAt(x, z);
      if (y <= g) return false;
      if (trees) {
        const c = terrain.canopyAt(x, z);
        if (c > 0 && y < g + c) return false;
      }
    }
    return true;
  }

  it('agrees with brute force on random sight lines (ground and trees)', () => {
    const r = new Rng(41);
    let blocked = 0;
    let blockedByTrees = 0;
    for (let i = 0; i < 120; i++) {
      const x = r.range(-28000, 28000);
      const z = r.range(-28000, 28000);
      const a = new Vector3(x, terrain.heightAt(x, z) + r.range(1.5, 40), z);
      const ang = r.range(0, Math.PI * 2);
      const dist = r.range(200, 3000);
      const bx = x + Math.cos(ang) * dist;
      const bz = z + Math.sin(ang) * dist;
      const b = new Vector3(bx, terrain.heightAt(bx, bz) + r.range(1.5, 40), bz);
      const ground = terrain.lineOfSight(a, b, false);
      const trees = terrain.lineOfSight(a, b, true);
      const bg = bruteLos(a, b, false);
      const bt = bruteLos(a, b, true);
      // Sampling every 0.5 m can step over a sliver of ground the exact test sees; never the reverse.
      if (bg) expect(ground).toBe(true);
      if (!ground) expect(bg).toBe(false);
      if (!bt) expect(trees).toBe(false);
      if (!ground) blocked++;
      if (ground && !trees) blockedByTrees++;
    }
    expect(blocked).toBeGreaterThan(10);
    expect(blockedByTrees).toBeGreaterThan(3);
  });

  it('is blocked behind a ridge and clear along the valley', () => {
    // Along the river, 300 m above the water: the valley is open.
    const river = terrain.rivers![0];
    const p = river.points;
    const i = Math.floor(p.length / 4);
    const j = i + 2 * Math.floor(500);
    const a = new Vector3(p[i], river.levels[i / 2] + 300, p[i + 1]);
    const b = new Vector3(p[j], river.levels[j / 2] + 300, p[j + 1]);
    expect(a.distanceTo(b)).toBeGreaterThan(5000);
    expect(terrain.lineOfSight(a, b)).toBe(true);
    // Find the highest point of the map and look across it near the ground.
    let best = { x: 0, z: 0, h: -Infinity };
    for (let gz = -30000; gz <= 30000; gz += 500) {
      for (let gx = -30000; gx <= 30000; gx += 500) {
        const h = terrain.heightAt(gx, gz);
        if (h > best.h) best = { x: gx, z: gz, h };
      }
    }
    let found = false;
    for (let k = 0; k < 16 && !found; k++) {
      const ang = (k / 16) * Math.PI * 2;
      const c = new Vector3(best.x + Math.cos(ang) * 1500, 0, best.z + Math.sin(ang) * 1500);
      const e = new Vector3(best.x - Math.cos(ang) * 1500, 0, best.z - Math.sin(ang) * 1500);
      c.y = terrain.heightAt(c.x, c.z) + 2;
      e.y = terrain.heightAt(e.x, e.z) + 2;
      if (Math.max(c.y, e.y) < best.h - 50) {
        expect(terrain.lineOfSight(c, e)).toBe(false);
        expect(bruteLos(c, e, false)).toBe(false);
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  it('trees block only when asked to', () => {
    // A sight line skimming 3 m over a forest stand: clear of the ground, blocked by the canopy.
    const r = new Rng(43);
    let tested = 0;
    for (let i = 0; i < 4000 && tested < 5; i++) {
      const x = r.range(-28000, 28000);
      const z = r.range(-28000, 28000);
      if (terrain.canopyAt(x, z) < 10 || (terrain.forestDensityAt?.(x, z) ?? 0) < 0.7) continue;
      const ang = r.range(0, Math.PI * 2);
      const a = new Vector3(x - Math.cos(ang) * 60, 0, z - Math.sin(ang) * 60);
      const b = new Vector3(x + Math.cos(ang) * 60, 0, z + Math.sin(ang) * 60);
      a.y = Math.max(terrain.heightAt(a.x, a.z), terrain.heightAt(x, z)) + 4;
      b.y = Math.max(terrain.heightAt(b.x, b.z), terrain.heightAt(x, z)) + 4;
      if (!bruteLos(a, b, false) || bruteLos(a, b, true)) continue;
      expect(terrain.lineOfSight(a, b, false)).toBe(true);
      expect(terrain.lineOfSight(a, b, true)).toBe(false);
      tested++;
    }
    expect(tested).toBe(5);
  });

  it('a point on the ground can be seen from above', () => {
    for (const a of terrain.targetAreas) {
      const g = new Vector3(a.x, terrain.heightAt(a.x, a.z), a.z);
      const eye = new Vector3(a.x + 1500, g.y + 1200, a.z - 800);
      expect(terrain.lineOfSight(eye, g, false)).toBe(bruteLos(eye, g, false));
    }
  });
});
