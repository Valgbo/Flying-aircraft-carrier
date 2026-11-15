/**
 * Flight-ops sandbox: the air wing on a stand-in deck (or the real ship), with the ops HUD.
 *
 *   /?sandbox=ops&quality=high&active=1&auto=1&view=overview
 *
 * Parameters:
 *   active=1        run the ops game (otherwise the jets stay parked)
 *   auto=1          press launch automatically every few seconds
 *   launch=N        press launch N times right after loading
 *   view=overview|parked|jet|cat|approach|wires|pattern    camera preset
 *   cam=x,y,z  tgt=x,y,z  fov=deg                          override the preset (ship-relative metres)
 *   follow=N        camera rides behind jet N (follow=-N looks at it from ahead)
 *   ship=1          render the real <Carrier /> instead of the stand-in deck
 *   rock=deg        rock the ship (roll amplitude in degrees) to provoke holds and wave-offs
 *   warp=N          run simulated time N× faster (software rendering is slow)
 *   speed=m/s       ship forward speed
 *   hud=0           hide the HUD overlay
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  BufferGeometry,
  Euler,
  Float32BufferAttribute,
  Shape,
  ShapeGeometry,
  Vector3,
  type Group,
} from 'three';
import FlightOps from '../../aircraft/FlightOps';
import { OPS } from '../../aircraft/opsConfig';
import { STRIP, approachLinePoint, stripPoint } from '../../aircraft/pattern';
import Carrier from '../../carrier/Carrier';
import { debugFlags } from '../../config/debugFlags';
import { FRAME_PRIORITY } from '../../config/frame';
import {
  CATAPULTS,
  DECK,
  ELEVATOR,
  ISLAND,
  LANDING_STRIP,
  PARKING_SPOTS,
} from '../../config/layout';
import { PALETTE } from '../../config/palette';
import { emitAction } from '../../state/actions';
import { sim } from '../../state/sim';
import OpsHUD from '../../ui/OpsHUD';
import Toasts from '../../ui/Toasts';
import { DEG2RAD } from '../../utils/math';
import SandboxStage from '../SandboxStage';

type Vec3 = [number, number, number];
interface View {
  camera: Vec3;
  target: Vec3;
  fov: number;
}

const FINAL_VIEW = approachLinePoint(300);

const VIEWS: Record<string, View> = {
  overview: { camera: [-150, 230, 190], target: [0, 14, 10], fov: 45 },
  parked: { camera: [-4, 26, 62], target: [27, 16, 100], fov: 40 },
  jet: { camera: [10, 20.5, 55], target: [27, 16, 68], fov: 32 },
  cat: { camera: [-34, 22, -30], target: [0, 15, -75], fov: 45 },
  approach: { camera: [FINAL_VIEW[0] + 6, 46, FINAL_VIEW[1]], target: [-4, 14, 90], fov: 26 },
  wires: { camera: [-34, 24, 128], target: [0, 15, 92], fov: 45 },
  pattern: { camera: [500, 900, 2400], target: [-700, 200, 300], fov: 55 },
};

function parseVec(value: string | null): Vec3 | null {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? (parts as Vec3) : null;
}

/** Line segments on the deck, 5 cm above the surface, from [x, z] point pairs. */
function deckLines(segments: readonly (readonly [number, number])[][]): BufferGeometry {
  const positions: number[] = [];
  for (const line of segments) {
    for (let i = 0; i < line.length - 1; i++) {
      positions.push(line[i][0], DECK.y + 0.05, line[i][1]);
      positions.push(line[i + 1][0], DECK.y + 0.05, line[i + 1][1]);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geometry;
}

/** A dark slab with the deck outline and the layout drawn on it, following the ship. */
function StandInDeck() {
  const group = useRef<Group>(null);
  const parts = useMemo(() => {
    const shape = new Shape();
    DECK.outline.forEach(([x, z], i) => (i === 0 ? shape.moveTo(x, z) : shape.lineTo(x, z)));
    shape.closePath();
    const slab = new ShapeGeometry(shape);
    // the shape lies in XY: turn it into the deck plane (shape y → ship z)
    slab.rotateX(Math.PI / 2);

    const half = LANDING_STRIP.width / 2;
    const side = (distance: number, offset: number): [number, number] => {
      const p = stripPoint(distance);
      return [p[0] - STRIP.dirZ * offset, p[1] + STRIP.dirX * offset];
    };
    const white = deckLines([
      [side(0, -half), side(STRIP.length, -half)],
      [side(0, half), side(STRIP.length, half)],
      [side(0, 0), side(STRIP.length, 0)],
      ...LANDING_STRIP.wireDistances.map((d) => [side(d, -half - 1), side(d, half + 1)]),
    ]);
    const yellow = deckLines([
      ...CATAPULTS.map((c): [number, number][] => [
        [c.start[0], c.start[2]],
        [c.end[0], c.end[2]],
      ]),
      ...PARKING_SPOTS.map((spot): [number, number][] => {
        const [x, , z] = spot.position;
        const heading = spot.headingDeg * DEG2RAD;
        const dx = Math.sin(heading);
        const dz = -Math.cos(heading);
        return [
          [x - dx * 8, z - dz * 8],
          [x + dx * 8, z + dz * 8],
          [x + dx * 6 + dz * 1.5, z + dz * 6 - dx * 1.5],
        ];
      }),
      [
        [ELEVATOR.minX, ELEVATOR.minZ],
        [ELEVATOR.maxX, ELEVATOR.minZ],
        [ELEVATOR.maxX, ELEVATOR.maxZ],
        [ELEVATOR.minX, ELEVATOR.maxZ],
        [ELEVATOR.minX, ELEVATOR.minZ],
      ],
    ]);
    const lane = deckLines([
      [
        [OPS.laneX, 140],
        [OPS.laneX, -24],
      ],
    ]);
    return { slab, white, yellow, lane };
  }, []);
  useEffect(
    () => () => {
      for (const geometry of Object.values(parts)) geometry.dispose();
    },
    [parts],
  );
  useFrame(() => {
    group.current?.position.copy(sim.carrier.position);
    group.current?.quaternion.copy(sim.carrier.quaternion);
  });
  return (
    <group ref={group}>
      <mesh geometry={parts.slab} position={[0, DECK.y, 0]} receiveShadow>
        <meshStandardMaterial color={PALETTE.deck} roughness={0.9} side={2} />
      </mesh>
      <lineSegments geometry={parts.white}>
        <lineBasicMaterial color={PALETTE.markingWhite} />
      </lineSegments>
      <lineSegments geometry={parts.yellow}>
        <lineBasicMaterial color={PALETTE.markingYellow} />
      </lineSegments>
      <lineSegments geometry={parts.lane}>
        <lineBasicMaterial color={PALETTE.lightBlue} />
      </lineSegments>
      <mesh
        position={[ISLAND.centerX, DECK.y + ISLAND.height / 2, ISLAND.centerZ]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[ISLAND.width, ISLAND.height, ISLAND.length]} />
        <meshStandardMaterial color={PALETTE.hull} roughness={0.8} />
      </mesh>
    </group>
  );
}

const _euler = new Euler(0, 0, 0, 'YXZ');

/**
 * Runs between the idle driver and the gameplay systems: speeds simulated time up and / or
 * rocks the ship, so slow software rendering can still show whole sorties and wave-offs.
 */
function TimeAndMotion({ warp, rockDeg }: { warp: number; rockDeg: number }) {
  useFrame(() => {
    if (sim.dt > 0 && warp > 1) {
      const extra = sim.dt * (warp - 1);
      sim.dt += extra;
      sim.time += extra;
    }
    if (rockDeg > 0) {
      const amplitude = rockDeg * DEG2RAD;
      const c = sim.carrier;
      c.roll = amplitude * Math.sin(sim.time * 1.3);
      c.pitch = 0.3 * amplitude * Math.sin(sim.time * 0.9);
      c.quaternion.setFromEuler(_euler.set(c.pitch, 0, -c.roll));
      c.angularVelocity.set(
        0.27 * amplitude * Math.cos(sim.time * 0.9),
        0,
        -1.3 * amplitude * Math.cos(sim.time * 1.3),
      );
    }
  }, FRAME_PRIORITY.driver + 10);
  return null;
}

function AutoLaunch({ interval }: { interval: number }) {
  const next = useRef(2);
  useFrame(() => {
    if (sim.time < next.current) return;
    next.current = sim.time + interval;
    emitAction('launchJet');
  }, FRAME_PRIORITY.systems + 1);
  return null;
}

const _offset = new Vector3();

/** Rides with jet `id`: behind and above it, or ahead of it looking back when `ahead`. */
function FollowCamera({ id, ahead }: { id: number; ahead: boolean }) {
  const camera = useThree((s) => s.camera);
  useFrame(() => {
    const jet = sim.jets.find((j) => j.id === id);
    if (!jet) return;
    _offset.set(9, 5, ahead ? -30 : 30).applyQuaternion(jet.quaternion);
    camera.position.copy(jet.position).add(_offset);
    camera.lookAt(jet.position);
  });
  return null;
}

export default function OpsSandbox() {
  const params = debugFlags.params;
  const preset = VIEWS[params.get('view') ?? 'overview'] ?? VIEWS.overview;
  const camera = parseVec(params.get('cam')) ?? preset.camera;
  const target = parseVec(params.get('tgt')) ?? preset.target;
  const fov = Number(params.get('fov')) || preset.fov;
  const active = params.get('active') === '1';
  const follow = Number(params.get('follow')) || 0;
  const launches = Number(params.get('launch')) || 0;
  const warp = Number(params.get('warp')) || 1;
  const rockDeg = Number(params.get('rock')) || 0;

  useEffect(() => {
    if (!active) return;
    // after FlightOps has mounted and subscribed to the action
    const id = window.setTimeout(() => {
      for (let i = 0; i < launches; i++) emitAction('launchJet');
    }, 300);
    return () => window.clearTimeout(id);
  }, [active, launches]);

  return (
    <>
      <SandboxStage
        camera={camera}
        target={target}
        fov={fov}
        forwardSpeed={Number(params.get('speed')) || 0}
      >
        <ambientLight intensity={0.5} color="#dfe9f5" />
        <TimeAndMotion warp={warp} rockDeg={rockDeg} />
        {params.get('ship') === '1' ? <Carrier /> : <StandInDeck />}
        <FlightOps active={active} />
        {active && params.get('auto') === '1' && <AutoLaunch interval={6} />}
        {follow !== 0 && <FollowCamera id={Math.abs(follow)} ahead={follow < 0} />}
      </SandboxStage>
      {params.get('hud') !== '0' && (
        <div className="ui-root">
          <OpsHUD />
          <Toasts />
        </div>
      )}
    </>
  );
}
