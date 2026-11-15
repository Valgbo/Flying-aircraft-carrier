/**
 * IdleDriver — drives `sim` in the menu and hangar scenes (and in sandboxes): the ship hovers
 * at IDLE_ALTITUDE with a gentle bob while the turbines follow the hangar demo sliders.
 * Purely kinematic; no physics engine is loaded. Flying screens use PhysicsDriver instead.
 */
import { useFrame } from '@react-three/fiber';
import { Euler } from 'three';
import { debugFlags } from '../config/debugFlags';
import { FRAME_PRIORITY } from '../config/frame';
import { HOVER_THROTTLE, IDLE_ALTITUDE, PHYS } from '../config/physicsConfig';
import { combineInput } from '../controls/input';
import { sim, updateDerived } from '../state/sim';
import { publishTelemetry } from '../state/telemetry';
import { isFlyingScreen, useGameStore } from '../state/useGameStore';
import { DEG2RAD, clamp, damp, moveToward } from '../utils/math';

const _euler = new Euler(0, 0, 0, 'YXZ');

/**
 * Tweakable idle-scene parameters (used by sandboxes to put the ship where a module needs it,
 * e.g. low over the water to look at downwash). The app itself leaves the defaults alone.
 */
export const idleConfig = {
  /** Hover altitude of the ship origin, m ASL. */
  altitude: IDLE_ALTITUDE as number,
  /** Constant speed along the ship's bow direction (-Z), m/s. */
  forwardSpeed: 0,
};

/** Advance the idle hover by `dt` seconds. Exported so sandboxes and tests can reuse it. */
export function stepIdle(dt: number): void {
  const { hangar, screen, paused } = useGameStore.getState();
  if (debugFlags.fixedTime !== null) {
    sim.time = debugFlags.fixedTime;
    sim.dt = 0;
    dt = 1; // let actuators settle instantly on their commands
  } else if (paused) {
    sim.dt = 0;
    return;
  } else {
    sim.time += dt;
    sim.dt = dt;
  }
  combineInput();

  const t = sim.time;
  const c = sim.carrier;
  c.position.set(0, idleConfig.altitude + Math.sin(t * 0.35) * 1.4, -idleConfig.forwardSpeed * t);
  _euler.set(Math.sin(t * 0.27) * 0.007, 0, Math.sin(t * 0.21 + 1.3) * 0.01);
  c.quaternion.setFromEuler(_euler);
  c.velocity.set(0, Math.cos(t * 0.35) * 0.35 * 1.4, -idleConfig.forwardSpeed);
  c.angularVelocity.set(0, 0, 0);

  const inHangar = screen === 'hangar';
  const throttleCmd = inHangar ? clamp(hangar.demoThrottle, 0, 1) : HOVER_THROTTLE;
  const tiltCmd = inHangar ? clamp(hangar.demoTiltDeg * DEG2RAD, PHYS.tiltMin, PHYS.tiltMax) : 0;
  for (let i = 0; i < 4; i++) {
    const turbine = sim.turbines[i];
    turbine.enabled = true;
    turbine.throttleCmd = throttleCmd;
    turbine.tiltCmd = tiltCmd;
    const rate = throttleCmd > turbine.throttle ? PHYS.spoolUpRate : PHYS.spoolDownRate;
    turbine.throttle = dt >= 1 ? throttleCmd : damp(turbine.throttle, throttleCmd, rate * 2, dt);
    turbine.tilt = dt >= 1 ? tiltCmd : moveToward(turbine.tilt, tiltCmd, PHYS.tiltRate * dt);
    turbine.thrust = turbine.throttle * PHYS.maxThrust;
  }
  sim.controls.targetAltitude = idleConfig.altitude;

  updateDerived(sim.dt);
  publishTelemetry();
}

export interface IdleDriverProps {
  /**
   * Keep driving even while the store is on a flying screen. Sandboxes use this to show flight
   * UI over the idle hover; the app never does.
   */
  always?: boolean;
}

export default function IdleDriver({ always = false }: IdleDriverProps) {
  useFrame((_, delta) => {
    // A frame can still reach this driver after the store has switched to a flying screen and
    // reset `sim` for it, but before the scene has re-rendered. It must not touch that state.
    if (!always && isFlyingScreen(useGameStore.getState().screen)) return;
    stepIdle(Math.min(delta, 0.1));
  }, FRAME_PRIORITY.driver);
  return null;
}
