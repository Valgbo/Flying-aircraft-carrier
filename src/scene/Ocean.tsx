/**
 * Ocean — the open sea, in one draw call.
 *
 * One camera-centred grid (src/scene/ocean/oceanGrid.ts) displaced in the vertex shader by the
 * same wave table buoyancy uses (`waveHeightAt`, src/config/waves.ts), shaded analytically from
 * `sim.env` with no reflection or refraction passes. It also draws what the ship does to the
 * water: waterline foam and wake, the splash of a touch-down, the four turbine downwash patches
 * and a contact shadow.
 * See src/scene/ocean/oceanShader.ts for the shading model and oceanFrame.ts for the inputs.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { Mesh } from 'three';
import { onEvent } from '../state/events';
import { useGameStore } from '../state/useGameStore';
import { useQuality } from '../state/useQuality';
import { createDetailTexture } from './ocean/detailTexture';
import { OCEAN } from './ocean/oceanConfig';
import { createOceanSurface, startSplash, updateOceanSurface } from './ocean/oceanFrame';
import { buildOceanGeometry, oceanGridLayout } from './ocean/oceanGrid';

export default function Ocean() {
  const mesh = useRef<Mesh>(null);
  const level = useGameStore((s) => s.effectiveQuality);
  const segments = useQuality().oceanSegments;
  const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy());

  const detail = useMemo(() => {
    const texture = createDetailTexture();
    texture.anisotropy = Math.max(1, Math.min(OCEAN.anisotropy, maxAnisotropy));
    return texture;
  }, [maxAnisotropy]);
  useEffect(() => () => detail.dispose(), [detail]);

  const layout = useMemo(() => oceanGridLayout(segments), [segments]);
  const geometry = useMemo(() => buildOceanGeometry(layout), [layout]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // the number of ripple octaves is compiled into the shader, so the material follows the preset
  const surface = useMemo(
    () => createOceanSurface(level, detail, detail.anisotropy),
    [level, detail],
  );
  useEffect(() => () => surface.material.dispose(), [surface]);
  useEffect(
    () => onEvent('splashdown', ({ sinkRate }) => startSplash(surface, sinkRate)),
    [surface],
  );

  useFrame(({ camera, scene }) => {
    if (mesh.current) updateOceanSurface(surface, mesh.current, camera, scene, layout.baseCell);
  });

  return (
    <mesh
      ref={mesh}
      name="ocean"
      geometry={geometry}
      material={surface.material}
      frustumCulled={false}
    />
  );
}
