/**
 * Bombs (PLAN_A10.md §6.5, §16 rows Bomb CCIP, Bomb CCRP, Fuze, Blast; ARCHITECTURE §12.1,
 * §12.2): the live Mk 82 against the point its registered model predicts at release (the CCIP
 * pipper's ground point), the CCRP release point, the Mk 82 AIR's ballute, fuze arming and duds,
 * and the blast table reproduced through the bombs' own detonation path. Fixtures: the weapons
 * kinematic test bed over flat ground. Two tests use the avionics module's real solution and are
 * marked (integration); they skip while its solution is invalid (a stand-in).
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createImpactPrediction,
  cycleProfile,
  stepFireControl,
} from '../../../src/a10/core/avionics';
import { SIM_DT } from '../../../src/a10/core/constants';
import { createVehicle, VEHICLE_MODELS } from '../../../src/a10/core/targets';
import type { Vehicle, VehicleKind } from '../../../src/a10/core/targets/types';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { DEG, FT, KT } from '../../../src/a10/core/units';
import { storeModel, type StoreType } from '../../../src/a10/core/weapons';
import {
  createGunTestbed,
  predictStoreRelease,
  queueRelease,
  runUntilLanded,
  setKinematicState,
  stepKinematic,
} from '../../../src/a10/core/weapons/testbed';
import { createFlatTerrain, windAt } from '../../../src/a10/core/world';
import type { Terrain } from '../../../src/a10/core/world/types';
import { BSU49, FUZE, WARHEADS } from '../../../src/a10/data/munitions';
import { BLAST } from '../../../src/a10/data/vehicles';

type Detonation = Extract<SimEvent, { type: 'detonation' }>;
const detonations = (sim: Sim): Detonation[] =>
  sim.events.filter((e): e is Detonation => e.type === 'detonation');

/** A kinematic A-10 with one store on `station`, `height` m above flat ground at sea level. */
function bed(opts: {
  store?: StoreType;
  station?: number;
  height: number;
  speedKt: number;
  diveDeg: number;
  seed?: number;
  realism?: 'authentic' | 'relaxed';
}) {
  const station = opts.station ?? 5;
  return createGunTestbed({
    seed: opts.seed ?? 1,
    terrain: createFlatTerrain(0),
    altitude: opts.height,
    speed: opts.speedKt * KT,
    pathAngle: -opts.diveDeg * DEG,
    customLoadout: { [station]: [opts.store ?? 'MK-82'] },
    realism: opts.realism ?? 'authentic',
  });
}

/** Impact point of the (only) store released in this sim, from its debrief record. */
function impactOf(sim: Sim, k = 0): Vector3 {
  const r = sim.debrief.weapons[k];
  return new Vector3(r.impact.x, r.impact.y, r.impact.z);
}

/** Set a crosswind of `kt` knots (from the left of a northbound run) measured at the aircraft. */
function crosswindAtAircraft(sim: Sim, kt: number): void {
  sim.world.surfaceWind.set(1, 0, 0);
  const w = windAt(sim.world, sim.aircraft.position, new Vector3());
  sim.world.surfaceWind.set((kt * KT) / w.length(), 0, 0);
}

