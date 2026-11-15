/**
 * Compact legend of the keyboard controls, built from the live key bindings. It can be
 * dismissed (a small button brings it back) and is not rendered at all while the on-screen
 * touch controls are visible — their corner belongs to them.
 */
import { useState } from 'react';
import { useTouchControlsVisible } from '../../controls/touchVisibility';
import { useGameStore } from '../../state/useGameStore';
import { CloseIcon, KeyboardIcon } from './icons';
import { buildKeyHints } from './keyHints';

/** Remembered for the session, so the legend stays dismissed across screen changes. */
let dismissedThisSession = false;

export default function KeyLegend() {
  const touch = useTouchControlsVisible();
  const bindings = useGameStore((s) => s.settings.keyBindings);
  const screen = useGameStore((s) => s.screen);
  const assistEnabled = useGameStore((s) => s.assistEnabled);
  const [dismissed, setDismissed] = useState(dismissedThisSession);

  if (touch) return null;

  const setHidden = (hidden: boolean): void => {
    dismissedThisSession = hidden;
    setDismissed(hidden);
  };

  if (dismissed) {
    return (
      <button
        type="button"
        className="hud-keys-show hud-iconbtn fac-focusable"
        onClick={() => setHidden(false)}
        aria-label="Show keyboard controls"
        title="Show keyboard controls"
      >
        <KeyboardIcon />
      </button>
    );
  }

  const hints = buildKeyHints(bindings, screen, assistEnabled);
  return (
    <section className="hud-keys fac-panel" aria-label="Keyboard controls">
      <header className="hud-keys-head">
        <span className="fac-label">Controls</span>
        <button
          type="button"
          className="hud-keys-close fac-focusable"
          onClick={() => setHidden(true)}
          aria-label="Hide keyboard controls"
          title="Hide"
        >
          <CloseIcon />
        </button>
      </header>
      <dl className="hud-keys-list">
        {hints.map((hint) => (
          <div className="hud-keys-row" key={hint.id}>
            <dt>
              {hint.keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </dt>
            <dd>{hint.label}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
