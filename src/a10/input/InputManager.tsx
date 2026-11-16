/**
 * Input: keyboard, mouse, gamepads and any stick, throttle or pedals → sim.input, commands and
 * viewInput. OWNED BY THE INPUT MODULE (docs/a10/ARCHITECTURE.md §8). Mounted once by App.tsx.
 *
 * The work is in ./runtime.ts (DOM) and ./engine.ts (pure). Here: the lifetime (StrictMode-safe
 * attach/detach), the per-frame hook (`onBeforeSimSteps`: devices are sampled and sim.input is
 * written right before the steps, with the test override applied last), and two small overlays:
 * the mouse-stick ring (mouse-stick mode) and the free-cursor badge.
 */
import { useEffect, useRef, useState } from 'react';
import { onBeforeSimSteps } from '../view/frame';
import { useBindings } from './bindingsStore';
import { attachInputRuntime, type RuntimeStatus } from './runtime';
import { bindingName } from './labels';
import './input.css';

const RING_RADIUS_PX = 64;

interface Hints {
  ring: boolean;
  lockHint: boolean;
  cursorFree: boolean;
}

const sameHints = (a: Hints, b: Hints) =>
  a.ring === b.ring && a.lockHint === b.lockHint && a.cursorFree === b.cursorFree;

function hintsOf(s: RuntimeStatus): Hints {
  return {
    ring: s.mouseStick && s.pointerLocked && !s.cursorFree,
    lockHint: s.mouseStick && !s.pointerLocked && !s.cursorFree,
    cursorFree: s.live && s.cursorFree,
  };
}

export default function InputManager() {
  const dotRef = useRef<HTMLDivElement>(null);
  const [hints, setHints] = useState<Hints>({ ring: false, lockHint: false, cursorFree: false });
  const hintsRef = useRef(hints);
  const config = useBindings((s) => s.config);
  const cursorKey = config.controls.cursorFree[0];

  useEffect(() => {
    const runtime = attachInputRuntime({
      onFrame: (out, status) => {
        const next = hintsOf(status);
        if (!sameHints(next, hintsRef.current)) {
          hintsRef.current = next;
          setHints(next);
        }
        const dot = dotRef.current;
        if (dot && next.ring) {
          const x = out.mouseStickX * RING_RADIUS_PX;
          const y = out.mouseStickY * RING_RADIUS_PX;
          dot.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        }
      },
    });
    const off = onBeforeSimSteps((sim, realDt) => {
      runtime.frame(realDt, sim);
    });
    return () => {
      off();
      runtime.detach();
    };
  }, []);

  return (
    <div className="a10in-overlay" aria-hidden={!hints.cursorFree && !hints.lockHint}>
      {hints.ring && (
        <div className="a10in-stick" data-testid="mouse-stick">
          <div className="a10in-stick__cross" />
          <div className="a10in-stick__dot" ref={dotRef} />
        </div>
      )}
      {hints.lockHint && (
        <div className="a10in-badge" role="status">
          Click the view to fly with the mouse
        </div>
      )}
      {hints.cursorFree && (
        <div className="a10in-badge" role="status" data-testid="cursor-free">
          Cursor free: click switches in the cockpit
          {cursorKey ? ` · ${bindingName(cursorKey, config)} to fly` : ''}
        </div>
      )}
    </div>
  );
}
