/**
 * Hydra 70 rockets (PLAN_A10.md §6.7, §16 row Rockets; ARCHITECTURE §12.2): the Mk 66 motor
 * (burn-out speed and burn time from a static launch), turning into a crosswind during the burn,
 * single and ripple fire from a pod that stays, launch dispersion, warheads and the predictor.
 * Fixtures: the weapons kinematic test bed over flat ground.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createImpactPrediction } from '../../../src/a10/core/avionics';
import { SIM_DT } from '../../../src/a10/core/constants';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { DEG, KT } from '../../../src/a10/core/units';
import { motorThrustAt, rearm, storeModel, type StoreType } from '../../../src/a10/core/weapons';
import {
  createGunTestbed,
  predictStoreRelease,
  queueRelease,
  runUntilLanded,
  stepKinematic,
} from '../../../src/a10/core/weapons/testbed';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { HYDRA70, MK66, STORES, WARHEADS } from '../../../src/a10/data/munitions';

type Detonation = Extract<SimEvent, { type: 'detonation' }>;
const detonations = (sim: Sim): Detonation[] =>
  sim.events.filter((e): e is Detonation => e.type === 'detonation');

const POD: StoreType = 'LAU-131-M151';

function bed(opts: {
  height: number;
  speedKt: number;
  diveDeg?: number;
  pod?: StoreType;
  seed?: number;
}): Sim {
  return createGunTestbed({
    seed: opts.seed ?? 1,
    terrain: createFlatTerrain(0),
    altitude: opts.height,
    speed: opts.speedKt * KT,
    pathAngle: -(opts.diveDeg ?? 0) * DEG,
    customLoadout: { 4: [opts.pod ?? POD] },
  });
}

describe('Mk 66 motor (PLAN §16): static launch', () => {
  /** One rocket from a stationary launcher 50 m above sea-level ground, flown to burn-out. */
  function staticLaunch() {
    const sim = bed({ height: 50, speedKt: 0 });
    queueRelease(sim, 4, POD, { delivery: 'ROCKET', armingTime: 1.1 });
    stepKinematic(sim);
    const b = sim.projectiles.bodies[0];
    const spec = b.flight!;
    let burnout = -1;
    for (let k = 0; k < 240 && burnout < 0; k++) {
      stepKinematic(sim);
      if (b.motorTime <= 0) burnout = sim.time - b.releaseTime;
    }
    return { b, spec, burnout, speed: b.velocity.length() };
  }

  it('burns out at 739 m/s ± 3 %', () => {
    const { speed } = staticLaunch();
    // Measured: 737.6 m/s.
    expect(Math.abs(speed / HYDRA70.burnoutSpeed - 1)).toBeLessThan(0.03);
  });

  it('burns for 1.05–1.10 s (the in-tube burn included) and loses its propellant', () => {
    const { b, spec, burnout } = staticLaunch();
    // The rocket leaves the 1.5 m tube 0.074 s after ignition at ≈45 m/s.
    expect(spec.motorOffset).toBeGreaterThan(0.05);
    expect(spec.motorOffset).toBeLessThan(0.1);
    const burn = burnout + spec.motorOffset;
    expect(burn).toBeGreaterThanOrEqual(1.05);
    expect(burn).toBeLessThanOrEqual(1.1 + SIM_DT);
    expect(spec.motor!.burnTime).toBe(MK66.burnTime);
    expect(spec.motor!.totalImpulse).toBeCloseTo(MK66.totalImpulse, 6);
    // Average thrust ≈6.29 kN; the mass falls by the propellant burnt.
    expect(spec.motor!.totalImpulse / spec.motor!.burnTime).toBeCloseTo(MK66.averageThrust, -2);
    expect(motorThrustAt(spec.motor!, 0.5)).toBeGreaterThan(5900);
    expect(b.mass).toBeCloseTo(
      STORES[POD].rocketMass! - MK66.propellantMass,
      6,
    );
  });
});

describe('Rockets in a crosswind (PLAN §6.7): the fins turn the rocket into the wind', () => {
  it('during the burn the rocket moves upwind; after it the wind carries it back', () => {
    const run = (windX: number) => {
      const sim = bed({ height: 600, speedKt: 300, diveDeg: 10, seed: 5 });
      sim.world.surfaceWind.set(windX, 0, 0);
      queueRelease(sim, 4, POD, { delivery: 'ROCKET', armingTime: 1.1 });
      stepKinematic(sim);
      const b = sim.projectiles.bodies[0];
      const x0 = b.position.x;
      let atBurnout = NaN;
      let vxBurnout = NaN;
      let later = NaN;
      for (let k = 0; k < 360 && sim.projectiles.bodies.length > 0; k++) {
        stepKinematic(sim);
        if (Number.isNaN(atBurnout) && b.motorTime <= 0) {
          atBurnout = b.position.x - x0;
          vxBurnout = b.velocity.x;
        }
        if (sim.time - b.releaseTime > 3 && Number.isNaN(later)) later = b.velocity.x;
      }
      return { atBurnout, vxBurnout, later };
    };
    // Wind blowing toward +x (from the west, across a northbound run).
    const calm = run(0);
    const windy = run(8);
    // Into the wind (−x) during the burn.
    expect(windy.atBurnout - calm.atBurnout).toBeLessThan(-1);
    expect(windy.vxBurnout - calm.vxBurnout).toBeLessThan(-5);
    // After burn-out the drag slows the upwind drift (the wind pushes it back).
    expect(windy.later - calm.later).toBeGreaterThan(windy.vxBurnout - calm.vxBurnout);
  });
});

