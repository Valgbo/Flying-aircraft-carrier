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
        // the antialias flag can only be chosen when the GL context is created
        key={quality.antialias ? 'aa' : 'no-aa'}
        shadows={quality.shadows}
        dpr={quality.dpr}
        gl={{ antialias: quality.antialias, powerPreference: 'high-performance' }}
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
