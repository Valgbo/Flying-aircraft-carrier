/**
 * Flight systems: warnings (altitude, PULL UP prediction, fuel), ground contact, mass and CG,
 * engines (fuel, flame-out, igniters), turbulence, and the module contract (prev* state, external
 * forces applied once, full-sim stepping with the other modules' current code).
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { A10, A10_AERO, A10_MASS, A10_WARNINGS } from '../../../src/a10/data/aircraft';
import { G0, SIM_DT } from '../../../src/a10/core/constants';
import { createSim, runSim } from '../../../src/a10/core/sim';
import {
  predictRecoveryClearance,
  setAltitudeAlert,
  stepFlight,
  updateMassProperties,
} from '../../../src/a10/core/flight';
import { createTestbed, runFlightOnly, stepFlightOnly } from '../../../src/a10/core/flight/testbed';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { createFlatTerrain, gustAt, gustScales, windAt } from '../../../src/a10/core/world';

/** Generous timeout for flights of a minute or more (the CI machine may be loaded). */
const LONG = 60_000;
const KT = 0.514444;
const DEG = Math.PI / 180;

function warningEvents(sim: Sim, id: string): Extract<SimEvent, { type: 'warning' }>[] {
  return sim.events.filter(
    (e): e is Extract<SimEvent, { type: 'warning' }> => e.type === 'warning' && e.warning === id,
  );
}

/**
 * Hold a load factor with the stick: feed-forward from the elevator power (static g per unit
 * stick) plus an integrator, as a pilot would pull.
 */
function pullTo(n: number) {
  let base = NaN;
  let n0 = 1;
  let integ = 0;
  return (sim: Sim) => {
    const ac = sim.aircraft;
    if (Number.isNaN(base)) {
      base = sim.input.pitch;
      n0 = ac.gLoad;
    }
    const ke =
      ((A10_AERO.cmElevator * A10_AERO.elevatorMax) / -A10_AERO.cmAlpha) *
      A10_AERO.clAlpha *
      ((ac.dynamicPressure * A10.wingArea) / (ac.mass * G0));
    integ += 1.5 * (n - ac.gLoad) * SIM_DT;
    sim.input.pitch = Math.max(-1, Math.min(1, base + (n - n0 + integ) / ke));
  };
}

describe('warnings', () => {
  it(
    'altitude alert: on while descending below the setting, with events',
    () => {
      const sim = createTestbed({
        altitude: 400,
        groundHeight: 0,
        ias: 250 * KT,
        gamma: -5 * DEG,
        throttle: 0.5,
      });
      setAltitudeAlert(sim, 300);
      expect(sim.aircraft.altitudeAlert).toBe(300);
      let onAt = -1;
      runFlightOnly(sim, 15, (s) => {
        if (onAt < 0 && s.aircraft.warnings.altitude) onAt = s.aircraft.agl;
      });
      expect(onAt).toBeGreaterThan(280);
      expect(onAt).toBeLessThan(300);
      expect(warningEvents(sim, 'altitude').some((e) => e.on)).toBe(true);
    },
    LONG,
  );

  it(
    'PULL UP: a steep dive at the ground warns in time for a real recovery',
    () => {
      // 30° dive at 350 kn from 1,000 m: the warning must come early enough that a 5 g pull
      // started 1 s after it (pilot reaction) still clears the ground.
      const sim = createTestbed({
        altitude: 1000,
        groundHeight: 0,
        ias: 350 * KT,
        gamma: -30 * DEG,
        throttle: 0.3,
      });
      let warnedAt = -1;
      let warnedAgl = 0;
      let pull: ((s: Sim) => void) | null = null;
      let minAgl = Infinity;
      runFlightOnly(sim, 25, (s) => {
        const ac = s.aircraft;
        if (warnedAt < 0 && ac.warnings.pullUp) {
          warnedAt = s.time;
          warnedAgl = ac.agl;
        }
        if (warnedAt >= 0 && s.time > warnedAt + 1 && !pull) pull = pullTo(5);
        if (pull) pull(s);
        minAgl = Math.min(minAgl, ac.agl);
      });
      console.log(
        `[flight] PULL UP at ${warnedAgl.toFixed(0)} m AGL (30° dive, 350 kn); 5 g pull 1 s later bottoms out at ${minAgl.toFixed(0)} m`,
      );
      expect(warnedAt).toBeGreaterThan(0);
      expect(sim.aircraft.crashed).toBe(false);
      expect(minAgl).toBeGreaterThan(5);
      // Not a nuisance: it does not sound at the start of the dive.
      expect(warnedAgl).toBeLessThan(800);
    },
    LONG,
  );

  it(
    'PULL UP stays quiet in level flight near the ground and clears after the recovery',
    () => {
      const sim = createTestbed({ altitude: 150, groundHeight: 0, ias: 300 * KT });
      runFlightOnly(sim, 5);
      expect(sim.aircraft.warnings.pullUp).toBe(false);
      expect(predictRecoveryClearance(sim)).toBeGreaterThan(100);
    },
    LONG,
  );

  it(
    'low fuel and master caution',
    () => {
      const sim = createTestbed({ altitude: 2000, ias: 250 * KT });
      sim.aircraft.fuel = A10_WARNINGS.lowFuel - 10;
      stepFlightOnly(sim);
      expect(sim.aircraft.warnings.lowFuel).toBe(true);
      expect(sim.aircraft.warnings.masterCaution).toBe(true);
      expect(warningEvents(sim, 'lowFuel').length).toBe(1);
    },
    LONG,
  );
});

