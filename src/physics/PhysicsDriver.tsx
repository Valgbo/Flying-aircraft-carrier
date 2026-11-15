/**
 * PhysicsDriver — drives `sim` on the flying screens (free flight, flight ops).
 *
 * PLACEHOLDER: a tiny kinematic "arcade" model so the rest of the app (controls, HUD, cameras)
 * can be developed against something that moves. It is replaced by the real rigid-body flight
 * model (Rapier + per-turbine thrust + flight assist) and loaded lazily by SceneRoot.
 */
import { useFrame } from '@react-three/fiber';
import { Euler, Vector3 } from 'three';
import { FRAME_PRIORITY } from '../config/frame';
import { FLOATING_ALTITUDE } from '../config/layout';
import { HOVER_THROTTLE, PHYS } from '../config/physicsConfig';
import { combineInput } from '../controls/input';
import { sim, updateDerived } from '../state/sim';
import { publishTelemetry } from '../state/telemetry';
import { useGameStore } from '../state/useGameStore';
import { clamp, damp, moveToward } from '../utils/math';

const _euler = new Euler(0, 0, 0, 'YXZ');
const _fwd = new Vector3();
let yaw = 0;

export default function PhysicsDriver() {
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    if (useGameStore.getState().paused) {
      sim.dt = 0;
      return;
    }
    if (sim.time === 0) yaw = 0;
    sim.time += dt;
    sim.dt = dt;
    const input = combineInput();
    const c = sim.carrier;
    const ctl = sim.controls;

    ctl.targetAltitude = clamp(
      ctl.targetAltitude + input.collective * 40 * dt,
      FLOATING_ALTITUDE,
      4000,
    );
    ctl.tiltLever = clamp(ctl.tiltLever + input.tilt * 0.4 * dt, PHYS.tiltMin, PHYS.tiltMax);
    const vy = clamp((ctl.targetAltitude - c.position.y) * 0.8, -25, 25);
    yaw -= input.yaw * 0.25 * dt;
    _euler.set(0, yaw, -input.strafe * 0.05);
    c.quaternion.setFromEuler(_euler);
    _fwd.set(0, 0, -1).applyQuaternion(c.quaternion);
    const airborne = c.position.y > FLOATING_ALTITUDE + 2;
    const targetSpeed = airborne ? Math.sin(ctl.tiltLever) * 110 : 0;
    const speed = damp(c.forwardSpeed, targetSpeed, 0.4, dt);
    c.velocity.set(_fwd.x * speed, damp(c.velocity.y, vy, 1.5, dt), _fwd.z * speed);
    c.position.addScaledVector(c.velocity, dt);
    c.position.y = Math.max(c.position.y, FLOATING_ALTITUDE);

    const throttleCmd = airborne || vy > 0.5 ? clamp(HOVER_THROTTLE + vy * 0.012, 0, 1) : 0;
    for (let i = 0; i < 4; i++) {
      const t = sim.turbines[i];
      t.throttleCmd = t.enabled ? throttleCmd : 0;
      t.tiltCmd = ctl.tiltLever;
      t.throttle = damp(t.throttle, t.throttleCmd, 1.5, dt);
      t.tilt = moveToward(t.tilt, t.tiltCmd, PHYS.tiltRate * dt);
      t.thrust = t.throttle * PHYS.maxThrust;
    }

    updateDerived(dt);
    publishTelemetry();
  }, FRAME_PRIORITY.driver);
  return null;
}
