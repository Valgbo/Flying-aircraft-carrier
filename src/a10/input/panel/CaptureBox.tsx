/**
 * The capture prompt of the controls panel: while it is shown, the next key (chord), mouse
 * click or wheel notch on the dashed box, gamepad button or joystick movement becomes the
 * binding. Keys are swallowed in the capture phase so the dialog never sees them (Escape cancels
 * here instead of closing the dialog). OWNED BY THE INPUT MODULE.
 */
import { useEffect, useRef } from 'react';
import type { Binding } from '../bindings';
import { CaptureSession, capturePrompt, type CaptureStep } from '../capture';
import type { ControlId } from '../controls';
import { beginInputCapture } from '../gating';
import { readPads } from '../runtime';

export interface CaptureBoxProps {
  control: ControlId;
  step: CaptureStep;
  onBinding: (binding: Binding) => void;
  onCancel: () => void;
}

export default function CaptureBox({ control, step, onBinding, onCancel }: CaptureBoxProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onBinding, onCancel });
  handlers.current = { onBinding, onCancel };

  useEffect(() => {
    const end = beginInputCapture();
    const session = new CaptureSession(control, step, readPads());
    let raf = 0;
    const settle = (outcome: ReturnType<CaptureSession['keyDown']>) => {
      if (!outcome) return;
      if (outcome.kind === 'cancel') handlers.current.onCancel();
      else handlers.current.onBinding(outcome.binding);
    };
    const mods = (e: KeyboardEvent) => ({
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
      meta: e.metaKey,
    });
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat || session.finished) return;
      settle(session.keyDown(e.code, mods(e)));
    };
    // Key-ups are not swallowed: a key held before the capture must still be let go by the
    // flight controls. preventDefault keeps a captured Space from clicking the focused button.
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      if (session.finished) return;
      settle(session.keyUp(e.code));
    };
    const box = boxRef.current;
    const onMouseDown = (e: MouseEvent) => {
      // the Cancel button inside the box is a button, not an input to bind
      if (e.target instanceof Element && e.target.closest('button')) return;
      e.preventDefault();
      e.stopPropagation();
      if (!session.finished) settle(session.mouseDown(e.button));
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (session.finished || e.deltaY === 0) return;
      settle(session.wheel(e.deltaY < 0 ? 1 : -1));
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    const poll = () => {
      if (!session.finished) settle(session.pads(readPads()));
      if (!session.finished) raf = requestAnimationFrame(poll);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    box?.addEventListener('mousedown', onMouseDown);
    box?.addEventListener('wheel', onWheel, { passive: false });
    box?.addEventListener('contextmenu', onContextMenu);
    raf = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      box?.removeEventListener('mousedown', onMouseDown);
      box?.removeEventListener('wheel', onWheel);
      box?.removeEventListener('contextmenu', onContextMenu);
      end();
    };
  }, [control, step]);

  return (
    <div className="a10in-capture" ref={boxRef} role="status" data-testid={`capture-${control}`}>
      <span className="a10in-capture__text">{capturePrompt(control, step)}</span>
      <button
        type="button"
        className="fac-btn fac-btn--ghost settings-btn"
        onClick={() => handlers.current.onCancel()}
      >
        {step === 'negative' ? 'Done' : 'Cancel'}
      </button>
    </div>
  );
}
