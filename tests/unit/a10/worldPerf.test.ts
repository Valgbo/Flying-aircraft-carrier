/**
 * World module performance budgets (PLAN_A10.md §14 and the world brief). Each figure is the best
 * of several repetitions of a performance.now() loop, so a busy machine (parallel test workers)
 * does not fail the test for time the process did not get; generation also reports CPU time.
 */
import { Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createTerrain,
  generateTerrainData,
  type Terrain,
  type TerrainData,
  type TerrainHit,
} from '../../../src/a10/core/world';
import { Rng } from '../../../src/a10/core/rng';

let data: TerrainData;
let terrain: Terrain;
let genWallMs = 0;
let genCpuMs = 0;
const results: Array<[string, number, number, string]> = [];

/** Process CPU time, ms (Node), or NaN where unavailable. */
function cpuMs(): number {
  const proc = (globalThis as { process?: { cpuUsage(): { user: number; system: number } } }).process;
  if (!proc) return NaN;
  const c = proc.cpuUsage();
  return (c.user + c.system) / 1000;
}

beforeAll(() => {
  const c0 = cpuMs();
  const t0 = performance.now();
  data = generateTerrainData(7);
  genWallMs = performance.now() - t0;
  genCpuMs = cpuMs() - c0;
  terrain = createTerrain(data);
}, 60000);

/**
 * Mean per-call time (µs) over all `n` inputs, taken as the best of `reps` passes; each pass runs
 * the inputs in short batches and keeps each batch's best time, so a descheduled slice of a busy
 * machine is not counted.
 */
function bench(n: number, reps: number, fn: (i: number) => number): number {
  let sink = 0;
  for (let i = 0; i < Math.min(n, 2000); i++) sink += fn(i); // warm up
  const batch = Math.max(1, Math.ceil(n / 20));
  let total = 0;
  for (let b0 = 0; b0 < n; b0 += batch) {
    const b1 = Math.min(n, b0 + batch);
    let best = Infinity;
    for (let r = 0; r < reps; r++) {
      const t0 = performance.now();
      for (let i = b0; i < b1; i++) sink += fn(i);
      best = Math.min(best, performance.now() - t0);
    }
    total += best;
  }
  if (sink === 0.123456789) console.log(sink);
  return (total * 1000) / n;
}

function record(name: string, value: number, budget: number, unit: string): void {
  results.push([name, value, budget, unit]);
}

const hit: TerrainHit = { point: new Vector3(), normal: new Vector3(), distance: 0, t: 0, surface: 'grass' };

