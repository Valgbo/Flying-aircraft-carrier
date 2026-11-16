/**
 * FLIGHT module public API. FOUNDATION STAND-IN: a simple, stable point-mass model (the stick
 * commands pitch and roll rates, thrust and drag set the speed) so the app can fly before the
 * real six-degree-of-freedom model lands. The flight module owner replaces the implementation
 * and keeps these exports and their meaning.
 */
import { Quaternion, Vector3 } from 'three';
import { A10 } from '../../data/aircraft';
import { G0 } from '../constants';
import { attitudeFromQuaternion, headingOf, quaternionFromAttitude, worldToBody } from '../frames';
import type { Sim } from '../types';
import { casFromTas, densityAt, speedOfSoundAt } from '../world/atmosphere';
import type { Terrain } from '../world/types';
import type { AircraftState, EngineState, WarningId } from './types';

export type * from './types';

/** Where and how a flight starts. */
export interface AirStart {
  x: number;
  z: number;
  /** Height above the ground, m. */
  agl: number;
  /** rad, 0 = north. */
  heading: number;
  /** True airspeed, m/s. */
  speed: number;
}

function engine(lever: number): EngineState {
  return { lever, n1: 0.8, n2: 0.85, thrust: 0, itt: 700, fuelFlow: 0.35, running: true };
}

const WARNINGS: WarningId[] = [
  'stall',
  'stallChopped',
  'overG',
  'altitude',
  'pullUp',
  'overspeed',
  'lowFuel',
  'masterCaution',
];

export function createAircraftState(terrain: Terrain, start: AirStart): AircraftState {
  const ground = terrain.heightAt(start.x, start.z);
  const position = new Vector3(start.x, ground + start.agl, start.z);
  const orientation = quaternionFromAttitude(start.heading, 0.02, 0, new Quaternion());
  const velocity = new Vector3(0, 0, -start.speed).applyQuaternion(
    quaternionFromAttitude(start.heading, 0, 0, new Quaternion()),
  );
  const warnings = {} as Record<WarningId, boolean>;
  for (const w of WARNINGS) warnings[w] = false;
  return {
    position,
    velocity,
    orientation,
    angularVelocity: new Vector3(),
    acceleration: new Vector3(),
    prevPosition: position.clone(),
    prevVelocity: velocity.clone(),
    prevOrientation: orientation.clone(),
    externalForceBody: new Vector3(),
    externalMomentBody: new Vector3(),
    airVelocityBody: new Vector3(0, 0, -start.speed),
    tas: start.speed,
    ias: start.speed,
    mach: 0.3,
    alpha: 0.05,
    beta: 0,
    gLoad: 1,
    heading: start.heading,
    pitch: 0.02,
    bank: 0,
    flightPathAngle: 0,
    track: start.heading,
    groundSpeed: start.speed,
    verticalSpeed: 0,
    altitude: position.y,
    agl: start.agl,
    mass: A10.emptyMass + A10.internalFuel * 0.6,
    cgBody: new Vector3(),
    inertia: { xx: 3.2e4, yy: 1.0e5, zz: 1.2e5, xz: 0 },
    fuel: A10.internalFuel * 0.6,
    engines: [engine(0.85), engine(0.85)],
    surfaces: { elevator: 0, aileron: 0, rudder: 0, flaps: 0, speedBrake: 0, slats: 0 },
    trim: { pitch: 0, roll: 0, yaw: 0 },
    flapHandle: 0,
    speedBrakeCmd: 0,
    gearDown: false,
    autopilot: {
      engaged: false,
      mode: 'PATH',
      refAltitude: position.y,
      refHeading: start.heading,
      refPitch: 0,
      refBank: 0,
    },
    pac: { stage: 0, active: false, pitchCmd: 0, yawCmd: 0 },
    altitudeAlert: 150,
    warnings,
    crashed: false,
    maxG: 1,
  };
}

/** Flight controls: SAS, trim, PAC and autopilot → surface positions. Stand-in: direct. */
export function stepFlightControls(sim: Sim, dt: number): void {
  const ac = sim.aircraft;
  const s = ac.surfaces;
  const k = Math.min(1, dt * 12);
  s.elevator += (sim.input.pitch - s.elevator) * k;
  s.aileron += (sim.input.roll - s.aileron) * k;
  s.rudder += (sim.input.rudder - s.rudder) * k;
  if (sim.input.speedBrake !== 0) {
    ac.speedBrakeCmd = Math.min(1, Math.max(0, ac.speedBrakeCmd + sim.input.speedBrake * dt * 0.6));
  }
  s.speedBrake += (ac.speedBrakeCmd - s.speedBrake) * k;
  s.flaps = A10.flapAngles[ac.flapHandle];
  for (let i = 0; i < 2; i++) ac.engines[i].lever = sim.input.throttle[i];
}

const _fwd = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _q = new Quaternion();
const _v = new Vector3();
const _att = { heading: 0, pitch: 0, bank: 0 };