describe('Bomb CCIP (PLAN §16): the live Mk 82 lands on the pipper', () => {
  /** 30° dive, 300 kn, released 1,500 m above the target: predicted vs live impact. */
  function ccip(windKt: number) {
    const sim = bed({ height: 1500, speedKt: 300, diveDeg: 30 });
    if (windKt) crosswindAtAircraft(sim, windKt);
    const pred = createImpactPrediction();
    expect(predictStoreRelease(sim, 5, 'MK-82', pred)).toBe(true);
    queueRelease(sim, 5, 'MK-82', { aim: pred.point, aimValid: true, armingTime: 4 });
    runUntilLanded(sim);
    const rec = sim.debrief.weapons[0];
    return { miss: impactOf(sim).distanceTo(pred.point), rec, pred, sim };
  }

  it('within 5 m of the predicted point in still air', () => {
    const { miss, rec, pred } = ccip(0);
    expect(miss).toBeLessThan(5);
    // It is the same model: centimetres, not metres.
    expect(miss).toBeLessThan(0.1);
    expect(rec.missDistance).toBeCloseTo(
      Math.hypot(pred.point.x - rec.impact.x, pred.point.z - rec.impact.z),
      6,
    );
    expect(rec.impactTime).toBeCloseTo(pred.time, 1);
    // A sanity check of the delivery: ≈11.5 s time of fall, ≈1.5 km ahead, impact angle ≈55°.
    expect(pred.time).toBeGreaterThan(10.5);
    expect(pred.time).toBeLessThan(12.5);
  });

  it('within 10 m in a 15 kn crosswind measured at the aircraft', () => {
    const { miss, sim } = ccip(15);
    // The computer holds the wind at the aircraft; the bomb meets the slower wind lower down.
    expect(miss).toBeLessThan(10);
    expect(detonations(sim)[0].kind).toBe('bomb');
    // The wind did move the bomb (measured 2.3 m: a heavy, fast store), and the pipper moved
    // with it (measured 7 cm apart).
    const calm = ccip(0);
    const drift = impactOf(sim).distanceTo(impactOf(calm.sim));
    expect(drift).toBeGreaterThan(1.5);
    expect(miss).toBeLessThan(0.2 * drift);
  });

  it('CCIP with the avionics module’s own solution (integration)', (ctx) => {
    const sim = bed({ height: 1500, speedKt: 300, diveDeg: 30 });
    crosswindAtAircraft(sim, 15);
    const av = sim.avionics;
    applyCommand(sim, { type: 'masterMode', value: 'CCIP' });
    for (let k = 0; k < av.profiles.length + 1; k++) {
      const p = av.profiles.find((x) => x.id === av.selectedProfile);
      if (p?.store === 'MK-82') break;
      cycleProfile(sim, 1);
    }
    stepFireControl(sim, SIM_DT);
    if (!av.release.valid || av.sight !== 'CCIP') ctx.skip();
    const pipper = av.release.impact.clone();
    queueRelease(sim, 5, 'MK-82', { aim: pipper, aimValid: true, armingTime: 4 });
    runUntilLanded(sim);
    expect(impactOf(sim).distanceTo(pipper)).toBeLessThan(10);
  });
});

