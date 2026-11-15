/** World — sky, sun / ambient lighting and fog. PLACEHOLDER: flat sky colour and a fixed sun. */
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { DirectionalLight } from 'three';
import { sim } from '../state/sim';

export default function World() {
  const sun = useRef<DirectionalLight>(null);
  useFrame(() => {
    const light = sun.current;
    if (!light) return;
    light.position.copy(sim.carrier.position).addScaledVector(sim.env.sunDirection, 600);
    light.target.position.copy(sim.carrier.position);
    light.target.updateMatrixWorld();
  });
  return (
    <>
      <color attach="background" args={['#8fb9dc']} />
      <fog attach="fog" args={['#a9c8e2', 800, 16000]} />
      <hemisphereLight args={['#cfe6ff', '#2a3d4f', 0.9]} />
      <directionalLight ref={sun} intensity={2.2} color="#fff2dd" />
    </>
  );
}
