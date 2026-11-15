/**
 * PhysicsDriver — drives `sim` on the flying screens (free flight, flight ops).
 *
 * A Rapier world with ONE dynamic rigid body: the ship, with the mass and principal inertia
 * from `PHYS` and no colliders. Rapier is only the integrator. Before every fixed 1/60 s step
 * the driver runs the engine-independent flight pipeline (wind → flight computer or manual
 * control → turbine actuators → force model, see flightModel.ts) on the body's current state
 * and applies the resulting force and torque; the unit tests fly the very same pipeline with
 * their own integrator.
 *
 * After the world has stepped, a `useFrame` at FRAME_PRIORITY.driver copies the interpolated
 * pose and the velocities into `sim.carrier`, advances `sim.time` / `sim.dt` by the simulated
 * time actually stepped this frame, and publishes telemetry. The initial conditions are
 * whatever is in `sim` when the component mounts (SceneRoot re-keys it on every reset).
 *
 * Must be mounted at the scene root: the body's object is read in world space.
 */
import { useFrame } from '@react-three/fiber';
import {
  Physics,
  RigidBody,
  useBeforePhysicsStep,
  type RapierRigidBody,
} from '@react-three/rapier';
import { useRef, useState } from 'react';
import { Quaternion, Vector3, type Group } from 'three';
import type { RigidState } from '../carrier/carrierPhysics';
import { FRAME_PRIORITY } from '../config/frame';
import { TURBINE_NAMES } from '../config/layout';
import { HARD_LANDING_SINK_RATE, PHYS, WIND } from '../config/physicsConfig';
import { combineInput, input } from '../controls/input';
import { emitEvent } from '../state/events';
import { addCameraShake, sim, updateDerived } from '../state/sim';
import { publishTelemetry } from '../state/telemetry';
import type { Quad } from '../state/types';
import { useGameStore } from '../state/useGameStore';
import { clamp } from '../utils/math';
import {
  createWaterContactState,
  updateWaterContact,
  type WaterContactState,
} from './flightEvents';
import { FIXED_DT, advanceFlightControl, createFlightModel, type FlightModel } from './flightModel';

const NO_GRAVITY: [number, number, number] = [0, 0, 0];
const CENTRE_OF_MASS = { x: 0, y: 0, z: 0 };
const PRINCIPAL_INERTIA = { x: PHYS.inertia[0], y: PHYS.inertia[1], z: PHYS.inertia[2] };
const PRINCIPAL_FRAME = { x: 0, y: 0, z: 0, w: 1 };

type Vec3 = [number, number, number];

/** Everything the driver keeps between steps. Created once per mount. */
interface FlightRuntime {
  model: FlightModel;
  /** Last finite body state, restored if the integrator ever hands back garbage. */
  lastGood: RigidState;
  contact: WaterContactState;
  enabled: Quad<boolean>;
  assist: boolean;
  /** The Rapier body that has received its mass properties. */
  configuredBody: RapierRigidBody | null;
  /** Physics steps taken since the last rendered frame. */
  pendingSteps: number;
  /** Pose and velocities the body is created with. */
  initial: {
    position: Vec3;
    quaternion: [number, number, number, number];
    linear: Vec3;
    angular: Vec3;
  };
}

function createRuntime(): FlightRuntime {
  const c = sim.carrier;
  const body: RigidState = {
    position: c.position.clone(),
    quaternion: c.quaternion.clone(),
    velocity: c.velocity.clone(),
    angularVelocity: c.angularVelocity.clone(),
  };
  const state = useGameStore.getState();
  const model = createFlightModel({
    body,
    turbines: sim.turbines,
    controls: sim.controls,
    wind: sim.env.wind,
    time: sim.time,
    windLevel: state.screen === 'ops' ? WIND.opsLevel : WIND.freeFlightLevel,
  });
  return {
    model,
    lastGood: {
      position: body.position.clone(),
      quaternion: body.quaternion.clone(),
      velocity: body.velocity.clone(),
      angularVelocity: body.angularVelocity.clone(),
    },
    contact: createWaterContactState(model.keelClearance),
    enabled: [
      sim.turbines[0].enabled,
      sim.turbines[1].enabled,
      sim.turbines[2].enabled,
      sim.turbines[3].enabled,
    ],
    assist: state.assistEnabled,
    configuredBody: null,
    pendingSteps: 0,
    initial: {
      position: [c.position.x, c.position.y, c.position.z],
      quaternion: [c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w],
      linear: [c.velocity.x, c.velocity.y, c.velocity.z],
      angular: [c.angularVelocity.x, c.angularVelocity.y, c.angularVelocity.z],
    },
  };
}

function isFiniteState(
  p: { x: number; y: number; z: number },
  q: { x: number; y: number; z: number; w: number },
  v: { x: number; y: number; z: number },
  w: { x: number; y: number; z: number },
): boolean {
  return (
    Number.isFinite(p.x + p.y + p.z) &&
    Number.isFinite(q.x + q.y + q.z + q.w) &&
    Number.isFinite(v.x + v.y + v.z) &&
    Number.isFinite(w.x + w.y + w.z)
  );
}