describe('Bomb CCRP (PLAN §16): released at the computed release point', () => {
  const HEIGHT = 5000 * FT;
  const SPEED = 300 * KT;

  /**
   * The release time that puts a level, straight, constant-speed run's Mk 82 on `target`:
   * Newton iterations on the along-track error, each a prediction from the aircraft's state
   * extrapolated to the trial time.
   */
  function solveRelease(sim: Sim, target: Vector3): number {
    const ac = sim.aircraft;
    const p0 = ac.position.clone();
    const dir = new Vector3(ac.velocity.x, 0, ac.velocity.z).normalize();
    const vg = Math.hypot(ac.velocity.x, ac.velocity.z);
    const pred = createImpactPrediction();
    let dt = 0;
    for (let k = 0; k < 6; k++) {
      ac.position.copy(p0).addScaledVector(ac.velocity, dt);
      expect(predictStoreRelease(sim, 5, 'MK-82', pred)).toBe(true);
      dt += new Vector3().subVectors(target, pred.point).dot(dir) / vg;
    }
    ac.position.copy(p0);
    return dt;
  }

  function ccrp(windKt: number) {
    const sim = bed({ height: HEIGHT, speedKt: 300, diveDeg: 0 });
    if (windKt) crosswindAtAircraft(sim, windKt);
    // The target: on the ground ahead, where a release 3.2794 s from now would put the bomb.
    const probe = createImpactPrediction();
    const start = sim.aircraft.position.clone();
    sim.aircraft.position.addScaledVector(sim.aircraft.velocity, 3.2794);
    predictStoreRelease(sim, 5, 'MK-82', probe);
    sim.aircraft.position.copy(start);
    const target = probe.point.clone().add(new Vector3(0, 0, -0.5));
    const lead = solveRelease(sim, target);
    queueRelease(sim, 5, 'MK-82', {
      time: sim.time + lead,
      delivery: 'CCRP',
      aim: target,
      aimValid: true,
      armingTime: 4,
    });
    runUntilLanded(sim);
    const rec = sim.debrief.weapons[0];
    return { rec, lead, target, sim };
  }

  it('level at 5,000 ft above the target, 300 kn: miss under 10 m (own release-point solver)', () => {
    const { rec, lead } = ccrp(0);
    expect(lead).toBeGreaterThan(3);
    expect(lead).toBeLessThan(3.6);
    expect(rec.missDistance).toBeLessThan(10);
    // Exact-time release from the same model: well under a metre.
    expect(rec.missDistance).toBeLessThan(0.5);
    expect(rec.delivery).toBe('CCRP');
    expect(rec.release.agl).toBeCloseTo(HEIGHT, 0);
    expect(rec.release.speed).toBeCloseTo(SPEED, 0);
  });

  it('…and in a 15 kn crosswind (the wind measured at the aircraft)', () => {
    const { rec } = ccrp(15);
    expect(rec.missDistance).toBeLessThan(10);
  });

  it('CCRP with the avionics module’s release (integration)', (ctx) => {
    const sim = bed({ height: HEIGHT, speedKt: 300, diveDeg: 0 });
    const av = sim.avionics;
    // The target 3 km ahead on the run-in, as the SPI (the active steerpoint).
    const target = new Vector3(0, 0, sim.aircraft.position.z - 3000);
    const sp = av.steerpoints[av.activeSteerpoint];
    if (!sp) ctx.skip();
    sp.position.copy(target);
    av.spi.position.copy(target);
    av.spi.valid = true;
    applyCommand(sim, { type: 'masterMode', value: 'CCRP' });
    for (let k = 0; k < av.profiles.length + 1; k++) {
      const p = av.profiles.find((x) => x.id === av.selectedProfile);
      if (p?.store === 'MK-82') break;
      cycleProfile(sim, 1);
    }
    stepFireControl(sim, SIM_DT);
    if (!av.release.valid || av.sight !== 'CCRP') ctx.skip();
    let released = false;
    for (let k = 0; k < Math.round(40 / SIM_DT); k++) {
      sim.input.weaponRelease = true;
      stepKinematic(sim);
      stepFireControl(sim, SIM_DT);
      if (sim.debrief.weapons.length > 0) released = true;
      if (released && sim.projectiles.bodies.length === 0) break;
    }
    expect(released).toBe(true);
    const rec = sim.debrief.weapons.find((r) => !r.simulated)!;
    expect(Math.hypot(rec.impact.x - target.x, rec.impact.z - target.z)).toBeLessThan(10);
  });
});

