/**
 * Damage model tests (PLAN_A10.md §9, §6.3 "behind the armour", §6.5 blast and fragments, §16
 * "Blast"): component damage and kill states, events and debrief records, fires and cook-offs,
 * the blast threshold table and the statistical fragments. Fixtures are hand-built (flat terrain,
 * vehicles placed directly) so the tests do not depend on other modules' unfinished work.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createSim } from '../../../src/a10/core/sim';
import {
  applyBlast,
  blastImpulse,
  blastLevel,
  createVehicle,
  fragmentCount,
  fragmentPenetration,
  fragmentSpeed,
  gurneyVelocity,
  resolveRoundHit,
  segmentHitVehicle,
  stepTargets,
  VEHICLE_MODELS,
  type RoundHitResult,
  type Vehicle,
  type VehicleHit,
  type VehicleKind,
} from '../../../src/a10/core/targets';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { RoundType } from '../../../src/a10/core/weapons';
import { createFlatTerrain } from '../../../src/a10/core/world';
import {
  BLAST,
  BLAST_THRESHOLDS,
  FRAGMENTS,
  VEHICLE_SHAPES,
} from '../../../src/a10/data/vehicles';

const DT = 1 / 120;

function freshSim(seed = 1, ground = 0): Sim {
  return createSim({ seed, terrain: createFlatTerrain(ground), scenario: 'empty' });
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

function newResult(): RoundHitResult {
  return {
    outcome: 'stopped',
    obliquity: 0,
    effectiveThicknessMm: 0,
    penetrationMm: 0,
    damaged: [],
    ricochetVelocity: new Vector3(),
  };
}

/** Hull-frame point → world, for a vehicle on flat ground (no pitch or roll). */
function hullToWorld(v: Vehicle, x: number, y: number, z: number): Vector3 {
  const h = v.heading;
  return new Vector3(
    v.position.x + x * Math.cos(h) - z * Math.sin(h),
    v.position.y + y,
    v.position.z + x * Math.sin(h) + z * Math.cos(h),
  );
}

/** Fire one round with world velocity `vel` at hull point `aim`; returns the result (copy). */
function fire(sim: Sim, v: Vehicle, aim: [number, number, number], vel: Vector3, type: RoundType = RoundType.API) {
  const hit = newHit();
  const res = newResult();
  const dir = vel.clone().normalize();
  const p = hullToWorld(v, aim[0], aim[1], aim[2]);
  const ok = segmentHitVehicle(sim, p.clone().addScaledVector(dir, -30), p.clone().addScaledVector(dir, 1), hit);
  if (!ok) return null;
  resolveRoundHit(sim, hit, type, vel, res, 42);
  return { hit, res: { ...res, damaged: [...res.damaged] } };
}

function step(sim: Sim, seconds: number): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    stepTargets(sim, DT);
    sim.time += DT;
    sim.stepCount++;
  }
}

const mbt = VEHICLE_SHAPES.mbt;
const TOP = mbt.hullClearance + mbt.hullHeight;
const TZ = mbt.turret!.offsetZ;

/** A fast round coming down steeply (penetrates the turret roof and reaches the carousel). */
const STEEP = new Vector3(0.2, -1, 0.1).normalize().multiplyScalar(1150);

