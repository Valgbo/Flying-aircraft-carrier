/**
 * `sim` — the live, MUTABLE simulation state. It is a plain singleton, not React state:
 * the active driver writes it every frame and visual components read it inside `useFrame`
 * (no re-renders). UI that needs React updates reads the ≈10 Hz `telemetry` snapshot in the
 * store instead (see telemetry.ts).
 *
 * This module must stay free of React and of the store (the store imports it).
 */
import { Color, Quaternion, Vector3 } from 'three';
import { FLOATING_ALTITUDE, HULL } from '../config/layout';
import { HOVER_THROTTLE, IDLE_ALTITUDE, OPS_START_ALTITUDE, PHYS } from '../config/physicsConfig';
import { waveHeightAt } from '../config/waves';
import { RAD2DEG, clamp, wrapDeg360 } from '../utils/math';
import type { Screen, SimState, TurbineSim } from './types';

function makeTurbine(): TurbineSim {
  return { enabled: true, throttleCmd: 0, throttle: 0, tiltCmd: 0, tilt: 0, thrust: 0 };
}

export const sim: SimState = {
  time: 0,
  dt: 0,
  carrier: {
    position: new Vector3(0, IDLE_ALTITUDE, 0),
    quaternion: new Quaternion(),
    velocity: new Vector3(),
    angularVelocity: new Vector3(),
    altitude: IDLE_ALTITUDE,
    keelClearance: IDLE_ALTITUDE + HULL.keelY,
    speed: 0,
    forwardSpeed: 0,
    verticalSpeed: 0,
    headingDeg: 0,
    pitch: 0,
    roll: 0,
    gLoad: 1,
    afloat: false,
  },
  turbines: [makeTurbine(), makeTurbine(), makeTurbine(), makeTurbine()],
  controls: {
    targetAltitude: IDLE_ALTITUDE,
    tiltLever: 0,
    manualThrottle: [0, 0, 0, 0],
    manualTilt: [0, 0, 0, 0],
  },
  env: {
    sunDirection: new Vector3(0.45, 0.62, 0.64).normalize(),
    daylight: 1,
    sunColor: new Color(1.0, 0.95, 0.86).multiplyScalar(2.2),
    horizonColor: new Color('#a9c8e2'),
    zenithColor: new Color('#3d7fc4'),
    wind: new Vector3(),
    cloudCover: 0,
  },
  jets: [],
  camera: {
    position: new Vector3(0, IDLE_ALTITUDE + 80, 420),
    shake: 0,
  },
};

const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _prevVel = new Vector3();
let _hasPrevVel = false;

/**
 * Recompute the derived fields of `sim.carrier` from its pose and velocities.
 * Drivers call this once per frame after updating position / quaternion / velocity.
 * `dt` (seconds of simulated time since the previous call) is used to estimate the g-load;
 * pass 0 to leave the g-load untouched.
 */
export function updateDerived(dt = 0): void {
  const c = sim.carrier;
  _fwd.set(0, 0, -1).applyQuaternion(c.quaternion);
  _right.set(1, 0, 0).applyQuaternion(c.quaternion);
  _up.set(0, 1, 0).applyQuaternion(c.quaternion);

  c.altitude = c.position.y;
  const keelY = c.position.y + HULL.keelY * _up.y;
  c.keelClearance = keelY - waveHeightAt(c.position.x, c.position.z, sim.time);
  c.afloat = c.keelClearance < 0;
  c.speed = Math.hypot(c.velocity.x, c.velocity.z);
  c.forwardSpeed = c.velocity.dot(_fwd);
  c.verticalSpeed = c.velocity.y;
  c.headingDeg = wrapDeg360(Math.atan2(_fwd.x, -_fwd.z) * RAD2DEG);
  c.pitch = Math.asin(clamp(_fwd.y, -1, 1));
  c.roll = Math.atan2(-_right.y, _up.y);

  if (dt > 1e-5 && _hasPrevVel) {
    const ax = (c.velocity.x - _prevVel.x) / dt;
    const ay = (c.velocity.y - _prevVel.y) / dt + PHYS.gravity;
    const az = (c.velocity.z - _prevVel.z) / dt;
    const g = (ax * _up.x + ay * _up.y + az * _up.z) / PHYS.gravity;
    // light smoothing — raw finite differences are noisy
    c.gLoad += (clamp(g, -4, 8) - c.gLoad) * Math.min(1, dt * 6);
  }
  if (dt > 1e-5) {
    _prevVel.copy(c.velocity);
    _hasPrevVel = true;
  }
}

/**
 * Put the whole simulation into the starting state for a screen:
 *   menu / hangar → hovering level at IDLE_ALTITUDE, turbines at hover throttle
 *   flight        → floating at rest on the sea, turbines idle
 *   ops           → hovering level at OPS_START_ALTITUDE, flight assist holding altitude
 * Called by the store when the screen changes or the flight is restarted (never by components).
 */
export function resetSimForScreen(screen: Screen): void {
  const afloat = screen === 'flight';
  const altitude = afloat
    ? FLOATING_ALTITUDE
    : screen === 'ops'
      ? OPS_START_ALTITUDE
      : IDLE_ALTITUDE;

  sim.time = 0;
  sim.dt = 0;
  const c = sim.carrier;
  c.position.set(0, altitude, 0);
  c.quaternion.identity();
  c.velocity.set(0, 0, 0);
  c.angularVelocity.set(0, 0, 0);
  c.gLoad = 1;
  _hasPrevVel = false;

  const throttle = afloat ? 0 : HOVER_THROTTLE;
  for (let i = 0; i < 4; i++) {
    const t = sim.turbines[i];
    t.enabled = true;
    t.throttleCmd = throttle;
    t.throttle = throttle;
    t.tiltCmd = 0;
    t.tilt = 0;
    t.thrust = throttle * PHYS.maxThrust;
    sim.controls.manualThrottle[i] = throttle;
    sim.controls.manualTilt[i] = 0;
  }
  sim.controls.targetAltitude = altitude;
  sim.controls.tiltLever = 0;

  sim.env.wind.set(0, 0, 0);
  sim.jets.length = 0;
  sim.camera.shake = 0;

  updateDerived(0);
}

/** Add camera-shake energy (0..1 per call is sensible). The camera rig consumes and decays it. */
export function addCameraShake(amount: number): void {
  sim.camera.shake = Math.min(1.5, sim.camera.shake + amount);
}

resetSimForScreen('menu');
