/**
 * Rounds on the ground, the round pool and the stores (PLAN_A10.md §6.3, §6.8, §14, §16):
 * impact events, skips off hard ground at shallow angles, water, HEI bursts, lifetime, the pool
 * never allocating, determinism, loadouts, legality, rearm and jettison. Two tests run with
 * other modules' real code and are marked (integration).
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../../src/a10/core/constants';
import { stepFlight, stepFlightControls, stepWarnings } from '../../../src/a10/core/flight';
import { createTestbed } from '../../../src/a10/core/flight/testbed';
import { createSim } from '../../../src/a10/core/sim';
import { createVehicle, segmentHitVehicle } from '../../../src/a10/core/targets';
import type { VehicleHit } from '../../../src/a10/core/targets/types';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { DEG, KT } from '../../../src/a10/core/units';
import {
  allocRound,
  clearRoundPool,
  createRoundPool,
  createStoresState,
  freeRound,
  jettisonStores,
  loadoutIssues,
  LOADOUTS,
  muzzleState,
  predictRoundImpact,
  rearm,
  RoundType,
  stepGun,
  type RoundPrediction,
  type StoreType,
} from '../../../src/a10/core/weapons';
import {
  createGunTestbed,
  runKinematic,
  stepKinematic,
} from '../../../src/a10/core/weapons/testbed';
import { createFlatTerrain } from '../../../src/a10/core/world';
import type { SurfaceKind, Terrain } from '../../../src/a10/core/world/types';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import { GAU8, ROUND_BEHAVIOUR } from '../../../src/a10/data/gun';
import { STORES } from '../../../src/a10/data/munitions';

type Impact = Extract<SimEvent, { type: 'roundImpact' }>;
const impacts = (sim: Sim): Impact[] =>
  sim.events.filter((e): e is Impact => e.type === 'roundImpact');

/** Flat ground of one surface kind (and ground moisture). */
function ground(surface: SurfaceKind, moisture = 0.2, height = 0): Terrain {
  const base = createFlatTerrain(height);
  return {
    ...base,
    surfaceAt: () => surface,
    moistureAt: () => moisture,
    segmentHit(p0, p1, out) {
      const hit = base.segmentHit(p0, p1, out);
      if (hit) out.surface = surface;
      return hit;
    },
  };
}

/** Put one round in the pool at `p` with velocity `v` (bypassing the gun). */
function shoot(sim: Sim, type: RoundType, p: Vector3, v: Vector3): number {
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
  pool.burst[i] = 0;
  return i;
}

/** A round coming in at `angleDeg` below the horizon, heading north, at `speed`. */
function grazing(sim: Sim, type: RoundType, angleDeg: number, speed = 900, x = 0): number {
  const a = angleDeg * DEG;
  const v = new Vector3(0, -Math.sin(a), -Math.cos(a)).multiplyScalar(speed);
  return shoot(sim, type, new Vector3(x, 2, 0), v);
}

function runUntilEmpty(sim: Sim, maxSeconds = 10): void {
  for (let k = 0; k < maxSeconds / SIM_DT && sim.projectiles.rounds.live > 0; k++) {
    stepKinematic(sim);
  }
}

/** Step until the first impact (a round 2 m up at 3° reaches the ground ≈38 m on). */
function firstImpact(sim: Sim): Impact {
  for (let k = 0; k < 120 && impacts(sim).length === 0; k++) stepKinematic(sim);
  return impacts(sim)[0];
}

