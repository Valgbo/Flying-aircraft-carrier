/**
 * Sky sandbox — World + Clouds on their own, with a plain sea plane and a grey stand-in ship
 * to judge light, shadow, fog and the horizon seam. Open /?sandbox=sky
 *
 * URL parameters:
 *   ?time=<hours>      time of day (standard flag → settings.timeOfDay)
 *   ?altitude=<m>      altitude of the ship (default: the idle hover altitude)
 *   ?speed=<m/s>       forward speed of the ship (shadow snapping, cloud wrap); together with
 *                      ?fixedTime the ship sits speed × fixedTime metres north of the origin and
 *                      the ship-relative presets follow it (e.g. speed=50&fixedTime=1000 → 50 km)
 *   ?view=ship|shadow|below|inside|above|sun|antisun   camera preset
 *   ?ship=1            the real carrier model instead of the grey stand-in
 *   ?fixedTime=<s>     freeze simulated time (deterministic frame; the wind drift stops)
 */
import { useFrame } from '@react-three/fiber';
import { Suspense, lazy, useLayoutEffect, useMemo, useRef } from 'react';
import type { Group } from 'three';
import { debugFlags } from '../../config/debugFlags';
import { DECK, HULL, ISLAND } from '../../config/layout';
import { IDLE_ALTITUDE } from '../../config/physicsConfig';
import Clouds from '../../scene/Clouds';
import World from '../../scene/World';
import { CLOUD_STRIDE, createCloudLayout, wrapCentered } from '../../scene/sky/cloudLayout';
import { getSkyState } from '../../scene/sky/currentSky';
import { idleConfig } from '../../sim/IdleDriver';
import { sim } from '../../state/sim';
import { useGameStore } from '../../state/useGameStore';
import { getQuality } from '../../state/useQuality';
import SandboxStage from '../SandboxStage';

const Carrier = lazy(() => import('../../carrier/Carrier'));

type Triple = [number, number, number];

