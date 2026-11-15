/**
 * Ocean sandbox: the sea with a stand-in ship, a stand-in sky and a controllable sun.
 * Open /?sandbox=ocean&quality=high plus any of:
 *
 *   altitude=<m>     ship origin above sea level: 6 = afloat (default), 30 = low hover, 420, 3000
 *   speed=<m/s>      constant forward speed (wake when afloat)
 *   throttle=<0..1>  all four turbines (downwash strength); tilt=<deg> tilts them
 *   view=quarter|low|top|astern|horizon|graze|far   camera preset (the camera follows the ship)
 *   sunElev=<deg>    sun elevation above the horizon (default 38)
 *   sunAz=<deg>      compass bearing of the sun (default 315; the default camera looks that way)
 *   night=1          moonlit night (sunElev / sunAz then place the moon)
 *   ship=1           the real Carrier instead of the grey stand-in box
 *   world=1          the real World (sky, lights, scene fog; use ?time=<hours>) instead of the
 *                    stand-in sky — loaded lazily, so the sandbox works while World is mid-edit
 *   fixedTime=<s>    freeze the simulation for repeatable screenshots
 */
import { useFrame, useThree } from '@react-three/fiber';
import { Suspense, lazy, useEffect, useMemo, useRef } from 'react';
import {
  BackSide,
  Color,
  ShaderMaterial,
  Vector3,
  type DirectionalLight,
  type Group,
  type HemisphereLight,
  type Mesh,
} from 'three';
import Carrier from '../../carrier/Carrier';
import { debugFlags } from '../../config/debugFlags';
import { FRAME_PRIORITY } from '../../config/frame';
import { DECK, FLOATING_ALTITUDE, HULL, TURBINE, TURBINE_MOUNTS } from '../../config/layout';
import Ocean from '../../scene/Ocean';
import { idleConfig } from '../../sim/IdleDriver';
import { sim } from '../../state/sim';
import { DEG2RAD, clamp, smoothstep } from '../../utils/math';
import SandboxStage from '../SandboxStage';

type Triple = [number, number, number];

