/**
 * Turbine sandbox: the turbines and their exhaust on a grey stand-in hull (no other module).
 *
 *   /?sandbox=turbine&quality=high&throttle=0.9&tilt=40&view=close
 *
 * Parameters:
 *   index=0..3            which turbine the close-up shows (default 0, forward port)
 *   all=1                 all four turbines in their mounts, camera on the whole ship
 *   throttle=0..1         demo throttle of every turbine (default: hover)
 *   tilt=deg              demo tilt of every turbine (-20..60)
 *   off=0,2               engines switched off (they spool down and go dark)
 *   altitude=m            hover altitude; e.g. 30 puts the nozzles just above the stand-in sea
 *   speed=m/s             constant forward speed (the camera follows the ship)
 *   wind=x,y,z            world wind, m/s
 *   view=close|top|under|side|inboard|plume|sea|ship    camera preset
 *   cam=x,y,z  tgt=x,y,z  fov=deg   override the preset (metres from the turbine pivot, or
 *                         from the ship origin with all=1 / view=ship)
 *   hull=0                hide the stand-in hull and pylons
 *   fixedTime=<s>         freeze sim.time for repeatable frames
 *
 * `window.__TURBINE_STATS__` holds the draw calls and triangles of the previous frame
 * (shadow pass included), for budget checks from a Playwright script.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { Group, Vector3 } from 'three';
import Turbine from '../../carrier/Turbine';
import { debugFlags } from '../../config/debugFlags';
import { FRAME_PRIORITY } from '../../config/frame';
import { HULL, TURBINE, TURBINE_MOUNTS } from '../../config/layout';
import { PALETTE } from '../../config/palette';
import { IDLE_ALTITUDE } from '../../config/physicsConfig';
import { sim } from '../../state/sim';
import type { TurbineIndex } from '../../state/types';
import { clamp, damp } from '../../utils/math';
import SandboxStage from '../SandboxStage';

type Vec3 = [number, number, number];
interface View {
  camera: Vec3;
  target: Vec3;
  fov: number;
}

/** Presets relative to the pivot of a PORT turbine (outboard = -X); mirrored for starboard. */
const VIEWS: Record<string, View> = {
  close: { camera: [-62, 40, 66], target: [0, -3, 0], fov: 40 },
  top: { camera: [-4, 88, 10], target: [0, 0, 0], fov: 40 },
  under: { camera: [-30, -62, 34], target: [0, -3, 0], fov: 42 },
  side: { camera: [-125, 6, 0], target: [0, -12, 0], fov: 40 },
  inboard: { camera: [34, 30, -44], target: [19, 0, 0], fov: 36 },
  plume: { camera: [-170, -10, 150], target: [0, -52, 0], fov: 42 },
  sea: { camera: [-120, 14, 130], target: [0, -24, 0], fov: 42 },
};
const SHIP_VIEW: View = { camera: [250, 130, 330], target: [0, -10, 0], fov: 42 };

const PYLON_RADIUS = 3.3;
const PYLON_INNER_X = HULL.beam / 2;
const PYLON_OUTER_X = Math.abs(TURBINE_MOUNTS[0][0]) - TURBINE.ductOuterRadius;

function parseVec(value: string | null): Vec3 | null {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? (parts as Vec3) : null;
}

function parseIndices(value: string | null): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n < TURBINE_MOUNTS.length);
}

/** Switches engines off after the idle driver has run, and lets them spool down. */
function EngineSwitches({ off, wind }: { off: number[]; wind: Vec3 | null }) {
  const spool = useRef<number[] | null>(null);
  useFrame(() => {
    if (wind) sim.env.wind.set(wind[0], wind[1], wind[2]);
    if (off.length === 0) return;
    spool.current ??= sim.turbines.map((turbine) => turbine.throttle);
    for (const i of off) {
      const turbine = sim.turbines[i];
      // with a frozen clock there is no time to spool down in: show the end state
      spool.current[i] = debugFlags.fixedTime !== null ? 0 : damp(spool.current[i], 0, 0.9, sim.dt);
      turbine.enabled = false;
      turbine.throttle = spool.current[i];
      turbine.thrust = 0;
    }
  }, FRAME_PRIORITY.systems);
  return null;
}

const renderStats = { calls: 0, triangles: 0 };

/** Publishes the renderer's counters of the previous frame for budget checks. */
function RenderStats() {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const host = window as unknown as { __TURBINE_STATS__?: typeof renderStats };
    host.__TURBINE_STATS__ = renderStats;
    return () => {
      delete host.__TURBINE_STATS__;
    };
  }, []);
  useFrame(() => {
    renderStats.calls = gl.info.render.calls;
    renderStats.triangles = gl.info.render.triangles;
  });
  return null;
}

