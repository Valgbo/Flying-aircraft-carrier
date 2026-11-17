/**
 * The simulation: creation and the fixed-order step. FOUNDATION-OWNED.
 * See docs/a10/ARCHITECTURE.md §3 for the step order and why it is in this order.
 */
import { applyCommands, createAvionicsState, initAvionics, stepFireControl } from './avionics';
import { SIM_DT } from './constants';
import { createDebriefState, stepDebrief } from './debrief';
import {
  createAircraftState,
  stepFlight,
  stepFlightControls,
  stepWarnings,
  updateMassProperties,
  type AirStart,
} from './flight';
import { createRngStreams } from './rng';
import { createSensorsState, stepSensors } from './sensors';
import { createTargetsState, populateScenario, stepTargets } from './targets';
import type {
  Command,
  PilotInput,
  RealismFlags,
  RealismPreset,
  Sim,
  SimEvent,
  SimOptions,
} from './types';
import {
  createGunState,
  createProjectileState,
  createStoresState,
  stepGun,
  stepProjectiles,
  stepStores,
} from './weapons';
import { FT, KT } from './units';
import { createWorldState, stepWorld, tasFromCas } from './world';
import type { Terrain } from './world/types';

export function realismFlags(preset: RealismPreset): RealismFlags {
  const relaxed = preset === 'relaxed';
  const authentic = preset === 'authentic';
  return {
    preset,
    mapMarkers: !authentic,
    hudBoxes: relaxed,
    snapLock: relaxed,
    largeGate: preset === 'standard',
    twoStageTrigger: !relaxed,
    autoTrim: !authentic,
    unlimitedAmmo: relaxed,
    fuzeEffects: !relaxed,
    invulnerable: relaxed,
  };
}

export function createPilotInput(): PilotInput {
  return {
    pitch: 0,
    roll: 0,
    rudder: 0,
    throttle: [0.85, 0.85],
    trigger: 0,
    weaponRelease: false,
    speedBrake: 0,
    trimPitch: 0,
    trimRoll: 0,
    trimYaw: 0,
    slewX: 0,
    slewY: 0,
    laser: false,
  };
}

export interface CreateSimOptions extends Partial<SimOptions> {
  terrain: Terrain;
  /** Where to start; default: the terrain's suggested start at 8,000 ft and 250 KIAS. */
  start?: AirStart;
}

/**
 * Default air start (PLAN_A10.md §5): 8,000 ft above sea level, 250 kn indicated (≈283 kn true),
 * level, toward the first target area.
 */
export function defaultAirStart(terrain: Terrain): AirStart {
  const { x, z, heading } = terrain.start;
  const altitude = 8000 * FT;
  return {
    x,
    z,
    agl: altitude - terrain.heightAt(x, z),
    heading,
    speed: tasFromCas(250 * KT, altitude),
  };
}

export function createSim(opts: CreateSimOptions): Sim {
  const options: SimOptions = {
    seed: opts.seed ?? 1,
    scenario: opts.scenario ?? 'freeHunt',
    realism: opts.realism ?? realismFlags('authentic'),
    loadoutId: opts.loadoutId ?? 'tankHunter',
    customLoadout: opts.customLoadout,
    ammoLoad: opts.ammoLoad ?? 'combatMix',
  };
  const world = createWorldState(opts.terrain);
  const start = opts.start ?? defaultAirStart(opts.terrain);
  const sim: Sim = {
    options,
    time: 0,
    stepCount: 0,
    rng: createRngStreams(options.seed),
    input: createPilotInput(),
    commands: [],
    aircraft: createAircraftState(opts.terrain, start),
    avionics: createAvionicsState(),
    gun: createGunState(options.ammoLoad),
    stores: createStoresState(options.loadoutId, options.customLoadout),
    projectiles: createProjectileState(),
    world,
    targets: createTargetsState(),
    sensors: createSensorsState(),
    debrief: createDebriefState(),
    events: [],
  };
  updateMassProperties(sim);
  populateScenario(sim);
  // Steerpoints, SPI and weapon profiles exist before the first step (paused start, first HUD).
  initAvionics(sim);
  return sim;
}

/**
 * Advance the simulation by one fixed step (SIM_DT). The order matters:
 *  1. commands      switches and modes change before anything reads them
 *  2. controls      SAS / PAC / trim / autopilot turn stick + solution into surface positions
 *  3. flight        6-DOF integration; saves the previous state for sub-step interpolation
 *  4. gun           rounds leave at exact times between the previous and new aircraft state
 *  5. stores        releases spawn store bodies
 *  6. projectiles   rounds and bodies move; impacts are resolved against ground and vehicles
 *  7. targets       vehicles move, burn, react
 *  8. sensors       pod and seekers track the moved vehicles
 *  9. fire control  solutions from the new state (used by the next step's controls and releases)
 * 10. warnings, world, debrief
 */
export function stepSim(sim: Sim): void {
  const dt = SIM_DT;
  applyCommands(sim);
  stepFlightControls(sim, dt);
  stepFlight(sim, dt);
  stepGun(sim, dt);
  stepStores(sim, dt);
  stepProjectiles(sim, dt);
  stepTargets(sim, dt);
  stepSensors(sim, dt);
  stepFireControl(sim, dt);
  stepWarnings(sim, dt);
  stepWorld(sim, dt);
  stepDebrief(sim, dt);
  sim.time += dt;
  sim.stepCount++;
}

/** Run whole steps covering `seconds` (tests and tools). */
export function runSim(sim: Sim, seconds: number, each?: (sim: Sim) => void): void {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) {
    each?.(sim);
    stepSim(sim);
  }
}

/** Queue a discrete command for the next step. */
export function pushCommand(sim: Sim, command: Command): void {
  sim.commands.push(command);
}

/** Move all pending events into `out` (cleared first) and empty the sim's queue. */
export function drainEvents(sim: Sim, out: SimEvent[]): SimEvent[] {
  out.length = 0;
  for (const e of sim.events) out.push(e);
  sim.events.length = 0;
  return out;
}