describe('rounds on the ground (PLAN §6.3)', () => {
  it('a round digs into soft ground: one roundImpact with the surface, normal and speed', () => {
    const sim = createGunTestbed({ altitude: 500, terrain: ground('grass') });
    grazing(sim, RoundType.API, 30);
    runUntilEmpty(sim);
    const ev = impacts(sim);
    expect(ev).toHaveLength(1);
    const e = ev[0];
    expect(e.outcome).toBe('ground');
    expect(e.target).toEqual({ kind: 'ground', surface: 'grass' });
    expect(e.position.y).toBeCloseTo(0, 6);
    expect(e.normal).toEqual({ x: 0, y: 1, z: 0 });
    expect(Math.hypot(e.velocity.x, e.velocity.y, e.velocity.z)).toBeGreaterThan(850);
    expect(e.round).toBe(RoundType.API);
    // Hit 2 m below the start along a 30° path, ≈4 ms later.
    expect(e.position.z).toBeCloseTo(-2 / Math.tan(30 * DEG), 1);
    expect(e.t).toBeCloseTo(4 / 900, 3);
    expect(sim.projectiles.rounds.live).toBe(0);
  });

  it('shallow rounds skip off hard ground, at most twice; steep ones dig in', () => {
    const sim = createGunTestbed({ altitude: 500, terrain: ground('concrete') });
    grazing(sim, RoundType.API, 3);
    runUntilEmpty(sim);
    const ev = impacts(sim);
    expect(ev.map((e) => e.outcome)).toEqual(['skip', 'skip', 'ground']);
    // Each skip keeps 50–70 % of the speed.
    const speeds = ev.map((e) => Math.hypot(e.velocity.x, e.velocity.y, e.velocity.z));
    expect(speeds[1]).toBeLessThan(speeds[0] * 0.7);
    expect(speeds[1]).toBeGreaterThan(speeds[0] * 0.2);

    const steep = createGunTestbed({ altitude: 500, terrain: ground('concrete') });
    grazing(steep, RoundType.API, 20);
    runUntilEmpty(steep);
    expect(impacts(steep).map((e) => e.outcome)).toEqual(['ground']);
  });

  it('the skip rule: always below 6°, about half at 8°, never above 10°', () => {
    const fraction = (angle: number) => {
      const sim = createGunTestbed({ seed: angle, altitude: 500, terrain: ground('rock') });
      for (let k = 0; k < 300; k++) grazing(sim, RoundType.API, angle, 900, k * 3);
      for (let s = 0; s < 6; s++) stepKinematic(sim);
      const first = impacts(sim);
      expect(first).toHaveLength(300);
      return first.filter((e) => e.outcome === 'skip').length / first.length;
    };
    expect(fraction(4)).toBe(1);
    expect(Math.abs(fraction(8) - 0.5)).toBeLessThan(0.1);
    expect(fraction(12)).toBe(0);
  });

  it('a skip leaves flatter, slower and a little sideways (random from rng.gun)', () => {
    const sim = createGunTestbed({ altitude: 500, terrain: ground('road') });
    const angle = 4;
    const n = 300;
    for (let k = 0; k < n; k++) grazing(sim, RoundType.API, angle, 900, k * 3);
    for (let s = 0; s < 6; s++) stepKinematic(sim);
    const pool = sim.projectiles.rounds;
    let yawSq = 0;
    let count = 0;
    for (let i = 0; i < pool.capacity; i++) {
      if (!pool.alive[i] || pool.bounces[i] !== 1) continue;
      const v = new Vector3(pool.vx[i], pool.vy[i], pool.vz[i]);
      const speed = v.length();
      const up = Math.asin(v.y / speed) / DEG;
      const yaw = Math.atan2(v.x, -v.z) / DEG;
      expect(speed / 900).toBeGreaterThan(ROUND_BEHAVIOUR.skipSpeedMin - 0.03);
      expect(speed / 900).toBeLessThan(ROUND_BEHAVIOUR.skipSpeedMax + 0.01);
      expect(up).toBeGreaterThan(0);
      expect(up).toBeLessThan(angle * ROUND_BEHAVIOUR.skipDepartureMax + 0.2);
      yawSq += yaw * yaw;
      count++;
    }
    expect(count).toBe(n);
    expect(Math.sqrt(yawSq / count)).toBeGreaterThan(2.5);
    expect(Math.sqrt(yawSq / count)).toBeLessThan(5.5);
  });

  it('fields and dirt skip rounds only when dry; grass, sand and mud never', () => {
    const outcome = (surface: SurfaceKind, moisture: number) => {
      const sim = createGunTestbed({ altitude: 500, terrain: ground(surface, moisture) });
      grazing(sim, RoundType.API, 3);
      return firstImpact(sim).outcome;
    };
    expect(outcome('field', 0.2)).toBe('skip');
    expect(outcome('field', 0.8)).toBe('ground');
    expect(outcome('dirt', 0.2)).toBe('skip');
    for (const soft of ['grass', 'sand', 'mud', 'forest'] as const) {
      expect(outcome(soft, 0.1)).toBe('ground');
    }
  });

  it('water stops a round ("water")', () => {
    const sim = createGunTestbed({ altitude: 500, terrain: ground('water') });
    grazing(sim, RoundType.API, 3);
    runUntilEmpty(sim);
    const ev = impacts(sim);
    expect(ev.map((e) => e.outcome)).toEqual(['water']);
    expect(ev[0].target).toEqual({ kind: 'ground', surface: 'water' });
  });

  it('HEI bursts on any impact: roundImpact plus a detonation, never a skip', () => {
    for (const surface of ['concrete', 'grass', 'water'] as const) {
      const sim = createGunTestbed({ altitude: 500, terrain: ground(surface) });
      grazing(sim, RoundType.HEI, 3);
      runUntilEmpty(sim);
      const ev = impacts(sim);
      expect(ev).toHaveLength(1);
      expect(ev[0].round).toBe(RoundType.HEI);
      const det = sim.events.filter((e) => e.type === 'detonation');
      expect(det).toHaveLength(1);
      const d = det[0] as Extract<SimEvent, { type: 'detonation' }>;
      expect(d.kind).toBe('hei');
      expect(d.charge).toBe(GAU8.heiCharge);
      expect(d.vehicleId).toBe(0);
      expect(d.surface).toBe(surface);
      expect(d.t).toBe(ev[0].t);
      expect(d.position).toEqual(ev[0].position);
    }
  });

  it('TP rounds skip like API and never detonate', () => {
    const sim = createGunTestbed({ altitude: 500, terrain: ground('concrete') });
    grazing(sim, RoundType.TP, 3);
    runUntilEmpty(sim);
    expect(impacts(sim)[0].outcome).toBe('skip');
    expect(sim.events.some((e) => e.type === 'detonation')).toBe(false);
  });

  it('rounds are removed after 8 s or when they leave the map, without an impact', () => {
    const sim = createGunTestbed({ altitude: 500 });
    shoot(sim, RoundType.API, new Vector3(0, 100, 0), new Vector3(0, 500, -800));
    shoot(sim, RoundType.API, new Vector3(31995, 100, 0), new Vector3(1000, 0, 0));
    stepKinematic(sim);
    expect(sim.projectiles.rounds.live).toBe(1);
    runKinematic(sim, ROUND_BEHAVIOUR.maxLifetime - 0.1);
    expect(sim.projectiles.rounds.live).toBe(1);
    runKinematic(sim, 0.2);
    expect(sim.projectiles.rounds.live).toBe(0);
    expect(impacts(sim)).toHaveLength(0);
  });

  it('a burst at a hard runway skips its shallow rounds and lands the rest (gun to ground)', () => {
    const sim = createGunTestbed({
      altitude: 40,
      speed: 300 * KT,
      pitch: -3 * DEG,
      terrain: ground('concrete'),
    });
    runKinematic(sim, 3, (s) => {
      s.input.trigger = s.time < 1 ? 2 : 0;
    });
    const ev = impacts(sim);
    expect(ev.filter((e) => e.outcome === 'skip').length).toBeGreaterThan(10);
    expect(sim.events.filter((e) => e.type === 'detonation').length).toBeGreaterThan(3);
  });
});

