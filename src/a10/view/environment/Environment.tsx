/**
 * Environment: sky, sun and ambient light, haze, clouds. OWNED BY THE TERRAIN-VIEW MODULE.
 * FOUNDATION STAND-IN: a sky colour, linear fog and two lights.
 */
import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { Color, Fog } from 'three';

export default function Environment() {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    scene.background = new Color('#9fc3e6');
    scene.fog = new Fog('#b9cfe2', 4000, 30000);
    return () => {
      scene.background = null;
      scene.fog = null;
    };
  }, [scene]);
  return (
    <>
      <hemisphereLight args={['#cfe3ff', '#4a5a3a', 0.9]} />
      <directionalLight position={[3000, 6000, 2000]} intensity={2.2} />
    </>
  );
}
