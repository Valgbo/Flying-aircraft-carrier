/**
 * Rounds against vehicles (PLAN_A10.md §6.3; docs/a10/ARCHITECTURE.md §4): the weapons side of a
 * hit. The targets module is replaced by flat test plates (vi.mock), so these tests measure the
 * weapons module alone: the nearer of ground and vehicle wins, a ricochet flies on with the
 * velocity the targets module returns, a skipping round can still hit a vehicle, HEI bursts with
 * a detonation and a blast, and the burst record counts each hitting round once, even when it
 * lands after the burst ended.
 */
import { Vector3 } from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVehicle } from '../../../src/a10/core/targets';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { DEG } from '../../../src/a10/core/units';
import { allocRound, RoundType } from '../../../src/a10/core/weapons';
import {
  createGunTestbed as createBed,
  runKinematic,
  stepKinematic,
} from '../../../src/a10/core/weapons/testbed';
import { createFlatTerrain } from '../../../src/a10/core/world';
import type { SurfaceKind, Terrain } from '../../../src/a10/core/world/types';
import { GAU8 } from '../../../src/a10/data/gun';

interface Plate {
  id: number;
  /** Centre, outward normal and the two in-plane half-axes (unit vectors × half sizes). */
  c: [number, number, number];
  n: [number, number, number];
  u: [number, number, number];
  v: [number, number, number];
  halfU: number;
  halfV: number;
}

const mock = vi.hoisted(() => ({
  plates: [] as Plate[],
  blasts: [] as {
    x: number;
    y: number;
    z: number;
    charge: number;
    fragments: number;
    weapon?: string;
    sourceId?: number;
  }[],
  resolved: 0,
  /** Round ids passed to resolveRoundHit, in call order. */
  sourceIds: [] as number[],
  /** Vehicles whose plates the rounds go through (scoring panels). */
  panels: new Set<number>(),
}));

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

vi.mock('../../../src/a10/core/targets', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/a10/core/targets')>();
  return {
    ...real,
    segmentHitVehicle(
      _sim: Sim,
      p0: { x: number; y: number; z: number },
      p1: { x: number; y: number; z: number },
      out: import('../../../src/a10/core/targets/types').VehicleHit,
    ): boolean {
      let best = Infinity;
      for (const pl of mock.plates) {
        const d = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z];
        const denom = dot(d, pl.n);
        if (denom >= 0) continue; // only the outer face
        const t = dot([pl.c[0] - p0.x, pl.c[1] - p0.y, pl.c[2] - p0.z], pl.n) / denom;
        if (t < 0 || t > 1 || t >= best) continue;
        const q = [p0.x + d[0] * t, p0.y + d[1] * t, p0.z + d[2] * t];
        const r = [q[0] - pl.c[0], q[1] - pl.c[1], q[2] - pl.c[2]];
        if (Math.abs(dot(r, pl.u)) > pl.halfU || Math.abs(dot(r, pl.v)) > pl.halfV) continue;
        best = t;
        out.vehicleId = pl.id;
        out.t = t;
        out.point.set(q[0], q[1], q[2]);
        out.normal.set(pl.n[0], pl.n[1], pl.n[2]);
        out.thicknessMm = 20;
        out.part = 'hull';
        out.face = 'rear';
        out.plate = 0;
      }
      return best < Infinity;
    },
    resolveRoundHit(
      _sim: Sim,
      hit: import('../../../src/a10/core/targets/types').VehicleHit,
      type: number,
      velocity: { x: number; y: number; z: number },
      out: import('../../../src/a10/core/targets/types').RoundHitResult,
      sourceId = 0,
    ) {
      mock.resolved++;
      mock.sourceIds.push(sourceId);
      const n = hit.normal;
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
      const along = -(velocity.x * n.x + velocity.y * n.y + velocity.z * n.z) / speed;
      const obliquity = Math.acos(Math.max(-1, Math.min(1, along)));
      out.obliquity = obliquity;
      out.effectiveThicknessMm = 20 / Math.cos(obliquity);
      out.penetrationMm = 60;
      out.damaged = [];
      out.ricochetVelocity.set(0, 0, 0);
      if (type === 1) out.outcome = 'burst';
      else if (mock.panels.has(hit.vehicleId)) out.outcome = 'passedThrough';
      else if (obliquity > 70 * (Math.PI / 180)) {
        out.outcome = 'ricochet';
        const k = 2 * (velocity.x * n.x + velocity.y * n.y + velocity.z * n.z);
        out.ricochetVelocity
          .set(velocity.x - k * n.x, velocity.y - k * n.y, velocity.z - k * n.z)
          .multiplyScalar(0.6);
      } else out.outcome = 'penetrated';
      return out;
    },
    applyBlast(
      _sim: Sim,
      p: { x: number; y: number; z: number },
      charge: number,
      fragments = 0,
      weapon?: string,
      sourceId?: number,
    ) {
      mock.blasts.push({ x: p.x, y: p.y, z: p.z, charge, fragments, weapon, sourceId });
    },
  };
});