describe('round pool (PLAN §14)', () => {
  it('allocates and frees in O(1), reusing slots but never ids', () => {
    const pool = createRoundPool(8);
    const slots: number[] = [];
    for (let k = 0; k < 8; k++) slots.push(allocRound(pool));
    expect(new Set(slots).size).toBe(8);
    expect(allocRound(pool)).toBe(-1);
    expect(pool.live).toBe(8);
    const ids = new Set(slots.map((i) => pool.id[i]));
    freeRound(pool, slots[3]);
    freeRound(pool, slots[3]);
    expect(pool.live).toBe(7);
    const again = allocRound(pool);
    expect(again).toBe(slots[3]);
    expect(ids.has(pool.id[again])).toBe(false);
    clearRoundPool(pool);
    expect(pool.live).toBe(0);
    expect(pool.freeCount).toBe(8);
  });

  it('never allocates: a whole load fired and flown uses the same arrays', () => {
    const sim = createGunTestbed({ altitude: 600, speed: 300 * KT, pitch: -25 * DEG });
    const pool = sim.projectiles.rounds;
    const arrays = [
      pool.alive,
      pool.type,
      pool.px,
      pool.py,
      pool.pz,
      pool.vx,
      pool.vy,
      pool.vz,
      pool.fireTime,
      pool.id,
      pool.burst,
      pool.bounces,
      pool.ricochets,
      pool.wx,
      pool.wy,
      pool.wz,
      pool.flags,
      pool.free,
    ];
    let maxLive = 0;
    runKinematic(sim, 21, (s) => {
      s.input.trigger = 2;
      maxLive = Math.max(maxLive, pool.live);
      expect(pool.live + pool.freeCount).toBe(pool.capacity);
    });
    expect(sim.gun.totalFired).toBe(1150);
    expect(pool.capacity).toBe(ROUND_BEHAVIOUR.poolCapacity);
    expect(maxLive).toBeGreaterThan(50);
    expect(maxLive).toBeLessThanOrEqual(pool.capacity);
    expect(sim.gun.dropped).toBe(0);
    expect(pool.nextId).toBe(1151);
    const now = [
      pool.alive,
      pool.type,
      pool.px,
      pool.py,
      pool.pz,
      pool.vx,
      pool.vy,
      pool.vz,
      pool.fireTime,
      pool.id,
      pool.burst,
      pool.bounces,
      pool.ricochets,
      pool.wx,
      pool.wy,
      pool.wz,
      pool.flags,
      pool.free,
    ];
    now.forEach((a, k) => expect(a).toBe(arrays[k]));
    expect(impacts(sim).length).toBe(1150);
  });
});

