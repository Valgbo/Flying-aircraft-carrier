/**
 * A missile's shaped charge against vehicles (ARCHITECTURE §12.4, PLAN §6.4 "a Maverick hit
 * destroys any vehicle"): applyWarheadHit. A Maverick-sized warhead (AGM-65D/H: a ≈1,000 mm jet,
 * 39 kg TNT-equivalent, 15 kg case: data/munitions.ts) is fired by hand into vehicles on flat
 * ground, from every aspect; the jet, the behind-armour effects, the blast on the struck vehicle
 * and on its neighbours, the hit log and the kill count are checked. Fixtures are hand-built.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createSim } from '../../../src/a10/core/sim';
import {
  applyBlast,
  applyWarheadHit,
  createVehicle,
  segmentHitVehicle,
  stepTargets,
  type Vehicle,
  type VehicleHit,
  type VehicleKind,
  type WarheadStrike,
} from '../../../src/a10/core/targets';
import type { Sim } from '../../../src/a10/core/types';
import type { StoreBody } from '../../../src/a10/core/weapons/types';
import { createFlatTerrain } from '../../../src/a10/core/world';

const DEG = Math.PI / 180;
const DT = 1 / 120;
const SLOW = 120_000;
/** The AGM-65D/H warhead as the stores module passes it (penetration, TNT-equivalent charge). */
const MAVERICK = { penetrationMm: 1000, chargeKg: 39, caseKg: 15 };
const BODY_ID = 77;

function freshSim(seed: number): Sim {
  return createSim({ seed, terrain: createFlatTerrain(0), scenario: 'empty' });
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

/** Unit direction of flight of a weapon arriving from azimuth `az` (0 = ahead of a north-facing vehicle) in a `dive`. */
function arrival(az: number, dive: number): Vector3 {
  return new Vector3(
    -Math.sin(az) * Math.cos(dive),
    -Math.sin(dive),
    Math.cos(az) * Math.cos(dive),
  );
}

/** Where a weapon flying along `dir` toward the hull point `aim` strikes the vehicles (or null). */
function strike(sim: Sim, aim: Vector3, dir: Vector3): VehicleHit | null {
  const hit = newHit();
  const ok = segmentHitVehicle(
    sim,
    aim.clone().addScaledVector(dir, -30),
    aim.clone().addScaledVector(dir, 1),
    hit,
  );
  return ok ? hit : null;
}

function warhead(dir: Vector3, w: Partial<WarheadStrike> = {}): WarheadStrike {
  return {
    kind: 'shapedCharge',
    ...MAVERICK,
    direction: { x: dir.x * 300, y: dir.y * 300, z: dir.z * 300 },
    ...w,
  };
}

function settle(sim: Sim, seconds: number): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    stepTargets(sim, DT);
    sim.time += DT;
    sim.stepCount++;
  }
}

const killed = (v: Vehicle) => v.condition === 'destroyed' || v.condition === 'catastrophic';

/** Aim points on a north-facing T-72 at the origin: the hull's middle and the turret's. */
const AIMS: Record<string, Vector3> = {
  hull: new Vector3(0, 1.1, 0.3),
  turret: new Vector3(0, 2.05, -0.6),
};

