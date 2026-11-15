/**
 * The flight model as one fixed-step pipeline, independent of any physics engine:
 *
 *   wind → flight computer / manual control → turbine actuators → force model
 *
 * `advanceFlightControl` runs that pipeline for one step and leaves the net force and torque in
 * `model.forces`. The Rapier driver calls it before every world step and lets Rapier integrate
 * the rigid body; `stepFlightModel` adds a small semi-implicit Euler integrator instead, which
 * is what the unit tests fly. Both therefore exercise exactly the same control and force code.
 */
import { Quaternion, Vector3 } from 'three';
import {
  computeCarrierForces,
  createCarrierForces,
  type CarrierEnvironment,
  type CarrierForces,
  type RigidState,
} from '../carrier/carrierPhysics';
import { FLOATING_ALTITUDE, HULL } from '../config/layout';
import { HOVER_THROTTLE, PHYS, WEIGHT } from '../config/physicsConfig';
import { waveHeightAt } from '../config/waves';
import type { FlightControls, Quad, TurbineSim } from '../state/types';
import { stepTurbineActuators } from './actuators';
import {
  createFlightComputerState,
  stepFlightComputer,
  type FlightComputerState,
  type FlightSensors,
  type PilotAxes,
} from './flightComputer';
import { sampleWind } from './wind';

/** The physics step, s. */
export const FIXED_DT = 1 / 60;

/** Share of the weight the water must carry before the ship counts as afloat. */
const AFLOAT_BUOYANCY_SHARE = 0.03;
/** Hard limits that keep a runaway state finite, m/s and rad/s. */
const MAX_SPEED = 600;
const MAX_ANGULAR_SPEED = 4;

export interface FlightModel {
  /** Simulated seconds since the model was created. */
  time: number;
  body: RigidState;
  turbines: Quad<TurbineSim>;
  controls: FlightControls;
  /** Wind strength: 0 = calm, 1 = free flight, WIND.opsLevel = flight ops. */
  windLevel: number;
  env: CarrierEnvironment;
  computer: FlightComputerState;
  sensors: FlightSensors;
  /** Forces from the most recent `advanceFlightControl` / `refreshForces`. */
  forces: CarrierForces;
  /** Keel above the local water surface, m (same definition as `sim.carrier.keelClearance`). */
  keelClearance: number;
}

export interface FlightModelParts {
  body?: RigidState;
  turbines?: Quad<TurbineSim>;
  controls?: FlightControls;
  wind?: Vector3;
  time?: number;
  windLevel?: number;
}

function makeTurbine(throttle: number): TurbineSim {
  return {
    enabled: true,
    throttleCmd: throttle,
    throttle,
    tiltCmd: 0,
    tilt: 0,
    thrust: throttle * PHYS.maxThrust,
  };
}

/**
 * Build a model. Pass the live `sim` objects to drive the game state in place; omit them to
 * get a self-contained model (floating at rest with idle engines) for tests and tools.
 */
export function createFlightModel(parts: FlightModelParts = {}): FlightModel {
  const model: FlightModel = {
    time: parts.time ?? 0,
    body: parts.body ?? {
      position: new Vector3(0, FLOATING_ALTITUDE, 0),
      quaternion: new Quaternion(),
      velocity: new Vector3(),
      angularVelocity: new Vector3(),
    },
    turbines: parts.turbines ?? [makeTurbine(0), makeTurbine(0), makeTurbine(0), makeTurbine(0)],
    controls: parts.controls ?? {
      targetAltitude: FLOATING_ALTITUDE,
      tiltLever: 0,
      manualThrottle: [0, 0, 0, 0],
      manualTilt: [0, 0, 0, 0],
    },
    windLevel: parts.windLevel ?? 0,
    env: { time: parts.time ?? 0, wind: parts.wind ?? new Vector3(), turbulence: new Vector3() },
    computer: createFlightComputerState(),
    sensors: { supportForceY: 0, afloat: false, keelClearance: 0 },
    forces: createCarrierForces(),
    keelClearance: 0,
  };
  refreshForces(model);
  return model;
}

