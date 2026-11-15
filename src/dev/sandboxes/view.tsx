/**
 * View sandbox: the real camera rig and post-processing chain on a stand-in scene.
 * Open /?sandbox=view&quality=high plus any of:
 *
 *   screen=menu|hangar|flight|ops   which screen's camera behaviour to show (default flight;
 *                                   the sandbox keeps the idle driver on every screen)
 *   cam=orbit|chase|deck|bridge|turbine   camera mode on the flying screens (default chase)
 *   turbine=0..3      which turbine the turbine camera looks at
 *   hotspot=<id>      hangar: select a hotspot (turbine-0..3, island, catapults, arrestor, elevator)
 *   throttle=<0..1>   all four turbines (default: hover throttle)
 *   tilt=<deg>        tilt of all four turbines
 *   altitude=<m>      ship origin above sea level (default 420); speed=<m/s> forward speed
 *   shake=1           add camera-shake energy periodically (held at full with fixedTime)
 *   ship=1            the real Carrier instead of the stand-in
 *   fixedTime=<s>     freeze the simulation for repeatable screenshots
 */
import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  BackSide,
  DataTexture,
  NearestFilter,
  RGBAFormat,
  RepeatWrapping,
  type Group,
  type Mesh,
} from 'three';
import Carrier from '../../carrier/Carrier';
import { debugFlags } from '../../config/debugFlags';
import { FRAME_PRIORITY } from '../../config/frame';
import {
  DECK,
  HOTSPOTS,
  HULL,
  ISLAND,
  LANDING_STRIP,
  TURBINE,
  TURBINE_MOUNTS,
  type HotspotId,
} from '../../config/layout';
import { IDLE_ALTITUDE, PHYS } from '../../config/physicsConfig';
import CameraRig from '../../scene/CameraRig';
import PostFX from '../../scene/PostFX';
import IdleDriver, { idleConfig } from '../../sim/IdleDriver';
import { addCameraShake, sim } from '../../state/sim';
import type { CameraMode, TurbineIndex } from '../../state/types';
import { useGameStore } from '../../state/useGameStore';
import { useQuality } from '../../state/useQuality';
import { DEG2RAD, clamp } from '../../utils/math';
import '../../styles/global.css';

