/**
 * Targets module tests (PLAN_A10.md §9, §11): the armour hit test and its broadphase, vehicle
 * behaviour (columns on roads, scatter, cover, ground following, turrets, heat) and the scenarios
 * (free hunt, strafe pit, bombing circle, tactical lane). Fixtures are hand-built terrains (flat
 * or analytic, with hand-made roads, areas and trees) so the tests do not depend on the world
 * module's generator — except the one marked "(integration)".
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createSim, stepSim } from '../../../src/a10/core/sim';
import {
  createVehicle,
  digIn,
  segmentHitVehicle,
  segmentHitVehicleAll,
  spawnGroup,
  stepTargets,
  VEHICLE_MODELS,
  type Vehicle,
  type VehicleGroup,
  type VehicleHit,
  type VehicleKind,
} from '../../../src/a10/core/targets';
import type { ScenarioKind, Sim, SimEvent } from '../../../src/a10/core/types';
import {
  createFlatTerrain,
  createRoadPoint,
  createTerrain,
  generateTerrainData,
  nearestRoadPoint,
  roadLength,
  terrainFromHeightFunction,
} from '../../../src/a10/core/world';
import type { RoadPolyline, TargetArea, Terrain } from '../../../src/a10/core/world/types';
import { MOBILITY, SCENARIO, THERMAL, VEHICLE_SHAPES } from '../../../src/a10/data/vehicles';

const DT = 1 / 120;
const DEG = Math.PI / 180;
/** Timeout for the tests that simulate minutes of driving (slow on a loaded machine). */
const SLOW = 60_000;

function step(sim: Sim, seconds: number, each?: () => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    stepTargets(sim, DT);
    sim.time += DT;
    sim.stepCount++;
    each?.();
  }
}

function newHit(): VehicleHit {
  return {
    vehicleId: 0,
    t: 0,
    point: new Vector3(),
    normal: new Vector3(),
    thicknessMm: 0,
    part: 'hull',
    face: 'front',
    plate: 0,
  };
}

const polyline = (pts: Array<[number, number]>) => {
  const a = new Float64Array(pts.length * 2);
  pts.forEach(([x, z], i) => {
    a[2 * i] = x;
    a[2 * i + 1] = z;
  });
  return a;
};

/** A road north from (0, 0) for `straight` m, a 90° bend of radius `r` to the east, then east. */
function bendRoad(straight = 1500, r = 150): RoadPolyline {
  const pts: Array<[number, number]> = [];
  for (let s = 0; s <= straight; s += 25) pts.push([0, -s]);
  for (let k = 1; k <= 12; k++) {
    const a = (k / 12) * (Math.PI / 2);
    pts.push([r - r * Math.cos(a), -straight - r * Math.sin(a)]);
  }
  for (let s = 25; s <= straight; s += 25) pts.push([r + s, -straight - r]);
  return { id: 0, kind: 'road', points: polyline(pts), width: 7 };
}

function withFeatures(base: Terrain, extra: Partial<Terrain>): Terrain {
  return { ...base, ...extra } as Terrain;
}

function simOn(terrain: Terrain, seed = 1, scenario: ScenarioKind = 'empty'): Sim {
  return createSim({ seed, terrain, scenario });
}

function groupVehicles(sim: Sim, g: VehicleGroup): Vehicle[] {
  return g.vehicleIds.map((id) => sim.targets.vehicles.find((v) => v.id === id)!).filter(Boolean);
}

function impactEvent(sim: Sim, x: number, z: number): SimEvent {
  return {
    type: 'roundImpact',
    t: sim.time,
    round: 0,
    position: { x, y: 0, z },
    velocity: { x: 0, y: -300, z: -900 },
    normal: { x: 0, y: 1, z: 0 },
    target: { kind: 'ground', surface: 'grass' },
    outcome: 'ground',
  };
}

// ---- Hit test ----------------------------------------------------------------------------------

