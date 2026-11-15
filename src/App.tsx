/** App — the persistent 3D canvas with the DOM overlay on top. */
import { Canvas } from '@react-three/fiber';
import AudioManager from './audio/AudioManager';
import ControlsManager from './controls/ControlsManager';
import SceneRoot from './scene/SceneRoot';
import { useQuality } from './state/useQuality';
import UIRoot from './ui/UIRoot';

export default function App() {
  const quality = useQuality();
  return (
    <div className="app">
      <Canvas
        shadows={quality.shadows}
        dpr={quality.dpr}
        // The canvas itself is never antialiased, so one GL context serves every preset and a
        // preset change never rebuilds the scene: Low draws without antialiasing, Medium and
        // High draw through the PostFX composer, which multisamples its own buffers.
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        camera={{ fov: 50, near: 1, far: 60000, position: [300, 520, 420] }}
      >
        <SceneRoot />
      </Canvas>
      <UIRoot />
      <ControlsManager />
      <AudioManager />
    </div>
  );
}