describe('ground contact', () => {
  it(
    'flying into the ground ends the flight with a crash event',
    () => {
      const sim = createTestbed({
        altitude: 60,
        groundHeight: 0,
        ias: 250 * KT,
        gamma: -10 * DEG,
        throttle: 0.5,
      });
      runFlightOnly(sim, 6);
      const crash = sim.events.find((e) => e.type === 'crash');
      expect(sim.aircraft.crashed).toBe(true);
      expect(crash).toBeDefined();
      expect(crash && crash.type === 'crash' && crash.reason).toBe('terrain');
      const p = sim.aircraft.position.clone();
      runFlightOnly(sim, 1);
      expect(sim.aircraft.position.distanceTo(p)).toBe(0);
    },
    LONG,
  );

  it(
    'a wing tip strikes first in a steep bank close to the ground',
    () => {
      const sim = createTestbed({ altitude: 8.5, groundHeight: 0, ias: 250 * KT });
      sim.aircraft.orientation.setFromAxisAngle({ x: 0, y: 0, z: 1 } as never, -80 * DEG);
      stepFlight(sim, SIM_DT);
      expect(sim.aircraft.crashed).toBe(true);
    },
    LONG,
  );

  it(
    'water impacts say so',
    () => {
      const flat = createFlatTerrain(0);
      const terrain = { ...flat, surfaceAt: () => 'water' as const };
      const sim = createSim({
        terrain,
        scenario: 'empty',
        start: { x: 0, z: 0, agl: 30, heading: 0, speed: 120 },
      });
      sim.aircraft.velocity.set(0, -40, -100);
      runFlightOnly(sim, 3);
      const crash = sim.events.find((e) => e.type === 'crash');
      expect(crash && crash.type === 'crash' && crash.reason).toBe('water');
    },
    LONG,
  );

  it(
    'invulnerable (Relaxed preset): bounces off and flies on',
    () => {
      const sim = createTestbed({
        altitude: 60,
        groundHeight: 0,
        ias: 250 * KT,
        gamma: -10 * DEG,
        throttle: 0.6,
        realism: 'relaxed',
      });
      runFlightOnly(sim, 6);
      expect(sim.aircraft.crashed).toBe(false);
      expect(sim.events.some((e) => e.type === 'message' && e.text === 'GROUND CONTACT')).toBe(
        true,
      );
      expect(sim.aircraft.position.y).toBeGreaterThan(-1);
      expect(sim.events.some((e) => e.type === 'crash')).toBe(false);
    },
    LONG,
  );
});

