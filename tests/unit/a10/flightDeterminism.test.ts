/**
 * PLAN §16 determinism with the WHOLE simulation (review FC-9): the same seed and the same input
 * log give an identical state after 60 s — aircraft, gun, rounds and store bodies, vehicles (and
 * their damage), avionics, the random streams, the debrief and every event. The run fires a
 * PAC-2 burst through turbulence into a group of vehicles (API and HEI hits, damage, fires),
 * pulls out and flies on. Two runs are stepped interleaved (one would see the other's leftovers
 * in any shared module state) and a third one alone afterwards.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createSim, pushCommand, stepSim } from '../../../src/a10/core/sim';
import { createVehicle, markTargetsMoved } from '../../../src/a10/core/targets';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { createFlatTerrain, tasFromCas } from '../../../src/a10/core/world';

const LONG = 180_000;
const KT = 0.514444;
const DEG = Math.PI / 180;
const SECONDS = 60;

/** The scripted pilot: the same controls at the same sim time in every run. */
function pilot(sim: Sim): void {
  const t = sim.time;
  const input = sim.input;
  input.trigger = t < 1 ? 0 : t < 2 ? 1 : t < 4.5 ? 2 : 0;
  input.pitch = t >= 0.5 && t < 0.6 ? 0.05 : t >= 5 && t < 9 ? 0.35 : 0;
  input.rudder = t >= 2.5 && t < 2.7 ? 0.1 : 0;
  if (t >= 9) {
    input.throttle[0] = 1;
    input.throttle[1] = 1;
  }
}

function newSim(): Sim {
  const sim = createSim({
    seed: 1234,
    terrain: createFlatTerrain(0),
    scenario: 'empty',
    loadoutId: 'gunOnly',
    start: {
      x: 0,
      z: 0,
      agl: 1200,
      heading: 0,
      speed: tasFromCas(300 * KT, 1200),
      gamma: -30 * DEG,
    },
  });
  sim.world.turbulence = 0.5;
  pushCommand(sim, { type: 'masterArm', value: 'ARM' });
  pushCommand(sim, { type: 'gunPac', value: 'ARM' });
  pushCommand(sim, { type: 'masterMode', value: 'GUNS' });
  return sim;
}

/** Where the pipper rests when the burst starts (from a run without vehicles). */
function aimPoint(): Vector3 {
  const probe = newSim();
  while (probe.time < 2) {
    pilot(probe);
    stepSim(probe);
    probe.events.length = 0;
  }
  return probe.avionics.gun.impact.clone();
}

/** A column in the line of fire: a tank, an IFV, an APC and the trucks of a supply point. */
function placeTargets(sim: Sim, at: Vector3): void {
  const kinds = ['truckCargo', 'apc', 'mbt', 'ifv', 'truckAmmo', 'truckFuel'] as const;
  kinds.forEach((kind, i) => {
    createVehicle(sim, kind, at.x + (i % 2 ? 1.5 : -1.5), at.z - 30 + 12 * i, 0.3 * i, 1);
  });
  markTargetsMoved(sim.targets);
}

/** A JSON fingerprint of everything the simulation holds. */
function fingerprint(sim: Sim, events: SimEvent[]): string {
  return JSON.stringify({
    time: sim.time,
    steps: sim.stepCount,
    aircraft: sim.aircraft,
    gun: sim.gun,
    stores: sim.stores,
    projectiles: sim.projectiles,
    targets: sim.targets,
    avionics: sim.avionics,
    sensors: sim.sensors,
    rng: sim.rng,
    debrief: sim.debrief,
    events,
  });
}

describe('determinism of the whole simulation (PLAN §16, review FC-9)', () => {
  it(
    'same seed and input log: identical state after 60 s with gun fire, hits and damage',
    () => {
      const at = aimPoint();
      const a = newSim();
      const b = newSim();
      placeTargets(a, at);
      placeTargets(b, at);
      const eventsA: SimEvent[] = [];
      const eventsB: SimEvent[] = [];
      // Interleaved: any state shared between sims through module variables would show.
      while (a.time < SECONDS) {
        pilot(a);
        stepSim(a);
        eventsA.push(...a.events);
        a.events.length = 0;
        pilot(b);
        stepSim(b);
        eventsB.push(...b.events);
        b.events.length = 0;
      }
      const c = newSim();
      placeTargets(c, at);
      const eventsC: SimEvent[] = [];
      while (c.time < SECONDS) {
        pilot(c);
        stepSim(c);
        eventsC.push(...c.events);
        c.events.length = 0;
      }

      // The run did what it should: a burst, hits, damage, a pull-out, no crash.
      const rounds = a.gun.roundsLoaded - a.gun.rounds;
      const hits = a.debrief.hits.length;
      const damaged = a.targets.vehicles.filter(
        (v) => v.condition !== 'intact' || Object.values(v.components).some((c) => c < 1),
      ).length;
      console.log(
        `[flight] determinism run: ${rounds} rounds, ${hits} hits, ${damaged} vehicles damaged, ${eventsA.length} events, altitude ${a.aircraft.altitude.toFixed(0)} m`,
      );
      expect(rounds).toBeGreaterThan(100);
      expect(hits).toBeGreaterThan(5);
      expect(damaged).toBeGreaterThan(0);
      expect(a.aircraft.crashed).toBe(false);

      const fa = fingerprint(a, eventsA);
      expect(fingerprint(b, eventsB)).toBe(fa);
      expect(fingerprint(c, eventsC)).toBe(fa);
    },
    LONG,
  );
});
