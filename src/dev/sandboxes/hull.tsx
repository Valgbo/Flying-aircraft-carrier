/**
 * Hull sandbox: the hull, flight deck and island on their own (no turbines).
 *
 *   /?sandbox=hull&quality=high&view=bow
 *
 * Parameters:
 *   view=bow|side|top|stern|under|island|deck|bridge|pylon|elevator   camera preset
 *   cam=x,y,z  tgt=x,y,z  fov=deg     override the preset (carrier-local metres)
 *   night=1                           dark scene with sim.env.daylight ≈ 0 to check the lights
 *   full=1                            render the whole <Carrier /> including the turbines
 *   fixedTime=<s>                     freeze sim.time (e.g. 44 = elevator on its way down)
 */
import { useFrame } from '@react-three/fiber';
import Carrier from '../../carrier/Carrier';
import Deck from '../../carrier/Deck';
import Hull from '../../carrier/Hull';
import Island from '../../carrier/Island';
import { debugFlags } from '../../config/debugFlags';
import { ISLAND } from '../../config/layout';
import { IDLE_ALTITUDE } from '../../config/physicsConfig';
import { sim } from '../../state/sim';
import SandboxStage from '../SandboxStage';

type Vec3 = [number, number, number];
interface View {
  camera: Vec3;
  target: Vec3;
  fov?: number;
}

const VIEWS: Record<string, View> = {
  bow: { camera: [190, 70, -330], target: [0, 4, -20], fov: 34 },
  side: { camera: [430, 25, 0], target: [0, 8, 0], fov: 34 },
  top: { camera: [0, 400, 0.5], target: [0, 14, 0] },
  stern: { camera: [90, 45, 330], target: [0, 4, 40], fov: 34 },
  under: { camera: [170, -150, -230], target: [0, -4, 0], fov: 36 },
  island: { camera: [-38, 52, -42], target: [26, 36, 20] },
  deck: { camera: [9, 21, 176], target: [-12, 14, 40], fov: 55 },
  bridge: { camera: [...ISLAND.bridgeEye], target: [-8, 14, -110], fov: 70 },
  pylon: { camera: [120, 30, -190], target: [40, 4, -95] },
  elevator: { camera: [95, 40, -100], target: [27, 8, -48] },
};

function parseVec(value: string | null): Vec3 | null {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? (parts as Vec3) : null;
}

/** Stands in for the sky module: holds sim.env.daylight at night level. */
function NightEnvironment() {
  useFrame(() => {
    sim.env.daylight = 0.02;
  });
  return (
    <>
      <hemisphereLight args={['#33415c', '#070a10', 0.35]} />
      <directionalLight
        position={[-300, IDLE_ALTITUDE + 400, 200]}
        intensity={0.35}
        color="#9fb4ff"
      />
    </>
  );
}

/** Extra fill for the stage's daylight so the shadowed side of the ship stays readable. */
function DayFill() {
  return (
    <>
      <ambientLight intensity={0.9} color="#dfe9f5" />
      <directionalLight
        position={[-300, IDLE_ALTITUDE + 150, -400]}
        intensity={0.7}
        color="#cfe0ff"
      />
    </>
  );
}

export default function HullSandbox() {
  const params = debugFlags.params;
  const preset = VIEWS[params.get('view') ?? 'bow'] ?? VIEWS.bow;
  const camera = parseVec(params.get('cam')) ?? preset.camera;
  const target = parseVec(params.get('tgt')) ?? preset.target;
  const fov = Number(params.get('fov')) || preset.fov || 45;
  const night = params.get('night') === '1';
  const full = params.get('full') === '1';
  return (
    <SandboxStage
      camera={camera}
      target={target}
      fov={fov}
      lights={!night}
      background={night ? '#04070d' : '#8fb9dc'}
    >
      {night ? <NightEnvironment /> : <DayFill />}
      {full ? (
        <Carrier />
      ) : (
        // fixed at the nominal hover position (no bob), so camera presets are exact
        <group position={[0, IDLE_ALTITUDE, 0]}>
          <Hull />
          <Deck />
          <Island />
        </group>
      )}
    </SandboxStage>
  );
}
