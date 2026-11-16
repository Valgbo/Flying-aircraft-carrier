/**
 * When input reaches the aircraft. Pure; OWNED BY THE INPUT MODULE.
 *
 * live: the flight screen, not paused, the settings dialog closed and no key being captured.
 *       Flight controls act; when it closes, momentary axes, the trigger and held switches read
 *       zero, and the throttle levers FREEZE where they are (pausing never drops to idle).
 * app:  the flight screen with no dialog or capture, paused or not: views and pause work.
 */
import type { Gate } from './engine';

export interface GateState {
  screen: string;
  paused: boolean;
  settingsOpen: boolean;
  /** A key or device input is being captured for rebinding. */
  capturing: boolean;
}

export function computeGate(s: GateState): Gate {
  const app = s.screen === 'flight' && !s.settingsOpen && !s.capturing;
  return { live: app && !s.paused, app };
}

let captureDepth = 0;

/** The controls panel is capturing an input (flight and app keys stay inert meanwhile). */
export function isInputCaptureActive(): boolean {
  return captureDepth > 0;
}

/** Mark a capture as running; returns the function that ends it (idempotent). */
export function beginInputCapture(): () => void {
  captureDepth++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    captureDepth = Math.max(0, captureDepth - 1);
  };
}
