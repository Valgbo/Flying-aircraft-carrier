/**
 * Armour acceptance tests (PLAN_A10.md §6.3 table and §16 "Armour"): rounds fired from an aircraft
 * at 300 kn against the T-72-class tank, the IFV, the APC and trucks.
 *
 * Impact velocities come from the weapons module's ballistics (predictRoundImpact, the function
 * the fire-control computer and the live rounds use), fired along the line of fire at muzzle
 * velocity + 300 kn from 1,000 m above sea level (the contract's reading of the published
 * penetration figures, docs/a10/ARCHITECTURE.md §5), with the pipper on the target. Penetration
 * comes from penetrationMm. Nothing here copies a number from those modules.
 *
 * Tests whose result depends on the weapons module's final penetration fit (the crossover ranges)
 * are marked "(integration)".
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createSim } from '../../../src/a10/core/sim';
import {
  createVehicle,
  resolveRoundHit,
  segmentHitVehicle,
  stepTargets,
  VEHICLE_MODELS,
  type RoundHitResult,
  type RoundOutcome,
  type Vehicle,
  type VehicleHit,
  type VehicleKind,
} from '../../../src/a10/core/targets';
import type { Sim } from '../../../src/a10/core/types';
import { KT } from '../../../src/a10/core/units';
import { penetrationMm, predictRoundImpact, RoundType } from '../../../src/a10/core/weapons';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { GAU8 } from '../../../src/a10/data/gun';
import { T72_ARMOUR, ROUND_EFFECTS, VEHICLE_SHAPES } from '../../../src/a10/data/vehicles';

const DEG = Math.PI / 180;
/** The contract's reference firing altitude for the penetration fit, m. */
const FIRE_ALT = 1000;

/**
 * World impact velocity of a round fired from an aircraft at 300 kn in a `diveDeg` dive, flying
 * north, `range` m (slant) from the target, with the line of fire raised until the round lands
 * on the target (the pipper on it).
 */
