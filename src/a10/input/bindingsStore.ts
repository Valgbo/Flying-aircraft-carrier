/**
 * The live bindings, persisted under localStorage 'a10-bindings-v1' and validated field by
 * field on load (bindings.ts `sanitizeBindings`). OWNED BY THE INPUT MODULE. React reads it with
 * `useBindings`; the input runtime and the controls reference subscribe without React.
 */
import { create } from 'zustand';
import {
  defaultBindingsConfig,
  loadBindings,
  sanitizeBindings,
  saveBindings,
  type BindingsConfig,
} from './bindings';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export interface BindingsStore {
  config: BindingsConfig;
  /** Replace the configuration (sanitised) and save it. */
  setConfig(config: BindingsConfig): void;
  /** Every control and option back to the PLAN_A10.md §12 defaults. */
  resetAll(): void;
}

export const useBindings = create<BindingsStore>((set) => ({
  config: loadBindings(storage()),
  setConfig: (config) => {
    const clean = sanitizeBindings(config);
    saveBindings(storage(), clean);
    set({ config: clean });
  },
  resetAll: () => {
    const config = defaultBindingsConfig();
    saveBindings(storage(), config);
    set({ config });
  },
}));

export function getBindingsConfig(): BindingsConfig {
  return useBindings.getState().config;
}

/** Called with the new configuration whenever it changes. Returns the unsubscribe function. */
export function subscribeBindings(listener: (config: BindingsConfig) => void): () => void {
  return useBindings.subscribe((state, prev) => {
    if (state.config !== prev.config) listener(state.config);
  });
}