function numberParam(name: string, fallback: number): number {
  const raw = debugFlags.params.get(name);
  const value = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Camera position and orbit target in WORLD coordinates for a named preset. `shipZ` is where
 * the ship is along Z; the presets that look at the ship are placed relative to it.
 */
function cameraPreset(
  view: string,
  altitude: number,
  shipZ: number,
): { camera: Triple; target: Triple } {
  const sky = getSkyState(useGameStore.getState().settings.timeOfDay);
  const light = sky.lightDirection;
  switch (view) {
    case 'shadow':
      return { camera: [-70, altitude + 95, shipZ + 150], target: [10, altitude + 16, shipZ + 10] };
    case 'below':
      return { camera: [0, 250, 700], target: [-1800, 1500, -3200] };
    case 'inside': {
      // the middle of the cloud nearest the origin (valid for ?fixedTime=0: no wind drift yet)
      const layout = createCloudLayout(getQuality().cloudCount);
      let best = 0;
      let bestDistance = Infinity;
      for (let i = 0; i < layout.cloudCount; i++) {
        const o = i * CLOUD_STRIDE;
        const d = Math.hypot(
          wrapCentered(layout.clouds[o], 0, layout.tileSize),
          wrapCentered(layout.clouds[o + 2], 0, layout.tileSize),
        );
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
      const o = best * CLOUD_STRIDE;
      const x = wrapCentered(layout.clouds[o], 0, layout.tileSize);
      const z = wrapCentered(layout.clouds[o + 2], 0, layout.tileSize);
      const y = layout.clouds[o + 1] + layout.clouds[o + 4] * 0.5;
      const edge = numberParam('edge', 0) * layout.clouds[o + 3];
      return { camera: [x + edge, y, z], target: [0, altitude, 0] };
    }
    case 'above':
      return { camera: [0, 3900, 2600], target: [0, 1500, -4500] };
    case 'sun':
      return {
        camera: [-light.x * 520, altitude + 60 - light.y * 120, shipZ - light.z * 520],
        target: [light.x * 2000, altitude + 60 + light.y * 2000, shipZ + light.z * 2000],
      };
    case 'antisun':
      return {
        camera: [light.x * 520, altitude + 140, shipZ + light.z * 520],
        target: [0, altitude, shipZ],
      };
    default:
      return { camera: [260, altitude + 120, shipZ + 320], target: [0, altitude, shipZ] };
  }
}

/**
 * Re-applies the ship placement after mount. SandboxStage sets it while rendering and resets
 * it in an effect cleanup, which React's StrictMode runs once right after mounting — without
 * this the ship would fall back to the default altitude and speed in development.
 */
function ShipPlacement({ altitude, speed }: { altitude: number; speed: number }) {
  useLayoutEffect(() => {
    idleConfig.altitude = altitude;
    idleConfig.forwardSpeed = speed;
  }, [altitude, speed]);
  return null;
}

/** Grey boxes with the ship's main dimensions: hull, deck slab, island, mast and a tall pole. */
function StandInShip() {
  const group = useRef<Group>(null);
  useFrame(() => {
    if (!group.current) return;
    group.current.position.copy(sim.carrier.position);
    group.current.quaternion.copy(sim.carrier.quaternion);
  });
  const hullHeight = HULL.deckY - HULL.keelY - DECK.thickness;
  return (
    <group ref={group}>
      <mesh position={[0, HULL.keelY + hullHeight / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[HULL.beam, hullHeight, HULL.length]} />
        <meshStandardMaterial color="#6d747d" roughness={0.8} />
      </mesh>
      <mesh position={[0, DECK.y - DECK.thickness / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[DECK.halfWidth * 2, DECK.thickness, HULL.length - 4]} />
        <meshStandardMaterial color="#7d848c" roughness={0.85} />
      </mesh>
      <mesh
        position={[ISLAND.centerX, DECK.y + ISLAND.height / 2, ISLAND.centerZ]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[ISLAND.width, ISLAND.height, ISLAND.length]} />
        <meshStandardMaterial color="#868d96" roughness={0.8} />
      </mesh>
      <mesh
        position={[ISLAND.centerX, DECK.y + ISLAND.mastHeight / 2, ISLAND.centerZ - 12]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[2, ISLAND.mastHeight, 2]} />
        <meshStandardMaterial color="#868d96" roughness={0.8} />
      </mesh>
      <mesh position={[-12, DECK.y + 20, -70]} castShadow receiveShadow>
        <boxGeometry args={[5, 40, 5]} />
        <meshStandardMaterial color="#9a9186" roughness={0.8} />
      </mesh>
    </group>
  );
}

export default function SkySandbox() {
  const altitude = numberParam('altitude', IDLE_ALTITUDE);
  const speed = numberParam('speed', 0);
  const view = debugFlags.params.get('view') ?? 'ship';
  const realShip = debugFlags.params.get('ship') === '1';
  // the idle driver moves the ship along -Z at `speed`; with a pinned time it stays put there
  const shipZ = debugFlags.fixedTime !== null ? -speed * debugFlags.fixedTime : 0;
  const preset = useMemo(() => cameraPreset(view, altitude, shipZ), [view, altitude, shipZ]);
  // SandboxStage takes camera and target relative to the ship's hover position
  const camera: Triple = [preset.camera[0], preset.camera[1] - altitude, preset.camera[2]];
  const target: Triple = [preset.target[0], preset.target[1] - altitude, preset.target[2]];
  return (
    <SandboxStage
      background={null}
      lights={false}
      camera={camera}
      target={target}
      altitude={altitude}
      forwardSpeed={speed}
    >
      <ShipPlacement altitude={altitude} speed={speed} />
      <World />
      <Clouds />
      <mesh rotation-x={-Math.PI / 2}>
        <planeGeometry args={[240_000, 240_000]} />
        <meshStandardMaterial color="#0b2a44" roughness={0.6} />
      </mesh>
      {realShip ? (
        <Suspense fallback={null}>
          <Carrier />
        </Suspense>
      ) : (
        <StandInShip />
      )}
    </SandboxStage>
  );
}