describe('behind the armour', () => {
  it('a penetration through the ammunition stowage makes a catastrophic kill, often', () => {
    const sim = freshSim(3);
    const n = 40;
    const tanks: Vehicle[] = [];
    let crossedAmmo = 0;
    for (let i = 0; i < n; i++) {
      const v = createVehicle(sim, 'mbt', 60 * i, 0, 0, 1);
      tanks.push(v);
      const r = fire(sim, v, [0.62, TOP + mbt.turret!.height, TZ + 0.2], STEEP);
      expect(r).not.toBeNull();
      expect(r!.res.outcome).toBe('penetrated');
      if (r!.res.damaged.includes('ammo')) crossedAmmo++;
    }
    expect(crossedAmmo).toBeGreaterThan(n * 0.5);
    step(sim, 200);
    const catastrophic = tanks.filter((v) => v.condition === 'catastrophic').length;
    // at least sometimes — and in fact most of the time when the ammunition was hit
    expect(catastrophic).toBeGreaterThan(0);
    expect(catastrophic / crossedAmmo).toBeGreaterThan(0.4);
    for (const v of tanks) {
      if (v.condition !== 'catastrophic') continue;
      expect(v.thrownTurret).not.toBeNull();
    }
  });

  it('a catastrophic kill: vehicleDestroyed and a secondary detonation together, the turret lands', () => {
    const sim = freshSim(4);
    let v: Vehicle | null = null;
    let events: SimEvent[] = [];
    for (let i = 0; i < 60 && !v; i++) {
      const t = createVehicle(sim, 'mbt', 60 * i, 0, 0.7, 1);
      sim.events.length = 0;
      fire(sim, t, [0.62, TOP + mbt.turret!.height, TZ + 0.2], STEEP);
      for (let k = 0; k < 120 * 30 && t.condition !== 'catastrophic'; k++) {
        stepTargets(sim, DT);
        sim.time += DT;
        sim.stepCount++;
      }
      if (t.condition === 'catastrophic') {
        v = t;
        events = sim.events.slice();
      }
    }
    expect(v).not.toBeNull();
    const tank = v as Vehicle;
    const destroyed = events.filter((e) => e.type === 'vehicleDestroyed' && e.vehicleId === tank.id);
    const boom = events.filter(
      (e) => e.type === 'detonation' && e.kind === 'secondary' && e.vehicleId === tank.id,
    );
    expect(boom.length).toBeGreaterThanOrEqual(1);
    const last = destroyed[destroyed.length - 1];
    expect(last && last.type === 'vehicleDestroyed' && last.catastrophic).toBe(true);
    expect(boom[0].t).toBe(last.t);
    // one kill, catastrophic
    const kills = sim.debrief.kills.filter((k) => k.vehicleId === tank.id);
    expect(kills.length).toBe(1);
    expect(kills[0].catastrophic).toBe(true);
    expect(kills[0].weapon).toBe('API');
    // the turret flies up, then rests on the ground
    const tt = tank.thrownTurret!;
    const y0 = tt.position.y;
    stepTargets(sim, DT);
    expect(tt.position.y).toBeGreaterThan(y0);
    step(sim, 8);
    expect(tt.velocity.length()).toBe(0);
    expect(tt.position.y).toBeGreaterThan(0);
    expect(tt.position.y).toBeLessThan(1);
    expect(Math.hypot(tt.position.x - tank.position.x, tt.position.z - tank.position.z)).toBeLessThan(40);
  });

  it('engine hits: mobility kill, the engine stops and a moving vehicle rolls to a halt', () => {
    const sim = freshSim(5);
    const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
    v.speed = 8;
    const deck: [number, number, number] = [0.3, TOP, mbt.hullLength / 2 - 0.9];
    for (let k = 0; k < 8 && !v.mobilityKill; k++) fire(sim, v, deck, STEEP);
    expect(v.mobilityKill).toBe(true);
    expect(v.components.engine).toBeLessThan(0.5);
    expect(v.condition === 'damaged' || v.condition === 'destroyed' || v.condition === 'catastrophic').toBe(true);
    if (v.condition === 'damaged') expect(v.engineOn).toBe(false);
    step(sim, 6);
    expect(v.speed).toBe(0);
  });

  it('gun and sight hits: firepower kill', () => {
    const sim = freshSim(6);
    let firepower = 0;
    for (let i = 0; i < 20; i++) {
      // facing south, toward the aircraft: HEI on the turret front beside the gunner's sight
      const v = createVehicle(sim, 'mbt', 60 * i, 0, Math.PI, 1);
      for (let k = 0; k < 3; k++)
        fire(sim, v, [-0.42, TOP + mbt.turret!.height - 0.15, TZ - 0.6], new Vector3(0, -400, -800), RoundType.HEI);
      if (v.firepowerKill) firepower++;
    }
    expect(firepower).toBeGreaterThan(10);
  });

  it('fuel hits start fires that grow, burn the vehicle out and die away', () => {
    let burning: { sim: Sim; v: Vehicle } | null = null;
    for (let i = 0; i < 40 && !burning; i++) {
      const sim = freshSim(700 + i);
      const v = createVehicle(sim, 'truckFuel', 0, 0, Math.PI / 2, 1);
      // API through the tanker body from the right
      fire(sim, v, [1.0, 2.1, 1.0], new Vector3(0, -250, -900));
      if (v.internal.fireInTarget > 0) burning = { sim, v };
    }
    expect(burning).not.toBeNull();
    const { sim, v } = burning as { sim: Sim; v: Vehicle };
    expect(v.fire).toBeLessThan(0.2);
    step(sim, 30);
    expect(v.fire).toBeGreaterThan(0.5);
    expect(v.condition === 'destroyed' || v.condition === 'catastrophic').toBe(true);
    expect(v.heat.hull).toBeGreaterThan(50);
    // a full tanker burns for many minutes, then the fire dies away and the wreck cools
    step(sim, 3000);
    expect(v.fire).toBe(0);
    const warm = v.heat.hull;
    step(sim, 600);
    expect(v.heat.hull).toBeLessThan(warm);
  });

  it('records every hit and counts kills once', () => {
    const sim = freshSim(8);
    const v = createVehicle(sim, 'truckCargo', 0, 0, Math.PI / 2, 1);
    let shots = 0;
    while (v.condition !== 'destroyed' && v.condition !== 'catastrophic' && shots < 40) {
      const z = -3 + (shots % 7);
      fire(sim, v, [1.25, 1.6, z], new Vector3(0, -300, -850));
      shots++;
    }
    expect(v.condition === 'destroyed' || v.condition === 'catastrophic').toBe(true);
    const hits = sim.debrief.hits.filter((h) => h.vehicleId === v.id);
    expect(hits.length).toBe(shots);
    for (const h of hits) {
      expect(h.weapon).toBe('API');
      expect(h.sourceId).toBe(42);
      expect(h.vehicleKind).toBe('truckCargo');
      expect(h.plate).toBeGreaterThanOrEqual(0);
      expect(h.speed).toBeCloseTo(Math.hypot(300, 850), 6);
      expect(h.obliquity).toBeGreaterThanOrEqual(0);
    }
    expect(hits[hits.length - 1].condition).toBe(v.condition);
    expect(sim.targets.killed).toBe(1);
    expect(sim.debrief.kills.filter((k) => k.vehicleId === v.id).length).toBe(1);
    // more hits on a wreck add records, not kills
    fire(sim, v, [1.25, 1.6, 0], new Vector3(0, -300, -850));
    expect(sim.targets.killed).toBe(1);
    expect(sim.events.some((e) => e.type === 'vehicleDamaged' && e.vehicleId === v.id)).toBe(true);
  });

  it('damaged vehicles are counted while damaged, then as kills', () => {
    const sim = freshSim(9);
    const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
    // break a track with HEI from the side
    for (let k = 0; k < 12 && !v.mobilityKill; k++)
      fire(sim, v, [1.7, 0.5, 0.5 * k - 2], new Vector3(-700, -200, 0), RoundType.HEI);
    expect(v.mobilityKill).toBe(true);
    expect(v.condition).toBe('damaged');
    expect(sim.targets.damaged).toBe(1);
    expect(sim.targets.killed).toBe(0);
  });

  it('hulks stay intact but count their hits; panels let every round through', () => {
    const sim = freshSim(10);
    const hulk = createVehicle(sim, 'hulk', 0, 0, 0, 1);
    for (let k = 0; k < 10; k++) fire(sim, hulk, [0.3, TOP, 2.5], STEEP);
    expect(hulk.condition).toBe('intact');
    expect(hulk.hits).toBe(10);
    const panel = createVehicle(sim, 'panel', 100, 0, Math.PI, 1);
    const r = fire(sim, panel, [0, 3, 0], new Vector3(0, -150, 950));
    expect(r!.res.outcome).toBe('passedThrough');
    expect(panel.condition).toBe('intact');
    expect(sim.debrief.hits.filter((h) => h.vehicleKind === 'panel').length).toBe(1);
  });

  it('is deterministic: the same seed and shots give the same damage', () => {
    const run = () => {
      const sim = freshSim(21);
      const out: string[] = [];
      for (let i = 0; i < 6; i++) {
        const v = createVehicle(sim, (['mbt', 'ifv', 'apc'] as VehicleKind[])[i % 3], 50 * i, 0, 0.3 * i, 1);
        for (let k = 0; k < 4; k++) fire(sim, v, [0.2 * k, 1.6, 0.5 * k], STEEP);
      }
      step(sim, 20);
      for (const v of sim.targets.vehicles)
        out.push(`${v.condition}:${Array.from(v.internal.boxHealth).map((h) => h.toFixed(4)).join(',')}:${v.fire.toFixed(4)}`);
      return out.join('|');
    };
    expect(run()).toBe(run());
  });
});