describe('Pods (PLAN §6.7, §6.8): single and ripple fire', () => {
  it('a ripple of 7 empties the pod; the pod stays and gets lighter', () => {
    const sim = bed({ height: 1500, speedKt: 300, diveDeg: 20 });
    const st = sim.stores.stations[3];
    expect(st.rockets).toBe(7);
    const full = sim.stores.mass;
    for (let k = 0; k < 8; k++) {
      queueRelease(sim, 4, POD, { time: sim.time + 0.06 * k, delivery: 'ROCKET', armingTime: 1.1 });
    }
    for (let k = 0; k < 60; k++) stepKinematic(sim);
    expect(st.rockets).toBe(0);
    expect(st.stores).toEqual([POD]);
    expect(sim.stores.mass).toBeCloseTo(full - 7 * STORES[POD].rocketMass!, 6);
    const released = sim.events.filter((e) => e.type === 'storeReleased');
    const ignitions = sim.events.filter((e) => e.type === 'motorIgnition');
    expect(released).toHaveLength(7);
    expect(ignitions).toHaveLength(7);
    // The eighth press finds the pod empty.
    expect(sim.events.some((e) => e.type === 'message' && /NO ROCKETS/.test(e.text))).toBe(true);
    // Released at their exact times, 60 ms apart.
    const times = released.map((e) => e.t);
    for (let k = 1; k < times.length; k++) expect(times[k] - times[k - 1]).toBeCloseTo(0.06, 9);
    runUntilLanded(sim);
    expect(detonations(sim)).toHaveLength(7);
    expect(detonations(sim).every((d) => d.kind === 'rocket')).toBe(true);
    // Rearm fills the pod again.
    rearm(sim);
    expect(st.rockets).toBe(7);
    expect(sim.stores.mass).toBeCloseTo(full, 6);
  });

  it('warheads: M151 high explosive, M156 white phosphorus; a rocket that hits before arming is a dud', () => {
    const fire = (pod: StoreType, armingTime: number) => {
      const sim = bed({ height: 400, speedKt: 300, diveDeg: 20, pod });
      queueRelease(sim, 4, pod, { delivery: 'ROCKET', armingTime });
      runUntilLanded(sim);
      return detonations(sim)[0];
    };
    const he = fire('LAU-131-M151', 1.1);
    expect(he.kind).toBe('rocket');
    expect(he.charge).toBe(WARHEADS['LAU-131-M151']!.charge);
    const wp = fire('LAU-68-M156', 1.1);
    expect(wp.kind).toBe('whitePhosphorus');
    expect(wp.charge).toBe(WARHEADS['LAU-68-M156']!.charge);
    // 400 m above the ground at 20°: the rocket arrives in under 1.5 s.
    const dud = fire('LAU-131-M151', 5);
    expect(dud.kind).toBe('dud');
    expect(dud.charge).toBe(0);
  });

  it('launch dispersion: σ ≈ 3.5 mrad per axis about the predicted impact', () => {
    // The same launch from 140 test beds with different seeds (sim.rng.weapons draws).
    const across: number[] = [];
    let range = 0;
    for (let seed = 1; seed <= 140; seed++) {
      const sim = bed({ height: 800, speedKt: 300, diveDeg: 15, seed });
      const pred = createImpactPrediction();
      expect(predictStoreRelease(sim, 4, POD, pred)).toBe(true);
      range = sim.aircraft.position.distanceTo(pred.point);
      queueRelease(sim, 4, POD, { delivery: 'ROCKET', armingTime: 1.1 });
      runUntilLanded(sim);
      const r = sim.debrief.weapons[0];
      // Across the line of fire (x: the run is northbound).
      across.push(r.impact.x - pred.point.x);
    }
    const mean = across.reduce((s, x) => s + x, 0) / across.length;
    const sd = Math.sqrt(across.reduce((s, x) => s + (x - mean) ** 2, 0) / (across.length - 1));
    // The angular spread across the line of fire is the dispersion itself (measured ≈3.5 mrad).
    expect(sd / range).toBeGreaterThan(MK66.dispersion * 0.8);
    expect(sd / range).toBeLessThan(MK66.dispersion * 1.25);
    // Unbiased: the mean lies on the pipper.
    expect(Math.abs(mean)).toBeLessThan((3 * sd) / Math.sqrt(across.length));
  });
});

describe('Rocket fire control (PLAN §6.1 rule 2)', () => {
  it('the CCIP rocket pipper: the mean impact of the live rockets lies on the predicted point', () => {
    const sim = bed({ height: 600, speedKt: 300, diveDeg: 15, seed: 2 });
    sim.world.surfaceWind.set(4, 0, -2);
    const pred = createImpactPrediction();
    expect(predictStoreRelease(sim, 4, POD, pred)).toBe(true);
    const model = storeModel(POD)!;
    expect(model.dt).toBeGreaterThan(SIM_DT);
    // One rocket with its dispersion lands within a few mrad of the pipper.
    const from = sim.aircraft.position.clone();
    queueRelease(sim, 4, POD, { delivery: 'ROCKET', armingTime: 1.1 });
    runUntilLanded(sim);
    const r = sim.debrief.weapons[0];
    const impact = new Vector3(r.impact.x, r.impact.y, r.impact.z);
    expect(impact.distanceTo(pred.point) / from.distanceTo(pred.point)).toBeLessThan(
      5 * MK66.dispersion,
    );
  });
});
