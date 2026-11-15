/**
 * Physics sandbox — the flight model by itself: the real PhysicsDriver (Rapier path) flying a
 * plain debug ship over a wireframe sea, with live readouts. Open /?sandbox=physics
 *
 * URL parameters:
 *   scenario=float|takeoff|hover|cruise|turn|strafe|engineout|cut|land|manual   scripted pilot (default takeoff)
 *   warp=<seconds>   fly the scenario for that long with the engine-free integrator before
 *                    the first frame, so a screenshot can show any moment without waiting
 *   free=1           no script after the warp: fly it yourself through window.__FAC__.inputSources
 */
import { Canvas, useFrame } from '@react-three/fiber';
import { Suspense, useEffect, useMemo, useRef } from 'react';
import {
  BufferAttribute,
  PlaneGeometry,
  type Group,
  type Mesh,
  type PerspectiveCamera,
} from 'three';
import { debugFlags } from '../../config/debugFlags';
import { FRAME_PRIORITY } from '../../config/frame';
import { DECK, HULL, TURBINE, TURBINE_MOUNTS } from '../../config/layout';
import { PHYS, WIND } from '../../config/physicsConfig';
import { waveHeightAt } from '../../config/waves';
import { clearInput, inputSources } from '../../controls/input';
import PhysicsDriver from '../../physics/PhysicsDriver';
import { FIXED_DT, createFlightModel, stepFlightModel } from '../../physics/flightModel';
import { sim, updateDerived } from '../../state/sim';
import { useGameStore } from '../../state/useGameStore';
import '../../styles/global.css';
import { DEG2RAD, MS_TO_KTS, RAD2DEG } from '../../utils/math';

interface Scenario {
  screen: 'flight' | 'ops';
  assist: boolean;
  /** Called with the simulation time before every step / frame: set axes, flip switches. */
  script: (time: number) => void;
}

const axes = inputSources.keyboard;

function takeOffTo(altitude: number): void {
  axes.collective = sim.controls.targetAltitude < altitude ? 1 : 0;
}

const SCENARIOS: Record<string, Scenario> = {
  float: { screen: 'flight', assist: true, script: () => undefined },
  takeoff: { screen: 'flight', assist: true, script: () => takeOffTo(300) },
  hover: { screen: 'ops', assist: true, script: () => undefined },
  cruise: {
    screen: 'flight',
    assist: true,
    script: (t) => {
      takeOffTo(300);
      axes.tilt = t > 30 && sim.controls.tiltLever < 20 * DEG2RAD ? 1 : 0;
    },
  },
  turn: {
    screen: 'ops',
    assist: true,
    script: (t) => {
      axes.yaw = t > 3 && t < 20 ? 1 : 0;
    },
  },
  strafe: {
    screen: 'ops',
    assist: true,
    script: (t) => {
      axes.strafe = t > 3 && t < 18 ? 1 : 0;
    },
  },
  engineout: {
    screen: 'ops',
    assist: true,
    script: (t) => {
      if (t > 4) sim.turbines[0].enabled = false;
    },
  },
  cut: {
    screen: 'ops',
    assist: true,
    script: (t) => {
      if (t > 4) for (const turbine of sim.turbines) turbine.enabled = false;
    },
  },
  land: {
    screen: 'ops',
    assist: true,
    script: (t) => {
      axes.collective = t > 3 ? -1 : 0;
    },
  },
  manual: {
    screen: 'ops',
    assist: false,
    script: (t) => {
      axes.yaw = t > 4 && t < 9 ? 1 : 0;
      axes.tilt = t > 10 && t < 12 ? 1 : 0;
    },
  },
};

const scenarioName = debugFlags.params.get('scenario') ?? 'takeoff';
const scenario = SCENARIOS[scenarioName] ?? SCENARIOS.takeoff;
const scripted = debugFlags.params.get('free') !== '1';
const warpSeconds = Math.max(0, Number(debugFlags.params.get('warp') ?? 0) || 0);