describe('Mk 82 AIR high drag (PLAN §6.5, §16): the BSU-49 ballute', () => {
  it('falls steeper and lands well short of a low-drag release from the same state', () => {
    const run = (highDrag: boolean) => {
      const sim = bed({ store: 'MK-82AIR', height: 1500, speedKt: 300, diveDeg: 30 });
      queueRelease(sim, 5, 'MK-82AIR', { highDrag, armingTime: 2.6 });
      let opened = -1;
      runUntilLanded(sim, 120, (s) => {
        const b = s.projectiles.bodies[0];
        if (b && opened < 0 && b.highDrag) opened = s.time - b.releaseTime;
      });
      const det = detonations(sim)[0];
      const rec = sim.debrief.weapons[0];
      return { rec, det, opened };
    };
    const ld = run(false);
    const hd = run(true);
    const ldRange = -ld.rec.impact.z;
    const hdRange = -hd.rec.impact.z;
    // Measured: low drag 1,497 m ahead in 11.5 s; high drag 904 m in 19.8 s.
    expect(ldRange - hdRange).toBeGreaterThan(400);
    expect(hd.rec.impactTime - hd.rec.release.time).toBeGreaterThan(
      ld.rec.impactTime - ld.rec.release.time + 5,
    );
    expect(ld.opened).toBe(-1);
    expect(hd.opened).toBeGreaterThanOrEqual(BSU49.openStart);
    expect(hd.opened).toBeLessThan(BSU49.openStart + 0.05);
    expect(hd.det.kind).toBe('bomb');
  });

  it('the drag rises several-fold once the ballute is open, and the fall is steep', () => {
    const ld = storeModel('MK-82AIR')!.spec;
    const hd = storeModel('MK-82AIR/HD')!.spec;
    const cdaLd = ld.cd[Math.round(0.4 / 0.02)] * ld.area;
    const cdaHd = cdaLd + hd.balluteArea;
    expect(cdaHd / cdaLd).toBeGreaterThan(5);
    // Impact angle and speed from the same 30° dive.
    const angle = (key: string) => {
      const sim = bed({ store: 'MK-82AIR', height: 1500, speedKt: 300, diveDeg: 30 });
      const pred = createImpactPrediction();
      predictStoreRelease(sim, 5, key, pred);
      return Math.atan2(-pred.velocity.y, Math.hypot(pred.velocity.x, pred.velocity.z)) / DEG;
    };
    expect(angle('MK-82AIR/HD')).toBeGreaterThan(angle('MK-82AIR') + 15);
  });

  it('the live high-drag body matches its registered model within 0.5 m', () => {
    for (const [height, kt, dive] of [
      [1500, 300, 30],
      [300 * FT, 450, 0],
      [5000 * FT, 300, 0],
    ] as const) {
      const sim = bed({ store: 'MK-82AIR', height, speedKt: kt, diveDeg: dive });
      const pred = createImpactPrediction();
      expect(predictStoreRelease(sim, 5, 'MK-82AIR/HD', pred)).toBe(true);
      queueRelease(sim, 5, 'MK-82AIR', { highDrag: true, armingTime: 2.6 });
      runUntilLanded(sim);
      expect(impactOf(sim).distanceTo(pred.point), `${height} m ${kt} kn ${dive}°`).toBeLessThan(
        0.5,
      );
    }
  });

  it('a low-level high-drag release leaves the aircraft far ahead of the burst', () => {
    // 300 ft, 450 kn: the low-drag bomb lands under the aircraft (inside its fragment envelope);
    // the retarded bomb ≈450 m behind it.
    const run = (highDrag: boolean) => {
      const sim = bed({ store: 'MK-82AIR', height: 300 * FT, speedKt: 450, diveDeg: 0 });
      queueRelease(sim, 5, 'MK-82AIR', { highDrag, armingTime: 2.6 });
      runUntilLanded(sim);
      const rec = sim.debrief.weapons[0];
      const trail = sim.aircraft.position.z - rec.impact.z;
      return {
        rec,
        trail: -(450 * KT * (rec.impactTime - rec.release.time)) - rec.impact.z,
        z: trail,
      };
    };
    const ld = run(false);
    const hd = run(true);
    expect(Math.abs(ld.trail)).toBeLessThan(40);
    expect(Math.abs(hd.trail)).toBeGreaterThan(350);
    expect(ld.rec.fragmentWarning).toBe(true);
    expect(hd.rec.fragmentWarning).toBe(false);
  });
});