describe('mass, CG and inertia', () => {
  it(
    'adds fuel, rounds (cases kept after firing) and stores; burns fuel',
    () => {
      const sim = createTestbed({ altitude: 2000, ias: 250 * KT });
      const ac = sim.aircraft;
      const expected = A10.emptyMass + A10_MASS.pilotMass + ac.fuel + 1150 * A10_MASS.roundMass;
      expect(ac.mass).toBeCloseTo(expected, 3);
      // Fire 100 rounds: projectiles and propellant leave, cases stay in the drum.
      sim.gun.rounds = 1050;
      updateMassProperties(sim);
      expect(expected - ac.mass).toBeCloseTo(
        100 * (A10_MASS.roundMass - A10_MASS.spentCaseMass),
        3,
      );
      const m0 = ac.mass;
      const fuel0 = ac.fuel;
      runFlightOnly(sim, 10);
      const burnt = fuel0 - ac.fuel;
      expect(burnt).toBeGreaterThan(0.5);
      expect(m0 - ac.mass).toBeCloseTo(burnt, 1);
      // Roughly 0.15–0.4 kg/s per engine at cruise power.
      expect(burnt / 10 / 2).toBeGreaterThan(0.1);
      expect(burnt / 10 / 2).toBeLessThan(0.5);
    },
    LONG,
  );

  it(
    'heavy stores lower the g limits; an asymmetric load moves the CG and rolls the aircraft',
    () => {
      const sim = createTestbed({ altitude: 2000, ias: 250 * KT });
      const ac = sim.aircraft;
      const ixx0 = ac.inertia.xx;
      sim.stores.mass = 3000;
      sim.stores.lateralMoment = 0;
      // Spread over the stations, ≈3.3 m from the centreline on average (Σm·x²).
      sim.stores.rollInertia = 3000 * 3.3 * 3.3;
      updateMassProperties(sim);
      expect(ac.gLimitPositive).toBeLessThan(A10.gLimitPositive);
      expect(ac.gLimitPositive).toBeGreaterThan(5);
      expect(ac.inertia.xx).toBeGreaterThan(ixx0 + 2e4);
      // 600 kg on the right wing tip station.
      const right = createTestbed({ altitude: 2000, ias: 250 * KT });
      right.stores.mass = 600;
      right.stores.lateralMoment = 600 * 5.9;
      right.stores.rollInertia = 600 * 5.9 * 5.9;
      updateMassProperties(right);
      expect(right.aircraft.cgBody.x).toBeGreaterThan(0.15);
      runFlightOnly(right, 4);
      expect(right.aircraft.bank).toBeGreaterThan(5 * DEG);
    },
    LONG,
  );
});

describe('stores drag', () => {
  it(
    'the stores drag area adds drag and costs speed',
    () => {
      const clean = createTestbed({ altitude: 1000, ias: 300 * KT, throttle: 0.8 });
      const loaded = createTestbed({ altitude: 1000, ias: 300 * KT, throttle: 0.8 });
      loaded.stores.dragArea = 1.5; // m², e.g. a few bombs and pods
      runFlightOnly(loaded, 0.05);
      runFlightOnly(clean, 0.05);
      const dcd = loaded.aircraft.dragCoefficient - clean.aircraft.dragCoefficient;
      expect(dcd).toBeCloseTo(1.5 / A10.wingArea, 3);
      runFlightOnly(clean, 20);
      runFlightOnly(loaded, 20);
      expect(loaded.aircraft.tas).toBeLessThan(clean.aircraft.tas - 3);
    },
    LONG,
  );
});

describe('engines', () => {
  it(
    'N1, N2, ITT and fuel flow rise with the lever; the igniters run with the trigger',
    () => {
      const sim = createTestbed({ altitude: 1000, ias: 250 * KT, throttle: 0 });
      runFlightOnly(sim, 10);
      const idle = { ...sim.aircraft.engines[0] };
      runFlightOnly(sim, 12, (s) => {
        s.input.throttle[0] = s.input.throttle[1] = 1;
        s.input.trigger = 1;
      });
      const max = sim.aircraft.engines[0];
      expect(idle.n2).toBeGreaterThan(0.55);
      expect(idle.n2).toBeLessThan(0.65);
      expect(max.n1).toBeGreaterThan(0.97);
      expect(max.itt).toBeGreaterThan(idle.itt + 200);
      expect(max.fuelFlow).toBeGreaterThan(idle.fuelFlow * 3);
      expect(max.thrust).toBeGreaterThan(idle.thrust + 20000);
      expect(max.igniters).toBe(true);
    },
    LONG,
  );

  it(
    'no fuel: both engines flame out and the thrust goes',
    () => {
      const sim = createTestbed({ altitude: 2000, ias: 250 * KT });
      sim.aircraft.fuel = 0;
      runFlightOnly(sim, 10);
      for (const e of sim.aircraft.engines) {
        expect(e.running).toBe(false);
        expect(e.thrust).toBeLessThanOrEqual(0);
        expect(e.fuelFlow).toBe(0);
      }
    },
    LONG,
  );
});