describe('armour hit test', () => {
  const mbt = VEHICLE_SHAPES.mbt;
  const top = mbt.hullClearance + mbt.hullHeight;

  function shoot(sim: Sim, a: Vector3, b: Vector3) {
    const hit = newHit();
    const ok = segmentHitVehicle(sim, a, b, hit);
    const v = sim.targets.vehicles.find((x) => x.id === hit.vehicleId);
    return { ok, hit, name: ok && v ? VEHICLE_MODELS[v.kind].plates[hit.plate].name : '' };
  }

  it('finds the plate the 3D model shows from each side', () => {
    const sim = simOn(createFlatTerrain(0));
    createVehicle(sim, 'mbt', 0, 0, 0, 1);
    const cases: Array<[string, Vector3, Vector3, RegExp, number]> = [
      [
        'engine deck',
        new Vector3(0, 10, 2.5),
        new Vector3(0, -1, 2.5),
        /engine compartment top/,
        20,
      ],
      ['turret roof', new Vector3(0, 10, -0.6), new Vector3(0, -1, -0.6), /turret roof/, 40],
      ['glacis', new Vector3(0.6, 1.4, -20), new Vector3(0.6, 1.4, 0), /upper glacis/, 200],
      ['lower front', new Vector3(0.5, 0.7, -20), new Vector3(0.5, 0.7, 0), /lower front/, 85],
      ['hull side', new Vector3(20, 1.5, 0), new Vector3(0, 1.5, 0), /hull right/, 80],
      ['track run', new Vector3(20, 0.6, 0), new Vector3(0, 0.6, 0), /right track/, 20],
      [
        'side over the engine',
        new Vector3(-20, 1.5, 2.5),
        new Vector3(0, 1.5, 2.5),
        /engine compartment left/,
        70,
      ],
      ['rear', new Vector3(0, 0.9, 20), new Vector3(0, 0.9, 0), /engine compartment rear/, 40],
      [
        'turret side',
        new Vector3(20, 1.85, -0.6),
        new Vector3(0, 1.85, -0.6),
        /turret side 90/,
        130,
      ],
    ];
    for (const [label, a, b, re, mm] of cases) {
      const r = shoot(sim, a, b);
      expect(r.ok, label).toBe(true);
      expect(r.name, label).toMatch(re);
      expect(r.hit.thicknessMm, label).toBe(mm);
      // the point is on the segment, the normal is a unit vector facing the round
      const d = b.clone().sub(a);
      expect(r.hit.point.distanceTo(a.clone().addScaledVector(d, r.hit.t))).toBeLessThan(1e-9);
      expect(r.hit.normal.length()).toBeCloseTo(1, 9);
      expect(r.hit.normal.dot(d)).toBeLessThan(0);
    }
  });

  it('turns the turret plates with the turret and drops them when it is thrown', () => {
    const sim = simOn(createFlatTerrain(0));
    const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
    v.turretYaw = Math.PI / 2; // gun to the right
    const r = shoot(sim, new Vector3(20, top + 0.3, -0.6), new Vector3(0, top + 0.3, -0.6));
    expect(r.name).toMatch(/gun barrel|turret front/);
    const r2 = shoot(sim, new Vector3(20, top + 0.3, 0.2), new Vector3(0, top + 0.3, 0.2));
    expect(r2.name).toMatch(/turret (front|upper front)/);
    v.thrownTurret = {
      position: new Vector3(10, 0.5, 0),
      velocity: new Vector3(),
      spin: new Vector3(),
      angle: new Vector3(),
    };
    const r3 = shoot(sim, new Vector3(0, 10, -0.6), new Vector3(0, -1, -0.6));
    expect(r3.name).toMatch(/hull top/);
  });

  it('a dug-in hull is covered by the earth: only the turret and the hull top can be hit', () => {
    const sim = simOn(createFlatTerrain(50));
    const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
    digIn(sim, v);
    expect(v.position.y).toBeLessThan(50 - 1.2);
    const ground = 50;
    expect(shoot(sim, new Vector3(20, ground - 0.5, 0), new Vector3(0, ground - 0.5, 0)).ok).toBe(
      false,
    );
    const t = shoot(sim, new Vector3(20, ground + 0.6, -0.6), new Vector3(0, ground + 0.6, -0.6));
    expect(t.ok).toBe(true);
    expect(t.name).toMatch(/turret/);
    const deck = shoot(sim, new Vector3(0, ground + 10, 2.5), new Vector3(0, ground - 5, 2.5));
    expect(deck.name).toMatch(/engine compartment top/);
  });

  it('the broadphase finds exactly what testing every vehicle finds', { timeout: SLOW }, () => {
    const sim = simOn(createFlatTerrain(10), 3);
    const kinds: VehicleKind[] = [
      'mbt',
      'ifv',
      'apc',
      'truckCargo',
      'truckFuel',
      'truckAmmo',
      'hulk',
      'panel',
    ];
    const r = sim.rng.misc;
    for (let i = 0; i < 60; i++)
      createVehicle(
        sim,
        kinds[i % kinds.length],
        r.range(-200, 200),
        r.range(-200, 200),
        r.range(0, 6.28),
        1,
      );
    for (const v of sim.targets.vehicles) v.turretYaw = r.range(-3, 3);
    const a = newHit();
    const b = newHit();
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      const v = sim.targets.vehicles[i % 60];
      const len = i % 10 === 0 ? 300 : r.range(2, 20);
      const dir = new Vector3(r.range(-1, 1), r.range(-1, 0.2), r.range(-1, 1)).normalize();
      const end = new Vector3(
        v.position.x + r.range(-8, 8),
        10 + r.range(-9, 3),
        v.position.z + r.range(-8, 8),
      );
      const start = end.clone().addScaledVector(dir, -len);
      const ok1 = segmentHitVehicle(sim, start, end, a);
      const ok2 = segmentHitVehicleAll(sim, start, end, b);
      expect(ok1).toBe(ok2);
      if (ok1) {
        hits++;
        expect(a.vehicleId).toBe(b.vehicleId);
        expect(a.plate).toBe(b.plate);
        expect(a.t).toBeCloseTo(b.t, 12);
      }
    }
    expect(hits).toBeGreaterThan(150);
  });

  it('80 vehicles, 16,000 segment tests: well under 1 ms per frame (PLAN §14)', () => {
    const sim = simOn(createFlatTerrain(0), 4);
    const r = sim.rng.misc;
    const kinds: VehicleKind[] = [
      'mbt',
      'mbt',
      'ifv',
      'apc',
      'truckCargo',
      'truckFuel',
      'truckAmmo',
      'mbt',
    ];
    for (let g = 0; g < 10; g++) {
      const cx = r.range(-20000, 20000);
      const cz = r.range(-20000, 20000);
      for (let i = 0; i < 8; i++)
        createVehicle(
          sim,
          kinds[i],
          cx + r.range(-150, 150),
          cz + r.range(-150, 150),
          r.range(0, 6.28),
          g + 1,
        );
    }
    // round step segments (≈8 m), half of them aimed into the groups, half anywhere
    const n = 16000;
    const p0: Vector3[] = [];
    const p1: Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const v = sim.targets.vehicles[i % 80];
      const near = i % 2 === 0;
      const x = near ? v.position.x + r.range(-25, 25) : r.range(-30000, 30000);
      const z = near ? v.position.z + r.range(-25, 25) : r.range(-30000, 30000);
      const end = new Vector3(x, r.range(0, 4), z);
      p1.push(end);
      p0.push(end.clone().add(new Vector3(r.range(-2, 2), 4, r.range(-7, 7))));
    }
    const hit = newHit();
    segmentHitVehicle(sim, p0[0], p1[0], hit); // build the index
    let best = Infinity;
    let hits = 0;
    for (let rep = 0; rep < 5; rep++) {
      hits = 0;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) if (segmentHitVehicle(sim, p0[i], p1[i], hit)) hits++;
      best = Math.min(best, performance.now() - t0);
    }
    // 16,000 calls are one second of rounds; at 60 frames per second the budget is 1 ms per
    // frame, i.e. 16 ms for all of them
    console.log(
      `segmentHitVehicle: ${n} calls in ${best.toFixed(2)} ms (${((best / n) * 1000).toFixed(3)} µs each, ${hits} hits)`,
    );
    expect(hits).toBeGreaterThan(20);
    expect(best).toBeLessThan(16);
  });
});