/** Reset the sim for the scenario and fly the warp with the engine-free integrator. */
function prepare(): void {
  const store = useGameStore.getState();
  store.setScreen(scenario.screen);
  useGameStore.getState().setAssistEnabled(scenario.assist);
  clearInput();
  const model = createFlightModel({
    body: sim.carrier,
    turbines: sim.turbines,
    controls: sim.controls,
    wind: sim.env.wind,
    windLevel: scenario.screen === 'ops' ? WIND.opsLevel : WIND.freeFlightLevel,
  });
  const steps = Math.round(warpSeconds / FIXED_DT);
  for (let i = 0; i < steps; i++) {
    scenario.script(model.time);
    stepFlightModel(model, axes, scenario.assist);
  }
  sim.time = model.time;
  updateDerived(0);
  // remount the driver on the warped state
  useGameStore.setState((s) => ({ resetNonce: s.resetNonce + 1 }));
}

function ScenarioPilot() {
  useFrame(() => {
    if (scripted) scenario.script(sim.time);
  }, FRAME_PRIORITY.physics - 10);
  return null;
}

/** Box hull, deck slab and four tilting ducts with a bar showing each turbine's thrust. */
function DebugShip() {
  const root = useRef<Group>(null);
  const ducts = useRef<(Group | null)[]>([]);
  const bars = useRef<(Mesh | null)[]>([]);
  useFrame(() => {
    const group = root.current;
    if (!group) return;
    group.position.copy(sim.carrier.position);
    group.quaternion.copy(sim.carrier.quaternion);
    for (let i = 0; i < 4; i++) {
      const duct = ducts.current[i];
      const bar = bars.current[i];
      if (duct) duct.rotation.x = -sim.turbines[i].tilt;
      if (bar) {
        const length = 1 + (60 * sim.turbines[i].thrust) / PHYS.maxThrust;
        bar.scale.y = length;
        bar.position.y = -TURBINE.ductHeight / 2 - length / 2;
      }
    }
  });
  const hullHeight = HULL.deckY - HULL.keelY;
  return (
    <group ref={root}>
      <mesh position={[0, (HULL.deckY + HULL.keelY) / 2, 0]}>
        <boxGeometry args={[HULL.beam, hullHeight, HULL.length]} />
        <meshStandardMaterial color="#5d6b78" />
      </mesh>
      <mesh position={[0, DECK.y - DECK.thickness / 2, 0]}>
        <boxGeometry args={[DECK.halfWidth * 2, DECK.thickness, HULL.length - 4]} />
        <meshStandardMaterial color="#39424c" />
      </mesh>
      {/* bow marker */}
      <mesh position={[0, DECK.y + 4, -HULL.length / 2 + 14]}>
        <coneGeometry args={[9, 26, 4]} />
        <meshStandardMaterial color="#e0a030" />
      </mesh>
      {TURBINE_MOUNTS.map((mount, i) => (
        <group key={i} position={[mount[0], mount[1], mount[2]]}>
          <mesh rotation={[0, 0, Math.PI / 2]} position={[-Math.sign(mount[0]) * 22, 0, 0]}>
            <cylinderGeometry args={[2.5, 2.5, 44, 8]} />
            <meshStandardMaterial color="#4b5560" />
          </mesh>
          <group
            ref={(group) => {
              ducts.current[i] = group;
            }}
          >
            <mesh>
              <cylinderGeometry
                args={[
                  TURBINE.ductOuterRadius,
                  TURBINE.ductOuterRadius,
                  TURBINE.ductHeight,
                  24,
                  1,
                  true,
                ]}
              />
              <meshStandardMaterial color="#8a97a3" side={2} />
            </mesh>
            <mesh
              ref={(mesh) => {
                bars.current[i] = mesh;
              }}
            >
              <cylinderGeometry args={[6, 9, 1, 12]} />
              <meshBasicMaterial
                color={i % 2 === 0 ? '#ff5a3c' : '#3ccf6a'}
                transparent
                opacity={0.75}
              />
            </mesh>
          </group>
        </group>
      ))}
    </group>
  );
}

const SEA_SIZE = 2400;
const SEA_SEGMENTS = 48;

