/**
 * One-pointer-per-widget drag tracking on Pointer Events.
 *
 * Each widget captures the pointer that pressed it, so several fingers can work different
 * widgets at once and a finger that slides off its widget keeps controlling it until it
 * lifts. Further pointers landing on a busy widget are ignored. The drag always ends
 * cleanly: on pointerup, pointercancel, lostpointercapture, window blur, a hidden tab and
 * when the widget is unbound.
 */

export interface PointerDragHandlers {
  onStart(e: PointerEvent): void;
  onMove(e: PointerEvent): void;
  onEnd(): void;
}

/** Bind `handlers` to `el`. Returns the unbind function (which also ends a drag in progress). */
export function bindPointerDrag(el: HTMLElement, handlers: PointerDragHandlers): () => void {
  /** pointerId of the controlling pointer, -1 when idle. */
  let active = -1;

  const onDown = (e: PointerEvent): void => {
    if (active !== -1) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    active = e.pointerId;
    // keeps the focus where it is and suppresses text selection and compatibility mouse events
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // the pointer is already gone (synthetic or cancelled): the drag still works while over `el`
    }
    handlers.onStart(e);
  };

  const onMove = (e: PointerEvent): void => {
    if (e.pointerId === active) handlers.onMove(e);
  };

  const onRelease = (e: PointerEvent): void => {
    if (e.pointerId !== active) return;
    active = -1;
    handlers.onEnd();
  };

  /** End the drag without a pointer event (blur, hidden tab, unbind). */
  const abort = (): void => {
    if (active === -1) return;
    const id = active;
    active = -1;
    try {
      if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
    } catch {
      // nothing to release
    }
    handlers.onEnd();
  };

  const onVisibility = (): void => {
    if (document.hidden) abort();
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onRelease);
  el.addEventListener('pointercancel', onRelease);
  el.addEventListener('lostpointercapture', onRelease);
  window.addEventListener('blur', abort);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onRelease);
    el.removeEventListener('pointercancel', onRelease);
    el.removeEventListener('lostpointercapture', onRelease);
    window.removeEventListener('blur', abort);
    document.removeEventListener('visibilitychange', onVisibility);
    abort();
  };
}
