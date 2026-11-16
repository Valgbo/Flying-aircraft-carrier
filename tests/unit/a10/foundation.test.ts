import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  attitudeFromQuaternion,
  bodyDirFromHudAngles,
  bodyToWorld,
  hudAnglesFromBodyDir,
  omegaFromRates,
  pitchRate,
  quaternionFromAttitude,
  rollRate,
  worldToBody,
  yawRate,
} from '../../../src/a10/core/frames';
import { Rng, createRngStreams } from '../../../src/a10/core/rng';
import { createSim, drainEvents, runSim } from '../../../src/a10/core/sim';
import type { SimEvent } from '../../../src/a10/core/types';
import { createFlatTerrain, createTerrain, generateTerrainData } from '../../../src/a10/core/world';

const DEG = Math.PI / 180;

describe('frames', () => {
  it('heading 90° points the nose east, pitch up raises it, bank right lowers the right wing', () => {
    const q = quaternionFromAttitude(90 * DEG, 0, 0, new Quaternion());
    const nose = bodyToWorld(q, new Vector3(0, 0, -1), new Vector3());
    expect(nose.x).toBeCloseTo(1, 6);
    expect(nose.z).toBeCloseTo(0, 6);

    const up = quaternionFromAttitude(0, 30 * DEG, 0, new Quaternion());
    const nose2 = bodyToWorld(up, new Vector3(0, 0, -1), new Vector3());
    expect(nose2.y).toBeCloseTo(Math.sin(30 * DEG), 6);
    expect(nose2.z).toBeCloseTo(-Math.cos(30 * DEG), 6);

    const bank = quaternionFromAttitude(0, 0, 20 * DEG, new Quaternion());
    const right = bodyToWorld(bank, new Vector3(1, 0, 0), new Vector3());
    expect(right.y).toBeCloseTo(-Math.sin(20 * DEG), 6);
  });

  it('attitude round-trips through a quaternion', () => {
    const out = { heading: 0, pitch: 0, bank: 0 };
    for (const [h, p, b] of [
      [10, 5, -30],
      [200, -40, 60],
      [359, 80, 0],
    ]) {
      const q = quaternionFromAttitude(h * DEG, p * DEG, b * DEG, new Quaternion());
      attitudeFromQuaternion(q, out);
      expect(out.heading / DEG).toBeCloseTo(h, 6);
      expect(out.pitch / DEG).toBeCloseTo(p, 6);
      expect(out.bank / DEG).toBeCloseTo(b, 6);
    }
  });

  it('world↔body rotation round-trips', () => {
    const q = quaternionFromAttitude(1, 0.3, -0.4, new Quaternion());
    const v = new Vector3(3, -2, 7);
    const back = worldToBody(q, bodyToWorld(q, v, new Vector3()), new Vector3());
    expect(back.distanceTo(v)).toBeLessThan(1e-9);
  });

  it('aviation rates map to body angular velocity', () => {
    const w = omegaFromRates(0.1, 0.2, 0.3, new Vector3());
    expect(rollRate(w)).toBeCloseTo(0.1);
    expect(pitchRate(w)).toBeCloseTo(0.2);
    expect(yawRate(w)).toBeCloseTo(0.3);
  });

  it('HUD angles: right and up are positive and round-trip', () => {
    const a = { az: 0, el: 0 };
    hudAnglesFromBodyDir(new Vector3(0.1, 0, -1), a);
    expect(a.az).toBeGreaterThan(0);
    hudAnglesFromBodyDir(new Vector3(0, -0.1, -1), a);
    expect(a.el).toBeLessThan(0);
    const d = bodyDirFromHudAngles(0.05, -0.03, new Vector3());
    hudAnglesFromBodyDir(d, a);
    expect(a.az).toBeCloseTo(0.05, 9);
    expect(a.el).toBeCloseTo(-0.03, 9);
  });
});

describe('rng', () => {
  it('is deterministic and streams are independent', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
    const s1 = createRngStreams(7);
    const s2 = createRngStreams(7);
    s1.gun.next();
    expect(s1.targets.next()).toBe(s2.targets.next());
  });

  it('normal deviates have unit variance', () => {
    const r = new Rng(3);
    let sum = 0;
    let sq = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const x = r.normal();
      sum += x;
      sq += x * x;
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.03);
    expect(Math.abs(sq / n - 1)).toBeLessThan(0.05);
  });
});

describe('terrain stand-in contract', () => {
  it('segment and ray hits land on the surface', () => {
    const t = createTerrain(generateTerrainData(1));
    const hit = {
      point: new Vector3(),
      normal: new Vector3(),
      distance: 0,
      t: 0,
      surface: 'grass' as const,
    };
    const p0 = new Vector3(100, 2000, 100);
    const p1 = new Vector3(900, -100, 300);
    expect(t.segmentHit(p0, p1, hit)).toBe(true);
    expect(Math.abs(hit.point.y - t.heightAt(hit.point.x, hit.point.z))).toBeLessThan(0.05);
    expect(t.raycast(p0, new Vector3(0, -1, 0), 5000, hit)).toBe(true);
    expect(hit.point.x).toBeCloseTo(100, 6);
    expect(t.lineOfSight(new Vector3(0, 3000, 0), new Vector3(10, 3000, 10))).toBe(true);
  });

  it('flat terrain is flat', () => {
    const t = createFlatTerrain(50);
    expect(t.heightAt(1234, -999)).toBe(50);
  });
});

describe('sim loop', () => {
  it('runs, stays finite and is deterministic', () => {
    const run = () => {
      const sim = createSim({ seed: 5, terrain: createTerrain(generateTerrainData(5)) });
      runSim(sim, 10, (s) => {
        s.input.roll = s.time < 2 ? 0.3 : 0;
      });
      return sim;
    };
    const a = run();
    const b = run();
    expect(Number.isFinite(a.aircraft.position.x)).toBe(true);
    expect(a.aircraft.position.toArray()).toEqual(b.aircraft.position.toArray());
    expect(a.time).toBeCloseTo(10, 6);
    const events: SimEvent[] = [];
    drainEvents(a, events);
    expect(a.events.length).toBe(0);
  });

  it('places target groups for free hunt', () => {
    const sim = createSim({ seed: 1, terrain: createTerrain(generateTerrainData(1)) });
    expect(sim.targets.vehicles.length).toBeGreaterThan(0);
  });
});