/** Wireframe sea displaced by the shared wave field, re-centred under the ship. */
function DebugSea() {
  const mesh = useRef<Mesh>(null);
  const geometry = useMemo(() => {
    const plane = new PlaneGeometry(SEA_SIZE, SEA_SIZE, SEA_SEGMENTS, SEA_SEGMENTS);
    plane.rotateX(-Math.PI / 2);
    return plane;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame(() => {
    const sea = mesh.current;
    if (!sea) return;
    // snap to the grid so the wires stay put while the waves move through them
    const cell = SEA_SIZE / SEA_SEGMENTS;
    const x0 = Math.round(sim.carrier.position.x / cell) * cell;
    const z0 = Math.round(sim.carrier.position.z / cell) * cell;
    sea.position.set(x0, 0, z0);
    const position = geometry.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      position.setY(i, waveHeightAt(x0 + position.getX(i), z0 + position.getZ(i), sim.time));
    }
    position.needsUpdate = true;
  });
  return (
    <mesh ref={mesh} geometry={geometry}>
      <meshBasicMaterial color="#1f6f9c" wireframe />
    </mesh>
  );
}

/** Camera that keeps a fixed offset from the ship and looks at it. */
function FollowCamera() {
  useFrame(({ camera }) => {
    const p = sim.carrier.position;
    camera.position.set(p.x + 330, p.y + 120, p.z + 420);
    camera.lookAt(p.x, p.y - 20, p.z);
    (camera as PerspectiveCamera).updateProjectionMatrix();
  }, FRAME_PRIORITY.camera);
  return null;
}

function fixed(value: number, digits = 1): string {
  return value.toFixed(digits);
}

/** Text readout refreshed from `sim` in an animation-frame loop (no React updates). */
function Readout() {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = requestAnimationFrame(update);
      const element = ref.current;
      if (!element) return;
      const c = sim.carrier;
      const t = sim.turbines;
      const { assistEnabled, paused } = useGameStore.getState();
      element.textContent = [
        `scenario ${scenarioName}   warp ${warpSeconds}s   ${assistEnabled ? 'ASSIST' : 'MANUAL'}${paused ? '   PAUSED' : ''}`,
        `time     ${fixed(sim.time)} s    dt ${fixed(sim.dt * 1000, 0)} ms`,
        `altitude ${fixed(c.altitude)} m   target ${fixed(sim.controls.targetAltitude)} m   keel ${fixed(c.keelClearance)} m   ${c.afloat ? 'AFLOAT' : 'AIRBORNE'}`,
        `v/s      ${fixed(c.verticalSpeed)} m/s   speed ${fixed(c.speed)} m/s (${fixed(c.speed * MS_TO_KTS, 0)} kt)   forward ${fixed(c.forwardSpeed)} m/s`,
        `heading  ${fixed(c.headingDeg)}°   pitch ${fixed(c.pitch * RAD2DEG, 2)}°   roll ${fixed(c.roll * RAD2DEG, 2)}°   g ${fixed(c.gLoad, 2)}`,
        `throttle ${t.map((x) => fixed(x.throttle * 100, 0).padStart(3)).join(' ')} %   cmd ${t.map((x) => fixed(x.throttleCmd * 100, 0).padStart(3)).join(' ')} %`,
        `tilt     ${t.map((x) => fixed(x.tilt * RAD2DEG, 0).padStart(3)).join(' ')} °   lever ${fixed(sim.controls.tiltLever * RAD2DEG, 0)}°   engines ${t.map((x) => (x.enabled ? 'on' : 'OFF')).join(' ')}`,
        `wind     ${fixed(sim.env.wind.length())} m/s`,
      ].join('\n');
    };
    update();
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <pre
      ref={ref}
      style={{
        position: 'absolute',
        left: 12,
        top: 12,
        margin: 0,
        padding: '8px 10px',
        font: '12px/1.45 ui-monospace, monospace',
        color: '#e8f1f8',
        background: 'rgba(8, 16, 24, 0.72)',
        borderRadius: 6,
        pointerEvents: 'none',
      }}
    />
  );
}

prepare();

export default function PhysicsSandbox() {
  const resetNonce = useGameStore((s) => s.resetNonce);
  return (
    <div className="app">
      <Canvas camera={{ fov: 45, near: 1, far: 60000 }}>
        <color attach="background" args={['#9cc3e0']} />
        <hemisphereLight args={['#dcecff', '#27425a', 1.1]} />
        <directionalLight position={[300, 600, 200]} intensity={2} />
        <ScenarioPilot />
        <Suspense fallback={null}>
          <PhysicsDriver key={resetNonce} />
        </Suspense>
        <DebugSea />
        <DebugShip />
        <FollowCamera />
      </Canvas>
      <Readout />
    </div>
  );
}