function numberParam(name: string): number | null {
  const raw = debugFlags.params.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const CAMERAS: readonly CameraMode[] = ['orbit', 'chase', 'deck', 'bridge', 'turbine'];
const THROTTLE = numberParam('throttle');
const TILT_DEG = numberParam('tilt');
const ALTITUDE = numberParam('altitude') ?? IDLE_ALTITUDE;
const SPEED = numberParam('speed') ?? 0;
const SHAKE = debugFlags.params.get('shake') === '1';
const REAL_SHIP = debugFlags.params.get('ship') === '1';
/** Seconds of sim time between the knocks of ?shake=1. */
const SHAKE_PERIOD = 1.4;

/** Put the store into the state the URL asks for. Runs once, before the first render. */
function configureStore(): void {
  const store = useGameStore.getState();
  // default to the flight screen so every camera mode is reachable
  if (!debugFlags.screen) store.setScreen('flight');
  // setScreen selects that screen's default camera, so apply ?cam= afterwards
  if (debugFlags.cam && (CAMERAS as readonly string[]).includes(debugFlags.cam)) {
    useGameStore.getState().setCameraMode(debugFlags.cam as CameraMode);
  }
  const turbine = numberParam('turbine');
  if (turbine !== null && turbine >= 0 && turbine <= 3) {
    useGameStore.getState().setCameraTurbine(Math.round(turbine) as TurbineIndex);
  }
  const hotspot = debugFlags.params.get('hotspot');
  const patch: { selectedHotspot?: HotspotId; demoThrottle?: number; demoTiltDeg?: number } = {};
  if (hotspot && HOTSPOTS.some((h) => h.id === hotspot))
    patch.selectedHotspot = hotspot as HotspotId;
  if (THROTTLE !== null) patch.demoThrottle = clamp(THROTTLE, 0, 1);
  if (TILT_DEG !== null) patch.demoTiltDeg = TILT_DEG;
  useGameStore.getState().setHangar(patch);
}

configureStore();

/**
 * Applies ?throttle / ?tilt on the screens where the idle driver does not read the hangar
 * sliders, and feeds ?shake=1. Runs right after the driver so everything sees the result.
 */
function Scenario() {
  const lastKnock = useRef(-Infinity);
  useFrame(() => {
    if (useGameStore.getState().screen !== 'hangar') {
      for (const turbine of sim.turbines) {
        if (THROTTLE !== null) {
          turbine.throttle = clamp(THROTTLE, 0, 1);
          turbine.throttleCmd = turbine.throttle;
          turbine.thrust = turbine.throttle * PHYS.maxThrust;
        }
        if (TILT_DEG !== null) {
          turbine.tilt = clamp(TILT_DEG * DEG2RAD, PHYS.tiltMin, PHYS.tiltMax);
          turbine.tiltCmd = turbine.tilt;
        }
      }
    }
    if (!SHAKE) return;
    if (debugFlags.fixedTime !== null) {
      sim.camera.shake = 1;
    } else if (sim.time - lastKnock.current >= SHAKE_PERIOD || sim.time < lastKnock.current) {
      lastKnock.current = sim.time;
      addCameraShake(0.9);
    }
  }, FRAME_PRIORITY.driver + 1);
  return null;
}

/** A dark sea plane at y = 0 with a two-tone checker, so image distortion is visible against it. */
function Sea() {
  const texture = useMemo(() => {
    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      const light = ((i % size) + Math.floor(i / size)) % 2 === 0;
      data[i * 4] = light ? 30 : 14;
      data[i * 4 + 1] = light ? 62 : 36;
      data[i * 4 + 2] = light ? 92 : 60;
      data[i * 4 + 3] = 255;
    }
    const map = new DataTexture(data, size, size, RGBAFormat);
    map.wrapS = RepeatWrapping;
    map.wrapT = RepeatWrapping;
    map.magFilter = NearestFilter;
    map.repeat.set(40, 40);
    map.colorSpace = 'srgb';
    map.needsUpdate = true;
    return map;
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh rotation-x={-Math.PI / 2}>
      <planeGeometry args={[60000, 60000]} />
      <meshStandardMaterial map={texture} roughness={0.9} />
    </mesh>
  );
}

/**
 * Sky colour on a mesh rather than as a clear colour: three.js never tone-maps the clear
 * colour, so only a mesh looks the same with and without the composer.
 */
function SkyDome() {
  const dome = useRef<Mesh>(null);
  useFrame(({ camera }) => dome.current?.position.copy(camera.position));
  return (
    <mesh ref={dome} renderOrder={-1}>
      <sphereGeometry args={[30000, 24, 12]} />
      <meshBasicMaterial color="#8fb9dc" side={BackSide} depthWrite={false} fog={false} />
    </mesh>
  );
}

const stripDx = LANDING_STRIP.end[0] - LANDING_STRIP.threshold[0];
const stripDz = LANDING_STRIP.end[2] - LANDING_STRIP.threshold[2];
const HULL_HEIGHT = DECK.y - DECK.thickness - HULL.keelY;

/** Grey-box ship: hull, deck slab, island, strip marking, four ducts with HDR emissive rings. */
function StandInShip() {
  const group = useRef<Group>(null);
  useFrame(() => {
    group.current?.position.copy(sim.carrier.position);
    group.current?.quaternion.copy(sim.carrier.quaternion);
  });
  return (
    <group ref={group}>
      <mesh position={[0, HULL.keelY + HULL_HEIGHT / 2, 0]}>
        <boxGeometry args={[HULL.beam, HULL_HEIGHT, HULL.length]} />
        <meshStandardMaterial color="#7d8791" roughness={0.7} />
      </mesh>
      <mesh position={[0, DECK.y - DECK.thickness / 2, 0]}>
        <boxGeometry args={[DECK.halfWidth * 2, DECK.thickness, HULL.length - 4]} />
        <meshStandardMaterial color="#3b424a" roughness={0.85} />
      </mesh>
      <mesh
        position={[
          (LANDING_STRIP.threshold[0] + LANDING_STRIP.end[0]) / 2,
          DECK.y + 0.05,
          (LANDING_STRIP.threshold[2] + LANDING_STRIP.end[2]) / 2,
        ]}
        rotation-y={Math.atan2(stripDx, stripDz)}
      >
        <boxGeometry args={[1.2, 0.1, Math.hypot(stripDx, stripDz)]} />
        <meshStandardMaterial color="#e8e6da" roughness={0.8} />
      </mesh>
      <mesh position={[ISLAND.centerX, DECK.y + ISLAND.height / 2, ISLAND.centerZ]}>
        <boxGeometry args={[ISLAND.width, ISLAND.height, ISLAND.length]} />
        <meshStandardMaterial color="#8d969f" roughness={0.7} />
      </mesh>
      {TURBINE_MOUNTS.map((m, i) => (
        <group key={i} position={[m[0], m[1], m[2]]}>
          <mesh position={[-m[0] / 2, 0, 0]}>
            <boxGeometry args={[Math.abs(m[0]), 5, 9]} />
            <meshStandardMaterial color="#6f7882" roughness={0.7} />
          </mesh>
          <mesh>
            <cylinderGeometry
              args={[
                TURBINE.ductOuterRadius,
                TURBINE.ductOuterRadius,
                TURBINE.ductHeight,
                40,
                1,
                true,
              ]}
            />
            <meshStandardMaterial color="#59626b" roughness={0.6} side={2} />
          </mesh>
          <mesh position={[0, -TURBINE.ductHeight / 2, 0]} rotation-x={Math.PI / 2}>
            <torusGeometry args={[TURBINE.fanRadius, 1.6, 10, 48]} />
            <meshBasicMaterial color={[5, 2.1, 0.6]} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Reference spheres around the ship: HDR emissive ones must bloom, the lit white one must not. */
function TestSpheres() {
  return (
    <group position={[0, ALTITUDE, 0]}>
      <mesh position={[-260, 60, -120]}>
        <sphereGeometry args={[9, 24, 16]} />
        <meshBasicMaterial color={[4, 0.6, 0.4]} toneMapped={false} />
      </mesh>
      <mesh position={[-260, 60, 0]}>
        <sphereGeometry args={[9, 24, 16]} />
        <meshBasicMaterial color={[0.5, 3.5, 1.2]} toneMapped={false} />
      </mesh>
      <mesh position={[-260, 60, 120]}>
        <sphereGeometry args={[9, 24, 16]} />
        <meshStandardMaterial color="#ffffff" roughness={0.6} />
      </mesh>
      <mesh position={[900, 700, -2600]}>
        <sphereGeometry args={[60, 24, 16]} />
        <meshBasicMaterial color={[18, 15, 10]} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Readout() {
  const screen = useGameStore((s) => s.screen);
  const cameraMode = useGameStore((s) => s.cameraMode);
  const hotspot = useGameStore((s) => s.hangar.selectedHotspot);
  const quality = useGameStore((s) => s.effectiveQuality);
  return (
    <div
      style={{
        position: 'absolute',
        left: 12,
        bottom: 10,
        font: '12px monospace',
        color: '#fff',
        opacity: 0.8,
        pointerEvents: 'none',
      }}
    >
      {screen} · {cameraMode}
      {hotspot ? ` · ${hotspot}` : ''} · {quality}
    </div>
  );
}

export default function ViewSandbox() {
  const quality = useQuality();
  // set synchronously so the very first frame already uses it …
  idleConfig.altitude = ALTITUDE;
  idleConfig.forwardSpeed = SPEED;
  // … and again in the effect: StrictMode runs the cleanup once right after mounting
  useEffect(() => {
    idleConfig.altitude = ALTITUDE;
    idleConfig.forwardSpeed = SPEED;
    return () => {
      idleConfig.altitude = IDLE_ALTITUDE;
      idleConfig.forwardSpeed = 0;
    };
  }, []);
  return (
    <div className="app">
      <Canvas
        key={quality.antialias ? 'aa' : 'no-aa'}
        dpr={quality.dpr}
        gl={{ antialias: quality.antialias }}
        camera={{ fov: 50, near: 1, far: 60000, position: [300, 520, 420] }}
      >
        <IdleDriver />
        <Scenario />
        <SkyDome />
        <hemisphereLight args={['#cfe6ff', '#2a3d4f', 0.9]} />
        <directionalLight position={[400, 600, 300]} intensity={2.2} color="#fff2dd" />
        <Sea />
        {REAL_SHIP ? <Carrier /> : <StandInShip />}
        <TestSpheres />
        <CameraRig />
        <PostFX />
      </Canvas>
      <Readout />
    </div>
  );
}
