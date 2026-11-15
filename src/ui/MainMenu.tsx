/** MainMenu — PLACEHOLDER. */
import { useGameStore } from '../state/useGameStore';

export default function MainMenu() {
  const setScreen = useGameStore((s) => s.setScreen);
  const setSettingsOpen = useGameStore((s) => s.setSettingsOpen);
  return (
    <div
      data-testid="main-menu"
      className="fac-panel"
      style={{ position: 'absolute', left: 32, bottom: 32, padding: 20, display: 'grid', gap: 10 }}
    >
      <h1 style={{ margin: 0, fontSize: 22, letterSpacing: '0.08em' }}>FLYING AIRCRAFT CARRIER</h1>
      <button
        className="fac-btn fac-btn--primary"
        data-testid="menu-free-flight"
        onClick={() => setScreen('flight')}
      >
        Free flight
      </button>
      <button className="fac-btn" data-testid="menu-flight-ops" onClick={() => setScreen('ops')}>
        Flight ops
      </button>
      <button className="fac-btn" data-testid="menu-hangar" onClick={() => setScreen('hangar')}>
        Hangar
      </button>
      <button
        className="fac-btn fac-btn--ghost"
        data-testid="menu-settings"
        onClick={() => setSettingsOpen(true)}
      >
        Settings
      </button>
    </div>
  );
}
