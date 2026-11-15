/**
 * Key capture for rebinding. `captureNextKey()` resolves with the KeyboardEvent.code of the
 * next key pressed (or null if Escape was pressed or the capture was cancelled). The key is
 * swallowed in the capture phase, so it never reaches the flight controls or the page.
 * The keyboard layer should also stay inert while `isKeyCaptureActive()` is true.
 */

interface Pending {
  resolve: (code: string | null) => void;
  listener: (e: KeyboardEvent) => void;
}

let pending: Pending | null = null;

function finish(code: string | null): void {
  if (!pending) return;
  const p = pending;
  pending = null;
  window.removeEventListener('keydown', p.listener, { capture: true });
  p.resolve(code);
}

export function isKeyCaptureActive(): boolean {
  return pending !== null;
}

export function captureNextKey(): Promise<string | null> {
  finish(null);
  return new Promise((resolve) => {
    const listener = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      finish(e.code === 'Escape' ? null : e.code);
    };
    pending = { resolve, listener };
    window.addEventListener('keydown', listener, { capture: true });
  });
}

export function cancelKeyCapture(): void {
  finish(null);
}
