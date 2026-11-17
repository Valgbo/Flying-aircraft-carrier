/**
 * Sensors test bed: a Sim whose aircraft moves KINEMATICALLY (position, speed, attitude and a
 * steady turn set by the test) and whose vehicles drive kinematically, while only the sensors
 * step runs — so the sensor tests measure the sensors module alone, not the flight model, the
 * avionics or the vehicle behaviour. HOTAS / OSB actions go in as the avionics would queue them
 * (`queueRequest`), the switch states as the avionics keeps them (`cockpitSwitches`).
 */
import { Vector3 } from 'three';
import { THERMAL } from '../../data/vehicles';
import type { SensorRequest } from '../avionics/types';
import { SIM_DT } from '../constants';
import { quaternionFromAttitude } from '../frames';
import { createSim, realismFlags } from '../sim';
import { createVehicle, markTargetsMoved } from '../targets';
import type { Vehicle, VehicleKind } from '../targets/types';
import type { RealismPreset, ScenarioKind, Sim } from '../types';
import { createFlatTerrain, terrainFromHeightFunction } from '../world';
import type { SurfaceKind, Terrain } from '../world/types';
import { stepSensors } from './index';

export interface SensorTestbedOptions {
  terrain?: Terrain;
  seed?: number;
  /** Loadout preset (default 'tankHunter': pod on station 10, D on 3, H on 9). */
  loadoutId?: string;
  /** Vehicles the targets module places (default 'empty': the test adds its own). */
  scenario?: ScenarioKind;
  realism?: RealismPreset;
  /** Aircraft position (m) and altitude above sea level (m). */
  x?: number;
  z?: number;
  altitude?: number;
  /** Heading of the nose and the path, rad (default north). */
  heading?: number;
  /** True airspeed, m/s (default 150). */
  speed?: number;
  pitch?: number;
  bank?: number;
  /** Local time of day, h (default 10.5) and visibility, km (default 30). */
  timeOfDay?: number;
  visibilityKm?: number;
}

/** The aircraft's kinematic state (the test bed integrates it). */
export interface KinematicPose {
  heading: number;
  pitch: number;
  bank: number;
  speed: number;
}

const poses = new WeakMap<Sim, KinematicPose>();
const pending = new WeakMap<Sim, SensorRequest[]>();

export function createSensorTestbed(opts: SensorTestbedOptions = {}): Sim {
  const terrain = opts.terrain ?? createFlatTerrain(0);
  const x = opts.x ?? 0;
  const z = opts.z ?? 0;
  const sim = createSim({
    terrain,
    seed: opts.seed ?? 1,
    scenario: opts.scenario ?? 'empty',
    realism: realismFlags(opts.realism ?? 'authentic'),
    loadoutId: opts.loadoutId ?? 'tankHunter',
    start: { x, z, agl: 1000, heading: opts.heading ?? 0, speed: 150 },
  });
  sim.world.timeOfDay = opts.timeOfDay ?? 10.5;
  sim.world.visibilityKm = opts.visibilityKm ?? 30;
  setAircraft(sim, new Vector3(x, opts.altitude ?? 2000, z), {
    heading: opts.heading ?? 0,
    pitch: opts.pitch ?? 0,
    bank: opts.bank ?? 0,
    speed: opts.speed ?? 150,
  });
  return sim;
}

/** Place the aircraft with an attitude and a speed along its nose. */
export function setAircraft(sim: Sim, position: Vector3, pose: KinematicPose): void {
  const ac = sim.aircraft;
  ac.position.copy(position);
  quaternionFromAttitude(pose.heading, pose.pitch, pose.bank, ac.orientation);
  ac.velocity.set(0, 0, -pose.speed).applyQuaternion(ac.orientation);
  ac.angularVelocity.set(0, 0, 0);
  ac.prevPosition.copy(ac.position);
  ac.prevVelocity.copy(ac.velocity);
  ac.prevOrientation.copy(ac.orientation);
  ac.tas = pose.speed;
  poses.set(sim, { ...pose });
}

