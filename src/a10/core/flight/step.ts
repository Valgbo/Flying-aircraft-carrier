/**
 * stepFlight: one 120 Hz step of the aircraft (docs/a10/ARCHITECTURE.md §3, step 3).
 *
 *  1. save prev* (sub-step interpolation for the gun)
 *  2. mass properties (fuel burnt, rounds fired, stores)
 *  3. engines (spool, thrust, fuel flow) at the present flight condition
 *  4. wind at the aircraft: the world's mean wind plus its deterministic turbulence (gustAt)
 *  5. RK4 integration of the rigid body with aero, thrust, external force (recoil) and buffet
 *  6. derived air data, attitude, load factors, buffet
 *  7. ground contact: crash, or bounce when invulnerable
 *  8. clear the external force and moment
 */
import { Vector3 } from 'three';
import { A10, A10_AERO, A10_WARNINGS } from '../../data/aircraft';
import { G0 } from '../constants';
import { attitudeFromQuaternion, headingOf, wrapPi } from '../frames';
import type { Sim } from '../types';
import {
  casFromTas,
  densityAt,
  gustAt,
  pressureAt,
  speedOfSoundAt,
  temperatureAt,
  windAt,
} from '../world';
import { airViscosity } from './aero';
import { checkGroundContact } from './ground';
import {
  STATE_SIZE,
  createFlowRecord,
  createStepContext,
  derivative,
  integrateRk4,
  setInertia,
  setThrust,
  type StepContext,
} from './dynamics';
import { createEngineConditions, spoolMomentum, stepEngine, type EngineConditions } from './engine';
import { updateMass } from './mass';
import type { AircraftState } from './types';

const DEG = Math.PI / 180;
const P0 = 101325;
const T0 = 288.15;

const _state = new Float64Array(STATE_SIZE);
const _deriv = new Float64Array(STATE_SIZE);
const _ctx = createStepContext();
const _record = createFlowRecord();
const _cond = createEngineConditions();
const _att = { heading: 0, pitch: 0, bank: 0 };
const _gust = new Vector3();

/** Copy the integrated part of the aircraft state into a flat array. */
export function packState(ac: AircraftState, s: Float64Array): void {
  s[0] = ac.position.x;
  s[1] = ac.position.y;
  s[2] = ac.position.z;
  s[3] = ac.velocity.x;
  s[4] = ac.velocity.y;
  s[5] = ac.velocity.z;
  s[6] = ac.orientation.x;
  s[7] = ac.orientation.y;
  s[8] = ac.orientation.z;
  s[9] = ac.orientation.w;
  s[10] = ac.angularVelocity.x;
  s[11] = ac.angularVelocity.y;
  s[12] = ac.angularVelocity.z;
  s[13] = ac.fcs.flowAttachment;
}

function unpackState(s: Float64Array, ac: AircraftState): void {
  ac.position.set(s[0], s[1], s[2]);
  ac.velocity.set(s[3], s[4], s[5]);
  ac.orientation.set(s[6], s[7], s[8], s[9]);
  ac.angularVelocity.set(s[10], s[11], s[12]);
  ac.fcs.flowAttachment = s[13];
}

/** Engine conditions at an altitude and Mach (ISA with the world's deviation). */
export function engineConditions(
  altitude: number,
  mach: number,
  isaDeviation: number,
  out: EngineConditions,
): EngineConditions {
  const t = temperatureAt(altitude, isaDeviation);
  out.mach = mach;
  out.delta = pressureAt(altitude, isaDeviation) / P0;
  out.theta = t / T0;
  out.temperature = t;
  return out;
}

/**
 * Fill a step context from the aircraft: mass, inertia, air, wind, thrust, external loads and
 * control deflections. (Shared with the trim solver.)
 */
export function fillContext(sim: Sim, ctx: StepContext): void {
  const ac = sim.aircraft;
  const alt = ac.position.y;
  const isa = sim.world.isaDeviation;
  ctx.mass = ac.mass;
  ctx.cgX = ac.cgBody.x;
  ctx.cgY = ac.cgBody.y;
  ctx.cgZ = ac.cgBody.z;
  setInertia(ctx, ac.inertia);
  ctx.rho = densityAt(alt, isa);
  ctx.speedOfSound = speedOfSoundAt(alt, isa);
  ctx.viscosity = airViscosity(temperatureAt(alt, isa));
  ctx.windX = ac.wind.x;
  ctx.windY = ac.wind.y;
  ctx.windZ = ac.wind.z;
  setThrust(ctx, ac.engines[0].thrust, ac.engines[1].thrust);
  ctx.extFx = ac.externalForceBody.x;
  ctx.extFy = ac.externalForceBody.y;
  ctx.extFz = ac.externalForceBody.z;
  ctx.extMx = ac.externalMomentBody.x;
  ctx.extMy = ac.externalMomentBody.y;
  ctx.extMz = ac.externalMomentBody.z;
  ctx.spool = spoolMomentum(ac.engines[0]) + spoolMomentum(ac.engines[1]);
  ctx.alphaDot = ac.fcs.alphaRate;
  ctx.buffetFy = 0;
  const c = ctx.controls;
  const s = ac.surfaces;
  c.flapsDeg = s.flaps / DEG;
  c.slats = s.slats;
  c.speedBrake = s.speedBrake;
  c.gear = ac.gearPosition;
  c.elevator = s.elevator * A10_AERO.elevatorMax;
  c.aileron = s.aileron * A10_AERO.aileronMax;
  c.rudder = s.rudder * A10_AERO.rudderMax;
  c.asymmetry = ac.fcs.asymmetry;
  c.storesDragArea = Math.max(0, sim.stores.dragArea);
}