function numberParam(name: string, fallback: number): number {
  const raw = debugFlags.params.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const ALTITUDE = numberParam('altitude', FLOATING_ALTITUDE);
const SPEED = numberParam('speed', 0);
const SUN_ELEVATION = numberParam('sunElev', 38) * DEG2RAD;
const SUN_AZIMUTH = numberParam('sunAz', 315) * DEG2RAD;
const NIGHT = debugFlags.params.get('night') === '1';
const REAL_SHIP = debugFlags.params.get('ship') === '1';
const REAL_WORLD = debugFlags.params.get('world') === '1';
const World = lazy(() => import('../../scene/World'));
const THROTTLE = debugFlags.params.has('throttle') ? clamp(numberParam('throttle', 0), 0, 1) : null;
const TILT = debugFlags.params.has('tilt') ? numberParam('tilt', 0) : null;

/** Camera position and orbit target, relative to the ship's starting position. */
const VIEWS: Record<string, { camera: Triple; target: Triple }> = {
  quarter: { camera: [260, 120, 320], target: [0, 0, 0] },
  // eye 10 m above the sea, whatever the ship's altitude
  low: { camera: [190, 10 - ALTITUDE, 250], target: [0, 4 - ALTITUDE, 0] },
  top: { camera: [1, 520, 60], target: [0, 0, 40] },
  astern: { camera: [-170, 210, 330], target: [0, -ALTITUDE, 260] },
  horizon: { camera: [40, 30, 330], target: [-400, -40, -3000] },
  graze: { camera: [120, 10 - ALTITUDE, 420], target: [-900, 2 - ALTITUDE, -4000] },
  far: { camera: [1800, 900, 2400], target: [0, -ALTITUDE, 0] },
};
const VIEW = VIEWS[debugFlags.params.get('view') ?? 'quarter'] ?? VIEWS.quarter;

const DAY_HORIZON = new Color('#a9c8e2');
const DAY_ZENITH = new Color('#3d7fc4');
const DUSK_HORIZON = new Color(0.95, 0.5, 0.26);
const DUSK_ZENITH = new Color(0.1, 0.16, 0.36);
const DAY_SUN = new Color(1.0, 0.95, 0.86).multiplyScalar(2.2);
const DUSK_SUN = new Color(1.0, 0.5, 0.2).multiplyScalar(1.5);
const NIGHT_HORIZON = new Color(0.012, 0.02, 0.042);
const NIGHT_ZENITH = new Color(0.003, 0.006, 0.016);
const MOON = new Color(0.55, 0.68, 1.0).multiplyScalar(0.16);

/** Stand-in for the world module: writes the sun / moon and sky colours into `sim.env`. */
function writeEnvironment(): void {
  const env = sim.env;
  const flat = Math.cos(SUN_ELEVATION);
  env.sunDirection.set(
    Math.sin(SUN_AZIMUTH) * flat,
    Math.sin(SUN_ELEVATION),
    -Math.cos(SUN_AZIMUTH) * flat,
  );
  if (NIGHT) {
    env.daylight = 0;
    env.sunColor.copy(MOON);
    env.horizonColor.copy(NIGHT_HORIZON);
    env.zenithColor.copy(NIGHT_ZENITH);
    return;
  }
  const day = smoothstep(3 * DEG2RAD, 24 * DEG2RAD, SUN_ELEVATION);
  env.daylight = 1;
  env.sunColor.lerpColors(DUSK_SUN, DAY_SUN, day);
  env.horizonColor.lerpColors(DUSK_HORIZON, DAY_HORIZON, day);
  env.zenithColor.lerpColors(DUSK_ZENITH, DAY_ZENITH, day);
}

const SKY_VERTEX = /* glsl */ `
varying vec3 vDirection;
void main() {
  vDirection = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** The same horizon-to-zenith gradient the ocean assumes for its reflections, plus a sun disc. */
const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uHorizonColor;
uniform vec3 uZenithColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vDirection;
void main() {
  vec3 dir = normalize(vDirection);
  float down = 1.0 - clamp(dir.y, 0.0, 1.0);
  vec3 color = mix(uHorizonColor, uZenithColor, 1.0 - down * down * down);
  float toSun = max(dot(dir, uSunDir), 0.0);
  color += uSunColor * (0.06 * pow(toSun, 24.0) + 6.0 * smoothstep(0.99985, 0.99995, toSun));
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const _shipDelta = new Vector3();
const _lastShip = new Vector3();

/** Sky dome, lights and the camera follow — everything the ocean needs around it. */
function Surroundings({ standIn }: { standIn: boolean }) {
  const dome = useRef<Mesh>(null);
  const sunLight = useRef<DirectionalLight>(null);
  const skyLight = useRef<HemisphereLight>(null);
  const controls = useThree((s) => s.controls) as { target: Vector3; update(): void } | null;
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          uHorizonColor: { value: new Color() },
          uZenithColor: { value: new Color() },
          uSunDir: { value: new Vector3(0, 1, 0) },
          uSunColor: { value: new Color() },
        },
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        side: BackSide,
        depthWrite: false,
        fog: false,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => {
    _lastShip.set(0, 0, 0);
  }, []);

  // after the driver has moved the ship, before anything draws
  useFrame(({ camera }) => {
    if (standIn) writeEnvironment();
    // carry the orbit camera along with the ship (horizontal travel only; the stage placed the
    // camera relative to a ship at x = z = 0)
    if (controls) {
      _shipDelta.copy(sim.carrier.position).sub(_lastShip).setY(0);
      _lastShip.copy(sim.carrier.position);
      camera.position.add(_shipDelta);
      controls.target.add(_shipDelta);
      controls.update();
    }

    const env = sim.env;
    material.uniforms.uHorizonColor.value.copy(env.horizonColor);
    material.uniforms.uZenithColor.value.copy(env.zenithColor);
    material.uniforms.uSunDir.value.copy(env.sunDirection);
    material.uniforms.uSunColor.value.copy(env.sunColor);
    dome.current?.position.copy(camera.position);
    if (sunLight.current) {
      sunLight.current.position.copy(sim.carrier.position).addScaledVector(env.sunDirection, 900);
      sunLight.current.target.position.copy(sim.carrier.position);
      sunLight.current.target.updateMatrixWorld();
      sunLight.current.color.copy(env.sunColor);
    }
    if (skyLight.current) {
      skyLight.current.color.copy(env.zenithColor);
      skyLight.current.groundColor.copy(env.horizonColor).multiplyScalar(0.25);
    }
  }, FRAME_PRIORITY.driver + 5);

  if (!standIn) return null;
  return (
    <>
      <mesh ref={dome} material={material} renderOrder={-10} frustumCulled={false}>
        <sphereGeometry args={[40000, 48, 24]} />
      </mesh>
      <hemisphereLight ref={skyLight} intensity={2.4} />
      <directionalLight ref={sunLight} intensity={1} />
    </>
  );
}

/** Grey box of the hull's dimensions with four discs where the turbines are. */
function StandInShip() {
  const group = useRef<Group>(null);
  useFrame(() => {
    group.current?.position.copy(sim.carrier.position);
    group.current?.quaternion.copy(sim.carrier.quaternion);
  });
  const hullHeight = HULL.deckY - HULL.keelY;
  return (
    <group ref={group}>
      <mesh position={[0, (HULL.deckY + HULL.keelY) / 2, 0]}>
        <boxGeometry args={[HULL.beam, hullHeight, HULL.length]} />
        <meshStandardMaterial color="#7d848c" roughness={0.8} />
      </mesh>
      <mesh position={[0, HULL.deckY, 0]}>
        <boxGeometry args={[DECK.halfWidth * 2, 1.5, HULL.length]} />
        <meshStandardMaterial color="#565c64" roughness={0.9} />
      </mesh>
      {TURBINE_MOUNTS.map((mount, i) => (
        <mesh key={i} position={[mount[0], mount[1], mount[2]]}>
          <cylinderGeometry
            args={[TURBINE.ductOuterRadius, TURBINE.ductOuterRadius, TURBINE.ductHeight, 32]}
          />
          <meshStandardMaterial color="#9aa1a8" roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

export default function OceanSandbox() {
  // the first frame must already see the sandbox sky
  if (!REAL_WORLD) writeEnvironment();
  // SandboxStage resets the idle driver's altitude and speed in an effect cleanup, which React's
  // StrictMode runs once right after mounting; this parent effect runs after it and puts them back
  useEffect(() => {
    idleConfig.altitude = ALTITUDE;
    idleConfig.forwardSpeed = SPEED;
  }, []);
  return (
    <SandboxStage
      background={null}
      lights={false}
      shadows={false}
      altitude={ALTITUDE}
      forwardSpeed={SPEED}
      camera={VIEW.camera}
      target={VIEW.target}
      {...(THROTTLE !== null ? { throttle: THROTTLE } : {})}
      {...(TILT !== null ? { tiltDeg: TILT } : {})}
    >
      <Surroundings standIn={!REAL_WORLD} />
      {REAL_WORLD && (
        <Suspense fallback={null}>
          <World />
        </Suspense>
      )}
      <Ocean />
      {REAL_SHIP ? <Carrier /> : <StandInShip />}
    </SandboxStage>
  );
}