/** Six-degree-of-freedom step. Stand-in: rate-commanded point mass. */
export function stepFlight(sim: Sim, dt: number): void {
  const ac = sim.aircraft;
  ac.prevPosition.copy(ac.position);
  ac.prevVelocity.copy(ac.velocity);
  ac.prevOrientation.copy(ac.orientation);
  if (ac.crashed) return;

  const rho = densityAt(ac.position.y);
  // Engines: first-order spool toward the lever.
  let thrust = 0;
  for (const e of ac.engines) {
    const target = 0.55 + 0.45 * e.lever;
    e.n1 += (target - e.n1) * Math.min(1, dt / 2.5);
    e.n2 = 0.6 + 0.4 * e.n1;
    e.thrust = A10.engineThrust * Math.max(0, (e.n1 - 0.55) / 0.45) ** 1.6 * (rho / 1.225) ** 0.7;
    e.itt = 450 + 450 * e.n1;
    e.fuelFlow = 0.1 + 0.45 * e.n1 ** 2;
    thrust += e.thrust;
  }

  // Attitude: stick → body rates (stand-in).
  const pitchRate = 0.45 * ac.surfaces.elevator;
  const rollRate = 1.6 * ac.surfaces.aileron;
  const yawRate = 0.15 * ac.surfaces.rudder;
  _q.setFromAxisAngle(_v.set(1, 0, 0), pitchRate * dt);
  ac.orientation.multiply(_q);
  _q.setFromAxisAngle(_v.set(0, 0, 1), -rollRate * dt);
  ac.orientation.multiply(_q);
  _q.setFromAxisAngle(_v.set(0, 1, 0), -yawRate * dt);
  ac.orientation.multiply(_q);
  // Coordinated turn: bank turns the heading.
  attitudeFromQuaternion(ac.orientation, _att);
  const turn = (G0 * Math.tan(_att.bank)) / Math.max(60, ac.tas);
  _q.setFromAxisAngle(_v.set(0, 1, 0), -turn * dt);
  ac.orientation.premultiply(_q).normalize();
  ac.angularVelocity.set(pitchRate, -yawRate - turn, -rollRate);

  // Speed along the nose: thrust - drag - gravity component.
  _fwd.set(0, 0, -1).applyQuaternion(ac.orientation);
  const speed = ac.velocity.length();
  const cd = 0.032 + 0.09 * ac.surfaces.speedBrake + 0.02 * (ac.flapHandle / 2);
  const drag = 0.5 * rho * speed * speed * A10.wingArea * cd;
  const accel = (thrust - drag) / ac.mass - G0 * _fwd.y;
  const newSpeed = Math.max(40, speed + accel * dt);
  ac.velocity.copy(_fwd).multiplyScalar(newSpeed);
  ac.acceleration.subVectors(ac.velocity, ac.prevVelocity).divideScalar(dt);
  ac.position.addScaledVector(ac.velocity, dt);

  // Derived values.
  attitudeFromQuaternion(ac.orientation, _att);
  ac.heading = _att.heading;
  ac.pitch = _att.pitch;
  ac.bank = _att.bank;
  worldToBody(ac.orientation, ac.velocity, ac.airVelocityBody);
  ac.tas = newSpeed;
  ac.ias = casFromTas(newSpeed, ac.position.y);
  ac.mach = newSpeed / speedOfSoundAt(ac.position.y);
  ac.alpha = 0.05;
  ac.beta = 0;
  _up.set(0, 1, 0).applyQuaternion(ac.orientation);
  _right.set(1, 0, 0).applyQuaternion(ac.orientation);
  ac.gLoad = 1 / Math.max(0.2, Math.cos(_att.bank)) + (pitchRate * newSpeed) / G0;
  ac.maxG = Math.max(ac.maxG, ac.gLoad);
  ac.verticalSpeed = ac.velocity.y;
  ac.groundSpeed = Math.hypot(ac.velocity.x, ac.velocity.z);
  ac.flightPathAngle = Math.atan2(ac.velocity.y, ac.groundSpeed);
  ac.track = headingOf(ac.velocity.x, ac.velocity.z);
  ac.altitude = ac.position.y;
  const ground = sim.world.terrain.heightAt(ac.position.x, ac.position.z);
  ac.agl = ac.position.y - ground;
  for (const e of ac.engines) ac.fuel = Math.max(0, ac.fuel - e.fuelFlow * dt);
  ac.externalForceBody.set(0, 0, 0);
  ac.externalMomentBody.set(0, 0, 0);

  if (ac.agl <= 0.5) {
    if (sim.options.realism.invulnerable) {
      ac.position.y = ground + 1;
      if (ac.velocity.y < 0) ac.velocity.y = -ac.velocity.y * 0.3;
    } else {
      ac.crashed = true;
      sim.events.push({
        type: 'crash',
        t: sim.time,
        position: { x: ac.position.x, y: ac.position.y, z: ac.position.z },
        reason: 'terrain',
      });
    }
  }
}

/** Warning logic (stall, over-g, altitude, ground collision). Stand-in: altitude and pull-up only. */
export function stepWarnings(sim: Sim, _dt: number): void {
  const ac = sim.aircraft;
  set(sim, 'altitude', ac.agl < ac.altitudeAlert && ac.verticalSpeed < 0);
  const timeToImpact = ac.verticalSpeed < -1 ? ac.agl / -ac.verticalSpeed : Infinity;
  set(sim, 'pullUp', timeToImpact < 5 && ac.agl < 600);
}

function set(sim: Sim, id: WarningId, on: boolean): void {
  if (sim.aircraft.warnings[id] === on) return;
  sim.aircraft.warnings[id] = on;
  sim.events.push({ type: 'warning', t: sim.time, warning: id, on });
}

/** Recompute mass, CG and inertia after fuel or stores change. Stand-in: mass only. */
export function updateMassProperties(sim: Sim): void {
  const ac = sim.aircraft;
  ac.mass = A10.emptyMass + ac.fuel + sim.stores.mass + sim.gun.rounds * 0.69;
}
