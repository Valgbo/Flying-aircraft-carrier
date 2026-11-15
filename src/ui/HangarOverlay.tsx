/** HangarOverlay — inspect-mode UI: hotspots, info cards, demo controls. PLACEHOLDER. */
import { useGameStore } from '../state/useGameStore';

export default function HangarOverlay() {
  const setScreen = useGameStore((s) => s.setScreen);
  return (
    <div data-testid="hangar-overlay" style={{ position: 'absolute', left: 24, top: 24 }}>
      <button className="fac-btn" data-testid="hangar-back" onClick={() => setScreen('menu')}>
        ← Back
      </button>
    </div>
  );
}