// ---- Behaviour ---------------------------------------------------------------------------------

describe('columns on roads', () => {
  function columnSim(seed = 1, terrain?: Terrain): { sim: Sim; g: VehicleGroup } {
    const road = bendRoad();
    const t = withFeatures(terrain ?? createFlatTerrain(100), { roads: [road] });
    const sim = simOn(t, seed);
    const g = spawnGroup(sim, 'column', { roadId: 0, roadDistance: 400 }, 'supplyColumn')!;
    expect(g).not.toBeNull();
    return { sim, g };
  }

  it('drive their road at 30–40 km/h, ≈50 m apart, turning smoothly', { timeout: SLOW }, () => {
    const { sim, g } = columnSim(2);
    const road = sim.world.terrain.roads[0];
    const vs = groupVehicles(sim, g);
    expect(vs.length).toBe(5);
    expect(g.speed).toBeGreaterThanOrEqual(MOBILITY.columnSpeedMin);
    expect(g.speed).toBeLessThanOrEqual(MOBILITY.columnSpeedMax);
    const rp = createRoadPoint();
    const prevHeading = vs.map((v) => v.heading);
    let worstTurn = 0;
    let worstOffset = 0;
    let k = 0;
    step(sim, 200, () => {
      const sample = k++ % 12 === 0;
      vs.forEach((v, i) => {
        const radius =
          VEHICLE_SHAPES[v.kind].running.type === 'tracks'
            ? MOBILITY.turnRadiusTracked
            : MOBILITY.turnRadiusWheeled;
        let dh = Math.abs(v.heading - prevHeading[i]);
        if (dh > Math.PI) dh = 2 * Math.PI - dh;
        worstTurn = Math.max(worstTurn, dh / ((Math.max(1, v.speed) / radius) * DT));
        prevHeading[i] = v.heading;
        if (!sample) return;
        nearestRoadPoint([road], v.position.x, v.position.z, rp);
        worstOffset = Math.max(worstOffset, rp.offset);
        expect(v.position.y).toBeCloseTo(sim.world.terrain.heightAt(v.position.x, v.position.z), 6);
      });
    });
    expect(worstTurn).toBeLessThanOrEqual(1.0001);
    expect(worstOffset).toBeLessThan(MOBILITY.roadKeepRight * road.width + 3);
    // through the bend: everyone is on the eastward leg now, still in order and spaced
    for (const v of vs) expect(v.position.x).toBeGreaterThan(150);
    for (let i = 1; i < vs.length; i++) {
      const gap = vs[i - 1].position.distanceTo(vs[i].position);
      expect(gap).toBeGreaterThan(MOBILITY.columnSpacing * 0.7);
      expect(gap).toBeLessThan(MOBILITY.columnSpacing * 1.3);
      expect(vs[i - 1].position.x).toBeGreaterThan(vs[i].position.x);
    }
    expect(vs[0].speed).toBeGreaterThan(MOBILITY.columnSpeedMin * 0.95);
    expect(vs[0].engineOn).toBe(true);
    expect(vs[0].heat.running).toBeGreaterThan(5);
  });

  it('turn back at a dead end and carry on', { timeout: SLOW }, () => {
    const { sim, g } = columnSim(3);
    step(sim, 420);
    expect(g.route.length).toBeGreaterThan(1);
    const lead = groupVehicles(sim, g)[0];
    expect(lead.speed).toBeGreaterThan(5);
  });

  it('slow down on a steep grade', { timeout: SLOW }, () => {
    // flat for the first 600 m, then a 10 % climb northward
    const data = { seed: 0, size: 64000, resolution: 0, heights: new Float32Array(0), extra: {} };
    const hill = terrainFromHeightFunction(
      data,
      (_x, z) => 100 + (z < -600 ? 0.1 * (-600 - z) : 0),
      100,
      600,
      0.2,
    );
    const { sim, g } = columnSim(4, hill);
    const lead = groupVehicles(sim, g)[0];
    let flat = 0;
    let climb = 0;
    let pitch = 0;
    step(sim, 160, () => {
      if (lead.position.z > -500 && lead.position.z < -420) flat = lead.speed;
      if (lead.position.z < -1000 && lead.position.z > -1100) {
        climb = lead.speed;
        pitch = lead.pitch;
      }
    });
    expect(flat).toBeGreaterThan(0);
    expect(climb).toBeGreaterThan(0);
    expect(climb).toBeLessThan(flat * 0.85);
    expect(pitch).toBeCloseTo(Math.atan(0.1), 2);
  });

  it('stop and scatter 50–200 m off the road when attacked', { timeout: SLOW }, () => {
    const { sim, g } = columnSim(5);
    const road = sim.world.terrain.roads[0];
    step(sim, 30);
    const vs = groupVehicles(sim, g);
    const third = vs[2];
    sim.events.push(impactEvent(sim, third.position.x + 60, third.position.z));
    step(sim, 1);
    expect(g.alertTime).toBeGreaterThanOrEqual(0);
    expect(g.behaviour).toBe('scatter');
    step(sim, 120);
    const rp = createRoadPoint();
    for (const v of vs) {
      expect(v.speed).toBe(0);
      nearestRoadPoint([road], v.position.x, v.position.z, rp);
      expect(rp.offset).toBeGreaterThan(MOBILITY.scatterMin * 0.8);
      expect(rp.offset).toBeLessThan(MOBILITY.scatterMax + 40);
    }
  });

  it('a group out of reach of the impact keeps driving', () => {
    const { sim, g } = columnSim(6);
    step(sim, 10);
    sim.events.push(impactEvent(sim, 5000, 5000));
    step(sim, 5);
    expect(g.alertTime).toBe(-1);
    expect(groupVehicles(sim, g)[0].speed).toBeGreaterThan(5);
  });
});

