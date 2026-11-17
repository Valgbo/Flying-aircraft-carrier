/**
 * Stores release mechanics (PLAN_A10.md §6.8, §14, §16; ARCHITECTURE §12.1, §12.2, §12.6): the
 * release queue executed at the exact time inside a step, the station emptied and the totals
 * lowered, events, the debrief's weapon records, refusals, jettison, rearm, the models
 * registered with the fire-control computer and their predictor step, determinism, and no
 * allocation per step with bodies in flight. Fixtures: the weapons kinematic test bed.
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  createImpactPrediction,
  FIRE_CONTROL,
  storeBallistics,
  stepError,
  type CalibrationShot,
} from '../../../src/a10/core/avionics';
import { SIM_DT } from '../../../src/a10/core/constants';
import { updateMassProperties } from '../../../src/a10/core/flight';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { DEG, FT, KT } from '../../../src/a10/core/units';
import {
  fragmentEnvelope,
  integrateStore,
  jettisonStores,
  missClock,
  REGISTERED_STORE_KEYS,
  rearm,
  storeModel,
  type StoreBody,
} from '../../../src/a10/core/weapons';
import {
  createGunTestbed,
  predictStoreRelease,
  queueRelease,
  runKinematic,
  runUntilLanded,
  stepKinematic,
} from '../../../src/a10/core/weapons/testbed';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import { BLAST } from '../../../src/a10/data/vehicles';
import { STORE_BODY, STORES } from '../../../src/a10/data/munitions';

type Released = Extract<SimEvent, { type: 'storeReleased' }>;
type Detonation = Extract<SimEvent, { type: 'detonation' }>;

function bed(seed = 1, loadout: Record<number, string[]> = { 5: ['MK-82'], 7: ['MK-82'] }): Sim {
  return createGunTestbed({
    seed,
    terrain: createFlatTerrain(0),
    altitude: 1500,
    speed: 300 * KT,
    pathAngle: -30 * DEG,
    customLoadout: loadout as never,
  });
}

describe('the release queue (ARCHITECTURE §12.1)', () => {
  it('releases at the exact time inside the step, from the station (within a few cm at 300 kn)', () => {
    const sim = bed();
    const ac = sim.aircraft;
    // A release 0.37 of the way through the next step.
    const tRelease = sim.time + 0.37 * SIM_DT;
    queueRelease(sim, 5, 'MK-82', { time: tRelease });
    const p0 = ac.position.clone();
    stepKinematic(sim);
    const b = sim.projectiles.bodies[0];
    expect(b).toBeDefined();
    expect(b.releaseTime).toBeCloseTo(tRelease, 12);
    // Where the station was at that instant (the kinematic aircraft: constant velocity).
    const s = A10_GEOMETRY.stations[5]!;
    const station = new Vector3(s.x, s.y, s.z)
      .applyQuaternion(ac.orientation)
      .add(p0.clone().addScaledVector(ac.velocity, 0.37 * SIM_DT));
    // The body has flown on for the rest of the step: back it up along its start velocity.
    const start = b.position.clone().addScaledVector(b.velocity, -(1 - 0.37) * SIM_DT);
    expect(start.distanceTo(station)).toBeLessThan(0.03);
    // Its first position is the station point exactly (the view interpolates from it).
    expect(b.prevPosition.distanceTo(station)).toBeLessThan(1e-9);
    // The aircraft moves 1.29 m per step at 300 kn: a release at a step boundary would be off.
    expect(ac.velocity.length() * SIM_DT).toBeGreaterThan(1.2);
  });

  it('future requests wait; overdue ones go at the step start; the earliest goes first', () => {
    const sim = bed();
    const t0 = sim.time;
    queueRelease(sim, 7, 'MK-82', { time: t0 + 0.5 });
    queueRelease(sim, 5, 'MK-82', { time: t0 - 1 });
    stepKinematic(sim);
    expect(sim.projectiles.bodies).toHaveLength(1);
    expect(sim.projectiles.bodies[0].station).toBe(5);
    expect(sim.projectiles.bodies[0].releaseTime).toBe(t0);
    expect(sim.stores.releaseQueue).toHaveLength(1);
    runKinematic(sim, 0.5);
    expect(sim.stores.releaseQueue).toHaveLength(0);
    const rel = sim.events.filter((e): e is Released => e.type === 'storeReleased');
    expect(rel.map((e) => e.station)).toEqual([5, 7]);
    expect(rel[1].t).toBeCloseTo(t0 + 0.5, 12);
  });

  it('the store leaves its station; mass, drag and moments fall; storeReleased names the body', () => {
    const sim = bed(1, { 5: ['MK-82'], 9: ['TER-9A', 'MK-82', 'MK-82'] });
    const st = sim.stores;
    const before = { ...st };
    queueRelease(sim, 9, 'MK-82');
    stepKinematic(sim);
    expect(st.stations[8].rack).toBe('TER-9A');
    expect(st.stations[8].stores).toEqual(['MK-82']);
    expect(st.mass).toBeCloseTo(before.mass - STORES['MK-82'].mass, 9);
    expect(st.dragArea).toBeCloseTo(before.dragArea - STORES['MK-82'].dragArea, 12);
    const x9 = A10_GEOMETRY.stations[9]!.x;
    expect(st.lateralMoment).toBeCloseTo(before.lateralMoment - STORES['MK-82'].mass * x9, 6);
    expect(st.rollInertia!).toBeCloseTo(before.rollInertia! - STORES['MK-82'].mass * x9 * x9, 6);
    expect(st.dragMoment!).toBeCloseTo(before.dragMoment! - STORES['MK-82'].dragArea * x9, 9);
    const e = sim.events.find((x): x is Released => x.type === 'storeReleased')!;
    expect(e.station).toBe(9);
    expect(e.store).toBe('MK-82');
    expect(e.bodyId).toBe(sim.projectiles.bodies[0].id);
    expect(sim.events.some((x) => x.type === 'motorIgnition')).toBe(false);
    // The flight model feels it (the flight step runs updateMassProperties every step).
    const mass = sim.aircraft.mass;
    updateMassProperties(sim);
    expect(mass - sim.aircraft.mass).toBeCloseTo(STORES['MK-82'].mass, 3);
  });

  it('a request whose station no longer holds its store is dropped with a message', () => {
    const sim = bed();
    queueRelease(sim, 5, 'MK-82');
    queueRelease(sim, 5, 'MK-82', { time: sim.time + 0.001 });
    queueRelease(sim, 2, 'MK-82');
    queueRelease(sim, 7, 'AGM-65D');
    stepKinematic(sim);
    expect(sim.projectiles.bodies).toHaveLength(1);
    const messages = sim.events.filter((e) => e.type === 'message');
    expect(messages).toHaveLength(3);
    expect(sim.stores.releaseQueue).toHaveLength(0);
  });

  it('unlimited stores (relaxed preset): the store flies and stays on its station', () => {
    const sim = createGunTestbed({
      terrain: createFlatTerrain(0),
      altitude: 1500,
      speed: 300 * KT,
      realism: 'relaxed',
      customLoadout: { 4: ['LAU-131-M151'], 5: ['MK-82'] },
    });
    const mass = sim.stores.mass;
    queueRelease(sim, 5, 'MK-82');
    queueRelease(sim, 4, 'LAU-131-M151', { delivery: 'ROCKET' });
    stepKinematic(sim);
    expect(sim.projectiles.bodies).toHaveLength(2);
    expect(sim.stores.stations[4].stores).toEqual(['MK-82']);
    expect(sim.stores.stations[3].rockets).toBe(7);
    expect(sim.stores.mass).toBe(mass);
  });

  it('a body starts with its aim, fuze and arming from the request', () => {
    const sim = bed();
    const aim = new Vector3(10, 0, -1500);
    queueRelease(sim, 5, 'MK-82', { aim, aimValid: true, fuze: 'TAIL', armingTime: 4 });
    stepKinematic(sim);
    const b = sim.projectiles.bodies[0];
    expect(b.kind).toBe('bomb');
    expect(b.aim.equals(aim)).toBe(true);
    expect(b.aimValid).toBe(true);
    expect(b.fuze).toBe('TAIL');
    expect(b.armingTime).toBe(4);
    expect(b.armed).toBe(false);
    expect(b.alive).toBe(true);
    expect(b.flight!.key).toBe('MK-82');
    runKinematic(sim, 4.1);
    expect(b.armed).toBe(true);
  });
});

describe('weapon records (ARCHITECTURE §12.6)', () => {
  it('opened at the release with its conditions and completed at the impact', () => {
    const sim = bed();
    const pred = createImpactPrediction();
    predictStoreRelease(sim, 5, 'MK-82', pred);
    // Aim 20 m short of where the bomb will land: the miss is 20 m long, 12 o'clock.
    const aim = pred.point.clone().add(new Vector3(0, 0, 20));
    queueRelease(sim, 5, 'MK-82', { aim, aimValid: true, armingTime: 4 });
    stepKinematic(sim);
    const r = sim.debrief.weapons[0];
    expect(r.store).toBe('MK-82');
    expect(r.weapon).toBe('MK-82');
    expect(r.station).toBe(5);
    expect(r.delivery).toBe('CCIP');
    expect(r.simulated).toBe(false);
    expect(r.bodyId).toBe(sim.projectiles.bodies[0].id);
    expect(r.aimValid).toBe(true);
    expect(Number.isNaN(r.impactTime)).toBe(true);
    expect(r.release.dive).toBeCloseTo(30 * DEG, 6);
    expect(r.release.speed).toBeCloseTo(300 * KT, 6);
    expect(r.release.agl).toBeCloseTo(1500, 6);
    expect(r.release.slantRange).toBeGreaterThan(2000);
    runUntilLanded(sim);
    const det = sim.events.find((e): e is Detonation => e.type === 'detonation')!;
    expect(r.impactTime).toBeCloseTo(det.t, 12);
    expect(r.missDistance).toBeCloseTo(20, 0);
    expect(r.missClock).toBe(12);
    expect(r.dud).toBe(false);
    expect(r.fragmentWarning).toBe(false);
  });

  it('the miss clock: 12 long on the run-in, 6 short, 3 right, 9 left', () => {
    // Run-in heading east (π/2): long is +x, right is +z (south).
    const east = Math.PI / 2;
    expect(missClock(30, 0, east)).toBe(12);
    expect(missClock(-30, 0, east)).toBe(6);
    expect(missClock(0, 30, east)).toBe(3);
    expect(missClock(0, -30, east)).toBe(9);
    expect(missClock(20, 20, east)).toBe(2);
    expect(missClock(0, -30, 0)).toBe(12);
  });

  it('flags a release inside the fragment envelope (≈350 m for a Mk 82)', () => {
    const env = fragmentEnvelope(BLAST.mk82ChargeKg, BLAST.mk82FragmentKg);
    expect(env).toBeGreaterThan(250);
    expect(env).toBeLessThan(450);
    // A level release at 100 m and 300 kn: the aircraft is ≈100 m over the burst.
    const low = createGunTestbed({
      terrain: createFlatTerrain(0),
      altitude: 100,
      speed: 300 * KT,
      customLoadout: { 5: ['MK-82'] },
    });
    queueRelease(low, 5, 'MK-82', { armingTime: 0 });
    runUntilLanded(low);
    expect(low.debrief.weapons[0].fragmentWarning).toBe(true);
    // From 1,500 m in a 30° dive the aircraft is 2 km away when it bursts.
    const high = bed();
    queueRelease(high, 5, 'MK-82', { armingTime: 4 });
    runUntilLanded(high);
    expect(high.debrief.weapons[0].fragmentWarning).toBe(false);
  });
});

describe('jettison and rearm (ARCHITECTURE §4, §12.1)', () => {
  it('jettisoned stations fall as unarmed bodies (one per station) and land as duds', () => {
    const sim = createGunTestbed({
      terrain: createFlatTerrain(0),
      altitude: 800,
      speed: 250 * KT,
      loadoutId: 'tankHunter',
    });
    const before = sim.stores.mass;
    expect(jettisonStores(sim, 'all')).toBe(7);
    const rel = sim.events.filter((e): e is Released => e.type === 'storeReleased');
    expect(rel).toHaveLength(7);
    const bodies = sim.projectiles.bodies;
    expect(bodies).toHaveLength(7);
    expect(rel.map((e) => e.bodyId)).toEqual(bodies.map((b) => b.id));
    // The LAU-88 leaves with both its Mavericks; the rocket pod with its rockets.
    const lau88 = bodies.find((b) => b.station === 3)!;
    expect(lau88.type).toBe('LAU-88');
    expect(lau88.carried).toEqual(['AGM-65D', 'AGM-65D']);
    expect(lau88.mass).toBeCloseTo(STORES['LAU-88'].mass + 2 * STORES['AGM-65D'].mass, 6);
    const pod = bodies.find((b) => b.station === 2)!;
    expect(pod.rockets).toBe(7);
    expect(pod.kind).toBe('bomb');
    expect(bodies.every((b) => b.delivery === 'JETTISON' && !b.armed)).toBe(true);
    // Pods and the AIM-9 rails stay.
    const left = sim.stores.stations.filter((s) => s.rack || s.stores.length > 0);
    expect(left.map((s) => s.station)).toEqual([1, 10, 11]);
    expect(sim.stores.mass).toBeLessThan(before);
    runUntilLanded(sim);
    const dets = sim.events.filter((e): e is Detonation => e.type === 'detonation');
    expect(dets).toHaveLength(7);
    expect(dets.every((d) => d.kind === 'dud' && d.charge === 0)).toBe(true);
    expect(sim.debrief.weapons.every((r) => r.delivery === 'JETTISON' && r.dud)).toBe(true);
  });

  it('a JETTISON request drops its station at its time', () => {
    const sim = bed(1, { 5: ['MK-82'], 9: ['TER-9A', 'MK-82', 'MK-82'] });
    queueRelease(sim, 9, 'TER-9A', { delivery: 'JETTISON', time: sim.time + 0.5 * SIM_DT });
    stepKinematic(sim);
    expect(sim.stores.stations[8].rack).toBeNull();
    expect(sim.stores.stations[8].stores).toEqual([]);
    const b = sim.projectiles.bodies[0];
    expect(b.carried).toEqual(['MK-82', 'MK-82']);
    expect(b.releaseTime).toBeCloseTo(0.5 * SIM_DT, 12);
  });

  it('rearm refills the pods, clears the queue and leaves the bodies in flight', () => {
    const sim = bed(1, { 4: ['LAU-131-M151'], 5: ['MK-82'] });
    queueRelease(sim, 4, 'LAU-131-M151', { delivery: 'ROCKET' });
    queueRelease(sim, 5, 'MK-82');
    queueRelease(sim, 4, 'LAU-131-M151', { delivery: 'ROCKET', time: 5 });
    stepKinematic(sim);
    expect(sim.stores.stations[3].rockets).toBe(6);
    rearm(sim);
    expect(sim.stores.stations[3].rockets).toBe(7);
    expect(sim.stores.stations[4].stores).toEqual(['MK-82']);
    expect(sim.stores.releaseQueue).toHaveLength(0);
    expect(sim.projectiles.bodies).toHaveLength(2);
  });
});

describe('the fire-control computer flies the same models (PLAN §6.1 rule 2)', () => {
  it('every unguided store is registered: integrate is the live integrator', () => {
    for (const key of REGISTERED_STORE_KEYS) {
      const reg = storeBallistics(key);
      const own = storeModel(key);
      expect(reg, key).not.toBeNull();
      expect(own, key).not.toBeNull();
      // The very same object: the live bodies fly own.spec with integrateStore.
      expect(reg).toBe(own);
      const p1 = new Vector3(0, 1000, 0);
      const v1 = new Vector3(0, -50, -150);
      const p2 = p1.clone();
      const v2 = v1.clone();
      const w = new Vector3(3, 0, 1);
      for (let k = 0; k < 50; k++) {
        reg!.integrate(p1, v1, w, 0.05, k * 0.05);
        integrateStore(own!.spec, p2, v2, w, 0.05, k * 0.05);
      }
      expect(p1.equals(p2), key).toBe(true);
      expect(v1.equals(v2), key).toBe(true);
    }
    expect(storeModel('MK-82AIR/HD')!.spec.balluteArea).toBeGreaterThan(0);
    expect(storeModel('MK-82')!.spec.balluteArea).toBe(0);
  });

  it('the ejection the computer adds is the live release’s', () => {
    const sim = bed();
    const model = storeModel('MK-82')!;
    // A bomb: ≈6 m/s down the pylon normal (20 ft/s for a 500-lb store).
    expect(Math.hypot(model.ejection.x, model.ejection.y, model.ejection.z)).toBeCloseTo(
      20 * FT,
      2,
    );
    expect(model.ejection.y).toBeLessThan(-6);
    const rocket = storeModel('LAU-131-M151')!;
    expect(rocket.ejection.z).toBeLessThan(-40);
    const q = new Quaternion().copy(sim.aircraft.orientation);
    queueRelease(sim, 5, 'MK-82');
    stepKinematic(sim);
    const b = sim.projectiles.bodies[0];
    const expected = new Vector3(model.ejection.x, model.ejection.y, model.ejection.z)
      .applyQuaternion(q)
      .add(sim.aircraft.velocity);
    // The start velocity, one step of drag and gravity later.
    expect(b.velocity.distanceTo(expected)).toBeLessThan(0.2);
  });

  it('the predictor step stays within 0.5 m of the live integration over typical deliveries', () => {
    const shots: CalibrationShot[] = [];
    for (const [dive, h, kt] of [
      [30, 1500, 300],
      [45, 2500, 350],
      [10, 600, 400],
      [0, 5000 * FT, 300],
      [0, 300 * FT, 450],
    ] as const) {
      const v = kt * KT;
      shots.push({
        origin: { x: 0, y: h, z: 0 },
        velocity: { x: 0, y: -Math.sin(dive * DEG) * v, z: -Math.cos(dive * DEG) * v },
        wind: { x: 7.7, y: 0, z: 0 },
        groundHeight: 0,
      });
    }
    const rocketShots: CalibrationShot[] = [10, 20, 30].map((dive) => ({
      origin: { x: 0, y: 700, z: 0 },
      velocity: {
        x: 0,
        y: -Math.sin(dive * DEG) * (300 * KT + 45),
        z: -Math.cos(dive * DEG) * (300 * KT + 45),
      },
      wind: { x: 7.7, y: 0, z: 0 },
      groundHeight: 0,
    }));
    for (const key of REGISTERED_STORE_KEYS) {
      const model = storeModel(key)!;
      const rocket = model.launch === 'tube';
      const list = rocket ? rocketShots : shots;
      const dt = model.dt!;
      expect(dt).toBe(rocket ? STORE_BODY.predictorStepRocket : STORE_BODY.predictorStepBomb);
      // Angular error from the release point, as the avionics calibration measures it…
      const err = stepError(model, list, dt, SIM_DT);
      expect(err, key).toBeLessThan(FIRE_CONTROL.predictorTolerance);
      // …and in metres on the ground: the slant ranges are at most ≈3.5 km.
      expect(err * 3500, key).toBeLessThan(0.5);
    }
  });
});

describe('determinism and allocation (PLAN §14, ARCHITECTURE §3)', () => {
  function mixedRun(seed: number) {
    const sim = bed(seed, { 4: ['LAU-131-M151'], 5: ['MK-82'], 7: ['MK-82AIR'] });
    sim.world.surfaceWind.set(3, 0, -1);
    for (let k = 0; k < 7; k++) {
      queueRelease(sim, 4, 'LAU-131-M151', {
        time: 0.07 * k,
        delivery: 'ROCKET',
        armingTime: 1.1,
      });
    }
    queueRelease(sim, 5, 'MK-82', { time: 0.3, armingTime: 4 });
    queueRelease(sim, 7, 'MK-82AIR', { time: 0.31, highDrag: true, armingTime: 2.6 });
    runUntilLanded(sim);
    return JSON.stringify(sim.events) + JSON.stringify(sim.debrief.weapons);
  }

  it('the same seed gives the same releases, flights and impacts', () => {
    const a = mixedRun(7);
    expect(a).toContain('"rocket"');
    expect(mixedRun(7)).toBe(a);
    // Rocket dispersion draws from rng.weapons: another seed lands elsewhere.
    expect(mixedRun(8)).not.toBe(a);
  });

  it('a 10-minute flight with 50 releases reuses its bodies: no allocation per step', () => {
    const sim = createGunTestbed({
      terrain: createFlatTerrain(0),
      altitude: 1500,
      speed: 300 * KT,
      customLoadout: { 4: ['LAU-131-M151'], 5: ['MK-82'], 8: ['LAU-131-M151'] },
    });
    const ps = sim.projectiles;
    const bodies = ps.bodies;
    const pool = ps.bodyPool;
    const seen = new Set<StoreBody>(pool);
    const vectors = new Set<object>();
    for (const b of pool) vectors.add(b.position).add(b.velocity).add(b.orientation);
    let releases = 0;
    let maxInFlight = 0;
    const steps = Math.round(600 / SIM_DT);
    for (let k = 0; k < steps; k++) {
      // A release every 12 s (alternating a rocket, a bomb, a rocket), refilled each time.
      if (k % Math.round(12 / SIM_DT) === 0 && releases < 50) {
        // Back to the south of the range for each run-in (the test bed flies a straight line).
        sim.aircraft.position.set(0, 1500, 25000);
        sim.aircraft.prevPosition.copy(sim.aircraft.position);
        const st = sim.stores.stations;
        st[3].rockets = 7;
        st[7].rockets = 7;
        if (st[4].stores.length === 0) st[4].stores.push('MK-82');
        const which = releases % 3;
        if (which === 1) queueRelease(sim, 5, 'MK-82', { armingTime: 4 });
        else queueRelease(sim, which === 0 ? 4 : 8, 'LAU-131-M151', { delivery: 'ROCKET' });
        releases++;
      }
      stepKinematic(sim);
      maxInFlight = Math.max(maxInFlight, bodies.length);
      for (const b of bodies) {
        if (!seen.has(b)) seen.add(b);
      }
    }
    // The last bomb, released at 588 s, is still falling: let it land.
    runUntilLanded(sim, 60, () => {
      for (const b of bodies) seen.add(b);
    });
    expect(releases).toBe(50);
    expect(sim.debrief.weapons).toHaveLength(50);
    expect(sim.events.filter((e) => e.type === 'detonation')).toHaveLength(50);
    // The same arrays, and no body or vector objects beyond the pool made at the start.
    expect(ps.bodies).toBe(bodies);
    expect(ps.bodyPool).toBe(pool);
    expect(seen.size).toBe(STORE_BODY.poolSize);
    for (const b of seen) {
      expect(vectors.has(b.position)).toBe(true);
      expect(vectors.has(b.velocity)).toBe(true);
      expect(vectors.has(b.orientation)).toBe(true);
    }
    expect(maxInFlight).toBeGreaterThan(0);
    expect(bodies.length + pool.length).toBe(STORE_BODY.poolSize);
  });
});
