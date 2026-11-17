/**
 * Weapons test bed: a Sim over flat ground whose aircraft moves KINEMATICALLY (constant velocity
 * and attitude, set by the test) while only the weapons steps run. Used by the gun, ballistics
 * and weapons tests so they measure the weapons module alone, not the flight model.
 */
import { Vector3 } from 'three';
import { SIM_DT } from '../constants';
import { quaternionFromAttitude } from '../frames';
import { createSim, realismFlags } from '../sim';
import type { RealismPreset, Sim } from '../types';
import { createFlatTerrain } from '../world';
import type { Terrain } from '../world/types';
import { stepGun } from './gun';
import { stepProjectiles } from './projectiles';
import type { AmmoLoad } from './types';

export interface GunTestbedOptions {
  seed?: number;
  /** World to fly over (default: flat ground at `groundHeight`). */
  terrain?: Terrain;
  /** Height of the flat ground, m (default 0). */
  groundHeight?: number;
  /** Aircraft position, m (default x = z = 0, 1,000 m above sea level). */
  x?: number;
  z?: number;
  altitude?: number;
  /** True airspeed along the flight path, m/s (default 0: a fixed mount). */
  speed?: number;
  /** Heading of the path and the nose, rad (default north). */
  heading?: number;
  /** Flight-path angle, rad (+ climb, − dive; default level). */
  pathAngle?: number;
  /** Nose pitch, rad (default: along the flight path). */
  pitch?: number;
  load?: AmmoLoad;
  realism?: RealismPreset;
  /** Master Arm ARM and GUN/PAC ARM (default true). */
  armed?: boolean;
  loadoutId?: string;
  scenario?: 'empty' | 'freeHunt';
}

/** A sim with a gun ready to fire from a kinematic aircraft. */
export function createGunTestbed(opts: GunTestbedOptions = {}): Sim {
  const terrain = opts.terrain ?? createFlatTerrain(opts.groundHeight ?? 0);
  const altitude = opts.altitude ?? 1000;
  const x = opts.x ?? 0;
  const z = opts.z ?? 0;
  const heading = opts.heading ?? 0;
  const speed = opts.speed ?? 0;
  // A normal air start (the flight module never steps here); the kinematic state replaces it.
  const sim = createSim({
    terrain,
    seed: opts.seed ?? 1,
    scenario: opts.scenario ?? 'empty',
    realism: realismFlags(opts.realism ?? 'authentic'),
    loadoutId: opts.loadoutId ?? 'gunOnly',
    ammoLoad: opts.load ?? 'combatMix',
    start: { x, z, agl: 1000, heading, speed: 120 },
  });
  setKinematicState(sim, {
    position: new Vector3(x, altitude, z),
    speed,
    heading,
    pathAngle: opts.pathAngle ?? 0,
    pitch: opts.pitch,
  });
  if (opts.armed ?? true) {
    sim.avionics.masterArm = 'ARM';
    sim.avionics.gunPac = 'ARM';
  }
  return sim;
}

/** Put the aircraft at a position with a velocity and attitude (and no rotation). */
export function setKinematicState(
  sim: Sim,
  s: { position: Vector3; speed: number; heading: number; pathAngle: number; pitch?: number },
): void {
  const ac = sim.aircraft;
  const cg = Math.cos(s.pathAngle);
  ac.position.copy(s.position);
  ac.velocity.set(
    Math.sin(s.heading) * cg * s.speed,
    Math.sin(s.pathAngle) * s.speed,
    -Math.cos(s.heading) * cg * s.speed,
  );
  quaternionFromAttitude(s.heading, s.pitch ?? s.pathAngle, 0, ac.orientation);
  ac.angularVelocity.set(0, 0, 0);
  ac.prevPosition.copy(ac.position);
  ac.prevVelocity.copy(ac.velocity);
  ac.prevOrientation.copy(ac.orientation);
  ac.flightPathAngle = s.pathAngle;
  ac.tas = s.speed;
  ac.agl = ac.position.y - sim.world.terrain.heightAt(ac.position.x, ac.position.z);
  ac.externalForceBody.set(0, 0, 0);
  ac.externalMomentBody.set(0, 0, 0);
}

/**
 * One step: the aircraft moves on at constant velocity (the flight step's part), then the gun
 * and the projectiles step. The recoil the gun wrote is added (× dt) to `impulseBody` and the
 * moment (× dt) to `angularImpulseBody` if given, then cleared, as the flight step would.
 */
export function stepKinematic(
  sim: Sim,
  dt = SIM_DT,
  impulseBody?: Vector3,
  angularImpulseBody?: Vector3,
): void {
  const ac = sim.aircraft;
  ac.prevPosition.copy(ac.position);
  ac.prevVelocity.copy(ac.velocity);
  ac.prevOrientation.copy(ac.orientation);
  ac.position.addScaledVector(ac.velocity, dt);
  ac.agl = ac.position.y - sim.world.terrain.heightAt(ac.position.x, ac.position.z);
  stepGun(sim, dt);
  stepProjectiles(sim, dt);
  impulseBody?.addScaledVector(ac.externalForceBody, dt);
  angularImpulseBody?.addScaledVector(ac.externalMomentBody, dt);
  ac.externalForceBody.set(0, 0, 0);
  ac.externalMomentBody.set(0, 0, 0);
  sim.time += dt;
  sim.stepCount++;
}

/** Run stepKinematic for `seconds`, calling `each` before every step. */
export function runKinematic(
  sim: Sim,
  seconds: number,
  each?: (sim: Sim) => void,
  impulseBody?: Vector3,
): void {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) {
    each?.(sim);
    stepKinematic(sim, SIM_DT, impulseBody);
  }
}
