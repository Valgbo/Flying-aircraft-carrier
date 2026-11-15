/**
 * `window.__FAC__` — a small handle for end-to-end tests and console debugging.
 * It exposes live objects; nothing here is a stable public API.
 */
import { clearInput, input, inputSources } from '../controls/input';
import { emitAction } from '../state/actions';
import { sim } from '../state/sim';
import { useGameStore } from '../state/useGameStore';

export interface FacDebugHandle {
  store: typeof useGameStore;
  sim: typeof sim;
  input: typeof input;
  inputSources: typeof inputSources;
  clearInput: typeof clearInput;
  emitAction: typeof emitAction;
}

declare global {
  interface Window {
    __FAC__?: FacDebugHandle;
  }
}

export function installDebugHook(): void {
  window.__FAC__ = { store: useGameStore, sim, input, inputSources, clearInput, emitAction };
}
