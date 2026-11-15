/**
 * PauseMenu — shown on the flying screens while `store.paused`: resume, restart, settings,
 * exit, plus the current key bindings as a compact reference. While the settings dialog is
 * open on top of it the menu hides and hands the focus over; when the dialog closes, focus
 * returns to the button that opened it. Escape resumes: through the `togglePause` action
 * while Pause is bound to Escape, through this component once the player has moved Pause to
 * another key — never both. Styles: shell/pause.css.
 */
import { useEffect, useRef } from 'react';
import { isKeyCaptureActive } from '../controls/keyCapture';
import { useGameStore } from '../state/useGameStore';
import BrandMark from './shell/BrandMark';
import { OPS_ONLY_BINDINGS, keyboardCheatSheet } from './shell/cheatSheet';
import { KeyReference } from './shell/controls';
import { useModalFocus } from './shell/useModalFocus';
import './shell/shell.css';
import './shell/pause.css';

export default function PauseMenu() {
  const screen = useGameStore((s) => s.screen);
  const settingsOpen = useGameStore((s) => s.settingsOpen);
  const bindings = useGameStore((s) => s.settings.keyBindings);
  const setPaused = useGameStore((s) => s.setPaused);
  const resetFlight = useGameStore((s) => s.resetFlight);
  const setSettingsOpen = useGameStore((s) => s.setSettingsOpen);
  const setScreen = useGameStore((s) => s.setScreen);
  const panelRef = useRef<HTMLDivElement>(null);

  useModalFocus(panelRef, { active: !settingsOpen });

  // Capture phase: read the dialog state before the settings dialog's own Escape handler
  // has closed it, so one key press never closes both.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || isKeyCaptureActive()) return;
      const state = useGameStore.getState();
      if (state.settingsOpen || !state.paused) return;
      // Escape with a job of its own: Pause toggles through its action, anything else is
      // the player's choice of game key
      if (Object.values(state.settings.keyBindings).includes('Escape')) return;
      state.setPaused(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <div className="pause" data-testid="pause-menu" hidden={settingsOpen}>
      <div
        ref={panelRef}
        className="pause-panel fac-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pause-title"
        tabIndex={-1}
      >
        <header className="pause-head">
          <BrandMark height={40} />
          <div>
            <h2 className="pause-title" id="pause-title">
              Paused
            </h2>
            <p className="fac-label pause-mode">
              {screen === 'ops' ? 'Flight ops' : 'Free flight'}
            </p>
          </div>
        </header>

        <div className="pause-actions">
          <button
            type="button"
            className="fac-btn fac-btn--primary"
            data-testid="pause-resume"
            data-autofocus
            onClick={() => setPaused(false)}
          >
            Resume
          </button>
          <button
            type="button"
            className="fac-btn"
            data-testid="pause-restart"
            onClick={() => resetFlight()}
          >
            Restart
          </button>
          <button
            type="button"
            className="fac-btn"
            data-testid="pause-settings"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </button>
          <button
            type="button"
            className="fac-btn fac-btn--ghost"
            data-testid="pause-exit"
            onClick={() => setScreen('menu')}
          >
            Exit to menu
          </button>
        </div>

        <section className="pause-keys" aria-labelledby="pause-keys-title">
          <h3 className="fac-label pause-keys__title" id="pause-keys-title">
            Keys
          </h3>
          <KeyReference
            rows={keyboardCheatSheet(bindings, screen === 'ops' ? [] : OPS_ONLY_BINDINGS)}
          />
        </section>
      </div>
    </div>
  );
}
