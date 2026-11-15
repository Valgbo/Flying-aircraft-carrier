/** Ocean — PLACEHOLDER: a flat blue plane that follows the camera. */
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Mesh } from 'three';

export default function Ocean() {
  const mesh = useRef<Mesh>(null);
  useFrame(({ camera }) => {
    mesh.current?.position.set(camera.position.x, 0, camera.position.z);
  });
  return (
    <mesh ref={mesh} rotation-x={-Math.PI / 2}>
      <planeGeometry args={[60000, 60000]} />
      <meshStandardMaterial color="#12466b" roughness={0.35} metalness={0.1} />
    </mesh>
  );
}