describe('parked groups, ground, turrets and heat', () => {
  /** Trees east of x = 220 m. */
  const wood = (base: Terrain) =>
    withFeatures(base, { canopyAt: (x: number) => (x > 220 ? 18 : 0) });

  it(
    'attacked parked groups start engines and many head for the nearest trees',
    { timeout: SLOW },
    () => {
      let covered = 0;
      for (let seed = 1; seed <= 8; seed++) {
        const sim = simOn(wood(createFlatTerrain(0)), seed);
        const g = spawnGroup(sim, 'open', { x: 0, z: 0, heading: 0, radius: 80 }, 'tankPlatoon')!;
        const vs = groupVehicles(sim, g);
        for (const v of vs) v.engineOn = false;
        sim.events.push(impactEvent(sim, 30, 30));
        step(sim, 120);
        for (const v of vs) expect(v.engineOn).toBe(true);
        if (vs.every((v) => v.position.x > 200 && v.speed === 0)) covered++;
      }
      expect(covered).toBeGreaterThanOrEqual(3);
    },
  );

  it('sit on the ground with pitch and roll from the slope', () => {
    const data = { seed: 0, size: 64000, resolution: 0, heights: new Float32Array(0), extra: {} };
    const slope = terrainFromHeightFunction(data, (x) => 200 + 0.1 * x, -3000, 3400, 0.2);
    const sim = simOn(slope);
    const north = createVehicle(sim, 'mbt', 0, 0, 0, 1);
    const east = createVehicle(sim, 'mbt', 100, 0, Math.PI / 2, 1);
    expect(north.position.y).toBeCloseTo(200, 6);
    // facing north on ground rising to the east: the right side is high (roll + = right side down)
    expect(north.roll).toBeCloseTo(-Math.atan(0.1), 3);
    expect(north.pitch).toBeCloseTo(0, 3);
    expect(east.pitch).toBeCloseTo(Math.atan(0.1), 3);
    expect(east.roll).toBeCloseTo(0, 3);
  });

  it('turrets scan slowly, and follow the aircraft once the group is alerted', () => {
    const sim = simOn(createFlatTerrain(0), 7);
    const g = spawnGroup(sim, 'open', { x: 0, z: 0, heading: 0, radius: 60 }, 'tankPlatoon')!;
    const v = groupVehicles(sim, g)[0];
    step(sim, 20); // the turret first catches up with its scan pattern
    let maxRate = 0;
    let prev = v.turretYaw;
    let moved = 0;
    step(sim, 30, () => {
      maxRate = Math.max(maxRate, Math.abs(v.turretYaw - prev) / DT);
      moved = Math.max(moved, Math.abs(v.turretYaw));
      prev = v.turretYaw;
    });
    expect(moved).toBeGreaterThan(0.02);
    expect(maxRate).toBeLessThanOrEqual(MOBILITY.turretScanRate * 1.05 + 1e-9);
    sim.aircraft.position.set(v.position.x + 3000, 1000, v.position.z);
    sim.events.push(impactEvent(sim, 20, 0));
    step(sim, 15);
    const bearing = Math.atan2(1, 0); // east, relative to a hull facing north = +90°
    let off = Math.abs(v.turretYaw + v.heading - bearing);
    off = Math.min(off, 2 * Math.PI - off);
    expect(off).toBeLessThan(3 * DEG);
  });

  it(
    'heat: engine deck and exhaust hot while running, cooling over minutes once stopped',
    { timeout: SLOW },
    () => {
      const sim = simOn(createFlatTerrain(0), 8);
      const v = createVehicle(sim, 'ifv', 0, 0, 0, 1);
      v.heat.engine = 0;
      v.heat.exhaust = 0;
      step(sim, 900);
      expect(v.heat.engine).toBeGreaterThan(THERMAL.engineIdle * 0.9);
      expect(v.heat.exhaust).toBeGreaterThan(THERMAL.exhaustIdle * 0.9);
      v.engineOn = false;
      const e0 = v.heat.engine;
      step(sim, 60);
      expect(v.heat.engine).toBeGreaterThan(e0 * 0.9); // still warm after a minute
      step(sim, THERMAL.engineCool - 60);
      expect(v.heat.engine).toBeLessThan(e0 * 0.45); // ≈1/e after one time constant
      expect(v.heat.engine).toBeGreaterThan(e0 * 0.3);
    },
  );
});

