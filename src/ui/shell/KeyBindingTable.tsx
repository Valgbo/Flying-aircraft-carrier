/**
 * KeyBindingTable — the key-remapping table of the settings dialog. Pressing the button of a
 * row arms `captureNextKey()`; the next key pressed becomes the binding (Escape cancels).
 * A key that another action already uses is swapped with it (rebind.ts), so no key is ever
 * bound twice. Styles: settings.css (`settings-keys`, `settings-key`).
 */
import { useEffect, useRef, useState } from 'react';
import { cancelKeyCapture, captureNextKey } from '../../controls/keyCapture';
import { BINDING_LABELS, BINDING_ORDER, keyLabel, type BindingId } from '../../state/bindings';
import { useGameStore } from '../../state/useGameStore';
import { IconWarning } from './icons';
import { findDuplicateBindings, rebind } from './rebind';

export default function KeyBindingTable() {
  const bindings = useGameStore((s) => s.settings.keyBindings);
  const setKeyBinding = useGameStore((s) => s.setKeyBinding);
  const resetKeyBindings = useGameStore((s) => s.resetKeyBindings);
  const [capturing, setCapturing] = useState<BindingId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Identifies the capture in flight, so a superseded one cannot clear its successor's state. */
  const captureToken = useRef(0);

  // closing the dialog ends a capture in progress
  useEffect(() => cancelKeyCapture, []);

  const startCapture = async (id: BindingId) => {
    if (capturing === id) {
      cancelKeyCapture();
      return;
    }
    const token = ++captureToken.current;
    setCapturing(id);
    setNotice(null);
    const code = await captureNextKey();
    if (token === captureToken.current) setCapturing(null);
    if (code === null) return;

    const current = useGameStore.getState().settings.keyBindings;
    const result = rebind(current, id, code);
    if (!result.changed) return;
    setKeyBinding(id, code);
    if (result.swappedWith) {
      setKeyBinding(result.swappedWith, current[id]);
      setNotice(
        `${keyLabel(code)} was taken: “${BINDING_LABELS[result.swappedWith]}” moved to ${keyLabel(current[id])}.`,
      );
    }
  };

  const duplicates = findDuplicateBindings(bindings);

  return (
    <div className="settings-keys">
      <p className="settings-keys__hint" id="settings-keys-hint">
        Select an action, then press its new key. Esc cancels; a key that is already taken swaps
        places with the other action.
      </p>
      <ul className="settings-keys__list" aria-describedby="settings-keys-hint">
        {BINDING_ORDER.map((id) => {
          const active = capturing === id;
          const conflict = duplicates.has(id);
          return (
            <li key={id} className="settings-keys__row">
              <span className="settings-keys__label">
                {BINDING_LABELS[id]}
                {conflict && (
                  <span
                    className="settings-keys__conflict"
                    title="This key is bound to more than one action"
                  >
                    <IconWarning size={14} />
                    <span className="fac-visually-hidden">Key bound to more than one action</span>
                  </span>
                )}
              </span>
              <button
                type="button"
                className="settings-key fac-focusable"
                data-testid={`settings-rebind-${id}`}
                data-capturing={active ? '' : undefined}
                aria-label={
                  active
                    ? `${BINDING_LABELS[id]}: press a key, or Escape to cancel`
                    : `${BINDING_LABELS[id]}: ${keyLabel(bindings[id])}. Change key`
                }
                onClick={() => void startCapture(id)}
                // moving on (Tab is captured, so this means a click elsewhere) ends the capture
                onBlur={() => {
                  if (active) cancelKeyCapture();
                }}
              >
                {active ? 'Press a key…' : keyLabel(bindings[id])}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="settings-keys__foot">
        <p className="settings-keys__notice" role="status">
          {notice}
        </p>
        <button
          type="button"
          className="fac-btn fac-btn--ghost settings-btn"
          data-testid="settings-reset-controls"
          onClick={() => {
            cancelKeyCapture();
            resetKeyBindings();
            setNotice('Controls reset to their defaults.');
          }}
        >
          Reset controls
        </button>
      </div>
    </div>
  );
}