/** Carries the orbit camera along with the ship when it has forward speed. */
function FollowShip() {
  const last = useRef({ x: 0, z: 0 });
  const controls = useThree((state) => state.controls) as { target: Vector3 } | null;
  const camera = useThree((state) => state.camera);
  useFrame(() => {
    const dx = sim.carrier.position.x - last.current.x;
    const dz = sim.carrier.position.z - last.current.z;
    last.current.x = sim.carrier.position.x;
    last.current.z = sim.carrier.position.z;
    camera.position.x += dx;
    camera.position.z += dz;
    if (controls) {
      controls.target.x += dx;
      controls.target.z += dz;
    }
  }, FRAME_PRIORITY.camera);
  return null;
}

/** Grey box for the hull plus the four pylons, each ending where the real bearing cap sits. */
function StandInHull() {
  return (
    <>
      <mesh position={[0, (HULL.deckY + HULL.keelY) / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[HULL.beam, HULL.deckY - HULL.keelY, HULL.length]} />
        <meshStandardMaterial color={PALETTE.hull} roughness={0.8} />
      </mesh>
      {TURBINE_MOUNTS.map((mount, i) => (
        <mesh
          key={i}
          position={[
            (Math.sign(mount[0]) * (PYLON_INNER_X + PYLON_OUTER_X)) / 2,
            mount[1],
            mount[2],
          ]}
          rotation-z={Math.PI / 2}
          castShadow
          receiveShadow
        >
          <cylinderGeometry
            args={[PYLON_RADIUS, PYLON_RADIUS, PYLON_OUTER_X - PYLON_INNER_X, 20]}
          />
          <meshStandardMaterial color={PALETTE.hullDark} roughness={0.7} />
        </mesh>
      ))}
    </>
  );
}

function Ship({ indices, hull }: { indices: number[]; hull: boolean }) {
  const group = useRef<Group>(null);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.position.copy(sim.carrier.position);
    g.quaternion.copy(sim.carrier.quaternion);
  });
  return (
    <group ref={group}>
      {hull && <StandInHull />}
      {indices.map((i) => (
        <group key={i} position={[...TURBINE_MOUNTS[i]]}>
          <Turbine index={i as TurbineIndex} />
        </group>
      ))}
    </group>
  );
}

export default function TurbineSandbox() {
  const params = debugFlags.params;
  const number = (name: string): number | undefined => {
    const value = params.get(name);
    return value !== null && value.trim() !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
  };

  const all = params.get('all') === '1';
  const index = clamp(Math.round(number('index') ?? 0), 0, TURBINE_MOUNTS.length - 1);
  const viewName = params.get('view') ?? (all ? 'ship' : 'close');
  const shipRelative = viewName === 'ship' || !(viewName in VIEWS);
  const preset = shipRelative ? SHIP_VIEW : VIEWS[viewName];

  // presets are drawn for a port turbine; mirror them for a starboard one
  const mount = TURBINE_MOUNTS[index];
  const mirror = shipRelative || mount[0] < 0 ? 1 : -1;
  const origin: Vec3 = shipRelative ? [0, 0, 0] : [mount[0], mount[1], mount[2]];
  const place = (v: Vec3, mirrored: boolean): Vec3 => [
    origin[0] + (mirrored ? mirror : 1) * v[0],
    origin[1] + v[1],
    origin[2] + v[2],
  ];
  const camOverride = parseVec(params.get('cam'));
  const tgtOverride = parseVec(params.get('tgt'));

  return (
    <SandboxStage
      camera={camOverride ? place(camOverride, false) : place(preset.camera, true)}
      target={tgtOverride ? place(tgtOverride, false) : place(preset.target, true)}
      fov={number('fov') ?? preset.fov}
      throttle={number('throttle')}
      tiltDeg={number('tilt')}
      altitude={number('altitude') ?? IDLE_ALTITUDE}
      forwardSpeed={number('speed') ?? 0}
    >
      <EngineSwitches off={parseIndices(params.get('off'))} wind={parseVec(params.get('wind'))} />
      <FollowShip />
      <RenderStats />
      <Ship indices={all ? [0, 1, 2, 3] : [index]} hull={params.get('hull') !== '0'} />
      {/* stand-in sea at mean sea level, so the spray has something to land on */}
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[6000, 6000]} />
        <meshStandardMaterial color="#0d2b3c" roughness={0.55} />
      </mesh>
    </SandboxStage>
  );
}
