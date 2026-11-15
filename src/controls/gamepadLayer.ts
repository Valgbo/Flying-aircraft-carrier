/**
 * Gamepad DOM layer: finds the first standard-mapping pad, polls it in a single
 * requestAnimationFrame loop that only runs while such a pad is connected, and mirrors it
 * into `inputSources.gamepad` and the action bus (same gating as the keyboard).
 */
import { useGameStore } from '../state/useGameStore';
import { GamepadButtonEdges, mapGamepadAxes, pickGamepad } from './gamepad';
import { emitPilotActions, pilotInputLive } from './gating';
import { clearInput, inputSources } from './input';

/** Live status of the pad in use, for diagnostics (the controls sandbox shows it). */
export const gamepadStatus = { connected: false, id: '' };

const TOAST_MS = 2500;

function readPad(): Gamepad | null {
  try {
    return pickGamepad(navigator.getGamepads());
  } catch {
    // getGamepads() throws when a permissions policy forbids the Gamepad API
    return null;
  }
}

/** Start watching for gamepads. Returns the function that stops it and zeroes the slot. */
export function attachGamepad(): () => void {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
    return () => undefined;
  }
  const store = useGameStore;
  const edges = new GamepadButtonEdges();
  /** `Gamepad.index` of the pad in use, -1 for none. */
  let activeIndex = -1;
  let frame = 0;

  const poll = (): void => {
    frame = 0;
    const pad = readPad();
    if (!pad || pad.index !== activeIndex) {
      // vanished or replaced without an event: adopt() restarts the loop if a pad remains
      adopt(pad, true);
      return;
    }
    const state = store.getState();
    if (pilotInputLive(state)) mapGamepadAxes(pad, state.settings.invertY, inputSources.gamepad);
    else clearInput('gamepad');
    emitPilotActions(edges.update(pad));
    frame = requestAnimationFrame(poll);
  };

  function adopt(pad: Gamepad | null, announce: boolean): void {
    const index = pad ? pad.index : -1;
    if (index === activeIndex) return;
    const hadPad = activeIndex !== -1;
    activeIndex = index;
    edges.reset();
    clearInput('gamepad');
    gamepadStatus.connected = pad !== null;
    gamepadStatus.id = pad ? pad.id : '';
    if (announce && hadPad !== (pad !== null)) {
      store
        .getState()
        .pushMessage(pad ? 'GAMEPAD CONNECTED' : 'GAMEPAD DISCONNECTED', 'info', TOAST_MS);
    }
    if (pad && frame === 0) frame = requestAnimationFrame(poll);
    if (!pad && frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }

  const onPadsChanged = (): void => adopt(readPad(), true);

  // requestAnimationFrame stops in a hidden tab, so the last stick position would linger
  const onVisibility = (): void => {
    if (document.hidden) clearInput('gamepad');
  };

  window.addEventListener('gamepadconnected', onPadsChanged);
  window.addEventListener('gamepaddisconnected', onPadsChanged);
  document.addEventListener('visibilitychange', onVisibility);
  // a pad the page already knows about is picked up quietly (no toast on every mount)
  adopt(readPad(), false);

  return () => {
    window.removeEventListener('gamepadconnected', onPadsChanged);
    window.removeEventListener('gamepaddisconnected', onPadsChanged);
    document.removeEventListener('visibilitychange', onVisibility);
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    activeIndex = -1;
    gamepadStatus.connected = false;
    gamepadStatus.id = '';
    clearInput('gamepad');
  };
}