/**
 * Recompute every derived field (air data, attitude, load factors, buffet) from the present
 * rigid-body state, using `ctx` for the forces. `dt` > 0 also updates α̇.
 */
export function refreshDerived(sim: Sim, ctx: StepContext, dt: number): void {
  const ac = sim.aircraft;
  packState(ac, _state);
  derivative(_state, _deriv, ctx, _record);
  const r = _record;
  const alt = ac.position.y;
  const isa = sim.world.isaDeviation;
  ac.airVelocityBody.set(r.airX, r.airY, r.airZ);
  ac.tas = r.speed;
  ac.mach = r.mach;
  ac.dynamicPressure = r.dynamicPressure;
  ac.ias = casFromTas(r.speed, alt, isa);
  if (dt > 0) {
    const raw = wrapPi(r.alpha - ac.alpha) / dt;
    ac.fcs.alphaRate += (raw - ac.fcs.alphaRate) * Math.min(1, dt / 0.05);
  }
  ac.alpha = r.alpha;
  ac.beta = r.beta;
  ac.gLoad = r.specificY / G0;
  ac.lateralG = r.specificX / G0;
  ac.axialG = -r.specificZ / G0;
  attitudeFromQuaternion(ac.orientation, _att);
  ac.heading = _att.heading;
  ac.pitch = _att.pitch;
  ac.bank = _att.bank;
  const v = ac.velocity;
  ac.verticalSpeed = v.y;
  ac.groundSpeed = Math.sqrt(v.x * v.x + v.z * v.z);
  ac.flightPathAngle = Math.atan2(v.y, ac.groundSpeed);
  ac.track = ac.groundSpeed > 0.1 ? headingOf(v.x, v.z) : ac.heading;
  ac.altitude = alt;
  ac.agl = alt - sim.world.terrain.heightAt(ac.position.x, ac.position.z);
  ac.stallAlpha = r.coefficients.alphaStall;
  ac.liftCoefficient = r.coefficients.cl;
  ac.dragCoefficient = r.coefficients.cd;
  // Buffet: from a few degrees below the stall angle and with separated flow; above Vne.
  const onset = ac.stallAlpha - A10_AERO.buffetOnsetMargin;
  const separated = Math.min(1, Math.max(0, (0.95 - ac.fcs.flowAttachment) / 0.5));
  const stallBuffet = Math.max(
    Math.min(1, Math.max(0, (ac.alpha - onset) / (A10_AERO.buffetOnsetMargin + 2 * DEG))),
    separated,
  );
  const overspeed = Math.min(
    1,
    Math.max(0, (ac.ias - A10.vne) / A10_WARNINGS.overspeedBuffetRange),
  );
  ac.buffet = ac.tas > 20 ? Math.max(stallBuffet, overspeed) : 0;
}

/** Six-degree-of-freedom step (see the file comment). */
export function stepFlight(sim: Sim, dt: number): void {
  const ac = sim.aircraft;
  ac.prevPosition.copy(ac.position);
  ac.prevVelocity.copy(ac.velocity);
  ac.prevOrientation.copy(ac.orientation);
  if (ac.crashed) {
    ac.acceleration.set(0, 0, 0);
    ac.externalForceBody.set(0, 0, 0);
    ac.externalMomentBody.set(0, 0, 0);
    return;
  }

  updateMass(sim);

  // Engines at the present flight condition; fuel burns.
  const isa = sim.world.isaDeviation;
  const alt = ac.position.y;
  engineConditions(alt, ac.tas / speedOfSoundAt(alt, isa), isa, _cond);
  const fuelOk = ac.fuel > 0;
  const firingAid = sim.input.trigger > 0;
  for (let i = 0; i < 2; i++) {
    const e = ac.engines[i];
    stepEngine(e, _cond, dt, fuelOk);
    e.igniters = firingAid && e.running;
    ac.fuel -= e.fuelFlow * dt;
  }
  if (ac.fuel < 0) ac.fuel = 0;

  // Air at the aircraft: mean wind plus the world's frozen turbulence field, flown through.
  windAt(sim.world, ac.position, ac.wind);
  ac.wind.add(gustAt(sim.world, ac.position, sim.time, _gust));

  fillContext(sim, _ctx);
  if (ac.buffet > 0) {
    const k = Math.min(1, dt / 0.04);
    ac.fcs.buffetNoise += (sim.rng.air.normal() * 2.5 - ac.fcs.buffetNoise) * k;
    _ctx.buffetFy =
      ac.buffet * A10_AERO.buffetForce * ac.dynamicPressure * A10.wingArea * ac.fcs.buffetNoise;
  } else {
    ac.fcs.buffetNoise = 0;
  }

  packState(ac, _state);
  integrateRk4(_state, dt, _ctx);
  unpackState(_state, ac);
  ac.acceleration.subVectors(ac.velocity, ac.prevVelocity).divideScalar(dt);

  refreshDerived(sim, _ctx, dt);
  if (ac.gLoad > ac.maxG) ac.maxG = ac.gLoad;
  if (ac.gLoad < ac.minG) ac.minG = ac.gLoad;

  // A bounce (invulnerable) puts the aircraft into a new attitude and velocity: re-derive.
  if (checkGroundContact(sim) && !ac.crashed) refreshDerived(sim, _ctx, 0);

  ac.externalForceBody.set(0, 0, 0);
  ac.externalMomentBody.set(0, 0, 0);
}

/** Scratch shared with the trim solver. */
export const scratch = {
  state: _state,
  deriv: _deriv,
  ctx: _ctx,
  record: _record,
  cond: _cond,
};
