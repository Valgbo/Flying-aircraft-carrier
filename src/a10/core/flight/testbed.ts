/**
 * Flight-only test bed: a Sim over flat ground in which only the flight module steps (controls,
 * flight, warnings). Used by the flight tests, the flight sandbox and tuning tools, so the
 * flight model can be measured without the other modules' step functions.
 */
import { SIM_DT } from '../constants';
import { createSim, realismFlags } from '../sim';
import type { RealismFlags, RealismPreset, Sim } from '../types';
import { createFlatTerrain, tasFromCas } from '../world';
import { A10 } from '../../data/aircraft';
import { stepFlightControls } from './controls';
import { stepFlight } from './step';
import { levelFlightThrottle, trimAircraft } from './trim';
import { updateMass } from './mass';
import { stepWarnings } from './warnings';

export interface TestbedOptions {
  /** Altitude above sea level, m (default 3,000). */
  altitude?: number;
  /** Indicated airspeed, m/s (default 250 kn); or give the true airspeed. */
  ias?: number;
  tas?: number;
  /** Heading, rad (default north). */
  heading?: number;
  /** Flight-path angle, rad (default level). */
  gamma?: number;
  /**
   * Total mass, kg. Fuel is set first (up to full), then a clean ballast store (no drag) makes
   * up the rest. Default: 60 % fuel, full ammunition, clean.
   */
  mass?: number;
  /** Rounds in the drum (default 1,150). */
  rounds?: number;
  seed?: number;
  /** WorldState.turbulence (default 0: still air). */
  turbulence?: number;
  /** Height of the flat ground, m (default 2,000 m below sea level so sea-level tests fly). */
  groundHeight?: number;
  realism?: RealismPreset | RealismFlags;
  /** Throttle lever for both engines, or 'level' to hold the speed (default 'level'). */
  throttle?: number | 'level';
}

/** A trimmed aircraft in steady flight over flat ground, ready for stepFlightOnly. */
export function createTestbed(opts: TestbedOptions = {}): Sim {
  const altitude = opts.altitude ?? 3000;
  const ground = opts.groundHeight ?? -2000;
  const tas = opts.tas ?? tasFromCas(opts.ias ?? 250 * 0.514444, altitude);
  const realism =
    typeof opts.realism === 'string'
      ? realismFlags(opts.realism)
      : (opts.realism ?? realismFlags('authentic'));
  const sim = createSim({
    terrain: createFlatTerrain(ground),
    seed: opts.seed ?? 1,
    scenario: 'empty',
    realism,
    loadoutId: 'custom',
    customLoadout: {},
    start: { x: 0, z: 0, agl: altitude - ground, heading: opts.heading ?? 0, speed: tas },
  });
  sim.world.turbulence = opts.turbulence ?? 0;
  sim.world.surfaceWind.set(0, 0, 0);
  const st = sim.stores;
  for (const station of st.stations) station.stores.length = 0;
  st.mass = 0;
  st.dragArea = 0;
  st.lateralMoment = 0;
  st.rollInertia = 0;
  st.dragMoment = 0;
  sim.gun.rounds = opts.rounds ?? sim.gun.rounds;
  sim.gun.roundsLoaded = sim.gun.rounds;
  setTotalMass(sim, opts.mass);
  const gamma = opts.gamma ?? 0;
  if (opts.throttle === undefined || opts.throttle === 'level') {
    const lever = levelFlightThrottle(sim, gamma);
    sim.input.throttle[0] = lever;
    sim.input.throttle[1] = lever;
  } else {
    sim.input.throttle[0] = opts.throttle;
    sim.input.throttle[1] = opts.throttle;
    sim.aircraft.engines[0].lever = opts.throttle;
    sim.aircraft.engines[1].lever = opts.throttle;
    trimAircraft(sim, gamma);
  }
  return sim;
}

/**
 * Set the total mass: fuel first (60 % by default when `mass` is undefined), then a drag-free
 * ballast store for anything beyond full fuel.
 */
export function setTotalMass(sim: Sim, mass?: number): void {
  const ac = sim.aircraft;
  ac.fuel = A10.internalFuel * 0.6;
  sim.stores.mass = 0;
  updateMass(sim);
  if (mass === undefined) return;
  const withoutFuel = ac.mass - ac.fuel;
  ac.fuel = Math.min(A10.internalFuel, Math.max(0, mass - withoutFuel));
  sim.stores.mass = Math.max(0, mass - withoutFuel - ac.fuel);
  updateMass(sim);
}

/** One step of the flight module alone (controls, flight, warnings), advancing sim time. */
export function stepFlightOnly(sim: Sim): void {
  stepFlightControls(sim, SIM_DT);
  stepFlight(sim, SIM_DT);
  stepWarnings(sim, SIM_DT);
  sim.time += SIM_DT;
  sim.stepCount++;
}

/** Run the flight module alone for `seconds`, calling `each` before every step. */
export function runFlightOnly(sim: Sim, seconds: number, each?: (sim: Sim) => void): void {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) {
    each?.(sim);
    stepFlightOnly(sim);
  }
}
