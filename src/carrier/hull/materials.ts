/**
 * Material hooks shared by the hull, deck and island. Each component gets its own material
 * instance (disposed when it unmounts) while the textures behind them are shared.
 */
import { useEffect, useMemo } from 'react';
import { MeshStandardMaterial } from 'three';
import { useDecalAtlas, usePlatingTexture } from './shipTextures';

/** Painted steel: vertex colours carry the paint scheme, the plating map adds seams and weathering. */
export function usePaintMaterial(): MeshStandardMaterial {
  const map = usePlatingTexture();
  const material = useMemo(
    () => new MeshStandardMaterial({ vertexColors: true, map, roughness: 0.62, metalness: 0.2 }),
    [map],
  );
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

/**
 * Painted markings floating just off the plating. Besides the real offset of the quads,
 * polygon offset keeps them in front at long range where depth precision runs out.
 */
export function useDecalMaterial(): MeshStandardMaterial {
  const map = useDecalAtlas();
  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        map,
        transparent: true,
        depthWrite: false,
        roughness: 0.7,
        metalness: 0.05,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    [map],
  );
  useEffect(() => () => material.dispose(), [material]);
  return material;
}