describe('determinism', () => {
  it('the same seed gives identical impacts, skips and bursts', () => {
    const run = (seed: number) => {
      const sim = createGunTestbed({
        seed,
        altitude: 60,
        speed: 300 * KT,
        pitch: -4 * DEG,
        terrain: ground('rock'),
      });
      runKinematic(sim, 4, (s) => {
        s.input.trigger = s.time < 1.5 ? 2 : 0;
      });
      return JSON.stringify(sim.events) + JSON.stringify(sim.debrief.bursts);
    };
    const a = run(3);
    expect(a).toContain('"skip"');
    expect(run(3)).toBe(a);
    expect(run(4)).not.toBe(a);
  });
});

describe('stores (PLAN §6.8)', () => {
  const count = (stations: Record<number, StoreType[]>, type: StoreType) =>
    Object.values(stations)
      .flat()
      .filter((s) => s === type).length;

  it('offers the four planned presets, every one a legal A-10 load', () => {
    for (const id of ['tankHunter', 'gunOnly', 'rangeTraining', 'heavyBombs']) {
      expect(LOADOUTS[id], id).toBeDefined();
      expect(LOADOUTS[id].name.length).toBeGreaterThan(0);
    }
    for (const [id, preset] of Object.entries(LOADOUTS)) {
      expect(loadoutIssues(preset.stations), id).toEqual([]);
    }
  });

  it('the tank hunter carries what the plan lists', () => {
    const s = LOADOUTS.tankHunter.stations;
    expect(count(s, 'AGM-65D')).toBe(2);
    expect(count(s, 'AGM-65H')).toBe(2);
    expect(count(s, 'GBU-12')).toBe(2);
    expect(count(s, 'MK-82')).toBe(2);
    expect(count(s, 'LAU-131-M156') + count(s, 'LAU-68-M156')).toBe(1);
    expect(count(s, 'AN/AAQ-28')).toBe(1);
    // Mavericks on stations 3 and 9; the pod on 2 or 10; ECM and AIM-9s outboard.
    expect(s[3].slice(1)).toEqual(['AGM-65D', 'AGM-65D']);
    expect(s[9].slice(1)).toEqual(['AGM-65H', 'AGM-65H']);
    expect([2, 10].some((k) => s[k]?.[0] === 'AN/AAQ-28')).toBe(true);
    expect(s[1]).toEqual(['AN/ALQ-184']);
    expect(s[11]).toEqual(['LAU-114', 'AIM-9M', 'AIM-9M']);
  });

  it('weighs the stations and their moments from the data', () => {
    const state = createStoresState('tankHunter');
    let mass = 0;
    let drag = 0;
    let lateral = 0;
    let roll = 0;
    let yaw = 0;
    for (const [k, list] of Object.entries(LOADOUTS.tankHunter.stations)) {
      const x = A10_GEOMETRY.stations[Number(k)]!.x;
      for (const t of list) {
        mass += STORES[t].mass;
        drag += STORES[t].dragArea;
        lateral += STORES[t].mass * x;
        roll += STORES[t].mass * x * x;
        yaw += STORES[t].dragArea * x;
      }
    }
    expect(state.mass).toBeCloseTo(mass, 6);
    expect(state.dragArea).toBeCloseTo(drag, 9);
    expect(state.lateralMoment).toBeCloseTo(lateral, 6);
    expect(state.rollInertia).toBeCloseTo(roll, 6);
    expect(state.dragMoment).toBeCloseTo(yaw, 9);
    // A realistic load: about three tonnes, nearly balanced side to side.
    expect(state.mass).toBeGreaterThan(2500);
    expect(state.mass).toBeLessThan(3500);
    expect(Math.abs(state.lateralMoment / state.mass)).toBeLessThan(0.3);
    // Racks are split from what they carry.
    const s3 = state.stations[2];
    expect(s3.rack).toBe('LAU-88');
    expect(s3.stores).toEqual(['AGM-65D', 'AGM-65D']);
    expect(state.stations[3].rack).toBeNull();
    expect(state.stations[3].stores).toEqual(['GBU-12']);
    const clean = createStoresState('gunOnly');
    expect(clean.mass).toBe(0);
    expect(clean.dragArea).toBe(0);
    expect(createStoresState('noSuchPreset').mass).toBe(0);
  });

  it('reports illegal loads and still loads a custom choice as given', () => {
    const bad = (stations: Record<number, StoreType[]>) => loadoutIssues(stations).length;
    expect(bad({ 5: ['AGM-65D'] })).toBe(1);
    expect(bad({ 4: ['LAU-117', 'AGM-65D'] })).toBe(1);
    expect(bad({ 11: ['AIM-9M'] })).toBe(1);
    expect(bad({ 3: ['LAU-88', 'AGM-65G'] })).toBe(1);
    expect(bad({ 4: ['TER-9A', 'MK-82', 'MK-82', 'MK-82', 'MK-82'] })).toBe(1);
    expect(bad({ 5: ['MK-82'], 6: ['MK-82'] })).toBe(1);
    expect(bad({ 1: ['AN/AAQ-28'] })).toBe(1);
    expect(bad({ 2: ['MK-82', 'MK-82'] })).toBe(1);
    expect(bad({ 12: ['MK-82'] })).toBe(1);
    expect(bad({ 3: ['LAU-117', 'AGM-65G'], 9: ['LAU-117', 'AGM-65K'] })).toBe(0);
    const odd = createStoresState('custom', { 11: ['AN/AAQ-28'] });
    expect(odd.stations[10].stores).toEqual(['AN/AAQ-28']);
    expect(odd.mass).toBe(STORES['AN/AAQ-28'].mass);
  });

  it('a new flight carries the tank hunter by default, and the flight model feels its mass', () => {
    const terrain = createFlatTerrain(0);
    const loaded = createSim({ terrain, scenario: 'empty' });
    const clean = createSim({ terrain, scenario: 'empty', loadoutId: 'gunOnly' });
    expect(loaded.stores.loadoutId).toBe('tankHunter');
    expect(loaded.aircraft.mass - clean.aircraft.mass).toBeCloseTo(loaded.stores.mass, 3);
  });

  it('jettison drops racks with their stores and keeps pods and the AIM-9 rails', () => {
    const sim = createSim({ terrain: createFlatTerrain(0), scenario: 'empty' });
    const before = sim.stores.mass;
    expect(jettisonStores(sim, [4])).toBe(1);
    expect(sim.stores.stations[3].stores).toEqual([]);
    expect(sim.stores.mass).toBeCloseTo(before - STORES['GBU-12'].mass, 6);
    expect(jettisonStores(sim, [10, 11, 1])).toBe(0);
    const cleared = jettisonStores(sim, 'all');
    expect(cleared).toBe(6);
    const left = sim.stores.stations.filter((s) => s.rack || s.stores.length > 0);
    expect(left.map((s) => s.station)).toEqual([1, 10, 11]);
    const released = sim.events.filter((e) => e.type === 'storeReleased');
    expect(released).toHaveLength(7);
    expect(released.map((e) => (e.type === 'storeReleased' ? e.store : ''))).toContain('LAU-88');
    expect(sim.stores.mass).toBeCloseTo(
      STORES['AN/ALQ-184'].mass +
        STORES['AN/AAQ-28'].mass +
        STORES['LAU-114'].mass +
        2 * STORES['AIM-9M'].mass,
      6,
    );
  });

  it('rearm reloads the drum and puts the flight’s loadout back', () => {
    const sim = createGunTestbed({ altitude: 3000, loadoutId: 'tankHunter' });
    const full = createStoresState('tankHunter');
    runKinematic(sim, 1, (s) => {
      s.input.trigger = 2;
    });
    jettisonStores(sim, 'all');
    expect(sim.gun.rounds).toBeLessThan(1150);
    expect(sim.gun.firing).toBe(true);
    rearm(sim);
    expect(sim.gun.rounds).toBe(1150);
    expect(sim.gun.roundsLoaded).toBe(1150);
    expect(sim.gun.firing).toBe(false);
    expect(sim.events.some((e) => e.type === 'gunStop')).toBe(true);
    expect(sim.stores.mass).toBeCloseTo(full.mass, 6);
    expect(sim.stores.stations.map((s) => [s.rack, ...s.stores])).toEqual(
      full.stations.map((s) => [s.rack, ...s.stores]),
    );
  });
});

