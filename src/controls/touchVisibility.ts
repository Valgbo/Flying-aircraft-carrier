/**
 * Whether the on-screen touch controls should be shown: forced by the setting, or — on
 * 'auto' — when the device's primary pointer is coarse or a touch has been seen.
 * Shared by the touch controls themselves and by overlay layout code that must keep the
 * reserved touch zones free.
 */
import { useSyncExternalStore } from 'react';
import { useGameStore } from '../state/useGameStore';

let touchSeen = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function detectCoarse(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'touchstart',
    () => {
      if (!touchSeen) {
        touchSeen = true;
        notify();
      }
    },
    { passive: true },
  );
  try {
    matchMedia('(pointer: coarse)').addEventListener('change', notify);
  } catch {
    // matchMedia unavailable — 'auto' then only reacts to a real touch
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function isTouchDevice(): boolean {
  return touchSeen || detectCoarse();
}

/** Non-reactive read. */
export function touchControlsVisible(): boolean {
  const setting = useGameStore.getState().settings.touchControls;
  return setting === 'on' || (setting === 'auto' && isTouchDevice());
}

/** Reactive hook: re-renders when the setting or the detected pointer type changes. */
export function useTouchControlsVisible(): boolean {
  const setting = useGameStore((s) => s.settings.touchControls);
  const touch = useSyncExternalStore(subscribe, isTouchDevice, () => false);
  return setting === 'on' || (setting === 'auto' && touch);
}