function impactVelocity(diveDeg: number, range: number, type: RoundType = RoundType.API): Vector3 {
  const dive = diveDeg * DEG;
  const groundY = FIRE_ALT - range * Math.sin(dive);
  const terrain = createFlatTerrain(groundY);
  const origin = new Vector3(0, FIRE_ALT, range * Math.cos(dive));
  const out = { point: new Vector3(), velocity: new Vector3(), time: 0 };
  const speed0 = GAU8.muzzleVelocity + 300 * KT;
  const landZ = (el: number): number => {
    const v = new Vector3(0, Math.sin(el), -Math.cos(el)).multiplyScalar(speed0);
    if (!predictRoundImpact(type, origin, v, terrain, new Vector3(), 12, out)) return NaN;
    return out.point.z;
  };
  let el = -dive;
  for (let i = 0; i < 8; i++) {
    const z0 = landZ(el);
    const z1 = landZ(el + 1e-4);
    const slope = (z1 - z0) / 1e-4;
    if (!Number.isFinite(z0) || Math.abs(slope) < 1e-9) break;
    el -= z0 / slope;
    if (Math.abs(z0) < 0.05) break;
  }
  landZ(el);
  return out.velocity.clone();
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

interface Strikes {
  rate: Record<RoundOutcome, number>;
  plate: string;
  obliquity: number;
  effective: number;
  penetration: number;
}

/**
 * Fire `n` rounds with world velocity `vel` at the hull-frame point `aim` of fresh vehicles of
 * `kind` (one per round, so earlier damage cannot change the plate), heading `heading`.
 */
function strike(
  sim: Sim,
  kind: VehicleKind,
  heading: number,
  aim: [number, number, number],
  vel: Vector3,
  n = 60,
  type: RoundType = RoundType.API,
): Strikes {
  const count: Record<RoundOutcome, number> = {
    penetrated: 0,
    stopped: 0,
    ricochet: 0,
    burst: 0,
    passedThrough: 0,
  };
  const dir = vel.clone().normalize();
  const hit = newHit();
  const res = newResult();
  let plate = '';
  let obliquity = 0;
  let effective = 0;
  let penetration = 0;
  for (let i = 0; i < n; i++) {
    const v = createVehicle(sim, kind, 200 * (sim.targets.vehicles.length + 1), 0, heading, 1);
    const p = hullToWorld(v, aim[0], aim[1], aim[2]);
    const p0 = p.clone().addScaledVector(dir, -40);
    const p1 = p.clone().addScaledVector(dir, 0.5);
    expect(segmentHitVehicle(sim, p0, p1, hit)).toBe(true);
    expect(hit.vehicleId).toBe(v.id);
    resolveRoundHit(sim, hit, type, vel, res);
    count[res.outcome]++;
    plate = VEHICLE_MODELS[kind].plates[hit.plate].name;
    obliquity = res.obliquity;
    effective = res.effectiveThicknessMm;
    penetration = penetrationMm(type, vel.length());
  }
  const rate = { ...count };
  for (const k of Object.keys(rate) as RoundOutcome[]) rate[k] = count[k] / n;
  return { rate, plate, obliquity, effective, penetration };
}

function freshSim(seed = 11): Sim {
  return createSim({ seed, terrain: createFlatTerrain(0), scenario: 'empty' });
}

const mbt = VEHICLE_SHAPES.mbt;
const top = mbt.hullClearance + mbt.hullHeight;
/** Engine deck centre, rear plate centre, hull side (upper, over the fighting compartment). */
const DECK: [number, number, number] = [0.2, top, mbt.hullLength / 2 - 1.0];
const REAR: [number, number, number] = [0.3, mbt.hullClearance + 0.35, mbt.hullLength / 2];
const SIDE: [number, number, number] = [-1.09, top - 0.15, -0.6];

/** Range (m) at which the round's nominal penetration equals the plate's effective thickness. */
function crossover(diveDeg: number, effective: (v: Vector3) => number): number {
  const f = (r: number) => {
    const v = impactVelocity(diveDeg, r);
    return penetrationMm(RoundType.API, v.length()) - effective(v);
  };
  let lo = 200;
  let hi = 2500;
  if (f(lo) < 0) return 0;
  if (f(hi) > 0) return Infinity;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Effective thickness of a plate with world outward normal n to velocity v. */
const effectiveOf = (mm: number, n: Vector3) => (v: Vector3) => mm / -v.clone().normalize().dot(n);

describe('T-72 class: the attack table of PLAN §6.3', () => {
  it('roof / engine deck (20 mm): penetrated from a 45° dive firing at 1,000 m', () => {
    const vel = impactVelocity(45, 1000);
    const s = strike(freshSim(), 'mbt', 0, DECK, vel);
    expect(s.plate).toMatch(/engine compartment top/);
    expect(s.obliquity / DEG).toBeGreaterThan(40);
    expect(s.obliquity / DEG).toBeLessThan(50);
    expect(s.effective).toBeCloseTo(T72_ARMOUR.engineDeck / Math.cos(s.obliquity), 6);
    expect(s.penetration).toBeGreaterThan(s.effective);
    expect(s.rate.penetrated).toBeGreaterThan(0.9);
  });

  it('roof / engine deck (20 mm): just penetrated from a 45° dive firing at 1,200 m (≈28 mm)', () => {
    const vel = impactVelocity(45, 1200);
    const s = strike(freshSim(12), 'mbt', 0, DECK, vel, 100);
    expect(s.effective).toBeGreaterThan(26);
    expect(s.effective).toBeLessThan(30);
    // nominal penetration beats the plate; round-to-round scatter makes it "just"
    expect(s.penetration).toBeGreaterThan(s.effective);
    expect(s.rate.penetrated).toBeGreaterThan(0.5);
  });

  it('roof / engine deck: NOT penetrated from a 30° dive at 1,200 m (≈40 mm effective)', () => {
    const vel = impactVelocity(30, 1200);
    const s = strike(freshSim(13), 'mbt', 0, DECK, vel);
    expect(s.effective).toBeGreaterThan(37);
    expect(s.effective).toBeLessThan(42);
    expect(s.penetration).toBeLessThan(s.effective);
    expect(s.rate.penetrated).toBeLessThan(0.05);
    expect(s.rate.stopped).toBeGreaterThan(0.95);
  });

  it('roof / engine deck: a 30° dive works from inside ≈950 m (integration)', () => {
    const up = new Vector3(0, 1, 0);
    const r = crossover(30, effectiveOf(T72_ARMOUR.engineDeck, up));
    expect(r).toBeGreaterThan(850);
    expect(r).toBeLessThan(1050);
    const s = strike(freshSim(14), 'mbt', 0, DECK, impactVelocity(30, r - 150));
    expect(s.rate.penetrated).toBeGreaterThan(0.9);
  });

  it('roof: rounds from a 10° dive glance off (ricochet beyond 70°)', () => {
    const vel = impactVelocity(10, 900);
    const s = strike(freshSim(15), 'mbt', 0, DECK, vel);
    expect(s.obliquity).toBeGreaterThan(ROUND_EFFECTS.ricochetObliquity);
    expect(s.rate.ricochet).toBe(1);
  });

  it('a ricochet leaves the plate, slowed', () => {
    const sim = freshSim(16);
    const vel = impactVelocity(10, 900);
    const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
    const hit = newHit();
    const res = newResult();
    const p = hullToWorld(v, DECK[0], DECK[1], DECK[2]);
    const dir = vel.clone().normalize();
    expect(segmentHitVehicle(sim, p.clone().addScaledVector(dir, -40), p.clone().addScaledVector(dir, 0.5), hit)).toBe(true);
    resolveRoundHit(sim, hit, RoundType.API, vel, res);
    expect(res.outcome).toBe('ricochet');
    const out = res.ricochetVelocity;
    expect(out.dot(hit.normal)).toBeGreaterThan(0);
    expect(out.length()).toBeLessThan(vel.length() * 0.9);
    expect(out.length()).toBeGreaterThan(vel.length() * 0.5);
  });

  it('rear plate (40 mm, ≈41 mm along a 10° strafe): penetrated inside ≈950 m (integration)', () => {
    const rearNormal = new Vector3(0, 0, 1); // heading north: the rear faces the aircraft (south)
    const r = crossover(10, effectiveOf(T72_ARMOUR.hullRear, rearNormal));
    expect(r).toBeGreaterThan(850);
    expect(r).toBeLessThan(1050);
    const near = strike(freshSim(17), 'mbt', 0, REAR, impactVelocity(10, r - 150));
    expect(near.plate).toMatch(/engine compartment rear/);
    expect(near.effective).toBeGreaterThan(40);
    expect(near.effective).toBeLessThan(42);
    expect(near.rate.penetrated).toBeGreaterThan(0.9);
    const far = strike(freshSim(18), 'mbt', 0, REAR, impactVelocity(10, r + 200));
    expect(far.rate.penetrated).toBeLessThan(0.1);
  });

  it('rear plate penetrations reach the engine: mobility kill', () => {
    const sim = freshSim(19);
    const vel = impactVelocity(10, 500);
    let mobility = 0;
    const n = 30;
    for (let i = 0; i < n; i++) {
      const v = createVehicle(sim, 'mbt', 100 * i, 0, 0, 1);
      const hit = newHit();
      const res = newResult();
      const dir = vel.clone().normalize();
      const p = hullToWorld(v, REAR[0], REAR[1], REAR[2]);
      for (let k = 0; k < 3; k++) {
        segmentHitVehicle(sim, p.clone().addScaledVector(dir, -40), p.clone().addScaledVector(dir, 0.5), hit);
        resolveRoundHit(sim, hit, RoundType.API, vel, res);
      }
      if (v.mobilityKill) mobility++;
    }
    expect(mobility / n).toBeGreaterThan(0.6);
  });

  it('side plate (80 mm): never penetrated from 500 m and beyond', () => {
    for (const dive of [1, 5, 10, 20, 30]) {
      for (const range of [500, 700, 1000, 1500]) {
        const vel = impactVelocity(dive, range);
        // the left side faces the aircraft: heading west (left = south)
        const s = strike(freshSim(20 + dive + range), 'mbt', 1.5 * Math.PI, SIDE, vel, 20);
        expect(s.plate).toMatch(/hull (left|right)/);
        expect(s.rate.penetrated).toBe(0);
        expect(s.penetration * (1 + ROUND_EFFECTS.penetrationClip)).toBeLessThan(s.effective);
      }
    }
  });

  it('side plate (80 mm): only penetrated inside ≈400 m, at normal incidence (integration)', () => {
    const left = new Vector3(0, 0, 1); // heading west: the left side faces south, the aircraft
    const r = crossover(1, effectiveOf(T72_ARMOUR.hullSide, left));
    expect(r).toBeGreaterThan(300);
    expect(r).toBeLessThan(450);
  });

  it('front (glacis, turret front): never penetrated, not even point blank', () => {
    const glacis: [number, number, number] = [0.6, 1.4, -2.5];
    // the cheek beside the gun (the barrel shields the centre)
    const turret: [number, number, number] = [0.65, top + 0.3, -0.6 - 0.9];
    for (const [dive, range] of [
      [5, 200],
      [20, 300],
      [45, 400],
    ]) {
      const vel = impactVelocity(dive, range);
      // heading south: the front faces the aircraft
      const g = strike(freshSim(40 + dive), 'mbt', Math.PI, glacis, vel, 20);
      expect(g.plate).toMatch(/glacis/);
      expect(g.rate.penetrated).toBe(0);
      const t = strike(freshSim(50 + dive), 'mbt', Math.PI, turret, vel, 20);
      expect(t.plate).toMatch(/turret/);
      expect(t.rate.penetrated).toBe(0);
    }
  });
});

describe('light armour and trucks', () => {
  /**
   * A point on the plate facing each direction (hull frame), from the shapes as the layouts in
   * data/vehicles.ts build them: the upper front plate, the upper side plate, the rear plate.
   */
  const faces = (kind: 'ifv' | 'apc') => {
    const s = VEHICLE_SHAPES[kind];
    const C = s.hullClearance;
    const H = s.hullHeight;
    const top = C + H;
    const zF = -s.hullLength / 2;
    const zR = s.hullLength / 2;
    if (kind === 'ifv') {
      const yN = C + 0.45;
      const yMid = C + 0.67 * H;
      const z = zF + 0.75;
      const yF = 0.962;
      const y = 1.4;
      const x = s.hullWidth / 2 - ((y - yF) * 0.4) / (top - yF);
      return {
        front: [0.5, yN + 0.01 + ((z - zF) * (yMid - yN - 0.01)) / 1.7, z],
        right: [x, y, 1.0],
        left: [-x, y, 1.0],
        rear: [0.5, C + 0.9, zR],
      } as Record<string, [number, number, number]>;
    }
    const yW = Math.max(C + 0.5, 1.25);
    const xW = s.hullWidth / 2 - 0.05;
    const xT = s.hullWidth / 2 - 0.42;
    const y = yW + 0.35;
    const x = xW - ((y - yW) * (xW - xT)) / (top - yW);
    const z = zF + 0.8;
    return {
      front: [0.5, C + 0.62 + ((z - zF) * (top - C - 0.62)) / 1.6, z],
      right: [x, y, 0.5],
      left: [-x, y, 0.5],
      rear: [0.5, C + 0.75, zR],
    } as Record<string, [number, number, number]>;
  };

  for (const kind of ['ifv', 'apc'] as const) {
    it(`${kind}: penetrated from any direction at 1,500 m`, () => {
      const vel = impactVelocity(20, 1500);
      const f = faces(kind);
      for (const [name, heading] of [
        ['front', Math.PI],
        ['right', Math.PI / 2],
        ['left', 1.5 * Math.PI],
        ['rear', 0],
      ] as const) {
        const s = strike(freshSim(60), kind, heading, f[name], vel, 40);
        const msg = `${kind} ${name}: ${s.plate} ${s.effective.toFixed(1)} mm vs ${s.penetration.toFixed(1)} mm`;
        expect(s.rate.penetrated, msg).toBeGreaterThan(0.9);
      }
    });
  }

  it('trucks are destroyed by HEI bursts', () => {
    const vel = impactVelocity(20, 1000, RoundType.HEI);
    const dir = vel.clone().normalize();
    for (const kind of ['truckCargo', 'truckFuel', 'truckAmmo'] as const) {
      const sim = freshSim(70);
      const s = VEHICLE_SHAPES[kind];
      let destroyed = 0;
      const n = 20;
      for (let i = 0; i < n; i++) {
        const v = createVehicle(sim, kind, 100 * i, 0, Math.PI / 2, 1); // right side to the aircraft
        const hit = newHit();
        const res = newResult();
        // a burst's worth of HEI along the side: bonnet, cab, body
        for (let k = 0; k < 8; k++) {
          const z = -s.hullLength / 2 + 0.6 + (k / 7) * (s.hullLength - 1.2);
          const p = hullToWorld(v, s.hullWidth / 2, s.hullClearance + 0.8, z);
          if (!segmentHitVehicle(sim, p.clone().addScaledVector(dir, -40), p.clone().addScaledVector(dir, 2), hit)) continue;
          resolveRoundHit(sim, hit, RoundType.HEI, vel, res);
          expect(res.outcome).toBe('burst');
        }
        // fires take hold over the following seconds
        for (let k = 0; k < 120 * 20; k++) {
          stepTargets(sim, 1 / 120);
          sim.time += 1 / 120;
          sim.stepCount++;
        }
        if (v.condition === 'destroyed' || v.condition === 'catastrophic') destroyed++;
      }
      expect(destroyed / n, kind).toBeGreaterThan(0.8);
    }
  });

  it('a 30 mm HEI burst does not get through tank armour', () => {
    const vel = impactVelocity(30, 800, RoundType.HEI);
    const s = strike(freshSim(80), 'mbt', 0, DECK, vel, 20, RoundType.HEI);
    expect(s.rate.burst).toBe(1);
    expect(s.penetration).toBeLessThan(T72_ARMOUR.engineDeck);
  });
});
