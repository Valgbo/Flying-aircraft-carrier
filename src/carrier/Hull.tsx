/**
 * Hull — the lofted, chined hull shell with its elevator bay, sponsons, the four outrigger
 * pylons that reach out to the turbine pivots, and the painted identity markings (hull
 * number on both bow quarters, name across the transom). Two draw calls: the painted
 * structure and the decals. Geometry comes from src/carrier/hull/hullGeometry.ts.
 */
import { useEffect, useMemo } from 'react';
import { useQuality } from '../state/useQuality';
import { buildHullDecalGeometry, buildHullGeometry } from './hull/hullGeometry';
import { useDecalMaterial, usePaintMaterial } from './hull/materials';

export default function Hull() {
  const { detail } = useQuality();
  const structure = useMemo(() => buildHullGeometry(detail), [detail]);
  const decals = useMemo(() => buildHullDecalGeometry(), []);
  useEffect(() => () => structure.dispose(), [structure]);
  useEffect(() => () => decals.dispose(), [decals]);
  const paint = usePaintMaterial();
  const decalMaterial = useDecalMaterial();
  return (
    <group name="hull">
      <mesh geometry={structure} material={paint} castShadow receiveShadow />
      {/* paint does not cast a shadow of its own */}
      <mesh geometry={decals} material={decalMaterial} receiveShadow />
    </group>
  );
}
