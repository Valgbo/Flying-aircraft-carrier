/**
 * FLIGHT module public API (docs/a10/ARCHITECTURE.md §4): the A-10C as a six-degree-of-freedom
 * rigid body integrated at 120 Hz.
 *
 *  aero.ts       coefficient model: stall and post-stall (dynamic separation), flaps, slats,
 *                speed brakes, gear, stores drag, compressibility, lateral–directional
 *  engine.ts     two TF34-GE-100A: spool lag, thrust lapse, idle ram drag, fuel flow, N1/N2/ITT
 *  mass.ts       mass, CG and inertia from fuel, ammunition (and kept cases) and stores
 *  dynamics.ts   rigid-body equations, RK4
 *  step.ts       stepFlight: engines, the world's wind and turbulence (windAt + gustAt),
 *                integration, air data, buffet; ground.ts: ground contact (crash or bounce)
 *  controls.ts   stepFlightControls: actuators, SAS, trim and auto-trim, flaps, gear, speed
 *                brakes, slats; pac.ts and autopilot.ts add their series commands
 *  warnings.ts   stepWarnings: stall tones, over-g, altitude, PULL UP prediction, overspeed, fuel
 *  trim.ts       trim solver (air start, tests)
 *  testbed.ts    the flight module stepped alone over flat ground (tests, the flight sandbox);
 *                import it directly, it is not re-exported here
 *
 * Numbers live in data/aircraft.ts with their sources; tests/unit/a10/flight*.test.ts fly the
 * model against the public performance figures (PLAN_A10.md §5).
 */
import { Quaternion, Vector3 } from 'three';
import { A10, A10_WARNINGS } from '../../data/aircraft';
import { quaternionFromAttitude } from '../frames';
import type { Sim } from '../types';
import { speedOfSoundAt } from '../world';
import type { Terrain } from '../world/types';
import { createEngineState, settleEngine } from './engine';
import { updateMass } from './mass';
import { engineConditions } from './step';
import { startTrim } from './trim';
import type { AircraftState, WarningId } from './types';

export type * from './types';
export { stepFlight } from './step';
export { stepFlightControls } from './controls';
export { stepWarnings, predictRecoveryClearance } from './warnings';
export { autopilotCommand, engageAutopilot, disengageAutopilot } from './autopilot';
export { trimAircraft, levelFlightThrottle, type TrimResult } from './trim';
export { maxThrust, steadyThrust, idleThrust, type EngineConditions } from './engine';
export { staticLift, maxStaticLift, stallAlphaFor, machLiftFactor } from './aero';
export { engineConditions } from './step';

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
  /** Flight-path angle, rad (+ climb, − dive; default 0 = level). The start is trimmed along it. */
  gamma?: number;
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

/** Default throttle at an air start (matches the input layer's default lever). */
const START_LEVER = 0.85;

/**
 * A new aircraft in level flight at the air start: 60 % internal fuel, gear and flaps up. The
 * attitude, surfaces and trim are solved for steady flight when createSim first computes the
 * mass properties (updateMassProperties), so the flight begins trimmed.
 */