/** Put a self-contained model into a level hover at `altitude` with the engines trimmed for it. */
export function setHover(model: FlightModel, altitude: number): void {
  model.body.position.set(0, altitude, 0);
  model.body.quaternion.identity();
  model.body.velocity.set(0, 0, 0);
  model.body.angularVelocity.set(0, 0, 0);
  for (let i = 0; i < 4; i++) {
    const t = model.turbines[i];
    t.throttle = t.throttleCmd = HOVER_THROTTLE;
    t.tilt = t.tiltCmd = 0;
    model.controls.manualThrottle[i] = HOVER_THROTTLE;
    model.controls.manualTilt[i] = 0;
  }
  model.controls.targetAltitude = altitude;
  model.controls.tiltLever = 0;
  model.computer = createFlightComputerState();
  refreshForces(model);
}

const _up = new Vector3();

/**
 * Re-evaluate the forces and sensors for the current state without stepping anything.
 * Call after changing the state by hand so the next control step starts from fresh readings.
 */
export function refreshForces(model: FlightModel): void {
  model.env.time = model.time;
  sampleWind(model.time, model.windLevel, model.env.wind, model.env.turbulence);
  computeCarrierForces(model.body, model.turbines, model.env, model.forces);
  for (let i = 0; i < 4; i++) model.turbines[i].thrust = model.forces.thrust[i];
  model.sensors.supportForceY = model.forces.supportForceY;
  model.sensors.afloat = model.forces.buoyancy > AFLOAT_BUOYANCY_SHARE * WEIGHT;
  const p = model.body.position;
  _up.set(0, 1, 0).applyQuaternion(model.body.quaternion);
  model.keelClearance = p.y + HULL.keelY * _up.y - waveHeightAt(p.x, p.z, model.time);
  model.sensors.keelClearance = model.keelClearance;
}

/**
 * One control step of `dt` seconds for the current rigid-body state: samples the wind, runs the
 * flight computer (or manual control), moves the actuators and evaluates the force model.
 * Does NOT move the body or advance `model.time` — the caller's integrator does.
 */
export function advanceFlightControl(
  model: FlightModel,
  axes: PilotAxes,
  assist: boolean,
  dt: number,
): CarrierForces {
  stepFlightComputer(
    model.computer,
    model.body,
    model.turbines,
    model.controls,
    axes,
    model.sensors,
    assist,
    dt,
  );
  stepTurbineActuators(model.turbines, dt);
  refreshForces(model);
  return model.forces;
}

const _qInv = new Quaternion();
const _dq = new Quaternion();
const _torque = new Vector3();
const _omega = new Vector3();
const _axis = new Vector3();

/**
 * Semi-implicit Euler step of a rigid body with the ship's mass and principal inertia:
 * velocities first, then the pose with the new velocities (the scheme Rapier uses too).
 */
export function integrateRigidBody(body: RigidState, forces: CarrierForces, dt: number): void {
  body.velocity.addScaledVector(forces.force, dt / PHYS.mass);
  if (body.velocity.lengthSq() > MAX_SPEED * MAX_SPEED) body.velocity.setLength(MAX_SPEED);

  _qInv.copy(body.quaternion).invert();
  _torque.copy(forces.torque).applyQuaternion(_qInv);
  _omega.copy(body.angularVelocity).applyQuaternion(_qInv);
  _omega.x += (_torque.x / PHYS.inertia[0]) * dt;
  _omega.y += (_torque.y / PHYS.inertia[1]) * dt;
  _omega.z += (_torque.z / PHYS.inertia[2]) * dt;
  if (_omega.lengthSq() > MAX_ANGULAR_SPEED * MAX_ANGULAR_SPEED) {
    _omega.setLength(MAX_ANGULAR_SPEED);
  }
  body.angularVelocity.copy(_omega).applyQuaternion(body.quaternion);

  body.position.addScaledVector(body.velocity, dt);
  const angle = body.angularVelocity.length() * dt;
  if (angle > 1e-12) {
    _axis.copy(body.angularVelocity).normalize();
    body.quaternion.premultiply(_dq.setFromAxisAngle(_axis, angle)).normalize();
  }
}

/** Advance the whole model by one step with the built-in integrator (no physics engine). */
export function stepFlightModel(
  model: FlightModel,
  axes: PilotAxes,
  assist: boolean,
  dt: number = FIXED_DT,
): void {
  advanceFlightControl(model, axes, assist, dt);
  integrateRigidBody(model.body, model.forces, dt);
  model.time += dt;
}
