/**
 * Discrete action bus. Control sources (keyboard, gamepad, touch buttons, HUD buttons) call
 * `emitAction(name)`; systems subscribe with `onAction(name, handler)`.
 *
 * Store-level toggles (assist, camera, panel, pause, reset) are wired once in
 * `bindCoreActions()` (called from main.tsx). Gameplay actions such as `launchJet` are
 * handled by the system that owns them (flight ops).
 */

export type ActionName =
  | 'toggleAssist'
  | 'cycleCamera'
  | 'launchJet'
  | 'toggleTurbinePanel'
  | 'togglePause'
  | 'resetFlight';

type Handler = () => void;

const handlers = new Map<ActionName, Set<Handler>>();

export function onAction(name: ActionName, handler: Handler): () => void {
  let set = handlers.get(name);
  if (!set) {
    set = new Set();
    handlers.set(name, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}

export function emitAction(name: ActionName): void {
  const set = handlers.get(name);
  if (!set) return;
  for (const h of [...set]) h();
}

export const ACTION_NAMES: readonly ActionName[] = [
  'toggleAssist',
  'cycleCamera',
  'launchJet',
  'toggleTurbinePanel',
  'togglePause',
  'resetFlight',
];
