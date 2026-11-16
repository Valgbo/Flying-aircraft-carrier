/**
 * Terrain rendering. OWNED BY THE TERRAIN-VIEW MODULE.
 * FOUNDATION STAND-IN: one coarse 24 km mesh re-centred under the aircraft, coloured by height.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { BufferAttribute, Mesh, PlaneGeometry } from 'three';
import { getSim, getTerrain } from '../../state/runtime';

const N = 160;
const SPAN = 24000;

export default function TerrainView() {
  const mesh = useRef<Mesh>(null);
  const geometry = useMemo(() => {
    const g = new PlaneGeometry(SPAN, SPAN, N, N);
    g.rotateX(-Math.PI / 2);
    g.setAttribute('color', new BufferAttribute(new Float32Array((N + 1) * (N + 1) * 3), 3));
    return g;
  }, []);
  const centre = useRef({ x: Infinity, z: Infinity });

  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame(() => {
    const sim = getSim();
    const terrain = getTerrain();
    if (!terrain || !mesh.current) return;
    const px = sim ? sim.aircraft.position.x : terrain.start.x;
    const pz = sim ? sim.aircraft.position.z : terrain.start.z;
    const cell = SPAN / N;
    const cx = Math.round(px / (cell * 8)) * cell * 8;
    const cz = Math.round(pz / (cell * 8)) * cell * 8;
    if (cx === centre.current.x && cz === centre.current.z) return;
    centre.current = { x: cx, z: cz };
    const pos = geometry.attributes.position as BufferAttribute;
    const col = geometry.attributes.color as BufferAttribute;
    const base = new PlaneGeometry(SPAN, SPAN, N, N).rotateX(-Math.PI / 2).attributes
      .position as BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = base.getX(i) + cx;
      const z = base.getZ(i) + cz;
      const h = terrain.heightAt(x, z);
      pos.setXYZ(i, base.getX(i), h, base.getZ(i));
      const t = Math.min(1, Math.max(0, (h - 80) / 400));
      col.setXYZ(i, 0.32 + 0.2 * t, 0.42 + 0.08 * t, 0.22 + 0.12 * t);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geometry.computeVertexNormals();
    mesh.current.position.set(cx, 0, cz);
  });

  return (
    <mesh ref={mesh} geometry={geometry} frustumCulled={false}>
      <meshLambertMaterial vertexColors />
    </mesh>
  );
}