/** The pose the test bed flies (change its fields to manoeuvre). */
export function aircraftPose(sim: Sim): KinematicPose {
  let p = poses.get(sim);
  if (!p) {
    p = { heading: 0, pitch: 0, bank: 0, speed: 0 };
    poses.set(sim, p);
  }
  return p;
}

/** Queue a sensor request for the next step, as the avionics' HOTAS / OSB routing would. */
export function queueRequest(
  sim: Sim,
  sensor: SensorRequest['sensor'],
  action: SensorRequest['action'],
  dir: SensorRequest['dir'] = '',
  long = false,
  value = 0,
): void {
  let list = pending.get(sim);
  if (!list) {
    list = [];
    pending.set(sim, list);
  }
  list.push({ sensor, action, dir, long, value, t: sim.time });
}

/**
 * One step: the aircraft flies on (a coordinated turn at the pose's bank: ψ̇ = g·tan φ / V),
 * the queued requests become this step's sensor requests, and the sensors step.
 */
export function stepSensorTestbed(sim: Sim, dt = SIM_DT): void {
  prepareTestbedStep(sim, dt);
  stepSensors(sim, dt);
  finishTestbedStep(sim, dt);
}

/**
 * The part of a test-bed step before the sensors (a timing test calls `stepSensors` between this
 * and `finishTestbedStep`): the aircraft moves, the queued requests are posted.
 */
export function prepareTestbedStep(sim: Sim, dt = SIM_DT): void {
  const ac = sim.aircraft;
  const p = aircraftPose(sim);
  ac.prevPosition.copy(ac.position);
  ac.prevVelocity.copy(ac.velocity);
  ac.prevOrientation.copy(ac.orientation);
  if (p.speed > 1) p.heading += ((9.80665 * Math.tan(p.bank)) / p.speed) * dt;
  quaternionFromAttitude(p.heading, p.pitch, p.bank, ac.orientation);
  // the path follows the heading and the pitch (no wind, no angle of attack)
  ac.velocity.set(
    Math.sin(p.heading) * Math.cos(p.pitch) * p.speed,
    Math.sin(p.pitch) * p.speed,
    -Math.cos(p.heading) * Math.cos(p.pitch) * p.speed,
  );
  ac.position.addScaledVector(ac.velocity, dt);
  const reqs = sim.avionics.sensorRequests;
  reqs.length = 0;
  const list = pending.get(sim);
  if (list) {
    for (const r of list) reqs.push(r);
    list.length = 0;
  }
}

/** The part of a test-bed step after the sensors: the clock advances. */
export function finishTestbedStep(sim: Sim, dt = SIM_DT): void {
  sim.time += dt;
  sim.stepCount++;
}

/** Run the test bed for `seconds`, calling `each` before every step. */
export function runSensorTestbed(sim: Sim, seconds: number, each?: (sim: Sim) => void): void {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) {
    each?.(sim);
    stepSensorTestbed(sim);
  }
}

export type HeatState = 'cold' | 'idle' | 'running';

/** Set a vehicle's heat as the targets module keeps it (THERMAL in data/vehicles.ts). */
export function setVehicleHeat(v: Vehicle, state: HeatState, speed = 0): void {
  if (state === 'cold') {
    v.engineOn = false;
    v.heat.engine = 2;
    v.heat.exhaust = 1;
    v.heat.running = 0;
    v.heat.hull = THERMAL.hullSun;
    return;
  }
  const load = state === 'running';
  v.engineOn = true;
  v.heat.engine = load ? THERMAL.engineLoad : THERMAL.engineIdle;
  v.heat.exhaust = load ? THERMAL.exhaustLoad : THERMAL.exhaustIdle;
  v.heat.running = load ? Math.min(THERMAL.runningMax, THERMAL.runningPerSpeed * speed) : 0;
  v.heat.hull = THERMAL.hullSun + THERMAL.hullEngineShare * v.heat.engine;
}

