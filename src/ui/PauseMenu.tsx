/** PauseMenu — PLACEHOLDER. */
import { useGameStore } from '../state/useGameStore';

export default function PauseMenu() {
  const s = useGameStore();
  return (
    <div
      data-testid="pause-menu"
      className="fac-panel"
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        padding: 20,
        display: 'grid',
        gap: 10,
        minWidth: 220,
      }}
    >
      <strong>PAUSED</strong>
      <button
        className="fac-btn fac-btn--primary"
        data-testid="pause-resume"
        onClick={() => s.setPaused(false)}
      >
        Resume
      </button>
      <button className="fac-btn" data-testid="pause-restart" onClick={() => s.resetFlight()}>
        Restart
      </button>
      <button
        className="fac-btn"
        data-testid="pause-settings"
        onClick={() => s.setSettingsOpen(true)}
      >
        Settings
      </button>
      <button
        className="fac-btn fac-btn--ghost"
        data-testid="pause-exit"
        onClick={() => s.setScreen('menu')}
      >
        Exit to menu
      </button>
    </div>
  );
}