describe('turbulence', () => {
  it(
    "flies through the world's gust field (windAt + gustAt) at its intensity",
    () => {
      const sim = createTestbed({
        altitude: 100,
        groundHeight: 0,
        ias: 250 * KT,
        turbulence: 1,
        seed: 5,
      });
      const scales = gustScales(sim.world, 100, 0, {
        sigmaU: 0,
        sigmaW: 0,
        lengthU: 1,
        lengthW: 1,
      });
      const mean = new Vector3();
      const gust = new Vector3();
      let sum = 0;
      let sq = 0;
      let n = 0;
      runFlightOnly(sim, 60, (s) => {
        const w = s.aircraft.wind.y;
        sum += w;
        sq += w * w;
        n++;
      });
      // The wind the aircraft used in its last step is the world's mean wind plus its gust there.
      const ac = sim.aircraft;
      windAt(sim.world, ac.prevPosition, mean);
      gustAt(sim.world, ac.prevPosition, sim.time - SIM_DT, gust);
      const maxMismatch = mean.add(gust).distanceTo(ac.wind);
      const sigma = Math.sqrt(sq / n - (sum / n) ** 2);
      console.log(
        `[flight] vertical gust σ along a 60 s flight at 100 m, turbulence 1: ${sigma.toFixed(2)} m/s (world σw ${scales.sigmaW.toFixed(2)})`,
      );
      expect(maxMismatch).toBeLessThan(1e-9);
      expect(sigma).toBeGreaterThan(scales.sigmaW * 0.6);
      expect(sigma).toBeLessThan(scales.sigmaW * 1.4);

      const calm = createTestbed({ altitude: 100, groundHeight: 0, ias: 250 * KT, turbulence: 0 });
      runFlightOnly(calm, 5);
      expect(calm.aircraft.wind.length()).toBe(0);
    },
    LONG,
  );
});

describe('contract', () => {
  it(
    'saves prev* at the start of the step and applies the external force once',
    () => {
      const sim = createTestbed({ altitude: 2000, ias: 250 * KT });
      const ac = sim.aircraft;
      const p = ac.position.clone();
      const v = ac.velocity.clone();
      const q = ac.orientation.clone();
      ac.externalForceBody.set(0, 0, 50000);
      ac.externalMomentBody.set(1000, 0, 0);
      stepFlight(sim, SIM_DT);
      expect(ac.prevPosition.equals(p)).toBe(true);
      expect(ac.prevVelocity.equals(v)).toBe(true);
      expect(ac.prevOrientation.equals(q)).toBe(true);
      expect(ac.position.equals(p)).toBe(false);
      expect(ac.externalForceBody.length()).toBe(0);
      expect(ac.externalMomentBody.length()).toBe(0);
    },
    LONG,
  );

  it(
    'derived fields agree with the state',
    () => {
      const sim = createTestbed({ altitude: 2000, ias: 250 * KT, heading: 1.2 });
      runFlightOnly(sim, 2);
      const ac = sim.aircraft;
      expect(ac.altitude).toBe(ac.position.y);
      expect(ac.tas).toBeCloseTo(ac.airVelocityBody.length(), 6);
      expect(ac.ias).toBeLessThan(ac.tas);
      expect(ac.heading).toBeCloseTo(1.2, 1);
      expect(ac.track).toBeCloseTo(1.2, 1);
      expect(ac.gLoad).toBeCloseTo(1, 1);
      expect(ac.verticalSpeed).toBe(ac.velocity.y);
      expect(ac.agl).toBeCloseTo(ac.position.y + 2000, 6);
    },
    LONG,
  );

  it(
    'flies with the whole simulation (createSim + stepSim), trimmed at the start',
    () => {
      const sim = createSim({ seed: 9, terrain: createFlatTerrain(150) });
      const ac = sim.aircraft;
      // The air start is trimmed: 250 kn, level, 1 g.
      expect(Math.abs(ac.gLoad - 1)).toBeLessThan(0.02);
      expect(Math.abs(ac.flightPathAngle)).toBeLessThan(1e-6);
      const h0 = ac.altitude;
      runSim(sim, 10);
      expect(Number.isFinite(ac.position.x)).toBe(true);
      expect(Math.abs(ac.altitude - h0)).toBeLessThan(60);
      expect(ac.crashed).toBe(false);
    },
    LONG,
  );
});