describe('Fuze (PLAN §6.5, §16): arming time, duds', () => {
  /** A Mk 82 dropped from `height` m in level flight at 300 kn with a 4 s arming time. */
  function drop(height: number, realism: 'authentic' | 'relaxed' = 'authentic') {
    const sim = bed({ height, speedKt: 300, diveDeg: 0, realism });
    queueRelease(sim, 5, 'MK-82', { armingTime: 4 });
    runUntilLanded(sim);
    return { det: detonations(sim)[0], rec: sim.debrief.weapons[0], sim };
  }

  it('released below the arming height: a dud (no charge, no blast)', () => {
    // 4 s of fall from level flight is ≈78 m: from 50 m the bomb lands after ≈3.2 s.
    const { det, rec } = drop(50);
    expect(det.kind).toBe('dud');
    expect(det.charge).toBe(0);
    expect(rec.dud).toBe(true);
    expect(rec.impactTime - rec.release.time).toBeLessThan(4);
  });

  it('released above it: a detonation', () => {
    const { det, rec } = drop(150);
    expect(det.kind).toBe('bomb');
    expect(det.charge).toBe(WARHEADS['MK-82']!.charge);
    expect(rec.dud).toBe(false);
    expect(rec.impactTime - rec.release.time).toBeGreaterThan(4);
  });

  it('with realism fuze effects off every store arms at once', () => {
    const { det, rec } = drop(50, 'relaxed');
    expect(det.kind).toBe('bomb');
    expect(rec.dud).toBe(false);
    expect(rec.fragmentWarning).toBe(false);
  });

  it('a tail (delay) fuze buries the bomb first: less blast, fewer fragments, same impact', () => {
    const run = (fuze: 'NOSE' | 'TAIL') => {
      const sim = bed({ height: 1500, speedKt: 300, diveDeg: 30 });
      queueRelease(sim, 5, 'MK-82', { fuze, armingTime: 4 });
      runUntilLanded(sim);
      return { det: detonations(sim)[0], rec: sim.debrief.weapons[0] };
    };
    const nose = run('NOSE');
    const tail = run('TAIL');
    expect(tail.det.charge).toBeLessThan(nose.det.charge);
    expect(tail.det.kind).toBe('bomb');
    expect(tail.rec.impact.x).toBeCloseTo(nose.rec.impact.x, 6);
    // The instantaneous burst is above the ground (the charge behind the nose fuze).
    expect(nose.det.position.y).toBeGreaterThan(0.5);
    expect(tail.det.position.y).toBeCloseTo(0, 6);
  });

  it('on water: a nose fuze bursts at the surface, a tail fuze under it (less blast, no fragments)', () => {
    /** Flat sea-level ground that is all water. */
    const lake = (): Terrain => {
      const flat = createFlatTerrain(0);
      return {
        ...flat,
        surfaceAt: () => 'water',
        segmentHit(p0, p1, out) {
          if (!flat.segmentHit(p0, p1, out)) return false;
          out.surface = 'water';
          return true;
        },
      };
    };
    const run = (fuze: 'NOSE' | 'TAIL') => {
      const sim = createGunTestbed({
        terrain: lake(),
        altitude: 100,
        speed: 300 * KT,
        customLoadout: { 5: ['MK-82'] },
      });
      queueRelease(sim, 5, 'MK-82', { fuze, armingTime: 0 });
      runUntilLanded(sim);
      return { det: detonations(sim)[0], rec: sim.debrief.weapons[0] };
    };
    const nose = run('NOSE');
    const tail = run('TAIL');
    const charge = WARHEADS['MK-82']!.charge;
    expect(nose.det.surface).toBe('water');
    expect(nose.det.charge).toBe(charge);
    expect(tail.det.surface).toBe('water');
    expect(tail.det.kind).toBe('bomb');
    expect(tail.det.charge).toBeCloseTo(charge * FUZE.underwaterBlast, 9);
    // 100 m over the burst: the surface burst's fragments reach the aircraft, none get out of
    // the water.
    expect(nose.rec.fragmentWarning).toBe(true);
    expect(tail.rec.fragmentWarning).toBe(false);
  });
});