/** A vehicle on the ground at (x, z) with a heading (compass, rad), a speed and its heat. */
export function addVehicle(
  sim: Sim,
  kind: VehicleKind,
  x: number,
  z: number,
  heading = 0,
  opts: { speed?: number; heat?: HeatState } = {},
): Vehicle {
  const v = createVehicle(sim, kind, x, z, heading, -1);
  v.speed = opts.speed ?? 0;
  setVehicleHeat(v, opts.heat ?? (v.speed > 0 ? 'running' : 'idle'), v.speed);
  return v;
}

/** Drive every vehicle with a speed along its heading on the ground (kinematic). */
export function driveVehicles(sim: Sim, dt = SIM_DT): void {
  const terrain = sim.world.terrain;
  for (const v of sim.targets.vehicles) {
    if (v.speed === 0) continue;
    v.position.x += Math.sin(v.heading) * v.speed * dt;
    v.position.z -= Math.cos(v.heading) * v.speed * dt;
    v.position.y = terrain.heightAt(v.position.x, v.position.z);
  }
  markTargetsMoved(sim.targets);
}

/** Point the pod at a ground point now (INR there), as a slave to an SPI would. */
export function aimPodAt(sim: Sim, point: Vector3): void {
  const spi = sim.avionics.spi;
  spi.valid = true;
  spi.source = 'STPT';
  spi.position.copy(point);
  queueRequest(sim, 'TGP', 'slaveSpi', 'aft', true);
}

// ---- terrains with something in the way -------------------------------------------------------------

/**
 * Flat ground at `base` m with a ridge running east–west: height `height` m above the ground at
 * z = `z`, a Gaussian profile of half-width `width` m (exact ray queries: the world module's
 * analytic-terrain helper).
 */
export function ridgeTerrain(opts: {
  z: number;
  height: number;
  width: number;
  base?: number;
}): Terrain {
  const base = opts.base ?? 0;
  const { z: z0, height, width } = opts;
  const data = { seed: 0, size: 64000, resolution: 0, heights: new Float32Array(0), extra: {} };
  return terrainFromHeightFunction(
    data,
    (_x, z) => base + height * Math.exp(-(((z - z0) / width) ** 2)),
    base,
    base + height,
    Math.max(0.1, (0.9 * height) / width),
  );
}

/**
 * `base` with a strip of forest (canopy `height` m over x0..x1, z0..z1): canopyAt, surfaceAt and a
 * line of sight that tests the canopy (sampled every metre), as the world module's terrain does.
 */
export function withForest(
  base: Terrain,
  strip: { x0: number; x1: number; z0: number; z1: number; height: number },
): Terrain {
  const inside = (x: number, z: number) =>
    x >= strip.x0 && x <= strip.x1 && z >= strip.z0 && z <= strip.z1;
  const canopyAt = (x: number, z: number) => (inside(x, z) ? strip.height : 0);
  const surfaceAt = (x: number, z: number): SurfaceKind =>
    inside(x, z) ? 'forest' : base.surfaceAt(x, z);
  function lineOfSight(a: Vector3, b: Vector3, includeTrees = false): boolean {
    if (!base.lineOfSight(a, b, false)) return false;
    if (!includeTrees) return true;
    const len = a.distanceTo(b);
    if (len <= 2) return true;
    for (let s = 1; s <= len - 1; s += 1) {
      const k = s / len;
      const x = a.x + (b.x - a.x) * k;
      const y = a.y + (b.y - a.y) * k;
      const z = a.z + (b.z - a.z) * k;
      const c = canopyAt(x, z);
      if (c > 0 && y < base.heightAt(x, z) + c) return false;
    }
    return true;
  }
  return { ...base, canopyAt, surfaceAt, lineOfSight };
}