/** Copy the Rapier body into the model, or put the last good state back if it went non-finite. */
function readBody(runtime: FlightRuntime, body: RapierRigidBody): void {
  const p = body.translation();
  const q = body.rotation();
  const v = body.linvel();
  const w = body.angvel();
  const state = runtime.model.body;
  if (isFiniteState(p, q, v, w)) {
    state.position.set(p.x, p.y, p.z);
    state.quaternion.set(q.x, q.y, q.z, q.w);
    state.velocity.set(v.x, v.y, v.z);
    state.angularVelocity.set(w.x, w.y, w.z);
    runtime.lastGood.position.copy(state.position);
    runtime.lastGood.quaternion.copy(state.quaternion);
    runtime.lastGood.velocity.copy(state.velocity);
    runtime.lastGood.angularVelocity.copy(state.angularVelocity);
    return;
  }
  state.position.copy(runtime.lastGood.position);
  state.quaternion.copy(runtime.lastGood.quaternion);
  state.velocity.set(0, 0, 0);
  state.angularVelocity.set(0, 0, 0);
  body.setTranslation(state.position, true);
  body.setRotation(state.quaternion, true);
  body.setLinvel(state.velocity, true);
  body.setAngvel(state.angularVelocity, true);
}

/** Report engine switches and flight-assist changes made since the previous step. */
function watchSwitches(runtime: FlightRuntime, assist: boolean): void {
  for (let i = 0; i < 4; i++) {
    const enabled = sim.turbines[i].enabled;
    if (enabled === runtime.enabled[i]) continue;
    runtime.enabled[i] = enabled;
    emitEvent('engineToggled', { index: i, enabled });
    if (runtime.contact.inWater) continue;
    const { pushMessage } = useGameStore.getState();
    if (enabled) pushMessage(`ENGINE ${TURBINE_NAMES[i]} RESTARTED`, 'info');
    else pushMessage(`ENGINE ${TURBINE_NAMES[i]} OFF — LOSING LIFT`, 'alert', 5000);
  }
  if (assist !== runtime.assist) {
    runtime.assist = assist;
    emitEvent('assistChanged', { enabled: assist });
  }
}

/** Report the hull leaving or meeting the water. */
function watchWater(runtime: FlightRuntime): void {
  const event = updateWaterContact(runtime.contact, runtime.model.keelClearance);
  if (event === null) return;
  const { pushMessage } = useGameStore.getState();
  if (event === 'liftOff') {
    emitEvent('liftOff');
    pushMessage('LIFT-OFF', 'info');
    return;
  }
  const sinkRate = Math.max(0, -runtime.model.body.velocity.y);
  emitEvent('splashdown', { sinkRate });
  if (sinkRate > HARD_LANDING_SINK_RATE) {
    pushMessage('HARD LANDING', 'warn', 5000);
    addCameraShake(clamp(sinkRate / 20, 0.5, 1.2));
  } else {
    pushMessage('SPLASHDOWN', 'info');
    addCameraShake(clamp(sinkRate / 20, 0.08, 0.35));
  }
}

const _position = new Vector3();
const _quaternion = new Quaternion();

function CarrierBody() {
  const bodyRef = useRef<RapierRigidBody>(null);
  const probeRef = useRef<Group>(null);
  const [runtime] = useState(createRuntime);

  useBeforePhysicsStep(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (runtime.configuredBody !== body) {
      body.setAdditionalMassProperties(
        PHYS.mass,
        CENTRE_OF_MASS,
        PRINCIPAL_INERTIA,
        PRINCIPAL_FRAME,
        true,
      );
      runtime.configuredBody = body;
    }
    readBody(runtime, body);

    combineInput();
    const { assistEnabled, screen } = useGameStore.getState();
    const model = runtime.model;
    model.windLevel = screen === 'ops' ? WIND.opsLevel : WIND.freeFlightLevel;
    watchSwitches(runtime, assistEnabled);

    const forces = advanceFlightControl(model, input, assistEnabled, FIXED_DT);
    body.resetForces(false);
    body.resetTorques(false);
    body.addForce(forces.force, true);
    body.addTorque(forces.torque, true);

    watchWater(runtime);
    model.time += FIXED_DT;
    runtime.pendingSteps++;
  });

  useFrame(() => {
    // other systems read `input` every frame, also on frames without a physics step
    combineInput();
    const body = bodyRef.current;
    const object = probeRef.current?.parent;
    const steps = runtime.pendingSteps;
    runtime.pendingSteps = 0;
    sim.dt = steps * FIXED_DT;
    if (!body || !object || useGameStore.getState().paused) {
      sim.dt = 0;
      return;
    }
    sim.time = runtime.model.time;

    // the interpolated pose Rapier wrote to the body's object; velocities from the last step
    _position.copy(object.position);
    _quaternion.copy(object.quaternion);
    const v = body.linvel();
    const w = body.angvel();
    if (
      isFiniteState(_position, _quaternion, v, w) &&
      _quaternion.lengthSq() > 0.5 &&
      runtime.configuredBody === body
    ) {
      const c = sim.carrier;
      c.position.copy(_position);
      c.quaternion.copy(_quaternion).normalize();
      c.velocity.set(v.x, v.y, v.z);
      c.angularVelocity.set(w.x, w.y, w.z);
    }
    updateDerived(sim.dt);
    publishTelemetry();
  }, FRAME_PRIORITY.driver);

  return (
    <RigidBody
      ref={bodyRef}
      type="dynamic"
      colliders={false}
      canSleep={false}
      gravityScale={0}
      linearDamping={0}
      angularDamping={0}
      position={runtime.initial.position}
      quaternion={runtime.initial.quaternion}
      linearVelocity={runtime.initial.linear}
      angularVelocity={runtime.initial.angular}
    >
      <group ref={probeRef} />
    </RigidBody>
  );
}

export default function PhysicsDriver() {
  const paused = useGameStore((s) => s.paused);
  return (
    <Physics
      gravity={NO_GRAVITY}
      timeStep={FIXED_DT}
      paused={paused}
      interpolate
      colliders={false}
      updatePriority={FRAME_PRIORITY.physics}
    >
      <CarrierBody />
    </Physics>
  );
}