export function createAircraftState(terrain: Terrain, start: AirStart): AircraftState {
  const ground = terrain.heightAt(start.x, start.z);
  const position = new Vector3(start.x, ground + start.agl, start.z);
  const gamma = start.gamma ?? 0;
  const orientation = quaternionFromAttitude(start.heading, gamma + 0.03, 0, new Quaternion());
  const velocity = new Vector3(
    Math.sin(start.heading) * Math.cos(gamma) * start.speed,
    Math.sin(gamma) * start.speed,
    -Math.cos(start.heading) * Math.cos(gamma) * start.speed,
  );
  const warnings = {} as Record<WarningId, boolean>;
  for (const w of WARNINGS) warnings[w] = false;
  const cond = engineConditions(position.y, start.speed / speedOfSoundAt(position.y), 0, {
    mach: 0,
    delta: 1,
    theta: 1,
    temperature: 288.15,
  });
  const engines: [ReturnType<typeof createEngineState>, ReturnType<typeof createEngineState>] = [
    createEngineState(START_LEVER),
    createEngineState(START_LEVER),
  ];
  for (const e of engines) settleEngine(e, cond);
  const fuel = A10.internalFuel * 0.6;
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
    wind: new Vector3(),
    tas: start.speed,
    ias: start.speed,
    mach: start.speed / speedOfSoundAt(position.y),
    dynamicPressure: 0,
    alpha: 0.03,
    beta: 0,
    gLoad: 1,
    lateralG: 0,
    axialG: 0,
    heading: start.heading,
    pitch: gamma + 0.03,
    bank: 0,
    flightPathAngle: gamma,
    track: start.heading,
    groundSpeed: start.speed,
    verticalSpeed: velocity.y,
    altitude: position.y,
    agl: start.agl,
    stallAlpha: 0.25,
    liftCoefficient: 0,
    dragCoefficient: 0,
    buffet: 0,
    mass: A10.emptyMass + fuel,
    cgBody: new Vector3(),
    inertia: { xx: 5e4, yy: 1e5, zz: 1.4e5, xz: 0 },
    fuel,
    gLimitPositive: A10.gLimitPositive,
    gLimitNegative: A10.gLimitNegative,
    engines,
    surfaces: { elevator: 0, aileron: 0, rudder: 0, flaps: 0, speedBrake: 0, slats: 0 },
    trim: { pitch: 0, roll: 0, yaw: 0 },
    flapHandle: 0,
    speedBrakeCmd: 0,
    gearDown: false,
    gearPosition: 0,
    autopilot: {
      engaged: false,
      mode: 'PATH',
      refAltitude: position.y,
      refHeading: start.heading,
      refPitch: gamma,
      refBank: 0,
      pitchCmd: 0,
      rollCmd: 0,
    },
    pac: {
      stage: 0,
      active: false,
      pitchCmd: 0,
      yawCmd: 0,
      aimPoint: new Vector3(),
      aimValid: false,
      overridden: false,
      errorAz: 0,
      errorEl: 0,
    },
    altitudeAlert: A10_WARNINGS.altitudeAlertDefault,
    warnings,
    groundCollision: { clearance: Infinity, timeToImpact: Infinity },
    fcs: {
      pitchWashout: 0,
      yawWashout: 0,
      apGIntegral: 0,
      apBankIntegral: 0,
      pacPrevAz: 0,
      pacPrevEl: 0,
      pacPrevValid: false,
      pacRateAz: 0,
      pacRateEl: 0,
      pacIntAz: 0,
      pacIntEl: 0,
      elevatorCmd: 0,
      aileronCmd: 0,
      rudderCmd: 0,
      flowAttachment: 1,
      alphaRate: 0,
      asymmetry: 0,
      trimPending: true,
      buffetNoise: 0,
      flapDnBlown: false,
      flapMvrBlown: false,
      gcasCounter: 0,
      inContact: false,
    },
    crashed: false,
    maxG: 1,
    minG: 1,
  };
}

/**
 * Recompute mass, CG, inertia and g limits after fuel, ammunition or stores change (stepFlight
 * also does it every step). The first call after createAircraftState also trims the air start.
 */
export function updateMassProperties(sim: Sim): void {
  updateMass(sim);
  if (sim.aircraft.fcs.trimPending) startTrim(sim);
}

/** Flap handle: 0 UP, 1 MVR (7°), 2 DN (20°). The flaps then travel at their own rate. */
export function setFlapHandle(sim: Sim, handle: 0 | 1 | 2): void {
  const h = Math.min(2, Math.max(0, Math.round(handle))) as 0 | 1 | 2;
  sim.aircraft.flapHandle = h;
}

/** Gear handle. The gear takes several seconds to travel. */
export function setGear(sim: Sim, down: boolean): void {
  sim.aircraft.gearDown = down;
}

/** Fill the internal tanks (rearm and refuel from the pause menu). */
export function refuel(sim: Sim): void {
  sim.aircraft.fuel = A10.internalFuel;
  updateMassProperties(sim);
}

/** Altitude alert setting, m above the ground (radar). */
export function setAltitudeAlert(sim: Sim, metresAgl: number): void {
  if (!Number.isFinite(metresAgl)) return;
  sim.aircraft.altitudeAlert = Math.min(15000, Math.max(0, metresAgl));
}