describe('blast (PLAN §6.5, §16): the scaled-distance table', () => {
  const W = BLAST.mk82ChargeKg;

  /** A vehicle with its side `dist` m from a burst at ground level (hull-side distance). */
  function blastAt(kind: VehicleKind, dist: number, charge: number = W, fragments = 0, seed = 1): Vehicle {
    const sim = freshSim(seed);
    const v = createVehicle(sim, kind, 0, 0, 0, 1);
    const half = VEHICLE_MODELS[kind].parts
      .filter((p) => p.part !== 'gun')
      .reduce((m, p) => Math.max(m, p.max[0]), 0);
    applyBlast(sim, new Vector3(half + dist, 0.3, 0), charge, fragments, 'MK-82');
    return v;
  }

  const killed = (v: Vehicle) => v.condition === 'destroyed' || v.condition === 'catastrophic';

  it('a tank needs a hit within a few metres', () => {
    expect(killed(blastAt('mbt', 2))).toBe(true);
    expect(killed(blastAt('mbt', 3.5))).toBe(true);
    const near = blastAt('mbt', 6);
    expect(killed(near)).toBe(false);
    expect(near.mobilityKill).toBe(true);
    const far = blastAt('mbt', 20);
    expect(killed(far)).toBe(false);
    expect(far.mobilityKill).toBe(false);
  });

  it('a direct hit throws the turret', () => {
    const v = blastAt('mbt', 0.2);
    expect(v.condition).toBe('catastrophic');
    expect(v.thrownTurret).not.toBeNull();
  });

  it('light armour in between', () => {
    for (const kind of ['ifv', 'apc'] as const) {
      expect(killed(blastAt(kind, 8)), kind).toBe(true);
      expect(killed(blastAt(kind, 25)), kind).toBe(false);
    }
  });

  it('a truck is destroyed at 30 m, not at 60 m', () => {
    for (const kind of ['truckCargo', 'truckFuel', 'truckAmmo'] as const) {
      expect(killed(blastAt(kind, 30)), kind).toBe(true);
      expect(killed(blastAt(kind, 60)), kind).toBe(false);
    }
  });

  it('the table holds level by level: Z and the impulse floor', () => {
    const order = ['none', 'light', 'heavy', 'destroyed', 'catastrophic'];
    for (const kind of Object.keys(BLAST_THRESHOLDS) as VehicleKind[]) {
      const row = BLAST_THRESHOLDS[kind];
      if (!row) {
        expect(blastLevel(kind, W, 0.1)).toBe('none');
        continue;
      }
      // a Mk-82 reaches each level just inside its scaled distance
      expect(blastLevel(kind, W, row.destroyed.z * 0.98)).toMatch(/destroyed|catastrophic/);
      expect(blastLevel(kind, W, row.heavy.z * 0.98)).toBe('heavy');
      expect(blastLevel(kind, W, row.light.z * 0.98)).toBe('light');
      expect(blastLevel(kind, W, row.light.z * 1.02)).toBe('none');
      // never less damage closer in
      let prev = 99;
      for (let z = 0.2; z < 20; z *= 1.1) {
        const k = order.indexOf(blastLevel(kind, W, z));
        expect(k).toBeLessThanOrEqual(prev);
        prev = k;
      }
    }
    // the impulse is the scaled side-on impulse of UFC 3-340-02 (≈360 Pa·s/kg^⅓ at Z 1.2)
    expect(blastImpulse(1, 1.2)).toBeGreaterThan(300);
    expect(blastImpulse(1, 1.2)).toBeLessThan(380);
  });

  it('a 30 mm HEI burst or a rocket warhead does not wreck a tank by blast', () => {
    const hei = blastAt('mbt', 0, 0.055, 0);
    expect(killed(hei)).toBe(false);
    expect(hei.mobilityKill).toBe(false);
    const rocket = blastAt('mbt', 0, 1.2, 0);
    expect(killed(rocket)).toBe(false);
  });

  it('a dug-in tank needs a closer burst than one in the open', () => {
    const sim = freshSim(30);
    const open = createVehicle(sim, 'mbt', 0, 0, 0, 1);
    const dug = createVehicle(sim, 'mbt', 500, 0, 0, 1);
    dug.dugIn = true;
    dug.internal.digDepth = mbt.hullClearance + mbt.hullHeight - 0.25;
    dug.position.y = -dug.internal.digDepth;
    sim.targets.internal.dirty = true;
    applyBlast(sim, new Vector3(1.73 + 3.5, 0.3, 0), W, 0);
    applyBlast(sim, new Vector3(500 + 1.73 + 3.5, 0.3, 0), W, 0);
    expect(killed(open)).toBe(true);
    expect(killed(dug)).toBe(false);
  });
});