describe('applyWarheadHit: a Maverick-sized shaped charge (PLAN §6.4, ARCHITECTURE §12.4)', () => {
  it(
    'kills a T-72 from any aspect, including the front, with one hit record and one kill',
    { timeout: SLOW },
    () => {
      let shots = 0;
      let catastrophic = 0;
      for (const aim of Object.keys(AIMS)) {
        for (const dive of [5, 20, 45]) {
          for (let a = 0; a < 8; a++) {
            for (let seed = 1; seed <= 3; seed++) {
              const sim = freshSim(1000 * a + 10 * dive + seed);
              const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
              const dir = arrival(a * 45 * DEG, dive * DEG);
              const hit = strike(sim, AIMS[aim], dir)!;
              expect(hit, `${aim} ${a * 45}° ${dive}°`).not.toBeNull();
              applyWarheadHit(sim, hit, warhead(dir), 'AGM-65D', BODY_ID);
              shots++;
              const label = `${aim}, from ${a * 45}°, ${dive}° dive, seed ${seed}`;
              expect(killed(v), label).toBe(true);
              const recs = sim.debrief.hits.filter((h) => h.vehicleId === v.id);
              expect(recs.length, label).toBe(1);
              expect(recs[0].weapon).toBe('AGM-65D');
              expect(recs[0].sourceId).toBe(BODY_ID);
              expect(recs[0].outcome, label).toBe('penetrated');
              expect(recs[0].penetrationMm).toBe(1000);
              expect(recs[0].speed).toBeCloseTo(300, 6);
              expect(v.hits).toBe(1);
              expect(sim.debrief.kills.filter((k) => k.vehicleId === v.id).length).toBe(1);
              expect(sim.targets.killed).toBe(1);
              if (v.condition === 'catastrophic') catastrophic++;
            }
          }
        }
      }
      console.log(
        `[targets] AGM-65D into a T-72: ${shots}/${shots} destroyed, ${catastrophic} catastrophic at once`,
      );
      // "a tank is destroyed, often catastrophically"
      expect(catastrophic / shots).toBeGreaterThan(0.5);
    },
  );

  it(
    'the jet alone (no blast) kills nearly always: what is behind the armour is destroyed',
    { timeout: SLOW },
    () => {
      let shots = 0;
      let dead = 0;
      let catastrophic = 0;
      for (const aim of Object.keys(AIMS)) {
        for (const dive of [5, 20, 45]) {
          for (let a = 0; a < 8; a++) {
            for (let seed = 1; seed <= 3; seed++) {
              const sim = freshSim(500 + 1000 * a + 10 * dive + seed);
              const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
              const dir = arrival(a * 45 * DEG, dive * DEG);
              applyWarheadHit(
                sim,
                strike(sim, AIMS[aim], dir)!,
                warhead(dir, { chargeKg: 0, caseKg: 0 }),
                'AGM-65D',
                BODY_ID,
              );
              // ammunition set alight goes up within seconds
              settle(sim, 12);
              shots++;
              if (killed(v)) dead++;
              if (v.condition === 'catastrophic') catastrophic++;
            }
          }
        }
      }
      console.log(
        `[targets] jet alone into a T-72: ${dead}/${shots} destroyed, ${catastrophic} catastrophic after 12 s`,
      );
      expect(dead / shots).toBeGreaterThanOrEqual(0.95);
      expect(catastrophic / shots).toBeGreaterThan(0.5);
    },
  );

  it('armour still decides: a jet too weak for the front armour stops on it', () => {
    for (const [aim, dive] of [
      ['hull', 5],
      ['turret', 5],
      ['turret', 20],
    ] as const) {
      const sim = freshSim(40);
      const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
      const dir = arrival(0, dive * DEG);
      applyWarheadHit(
        sim,
        strike(sim, AIMS[aim], dir)!,
        warhead(dir, { penetrationMm: 150, chargeKg: 0, caseKg: 0 }),
        'TEST',
        BODY_ID,
      );
      const rec = sim.debrief.hits.find((h) => h.vehicleId === v.id)!;
      expect(rec.outcome, `${aim} ${dive}°`).toBe('stopped');
      expect(rec.effectiveThicknessMm).toBeGreaterThan(150);
      expect(v.components.crew).toBe(1);
      expect(v.components.ammo).toBe(1);
      expect(v.condition).toBe('intact');
    }
    // the same jet goes through the rear
    const sim = freshSim(41);
    const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
    const dir = arrival(180 * DEG, 5 * DEG);
    applyWarheadHit(
      sim,
      strike(sim, AIMS.hull, dir)!,
      warhead(dir, { penetrationMm: 150, chargeKg: 0, caseKg: 0 }),
      'TEST',
      BODY_ID,
    );
    expect(sim.debrief.hits.find((h) => h.vehicleId === v.id)!.outcome).toBe('penetrated');
  });

  it('destroys light armour and trucks from any aspect, every time', () => {
    for (const kind of ['ifv', 'apc', 'truckCargo', 'truckFuel', 'truckAmmo'] as VehicleKind[]) {
      for (let a = 0; a < 8; a++) {
        const sim = freshSim(60 + a);
        const v = createVehicle(sim, kind, 0, 0, 0, 1);
        const dir = arrival(a * 45 * DEG, 20 * DEG);
        applyWarheadHit(
          sim,
          strike(sim, new Vector3(0, 1.2, 0), dir)!,
          warhead(dir),
          'AGM-65H',
          BODY_ID,
        );
        expect(killed(v), `${kind} from ${a * 45}°`).toBe(true);
        expect(sim.debrief.hits.filter((h) => h.vehicleId === v.id).length).toBe(1);
      }
    }
  });

  it('a missed hull (a burst on the ground beside it) does only blast damage', () => {
    for (let seed = 1; seed <= 10; seed++) {
      // the warhead bursts on the ground 4 m from the right track (the weapons module's applyBlast)
      const sim = freshSim(seed);
      const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
      applyBlast(
        sim,
        new Vector3(1.71 + 4, 0.3, 0),
        MAVERICK.chargeKg,
        MAVERICK.caseKg,
        'AGM-65D',
        9,
      );
      expect(killed(v)).toBe(false);
      const recs = sim.debrief.hits.filter((h) => h.vehicleId === v.id);
      expect(recs.length).toBe(1);
      expect(['blast', 'fragment']).toContain(recs[0].outcome);
      // the same warhead striking the hull side there kills it
      const sim2 = freshSim(seed);
      const v2 = createVehicle(sim2, 'mbt', 0, 0, 0, 1);
      const dir = arrival(90 * DEG, 20 * DEG);
      applyWarheadHit(sim2, strike(sim2, AIMS.hull, dir)!, warhead(dir), 'AGM-65D', 9);
      expect(killed(v2)).toBe(true);
    }
  });

  it('the blast and case fragments reach the neighbours; the struck vehicle counts once', () => {
    const sim = freshSim(70);
    const tank = createVehicle(sim, 'mbt', 0, 0, 0, 1);
    const truck = createVehicle(sim, 'truckCargo', 12, 0, 0, 1);
    const far = createVehicle(sim, 'truckCargo', 0, 400, 0, 1);
    const dir = arrival(90 * DEG, 20 * DEG);
    const hit = strike(sim, AIMS.hull, dir)!;
    expect(hit.vehicleId).toBe(tank.id);
    applyWarheadHit(sim, hit, warhead(dir), 'AGM-65D', BODY_ID);
    expect(killed(truck)).toBe(true);
    const truckRecs = sim.debrief.hits.filter((h) => h.vehicleId === truck.id);
    expect(truckRecs.length).toBe(1);
    expect(truckRecs[0].outcome).toBe('blast');
    expect(truckRecs[0].weapon).toBe('AGM-65D');
    expect(truckRecs[0].sourceId).toBe(BODY_ID);
    expect(far.hits).toBe(0);
    // the weapons module's own applyBlast at the same point in the same step skips the tank
    applyBlast(sim, hit.point, MAVERICK.chargeKg, MAVERICK.caseKg, 'AGM-65D', BODY_ID);
    expect(sim.debrief.hits.filter((h) => h.vehicleId === tank.id).length).toBe(1);
    expect(tank.hits).toBe(1);
    expect(sim.debrief.kills.filter((k) => k.vehicleId === tank.id).length).toBe(1);
    expect(sim.debrief.kills.find((k) => k.vehicleId === tank.id)!.weapon).toBe('AGM-65D');
  });

  it('without a direction the jet follows the striking store body, else the plate normal', () => {
    const run = (withBody: boolean) => {
      const sim = freshSim(80);
      const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
      const dir = arrival(30 * DEG, 25 * DEG);
      if (withBody)
        sim.projectiles.bodies.push({
          id: BODY_ID,
          velocity: dir.clone().multiplyScalar(310),
        } as unknown as StoreBody);
      const hit = strike(sim, AIMS.turret, dir)!;
      applyWarheadHit(sim, hit, { kind: 'shapedCharge', ...MAVERICK }, 'AGM-65D', BODY_ID);
      const rec = sim.debrief.hits.find((h) => h.vehicleId === v.id)!;
      // the obliquity the jet met at the struck plate, from its direction
      const cos = -(dir.x * hit.normal.x + dir.y * hit.normal.y + dir.z * hit.normal.z);
      return { rec, theta: Math.acos(Math.min(1, cos)) };
    };
    const a = run(true);
    expect(a.rec.speed).toBeCloseTo(310, 6);
    expect(a.rec.obliquity).toBeCloseTo(a.theta, 6);
    const b = run(false);
    expect(b.rec.speed).toBe(0);
    expect(b.rec.obliquity).toBeCloseTo(0, 6);
  });

  it('a jet across the gun barrel puts the gun out of action without perforating the hull', () => {
    const sim = freshSim(90);
    const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
    // across the barrel, 2 m from its muzzle, from the right and slightly above
    const dir = arrival(-90 * DEG, 10 * DEG);
    const hit = strike(sim, new Vector3(0, 2.04, -5.8), dir)!;
    expect(hit.part).toBe('gun');
    applyWarheadHit(sim, hit, warhead(dir, { chargeKg: 0, caseKg: 0 }), 'AGM-65D', BODY_ID);
    const rec = sim.debrief.hits.find((h) => h.vehicleId === v.id)!;
    expect(rec.outcome).toBe('passedThrough');
    expect(v.components.gun).toBe(0);
    expect(v.firepowerKill).toBe(true);
    expect(v.components.crew).toBe(1);
  });

  it('is deterministic: the same seed and strike give the same result', () => {
    const run = () => {
      const sim = freshSim(99);
      const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
      createVehicle(sim, 'truckAmmo', 9, 6, 0.4, 1);
      const dir = arrival(130 * DEG, 25 * DEG);
      applyWarheadHit(sim, strike(sim, AIMS.hull, dir)!, warhead(dir), 'AGM-65D', BODY_ID);
      settle(sim, 20);
      return JSON.stringify({
        vehicles: sim.targets.vehicles.map((x) => [
          x.condition,
          Array.from(x.internal.boxHealth),
          x.fire,
        ]),
        hits: sim.debrief.hits,
        kills: sim.debrief.kills,
        v: v.condition,
      });
    };
    expect(run()).toBe(run());
  });
});
