/**
 * Keyboard DOM layer: feeds window key events into the pure KeyboardCore and mirrors the
 * result into `inputSources.keyboard` and the action bus.
 *
 * Rules it enforces:
 *  - inert while a key is being captured for rebinding (src/controls/keyCapture.ts);
 *  - keys typed into an editable or value-bearing control are left alone, except Escape when
 *    it is the pause key, so a dialog can always be closed;
 *  - browser / OS chords (Ctrl+R, Alt+←, ⌘…) never fly the ship;
 *  - a key-up always releases, whatever has the focus, so nothing can stay stuck;
 *  - bound keys do not scroll the page or re-activate a focused button while flying;
 *  - everything is released on window blur, when the tab is hidden and on detach.
 */
import { emitAction } from '../state/actions';
import { useGameStore } from '../state/useGameStore';
import { emitPilotActions, pilotInputLive } from './gating';
import { clearInput, inputSources } from './input';
import { isKeyCaptureActive } from './keyCapture';
import { KeyboardCore } from './keyboard';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * A modifier is down that makes this a shortcut rather than a flight key. Ctrl and Alt only
 * count when the pilot has not bound those keys themselves.
 */
function isShortcutChord(e: KeyboardEvent, core: KeyboardCore): boolean {
  if (e.metaKey) return true;
  if (e.ctrlKey && !core.isBound('ControlLeft') && !core.isBound('ControlRight')) return true;
  if (e.altKey && !core.isBound('AltLeft') && !core.isBound('AltRight')) return true;
  return false;
}

/** Start listening. Returns the function that stops it and zeroes the keyboard slot. */
export function attachKeyboard(): () => void {
  const store = useGameStore;
  let bindings = store.getState().settings.keyBindings;
  const core = new KeyboardCore(bindings);

  const sync = (): void => {
    if (pilotInputLive(store.getState())) core.readAxes(inputSources.keyboard);
    else clearInput('keyboard');
  };

  const releaseAll = (): void => {
    core.clear();
    clearInput('keyboard');
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isKeyCaptureActive()) return;
    if (isEditableTarget(e.target)) {
      if (e.code === 'Escape' && !e.repeat && bindings.togglePause === 'Escape') {
        emitAction('togglePause');
      }
      return;
    }
    if (isShortcutChord(e, core)) {
      // with ⌘ held, macOS never delivers the key-up of the other keys: let go of everything
      if (e.metaKey) releaseAll();
      return;
    }
    if (core.isBound(e.code) && pilotInputLive(store.getState())) e.preventDefault();
    const actions = core.keyDown(e.code, e.repeat);
    sync();
    emitPilotActions(actions);
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (core.isBound(e.code) && !isEditableTarget(e.target) && pilotInputLive(store.getState())) {
      // a focused button activates on the key-up of Space
      e.preventDefault();
    }
    core.keyUp(e.code);
    sync();
  };

  const onVisibility = (): void => {
    if (document.hidden) releaseAll();
  };

  const unsubscribe = store.subscribe((state) => {
    if (state.settings.keyBindings !== bindings) {
      bindings = state.settings.keyBindings;
      core.setBindings(bindings);
    }
    sync();
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', releaseAll);
    document.removeEventListener('visibilitychange', onVisibility);
    unsubscribe();
    releaseAll();
  };
}