describe('fragments (statistical model)', () => {
  it('Mott count, Gurney speed, drag and penetration are physical', () => {
    const n = fragmentCount(BLAST.mk82FragmentKg);
    expect(n).toBeGreaterThan(5000);
    expect(n).toBeLessThan(30000);
    const v0 = gurneyVelocity(BLAST.mk82ChargeKg, BLAST.mk82FragmentKg);
    expect(v0).toBeGreaterThan(1500);
    expect(v0).toBeLessThan(2200);
    // a 5 g fragment keeps about two-thirds of its speed over 30 m, a third over 90 m
    const m = 0.005;
    expect(fragmentSpeed(v0, m, 30, 1.2) / v0).toBeGreaterThan(0.55);
    expect(fragmentSpeed(v0, m, 90, 1.2) / v0).toBeLessThan(0.45);
    // truck skin yes, BMP side at 60 m no, tank roof never
    expect(fragmentPenetration(m, fragmentSpeed(v0, m, 60, 1.2))).toBeGreaterThan(3);
    expect(fragmentPenetration(m, fragmentSpeed(v0, m, 60, 1.2))).toBeLessThan(16);
    expect(fragmentPenetration(m, v0)).toBeLessThan(20);
    expect(FRAGMENTS.groundFactor).toBeGreaterThan(0);
  });

  it('fragments from a Mk-82 at 60 m rarely destroy a truck; at 30 m the truck is gone', () => {
    let destroyed60 = 0;
    let hit60 = 0;
    const n = 40;
    for (let i = 0; i < n; i++) {
      const sim = freshSim(100 + i);
      const v = createVehicle(sim, 'truckCargo', 0, 0, 0, 1);
      applyBlast(sim, new Vector3(1.25 + 60, 0.3, 0), BLAST.mk82ChargeKg, BLAST.mk82FragmentKg, 'MK-82');
      step(sim, 30);
      if (v.condition === 'destroyed' || v.condition === 'catastrophic') destroyed60++;
      if (v.hits > 0) hit60++;
    }
    expect(hit60 / n).toBeGreaterThan(0.5);
    expect(destroyed60 / n).toBeLessThan(0.25);
    const sim = freshSim(200);
    const v = createVehicle(sim, 'truckCargo', 0, 0, 0, 1);
    applyBlast(sim, new Vector3(1.25 + 30, 0.3, 0), BLAST.mk82ChargeKg, BLAST.mk82FragmentKg, 'MK-82');
    expect(v.condition === 'destroyed' || v.condition === 'catastrophic').toBe(true);
    const rec = sim.debrief.hits.find((h) => h.vehicleId === v.id);
    expect(rec?.weapon).toBe('MK-82');
    expect(rec?.outcome).toBe('blast');
  });

  it('an HEI round resolved on a vehicle is not counted again by its applyBlast', () => {
    const sim = freshSim(300);
    const v = createVehicle(sim, 'truckCargo', 0, 0, Math.PI / 2, 1);
    const r = fire(sim, v, [1.25, 1.6, 0], new Vector3(0, -300, -850), RoundType.HEI);
    expect(r!.res.outcome).toBe('burst');
    applyBlast(sim, r!.hit.point, 0.055, 0.28, 'HEI');
    expect(v.hits).toBe(1);
    expect(sim.debrief.hits.filter((h) => h.vehicleId === v.id).length).toBe(1);
    // a burst elsewhere still counts
    applyBlast(sim, new Vector3(0, 0.3, 5), 0.055, 0.28, 'HEI');
    expect(sim.debrief.hits.length).toBeGreaterThanOrEqual(1);
  });
});