// ---- Scenarios ---------------------------------------------------------------------------------

/** A hand-built range: roads, areas of every kind, two tree lines, the three range areas. */
function rangeTerrain(): Terrain {
  const main: Array<[number, number]> = [];
  for (let u = 0; u <= 1.0001; u += 1 / 600)
    main.push([-12000 + 24000 * u, -14000 + 600 * Math.sin(2 * Math.PI * 6 * u)]);
  const roads: RoadPolyline[] = [
    { id: 0, kind: 'road', points: polyline(main), width: 7, joinsStart: -1, joinsEnd: -1 },
    {
      id: 1,
      kind: 'track',
      points: polyline(
        Array.from({ length: 81 }, (_, i): [number, number] => [0, -14000 + 50 * i]),
      ),
      width: 4,
      joinsStart: 0,
      joinsEnd: -1,
    },
  ];
  const roadArea = (id: number, name: string, u: number): TargetArea => {
    const i = Math.round(u * 600);
    return {
      id,
      name,
      kind: 'road',
      x: main[i][0],
      z: main[i][1],
      radius: 600,
      heading: 1.57,
      roadId: 0,
      roadDistance: roadLength({
        id: 9,
        kind: 'road',
        points: polyline(main.slice(0, i + 1)),
        width: 7,
      }),
    };
  };
  const areas: TargetArea[] = [
    { id: 0, name: 'ALPHA', kind: 'open', x: 2000, z: -9000, radius: 450, heading: 0.5 },
    { id: 1, name: 'BRAVO', kind: 'treeline', x: 6000, z: -12000, radius: 350, heading: 0 },
    { id: 2, name: 'CHARLIE', kind: 'dugIn', x: -7000, z: -10000, radius: 300, heading: Math.PI },
    roadArea(3, 'DELTA', 0.3),
    roadArea(4, 'ECHO', 0.78),
    { id: 5, name: 'FOXTROT', kind: 'open', x: 9000, z: -8000, radius: 450, heading: 1 },
    { id: 6, name: 'GOLF', kind: 'treeline', x: -3000, z: -20000, radius: 350, heading: 0 },
    { id: 7, name: 'HOTEL', kind: 'open', x: -10000, z: -18000, radius: 450, heading: 2 },
    { id: 8, name: 'INDIA', kind: 'dugIn', x: 4000, z: -20000, radius: 300, heading: 0 },
    { id: 9, name: 'JULIETT', kind: 'open', x: 12000, z: -16500, radius: 450, heading: 0 },
    { id: 10, name: 'KILO', kind: 'open', x: -12000, z: -11000, radius: 450, heading: 0 },
    { id: 11, name: 'LIMA', kind: 'open', x: 0, z: -25000, radius: 450, heading: 0 },
    { id: 12, name: 'NEAR', kind: 'open', x: 0, z: 0, radius: 450, heading: 0 },
    { id: 13, name: 'TACTICAL LANE', kind: 'range', x: 15000, z: 2000, radius: 850, heading: 1.0 },
    { id: 14, name: 'BOMB CIRCLE', kind: 'range', x: 18000, z: 6000, radius: 380, heading: 2.0 },
    {
      id: 15,
      name: 'STRAFE PIT',
      kind: 'range',
      x: 20000,
      z: 9000,
      radius: 260,
      heading: Math.PI / 2,
    },
  ];
  const canopyAt = (x: number, z: number) =>
    (x > 6150 && x < 6600 && z > -13000 && z < -11000) ||
    (x > -2850 && x < -2500 && z > -21000 && z < -19000)
      ? 16
      : 0;
  return withFeatures(createFlatTerrain(120), {
    roads,
    targetAreas: areas,
    canopyAt,
    start: { x: 0, z: 6000, heading: Math.PI },
  });
}

