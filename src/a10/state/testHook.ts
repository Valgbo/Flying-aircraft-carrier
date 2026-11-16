/**
 * window.__A10__ for end-to-end tests and the console. FOUNDATION-OWNED.
 */
import { pushCommand } from '../core/sim';
import type { Command, PilotInput } from '../core/types';
import { getSim, getTerrain } from './runtime';
import { useA10Store } from './store';

export interface A10TestHook {
  store: typeof useA10Store;
  getSim: typeof getSim;
  getTerrain: typeof getTerrain;
  /** Queue a pilot command. */
  command(c: Command): void;
  /** Override pilot input fields until cleared (null clears). */
  setInput(patch: Partial<PilotInput> | null): void;
  /** Current override (the input layer applies it last). */
  inputOverride: Partial<PilotInput> | null;
}

export function installA10TestHook(): void {
  const hook: A10TestHook = {
    store: useA10Store,
    getSim,
    getTerrain,
    command(c) {
      const sim = getSim();
      if (sim) pushCommand(sim, c);
    },
    setInput(patch) {
      hook.inputOverride = patch;
    },
    inputOverride: null,
  };
  (window as unknown as { __A10__: A10TestHook }).__A10__ = hook;
}

/** The input layer calls this after writing sim.input, so tests can hold controls. */
export function applyTestInputOverride(input: PilotInput): void {
  const hook = (window as unknown as { __A10__?: A10TestHook }).__A10__;
  if (hook?.inputOverride) Object.assign(input, hook.inputOverride);
}