describe('Blast (PLAN §6.5, §16): the targets table through the bombs’ detonation path', () => {
  /**
   * A Mk 82 falls vertically (released from a hovering test bed) and bursts on the ground with
   * its side `dist` m from a vehicle's side (or on its roof, dist < 0).
   */
  function bombNear(kind: VehicleKind, dist: number, seed = 1): Vehicle {
    const sim = bed({ height: 300, speedKt: 0, diveDeg: 0, seed });
    const pred = createImpactPrediction();
    expect(predictStoreRelease(sim, 5, 'MK-82', pred)).toBe(true);
    const half = VEHICLE_MODELS[kind].parts
      .filter((p) => p.part !== 'gun')
      .reduce((m, p) => Math.max(m, p.max[0]), 0);
    const x = dist < 0 ? pred.point.x : pred.point.x - half - dist;
    const v = createVehicle(sim, kind, x, pred.point.z, 0, 1);
    queueRelease(sim, 5, 'MK-82', { armingTime: 2 });
    runUntilLanded(sim);
    const det = detonations(sim)[0];
    expect(det.kind).toBe('bomb');
    if (dist < 0) expect(det.vehicleId).toBe(v.id);
    return v;
  }

  const killed = (v: Vehicle) => v.condition === 'destroyed' || v.condition === 'catastrophic';

  it('uses the charge and case the blast table is calibrated to', () => {
    expect(WARHEADS['MK-82']!.charge).toBe(BLAST.mk82ChargeKg);
    expect(WARHEADS['MK-82']!.caseMass).toBe(BLAST.mk82FragmentKg);
  });

  it('a direct hit on a tank destroys it (detonation on the vehicle)', () => {
    const v = bombNear('mbt', -1);
    expect(killed(v)).toBe(true);
  });

  it('a tank needs a hit within a few metres', () => {
    expect(killed(bombNear('mbt', 2))).toBe(true);
    expect(killed(bombNear('mbt', 3.5))).toBe(true);
    const near = bombNear('mbt', 6);
    expect(killed(near)).toBe(false);
    expect(near.mobilityKill).toBe(true);
    expect(killed(bombNear('mbt', 20))).toBe(false);
  });

  it('an IFV is destroyed at 8 m, not at 25 m', () => {
    expect(killed(bombNear('ifv', 8))).toBe(true);
    expect(killed(bombNear('ifv', 25))).toBe(false);
  });

  it('a truck is destroyed at 30 m, rarely at 60 m (fragments)', () => {
    for (let seed = 1; seed <= 4; seed++)
      expect(killed(bombNear('truckCargo', 30, seed))).toBe(true);
    let at60 = 0;
    for (let seed = 1; seed <= 8; seed++) if (killed(bombNear('truckCargo', 60, seed))) at60++;
    expect(at60).toBeLessThanOrEqual(2);
  });

  it('the hits and kills are logged with the weapon name and the body id', () => {
    const sim = bed({ height: 300, speedKt: 0, diveDeg: 0 });
    const pred = createImpactPrediction();
    predictStoreRelease(sim, 5, 'MK-82', pred);
    const v = createVehicle(sim, 'truckCargo', pred.point.x - 10, pred.point.z, 0, 1);
    queueRelease(sim, 5, 'MK-82', { armingTime: 2 });
    runUntilLanded(sim);
    const bodyId = sim.debrief.weapons[0].bodyId;
    const hit = sim.debrief.hits.find((h) => h.vehicleId === v.id);
    expect(hit?.weapon).toBe('MK-82');
    expect(hit?.sourceId).toBe(bodyId);
    expect(sim.debrief.kills.find((k) => k.vehicleId === v.id)?.weapon).toBe('MK-82');
  });
});

describe('Bomb release from a dive keeps its station geometry', () => {
  it('an ejected bomb leaves downward from its pylon', () => {
    const sim = bed({ height: 1000, speedKt: 300, diveDeg: 0 });
    setKinematicState(sim, {
      position: sim.aircraft.position.clone(),
      speed: 300 * KT,
      heading: 0,
      pathAngle: 0,
    });
    queueRelease(sim, 5, 'MK-82');
    stepKinematic(sim);
    const b = sim.projectiles.bodies[0];
    // Separates downward at ≈6 m/s (20 ft/s for a 500-lb store).
    expect(b.velocity.y).toBeLessThan(-5);
    expect(b.velocity.y).toBeGreaterThan(-7);
  });
});