const alive = (v: Vehicle) => v.condition === 'intact' || v.condition === 'damaged';

describe('free hunt', () => {
  it('places 6–10 groups of every kind at least 8 km from the start', { timeout: SLOW }, () => {
    for (const seed of [1, 2, 3]) {
      const sim = simOn(rangeTerrain(), seed, 'freeHunt');
      const t = sim.targets;
      const groups = t.groups.filter((g) => g.reacts);
      expect(groups.length).toBeGreaterThanOrEqual(SCENARIO.huntGroupsMin);
      expect(groups.length).toBeLessThanOrEqual(SCENARIO.huntGroupsMax);
      expect(t.huntGroups).toBe(groups.length);
      expect(t.vehicles.length).toBeLessThanOrEqual(80);
      const a = sim.aircraft.position;
      for (const v of t.vehicles)
        expect(Math.hypot(v.position.x - a.x, v.position.z - a.z)).toBeGreaterThan(
          SCENARIO.minDistance,
        );
      const kinds = new Set(groups.map((g) => g.behaviour));
      expect(kinds.has('column')).toBe(true);
      expect(kinds.has('dugIn')).toBe(true);
      expect(kinds.has('parked')).toBe(true);
      // dug-in vehicles sit in pits; tree-line groups stand by the trees
      for (const v of t.vehicles.filter((x) => x.dugIn)) expect(v.position.y).toBeLessThan(120 - 1);
      const bravo = groups.find((g) => g.name === 'BRAVO');
      if (bravo && bravo.behaviour === 'parked') {
        for (const v of groupVehicles(sim, bravo)) {
          expect(v.position.x).toBeGreaterThan(6050);
          expect(v.position.x).toBeLessThan(6160);
        }
      }
    }
  });

  it(
    'replaces a group that is wiped out, far from the aircraft, keeping 6–10 alive',
    { timeout: SLOW },
    () => {
      const sim = simOn(rangeTerrain(), 4, 'freeHunt');
      const t = sim.targets;
      const target = t.groups[0];
      const before = t.groups.filter((g) => g.reacts).length;
      for (const v of groupVehicles(sim, target)) {
        v.condition = 'destroyed';
        v.engineOn = false;
      }
      sim.aircraft.position.set(target.cx, 1500, target.cz);
      step(sim, SCENARIO.respawnDelayMax + 5);
      expect(target.wipedOut).toBe(true);
      const live = t.groups.filter((g) => g.reacts && !g.wipedOut);
      expect(live.length).toBe(before);
      const fresh = t.groups[t.groups.length - 1];
      for (const v of groupVehicles(sim, fresh)) {
        expect(alive(v)).toBe(true);
        expect(Math.hypot(v.position.x - target.cx, v.position.z - target.cz)).toBeGreaterThan(
          SCENARIO.minDistance,
        );
      }
    },
  );

  it('is deterministic', { timeout: SLOW }, () => {
    const run = () => {
      const sim = simOn(rangeTerrain(), 9, 'freeHunt');
      step(sim, 10);
      const g = sim.targets.groups.find((x) => x.behaviour === 'column')!;
      sim.events.push(impactEvent(sim, g.cx + 40, g.cz));
      step(sim, 30);
      return JSON.stringify(
        sim.targets.vehicles.map((v) => [
          v.id,
          v.kind,
          v.position.toArray(),
          v.heading,
          v.speed,
          v.turretYaw,
          v.heat,
        ]),
      );
    };
    expect(run()).toBe(run());
  });

  it('falls back gracefully on a terrain without the named areas or roads', () => {
    const sim = simOn(createFlatTerrain(0), 5, 'freeHunt');
    const groups = sim.targets.groups;
    expect(groups.length).toBeGreaterThanOrEqual(SCENARIO.huntGroupsMin);
    const a = sim.aircraft.position;
    for (const v of sim.targets.vehicles)
      expect(Math.hypot(v.position.x - a.x, v.position.z - a.z)).toBeGreaterThan(
        SCENARIO.minDistance,
      );
  });
});

