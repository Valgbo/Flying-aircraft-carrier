/** A10App — the persistent 3D canvas with the DOM overlay, input and audio. FOUNDATION-OWNED. */
import { Canvas } from '@react-three/fiber';
import AudioManager from './audio/AudioManager';
import InputManager from './input/InputManager';
import { useA10Store } from './state/store';
import UIRoot from './ui/UIRoot';
import SceneRoot from './view/SceneRoot';

const DPR: Record<string, [number, number]> = { low: [0.75, 1], medium: [1, 1.5], high: [1, 2] };

export default function A10App() {
  const quality = useA10Store((s) => s.settings.quality);
  return (
    <div className="a10-app">
      <Canvas
        dpr={DPR[quality]}
        gl={{ antialias: true, stencil: true, powerPreference: 'high-performance' }}
        camera={{ fov: 62, near: 1, far: 90000, position: [0, 3000, 0] }}
      >
        <SceneRoot />
      </Canvas>
      <UIRoot />
      <InputManager />
      <AudioManager />
    </div>
  );
}
