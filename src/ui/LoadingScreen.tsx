/** LoadingScreen — covers the app until the scene has drawn and while the physics chunk loads. PLACEHOLDER. */
import { useGameStore } from '../state/useGameStore';

export default function LoadingScreen() {
  const sceneReady = useGameStore((s) => s.sceneReady);
  const physicsLoading = useGameStore((s) => s.physicsLoading);
  if (sceneReady && !physicsLoading) return null;
  return (
    <div
      data-testid="loading-screen"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background: sceneReady ? 'rgba(6, 13, 22, 0.6)' : 'var(--fac-bg)',
        pointerEvents: 'auto',
        zIndex: 50,
      }}
    >
      <span className="fac-label">
        {physicsLoading ? 'Spinning up flight systems…' : 'Loading…'}
      </span>
    </div>
  );
}
