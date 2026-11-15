/**
 * Deck — the flight deck: the textured surface with all painted markings (in layout
 * coordinates), the slab structure with arrestor wires, shuttles and deck-edge fittings, the
 * aircraft elevator cycling on its schedule, and the instanced deck / navigation lights.
 * Four draw calls. Per frame only the elevator height and the light brightness change.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  Color,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type InstancedMesh,
  type Mesh,
} from 'three';
import { ELEVATOR } from '../config/layout';
import { PALETTE } from '../config/palette';
import { sim } from '../state/sim';
import { useQuality } from '../state/useQuality';
import {
  buildDeckStructureGeometry,
  buildDeckSurfaceGeometry,
  buildElevatorGeometry,
  buildLightFittingGeometry,
} from './hull/deckGeometry';
import {
  deckLightBrightness,
  deckLightLayout,
  navigationLights,
  type LightColor,
} from './hull/deckLayout';
import { createDeckTexture } from './hull/deckTexture';
import { elevatorHeightAt } from './hull/elevator';
import { usePaintMaterial } from './hull/materials';

const LIGHT_COLORS: Record<LightColor, string> = {
  white: PALETTE.lightWhite,
  blue: PALETTE.lightBlue,
  green: PALETTE.lightGreen,
  red: PALETTE.lightRed,
};

const _matrix = new Matrix4();
const _color = new Color();

export default function Deck() {
  const quality = useQuality();
  const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy());
  // ≈ 8 cm per pixel normally, half that resolution on the lowest preset
  const pixelsPerMetre = quality.detail === 0 ? 6.4 : 12.8;

  const deckMap = useMemo(
    () => createDeckTexture(pixelsPerMetre, Math.min(16, maxAnisotropy)),
    [pixelsPerMetre, maxAnisotropy],
  );
  const deckMaterial = useMemo(
    () => new MeshStandardMaterial({ map: deckMap, roughness: 0.9, metalness: 0.04 }),
    [deckMap],
  );
  const lightMaterial = useMemo(() => new MeshBasicMaterial({ toneMapped: false }), []);
  const surface = useMemo(() => buildDeckSurfaceGeometry(), []);
  const structure = useMemo(() => buildDeckStructureGeometry(quality.detail), [quality.detail]);
  const elevator = useMemo(() => buildElevatorGeometry(), []);
  const fitting = useMemo(() => buildLightFittingGeometry(), []);
  const paint = usePaintMaterial();
  useEffect(() => () => deckMap.dispose(), [deckMap]);
  useEffect(() => () => deckMaterial.dispose(), [deckMaterial]);
  useEffect(() => () => lightMaterial.dispose(), [lightMaterial]);
  useEffect(() => () => surface.dispose(), [surface]);
  useEffect(() => () => structure.dispose(), [structure]);
  useEffect(() => () => elevator.dispose(), [elevator]);
  useEffect(() => () => fitting.dispose(), [fitting]);

  const lights = useMemo(
    () => [...deckLightLayout(quality.deckLights), ...navigationLights()],
    [quality.deckLights],
  );
  const lightsRef = useRef<InstancedMesh>(null);
  const elevatorRef = useRef<Mesh>(null);

  useLayoutEffect(() => {
    const mesh = lightsRef.current;
    if (!mesh) return;
    lights.forEach((light, i) => {
      _matrix.makeScale(light.scale, light.scale, light.scale);
      _matrix.setPosition(light.position[0], light.position[1], light.position[2]);
      mesh.setMatrixAt(i, _matrix);
      mesh.setColorAt(i, _color.set(LIGHT_COLORS[light.color]).multiplyScalar(light.gain));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [lights]);

  useFrame(() => {
    const platform = elevatorRef.current;
    if (platform) platform.position.y = elevatorHeightAt(sim.time) - ELEVATOR.topY;
    const mesh = lightsRef.current;
    if (mesh) {
      (mesh.material as MeshBasicMaterial).color.setScalar(deckLightBrightness(sim.env.daylight));
    }
  });

  return (
    <group name="deck">
      <mesh geometry={surface} material={deckMaterial} castShadow receiveShadow />
      <mesh geometry={structure} material={paint} castShadow receiveShadow />
      <mesh
        ref={elevatorRef}
        name="elevator"
        geometry={elevator}
        material={deckMaterial}
        castShadow
        receiveShadow
      />
      {/* emissive fittings: they glow rather than take part in the shadow pass */}
      <instancedMesh
        key={lights.length}
        ref={lightsRef}
        name="deck-lights"
        args={[fitting, lightMaterial, lights.length]}
      />
    </group>
  );
}