describe('range events', () => {
  it('strafe pit: panels abreast facing the run-in, hulks behind', () => {
    const sim = simOn(rangeTerrain(), 1, 'strafePit');
    const panels = sim.targets.vehicles.filter((v) => v.kind === 'panel');
    const hulks = sim.targets.vehicles.filter((v) => v.kind === 'hulk');
    expect(panels.length).toBe(4);
    expect(hulks.length).toBe(2);
    for (const p of panels) {
      expect(Math.hypot(p.position.x - 20000, p.position.z - 9000)).toBeLessThan(260);
      // the run-in heading is east: the panels face west, toward the aircraft
      expect(Math.cos(p.heading - 1.5 * Math.PI)).toBeGreaterThan(0.99);
    }
    for (const g of sim.targets.groups) expect(g.reacts).toBe(false);
  });

  it('bombing circle: hulks on and around the centre', () => {
    const sim = simOn(rangeTerrain(), 1, 'bombCircle');
    const hulks = sim.targets.vehicles;
    expect(hulks.length).toBe(7);
    expect(hulks.every((v) => v.kind === 'hulk')).toBe(true);
    expect(hulks.some((v) => Math.hypot(v.position.x - 18000, v.position.z - 6000) < 1)).toBe(true);
    for (const v of hulks)
      expect(Math.hypot(v.position.x - 18000, v.position.z - 6000)).toBeLessThan(380);
  });

  it(
    'tactical lane: hulks and a slow column that keeps going round its loop',
    { timeout: SLOW },
    () => {
      const sim = simOn(rangeTerrain(), 1, 'tacticalLane');
      const column = sim.targets.groups.find((g) => g.behaviour === 'column')!;
      expect(column).toBeDefined();
      expect(sim.targets.vehicles.filter((v) => v.kind === 'hulk').length).toBeGreaterThanOrEqual(
        5,
      );
      const vs = groupVehicles(sim, column);
      const start = vs[0].position.clone();
      sim.events.push(impactEvent(sim, vs[0].position.x + 20, vs[0].position.z));
      step(sim, 120);
      expect(column.behaviour).toBe('column'); // remote-controlled targets do not scatter
      for (const v of vs) {
        expect(v.speed).toBeGreaterThan(MOBILITY.laneSpeed * 0.8);
        expect(Math.hypot(v.position.x - 15000, v.position.z - 2000)).toBeLessThan(850);
      }
      expect(vs[0].position.distanceTo(start)).toBeGreaterThan(100);
    },
  );

  it('empty: nothing', () => {
    expect(simOn(rangeTerrain(), 1, 'empty').targets.vehicles.length).toBe(0);
  });

  it('range events fall back to another area when the named one is missing', () => {
    for (const scenario of ['strafePit', 'bombCircle', 'tacticalLane'] as const) {
      const sim = simOn(createFlatTerrain(0), 1, scenario);
      expect(sim.targets.vehicles.length, scenario).toBeGreaterThan(0);
    }
  });
});