type Impact = Extract<SimEvent, { type: 'roundImpact' }>;
const impacts = (sim: Sim): Impact[] =>
  sim.events.filter((e): e is Impact => e.type === 'roundImpact');

/** A target board facing the aircraft (outward normal +Z) at z, 10 m tall, 10 m wide or more. */
function board(id: number, z: number, halfWidth = 5): Plate {
  return { id, c: [0, 5, z], n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], halfU: halfWidth, halfV: 5 };
}

function ground(surface: SurfaceKind): Terrain {
  const base = createFlatTerrain(0);
  return {
    ...base,
    surfaceAt: () => surface,
    moistureAt: () => 0.1,
    segmentHit(p0, p1, out) {
      const hit = base.segmentHit(p0, p1, out);
      if (hit) out.surface = surface;
      return hit;
    },
  };
}

function shoot(sim: Sim, type: RoundType, p: Vector3, v: Vector3, burst = 0): number {
  const pool = sim.projectiles.rounds;
  const i = allocRound(pool);
  pool.type[i] = type;
  pool.px[i] = p.x;
  pool.py[i] = p.y;
  pool.pz[i] = p.z;
  pool.vx[i] = v.x;
  pool.vy[i] = v.y;
  pool.vz[i] = v.z;
  pool.fireTime[i] = sim.time;
  pool.burst[i] = burst;
  return i;
}

/**
 * The gun test bed with one (far-away) vehicle on the range: the weapons module only asks the
 * targets module for hits while vehicles exist. The mocked plates stand in for its armour.
 */
function createGunTestbed(opts: Parameters<typeof createBed>[0]): Sim {
  const sim = createBed(opts);
  createVehicle(sim, 'hulk', 20000, 20000, 0, 1);
  return sim;
}

function runUntilEmpty(sim: Sim): void {
  for (let k = 0; k < 1200 && sim.projectiles.rounds.live > 0; k++) stepKinematic(sim);
}

beforeEach(() => {
  mock.plates.length = 0;
  mock.blasts.length = 0;
  mock.resolved = 0;
  mock.sourceIds.length = 0;
  mock.panels.clear();
});