describe('with other modules (integration)', () => {
  it('a two-second burst slows an 18,000 kg A-10 by 3.8–4.8 m/s (integration: flight model)', () => {
    const fly = (fire: boolean) => {
      const sim = createTestbed({ mass: 18000, ias: 300 * KT, altitude: 1500 });
      sim.avionics.masterArm = 'ARM';
      sim.avionics.gunPac = 'GUNARM';
      for (let k = 0; k < Math.round(2 / SIM_DT); k++) {
        sim.input.trigger = fire ? 2 : 0;
        stepFlightControls(sim, SIM_DT);
        stepFlight(sim, SIM_DT);
        stepGun(sim, SIM_DT);
        stepWarnings(sim, SIM_DT);
        clearRoundPool(sim.projectiles.rounds);
        sim.time += SIM_DT;
      }
      return sim.aircraft.velocity.length();
    };
    const dv = fly(false) - fly(true);
    expect(dv).toBeGreaterThanOrEqual(3.8);
    expect(dv).toBeLessThanOrEqual(4.8);
  });

  // Runs once the targets module's real hit test is in the tree (the stand-in never hits).
  const probe = createGunTestbed({ altitude: 1000 });
  const vehicle = createVehicle(probe, 'mbt', 0, -3000, 0, 1);
  const probeHit: VehicleHit = {
    vehicleId: 0,
    t: 0,
    point: new Vector3(),
    normal: new Vector3(),
    thicknessMm: 0,
    part: 'hull',
    face: 'top',
    plate: 0,
  };
  const realTargets = segmentHitVehicle(
    probe,
    new Vector3(0, vehicle.position.y + 20, -3000),
    new Vector3(0, vehicle.position.y - 1, -3000),
    probeHit,
  );

  it.skipIf(!realTargets)(
    'a strafing burst hits a tank and the burst record counts the hits (integration: targets)',
    () => {
      const sim = createGunTestbed({
        altitude: 700,
        speed: 300 * KT,
        pathAngle: -30 * DEG,
        load: 'allAPI',
        scenario: 'empty',
      });
      // Put a tank where the pipper is.
      const o = new Vector3();
      const v = new Vector3();
      muzzleState(sim.aircraft, RoundType.API, o, v);
      const pred: RoundPrediction = { point: new Vector3(), velocity: new Vector3(), time: 0 };
      expect(
        predictRoundImpact(RoundType.API, o, v, sim.world.terrain, new Vector3(), 6, pred),
      ).toBe(true);
      // In a steady dive the impact point creeps only a few metres toward the aircraft during a
      // short burst, so a tank placed under the pipper takes many of its rounds.
      createVehicle(sim, 'mbt', pred.point.x, pred.point.z, Math.PI, 1);
      runKinematic(sim, 3, (s) => {
        s.input.trigger = s.time < 0.8 ? 2 : 0;
      });
      const onVehicle = impacts(sim).filter((e) => e.target.kind === 'vehicle');
      expect(onVehicle.length).toBeGreaterThan(5);
      const rec = sim.debrief.bursts[0];
      expect(rec.hits).toBeGreaterThan(5);
      expect(rec.hits).toBeLessThanOrEqual(rec.rounds);
    },
  );
});
