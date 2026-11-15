/**
 * Turbine — one tilting ducted fan. Rendered at its tilt pivot (the parent group sits at
 * TURBINE_MOUNTS[index]); axes are the carrier-local axes. PLACEHOLDER: ring + spinning disc.
 */
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group, Mesh } from 'three';
import { TURBINE } from '../config/layout';
import { sim } from '../state/sim';
import { turbineRpmFraction } from '../state/simHelpers';
import type { TurbineIndex } from '../state/types';
import TurbineExhaust from './TurbineExhaust';

export default function Turbine({ index }: { index: TurbineIndex }) {
  const pivot = useRef<Group>(null);
  const fan = useRef<Mesh>(null);
  useFrame(() => {
    const t = sim.turbines[index];
    // positive tilt leans the thrust axis (+Y) toward the bow (-Z): a rotation of -tilt about X
    if (pivot.current) pivot.current.rotation.x = -t.tilt;
    if (fan.current) fan.current.rotation.y += turbineRpmFraction(t) * 14 * sim.dt;
  });
  return (
    <group ref={pivot}>
      <mesh rotation-x={Math.PI / 2} castShadow>
        <torusGeometry args={[TURBINE.ductOuterRadius - 2, 2.4, 12, 48]} />
        <meshStandardMaterial color="#59626b" roughness={0.5} metalness={0.6} />
      </mesh>
      <mesh ref={fan}>
        <cylinderGeometry args={[TURBINE.fanRadius, TURBINE.fanRadius, 0.8, 11]} />
        <meshStandardMaterial color="#20262c" roughness={0.4} metalness={0.8} />
      </mesh>
      <TurbineExhaust index={index} />
    </group>
  );
}