describe('a strafing pass with the real gun (integration)', () => {
  /** Fly a trimmed 45° dive at 300 kn and fire a one-second burst; return the sim. */
  function pass(tank: { x: number; z: number } | null): Sim {
    const sim = createSim({
      seed: 17,
      terrain: createFlatTerrain(100),
      scenario: 'empty',
      start: { x: 0, z: 0, agl: 700, heading: 0, speed: 300 * 0.514444, gamma: -45 * DEG },
    });
    if (tank) createVehicle(sim, 'mbt', tank.x, tank.z, 0, 1);
    sim.avionics.masterArm = 'ARM';
    sim.avionics.gunPac = 'ARM';
    for (let i = 0; i < 120 * 4; i++) {
      sim.input.trigger = i >= 60 && i < 180 ? 2 : 0;
      stepSim(sim);
    }
    return sim;
  }

  it(
    'rounds strike the tank, are resolved against its plates and change its state',
    { timeout: SLOW },
    () => {
      const dry = pass(null);
      const ground = dry.events.filter((e) => e.type === 'roundImpact');
      expect(ground.length).toBeGreaterThan(30);
      let x = 0;
      let z = 0;
      for (const e of ground) {
        x += e.position.x;
        z += e.position.z;
      }
      const aim = { x: x / ground.length, z: z / ground.length };
      const sim = pass(aim);
      const tank = sim.targets.vehicles[0];
      const onTank = sim.events.filter(
        (e) => e.type === 'roundImpact' && e.target.kind === 'vehicle',
      );
      expect(onTank.length).toBeGreaterThan(5);
      const records = sim.debrief.hits.filter((h) => h.vehicleId === tank.id);
      const tally: Record<string, number> = {};
      for (const h of records)
        tally[`${h.weapon} ${h.face} ${h.part} ${h.outcome}`] =
          (tally[`${h.weapon} ${h.face} ${h.part} ${h.outcome}`] ?? 0) + 1;
      console.log(
        `strafing pass: ${ground.length} rounds, ${onTank.length} on the tank → ${tank.condition}`,
        JSON.stringify(tally),
        JSON.stringify(tank.components),
      );
      expect(records.length).toBe(onTank.length);
      expect(records.some((h) => h.outcome === 'penetrated')).toBe(true);
      expect(tank.hits).toBe(onTank.length);
      expect(tank.condition).not.toBe('intact');
    },
  );
});

describe('the generated world (integration)', () => {
  it(
    'free hunt on the generated range: groups far from the start, columns on its roads',
    { timeout: 180_000 },
    () => {
      const terrain = createTerrain(generateTerrainData(1));
      const sim = simOn(terrain, 1, 'freeHunt');
      const t = sim.targets;
      const groups = t.groups.filter((g) => g.reacts);
      expect(groups.length).toBeGreaterThanOrEqual(SCENARIO.huntGroupsMin);
      expect(groups.length).toBeLessThanOrEqual(SCENARIO.huntGroupsMax);
      const a = sim.aircraft.position;
      for (const v of t.vehicles)
        expect(Math.hypot(v.position.x - a.x, v.position.z - a.z)).toBeGreaterThan(
          SCENARIO.minDistance,
        );
      step(sim, 20);
      const rp = createRoadPoint();
      for (const g of groups.filter((x) => x.behaviour === 'column')) {
        for (const v of groupVehicles(sim, g)) {
          nearestRoadPoint(terrain.roads, v.position.x, v.position.z, rp);
          expect(rp.offset).toBeLessThan(8);
          expect(v.position.y).toBeCloseTo(terrain.heightAt(v.position.x, v.position.z), 3);
        }
      }
    },
  );
});