describe('world performance budgets', () => {
  it('generateTerrainData < 3 s', () => {
    // On a quiet machine wall time is the cost; under load the process CPU time is.
    const ms = Number.isNaN(genCpuMs) ? genWallMs : Math.min(genWallMs, genCpuMs);
    record('generateTerrainData (min of wall, CPU)', ms, 3000, 'ms');
    console.log(`generateTerrainData: wall ${genWallMs.toFixed(0)} ms, CPU ${genCpuMs.toFixed(0)} ms`);
    expect(ms).toBeLessThan(3000);
  });

  it('heightAt < 1 µs mean', () => {
    const r = new Rng(1);
    const N = 100000;
    const xs = new Float64Array(N).map(() => r.range(-32000, 32000));
    const zs = new Float64Array(N).map(() => r.range(-32000, 32000));
    const us = bench(N, 5, (i) => terrain.heightAt(xs[i], zs[i]));
    record('heightAt (random points)', us, 1, 'µs');
    expect(us).toBeLessThan(1);
  });

  it('segmentHit: an 8.5 m segment far above the ground < 0.5 µs, near the ground < 15 µs', () => {
    const r = new Rng(2);
    const N = 20000;
    const far: Vector3[] = [];
    const near: Vector3[] = [];
    for (let i = 0; i < N; i++) {
      const x = r.range(-31000, 31000);
      const z = r.range(-31000, 31000);
      const g = terrain.heightAt(x, z);
      // One 30 mm round step (1/120 s at ≈ 1,020 m/s) along a random direction.
      const el = r.range(-0.8, 0.1);
      const az = r.range(0, Math.PI * 2);
      const d = new Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).multiplyScalar(8.5);
      const a = new Vector3(x, g + r.range(300, 2500), z);
      far.push(a, a.clone().add(d));
      // Near the ground: the last steps before impact (some hit, some pass over).
      const b = new Vector3(x, g + r.range(0, 8), z);
      near.push(b, b.clone().add(d));
    }
    const usFar = bench(N, 5, (i) => (terrain.segmentHit(far[2 * i], far[2 * i + 1], hit) ? 1 : 0));
    const usNear = bench(N, 5, (i) => (terrain.segmentHit(near[2 * i], near[2 * i + 1], hit) ? 1 : 0));
    record('segmentHit 8.5 m, far above ground', usFar, 0.5, 'µs');
    record('segmentHit 8.5 m, near ground (incl. hit details)', usNear, 15, 'µs');
    expect(usFar).toBeLessThan(0.5);
    expect(usNear).toBeLessThan(15);
  });

  it('lineOfSight over 10 km < 300 µs', () => {
    const r = new Rng(3);
    const N = 300;
    const air: Vector3[] = [];
    const ground: Vector3[] = [];
    for (let i = 0; i < N; i++) {
      const x = r.range(-25000, 25000);
      const z = r.range(-25000, 25000);
      const ang = r.range(0, Math.PI * 2);
      const tx = Math.max(-31000, Math.min(31000, x + Math.cos(ang) * 10000));
      const tz = Math.max(-31000, Math.min(31000, z + Math.sin(ang) * 10000));
      // Aircraft at 1,000–3,000 m looking at a vehicle on the ground (sensors, eyes).
      air.push(new Vector3(x, r.range(1000, 3000), z), new Vector3(tx, terrain.heightAt(tx, tz) + 1.5, tz));
      // Ground to ground, 2 m up at both ends (the hardest: the whole line is low).
      ground.push(new Vector3(x, terrain.heightAt(x, z) + 2, z), new Vector3(tx, terrain.heightAt(tx, tz) + 2, tz));
    }
    const usAir = bench(N, 5, (i) => (terrain.lineOfSight(air[2 * i], air[2 * i + 1], false) ? 1 : 0));
    const usAirTrees = bench(N, 5, (i) => (terrain.lineOfSight(air[2 * i], air[2 * i + 1], true) ? 1 : 0));
    const usGround = bench(N, 5, (i) => (terrain.lineOfSight(ground[2 * i], ground[2 * i + 1], false) ? 1 : 0));
    const usGroundTrees = bench(N, 5, (i) => (terrain.lineOfSight(ground[2 * i], ground[2 * i + 1], true) ? 1 : 0));
    record('lineOfSight 10 km, air to ground', usAir, 300, 'µs');
    record('lineOfSight 10 km, air to ground, trees', usAirTrees, 300, 'µs');
    record('lineOfSight 10 km, ground to ground', usGround, 300, 'µs');
    record('lineOfSight 10 km, ground to ground, trees', usGroundTrees, 300, 'µs');
    expect(usAir).toBeLessThan(300);
    expect(usAirTrees).toBeLessThan(300);
    expect(usGround).toBeLessThan(300);
    expect(usGroundTrees).toBeLessThan(300);
  });

  it('raycast from 3,000 m down to the ground < 50 µs', () => {
    const r = new Rng(4);
    const N = 3000;
    const o: Vector3[] = [];
    const d: Vector3[] = [];
    for (let i = 0; i < N; i++) {
      o.push(new Vector3(r.range(-30000, 30000), 3000, r.range(-30000, 30000)));
      const el = r.range(-Math.PI / 2, -0.15);
      const az = r.range(0, Math.PI * 2);
      d.push(new Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)));
    }
    const us = bench(N, 5, (i) => (terrain.raycast(o[i], d[i], 30000, hit) ? 1 : 0));
    record('raycast 3,000 m down (incl. hit details)', us, 50, 'µs');
    expect(us).toBeLessThan(50);
  });

  it('report', () => {
    console.log('\n| Measure | Measured | Budget |\n|---|---|---|');
    for (const [name, v, b, unit] of results) {
      console.log(`| ${name} | ${v.toFixed(v < 10 ? 3 : 1)} ${unit} | < ${b} ${unit} |`);
    }
    expect(results.length).toBeGreaterThan(0);
  });
});