describe('rounds against vehicles (targets mocked)', () => {
  it('an API round hitting a plate head-on reports the vehicle and ends there', () => {
    mock.plates.push(board(42, -300));
    const sim = createGunTestbed({ altitude: 500 });
    shoot(sim, RoundType.API, new Vector3(0, 5, 0), new Vector3(0, 0, -1000));
    runUntilEmpty(sim);
    const ev = impacts(sim);
    expect(ev).toHaveLength(1);
    expect(ev[0].target).toEqual({ kind: 'vehicle', vehicleId: 42, part: 'hull' });
    expect(ev[0].outcome).toBe('penetrated');
    expect(ev[0].position.z).toBeCloseTo(-300, 6);
    expect(ev[0].normal).toEqual({ x: 0, y: 0, z: 1 });
    // Velocity at impact: slowed by drag over 300 m, still ≈930 m/s.
    const speed = Math.hypot(ev[0].velocity.x, ev[0].velocity.y, ev[0].velocity.z);
    expect(speed).toBeGreaterThan(900);
    expect(speed).toBeLessThan(1000);
    expect(mock.resolved).toBe(1);
    expect(sim.projectiles.rounds.live).toBe(0);
  });

  it('the nearer of the ground and the vehicle wins', () => {
    // A round 2 m up at 3° reaches soft ground ≈38 m on.
    const v = new Vector3(0, -Math.sin(3 * DEG), -Math.cos(3 * DEG)).multiplyScalar(900);
    mock.plates.push(board(1, -60));
    const behind = createGunTestbed({ altitude: 500, terrain: ground('grass') });
    shoot(behind, RoundType.API, new Vector3(0, 2, 0), v);
    runUntilEmpty(behind);
    expect(impacts(behind).map((e) => e.target.kind)).toEqual(['ground']);

    mock.plates.length = 0;
    mock.plates.push(board(2, -20));
    const front = createGunTestbed({ altitude: 500, terrain: ground('grass') });
    shoot(front, RoundType.API, new Vector3(0, 2, 0), v);
    runUntilEmpty(front);
    expect(impacts(front).map((e) => e.target.kind)).toEqual(['vehicle']);
  });

  it('a ricochet flies on with the velocity the targets module returns', () => {
    // A side plate (normal +X) the round meets 80° off its normal.
    mock.plates.push({
      id: 7,
      c: [0, 5, -200],
      n: [1, 0, 0],
      u: [0, 0, 1],
      v: [0, 1, 0],
      halfU: 50,
      halfV: 5,
    });
    const sim = createGunTestbed({ altitude: 500 });
    const yaw = -10 * DEG; // heading a little toward −X, into the plate's face
    const v = new Vector3(Math.sin(yaw), 0, -Math.cos(yaw)).multiplyScalar(1000);
    const i = shoot(sim, RoundType.API, new Vector3(30, 5, 0), v);
    for (let k = 0; k < 40; k++) stepKinematic(sim);
    const ev = impacts(sim);
    expect(ev[0].outcome).toBe('ricochet');
    expect(sim.projectiles.rounds.ricochets[i]).toBe(1);
    // Mirrored about the plate, at 60 % of the speed: now heading +X.
    const pool = sim.projectiles.rounds;
    expect(pool.alive[i]).toBe(1);
    expect(pool.vx[i]).toBeGreaterThan(0);
    expect(Math.hypot(pool.vx[i], pool.vy[i], pool.vz[i])).toBeLessThan(0.62 * 1000);
    expect(pool.px[i]).toBeGreaterThan(0);
    runUntilEmpty(sim);
    const after = impacts(sim);
    expect(after.map((e) => e.outcome)).toEqual(['ricochet', 'ground']);
  });

  it('a round skipping off hard ground can still hit a vehicle', () => {
    // Wide enough for the skip's sideways scatter (σ 4°) 160 m on.
    mock.plates.push(board(9, -200, 60));
    const sim = createGunTestbed({ altitude: 500, terrain: ground('concrete') });
    const v = new Vector3(0, -Math.sin(3 * DEG), -Math.cos(3 * DEG)).multiplyScalar(900);
    shoot(sim, RoundType.API, new Vector3(0, 2, 0), v);
    runUntilEmpty(sim);
    expect(impacts(sim).map((e) => e.outcome)).toEqual(['skip', 'penetrated']);
    expect(impacts(sim)[1].target.kind).toBe('vehicle');
  });

  it('HEI bursts on the vehicle: a detonation with its id and a small blast', () => {
    mock.plates.push(board(5, -250));
    const sim = createGunTestbed({ altitude: 500 });
    shoot(sim, RoundType.HEI, new Vector3(0, 5, 0), new Vector3(0, 0, -1000));
    runUntilEmpty(sim);
    const ev = impacts(sim);
    expect(ev).toHaveLength(1);
    expect(ev[0].outcome).toBe('burst');
    const det = sim.events.filter(
      (e): e is Extract<SimEvent, { type: 'detonation' }> => e.type === 'detonation',
    );
    expect(det).toHaveLength(1);
    expect(det[0].kind).toBe('hei');
    expect(det[0].vehicleId).toBe(5);
    expect(det[0].position).toEqual(ev[0].position);
    expect(mock.blasts).toHaveLength(1);
    expect(mock.blasts[0].charge).toBe(GAU8.heiCharge);
    expect(mock.blasts[0].fragments).toBe(GAU8.heiFragmentMass);
    expect(mock.blasts[0].z).toBeCloseTo(-250, 6);
    // The hit and kill records name the weapon and the round.
    expect(mock.blasts[0].weapon).toBe('HEI');
    expect(mock.sourceIds[0]).toBeGreaterThan(0);
    expect(mock.blasts[0].sourceId).toBe(mock.sourceIds[0]);
  });

  it('passes the round id to the hit log, and a round goes on through a scoring panel', () => {
    mock.plates.push(board(77, -150));
    mock.panels.add(77);
    // A round 5 m up, 1° down: through the panel at 150 m, into the grass ≈290 m out.
    const sim = createGunTestbed({ altitude: 500, terrain: ground('grass') });
    const v = new Vector3(0, -Math.sin(1 * DEG), -Math.cos(1 * DEG)).multiplyScalar(1000);
    const i = shoot(sim, RoundType.API, new Vector3(0, 5, 0), v);
    const id = sim.projectiles.rounds.id[i];
    runUntilEmpty(sim);
    const ev = impacts(sim);
    expect(ev.map((e) => e.outcome)).toEqual(['passedThrough', 'ground']);
    expect(ev[0].target).toEqual({ kind: 'vehicle', vehicleId: 77, part: 'hull' });
    expect(ev[1].position.z).toBeLessThan(-200);
    // Barely slowed by the sheet.
    const s0 = Math.hypot(ev[0].velocity.x, ev[0].velocity.y, ev[0].velocity.z);
    const s1 = Math.hypot(ev[1].velocity.x, ev[1].velocity.y, ev[1].velocity.z);
    expect(s1 / s0).toBeGreaterThan(0.8);
    expect(s1 / s0).toBeLessThan(0.97);
    expect(mock.sourceIds).toEqual([id]);
  });

  it('the burst record counts each hitting round once, also those landing after the burst', () => {
    mock.plates.push(board(3, -700));
    // Level at 6 m with the nose 2° up: the gun line is level, the rounds reach the board.
    const sim = createGunTestbed({ altitude: 6, speed: 0, pitch: 2 * DEG });
    runKinematic(sim, 2, (s) => {
      s.input.trigger = s.time < 0.5 ? 2 : 0;
    });
    const records = sim.debrief.bursts;
    expect(records).toHaveLength(1);
    const onBoard = impacts(sim).filter((e) => e.target.kind === 'vehicle');
    expect(onBoard.length).toBeGreaterThan(10);
    // HEI rounds burst on the board too: every round hit it once.
    expect(records[0].hits).toBe(onBoard.length);
    expect(records[0].hits).toBeLessThanOrEqual(records[0].rounds);
    // Some of them landed after the trigger was released (0.7 s flight).
    const gunStop = sim.events.find((e) => e.type === 'gunStop')!;
    expect(onBoard.some((e) => e.t > gunStop.t)).toBe(true);
  });
});
