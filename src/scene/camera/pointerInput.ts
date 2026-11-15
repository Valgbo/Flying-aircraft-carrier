/**
 * Pointer input for the camera rig: primary-button mouse drag, one-finger touch drag,
 * two-finger pinch and the mouse wheel, all on the canvas element only. Events merely
 * accumulate deltas; the rig drains them once per frame with `consume()`, so nothing here
 * touches the camera or React.
 */

interface TrackedPointer {
  id: number;
  x: number;
  y: number;
}

export interface PointerDeltas {
  /** Drag since the last frame, CSS pixels (+x right, +y down). */
  dx: number;
  dy: number;
  /** Multiplicative zoom since the last frame (> 1 = further away). */
  zoom: number;
}

const WHEEL_ZOOM_PER_PIXEL = 0.0011;
/** Largest wheel step taken from one event, pixels (tames free-spinning wheels). */
const WHEEL_MAX_STEP = 240;
const WHEEL_LINE_PIXELS = 16;

export class CameraPointerInput {
  private element: HTMLElement | null = null;
  private readonly pointers: TrackedPointer[] = [];
  private pinchDistance = 0;
  private dx = 0;
  private dy = 0;
  private zoom = 1;
  private interactive = true;
  private previousCursor = '';
  private previousTouchAction = '';

  /** True while at least one pointer is held on the canvas. */
  get dragging(): boolean {
    return this.pointers.length > 0;
  }

  /** Height of the canvas in CSS pixels (never 0), for converting drags into angles. */
  get height(): number {
    return Math.max(1, this.element?.clientHeight ?? 1);
  }

  attach(element: HTMLElement): void {
    this.detach();
    this.element = element;
    this.previousCursor = element.style.cursor;
    this.previousTouchAction = element.style.touchAction;
    element.style.touchAction = 'none';
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerEnd);
    element.addEventListener('pointercancel', this.onPointerEnd);
    element.addEventListener('lostpointercapture', this.onPointerEnd);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    this.updateCursor();
  }

  detach(): void {
    const element = this.element;
    if (!element) return;
    element.removeEventListener('pointerdown', this.onPointerDown);
    element.removeEventListener('pointermove', this.onPointerMove);
    element.removeEventListener('pointerup', this.onPointerEnd);
    element.removeEventListener('pointercancel', this.onPointerEnd);
    element.removeEventListener('lostpointercapture', this.onPointerEnd);
    element.removeEventListener('wheel', this.onWheel);
    for (const p of this.pointers) this.release(element, p.id);
    this.pointers.length = 0;
    element.style.cursor = this.previousCursor;
    element.style.touchAction = this.previousTouchAction;
    this.element = null;
    this.dx = 0;
    this.dy = 0;
    this.zoom = 1;
  }

  /** Whether the current view reacts to drags (drives the grab cursor). Cheap to call every frame. */
  setInteractive(interactive: boolean): void {
    if (interactive === this.interactive) return;
    this.interactive = interactive;
    this.updateCursor();
  }

  /** Move the accumulated deltas into `out` and reset them. */
  consume(out: PointerDeltas): void {
    out.dx = this.dx;
    out.dy = this.dy;
    out.zoom = this.zoom;
    this.dx = 0;
    this.dy = 0;
    this.zoom = 1;
  }

  private updateCursor(): void {
    if (!this.element) return;
    this.element.style.cursor = !this.interactive ? '' : this.dragging ? 'grabbing' : 'grab';
  }

  private find(id: number): TrackedPointer | undefined {
    for (const p of this.pointers) if (p.id === id) return p;
    return undefined;
  }

  private release(element: HTMLElement, id: number): void {
    try {
      if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    } catch {
      // the pointer is already gone — nothing to release
    }
  }

  private pinchSpan(): number {
    const [a, b] = this.pointers;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    const element = this.element;
    if (!element) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.pointers.length >= 2 || this.find(e.pointerId)) return;
    this.pointers.push({ id: e.pointerId, x: e.clientX, y: e.clientY });
    try {
      element.setPointerCapture(e.pointerId);
    } catch {
      // capture is a nicety (drags continue outside the canvas); carry on without it
    }
    if (this.pointers.length === 2) this.pinchDistance = this.pinchSpan();
    this.updateCursor();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const p = this.find(e.pointerId);
    if (!p) return;
    if (this.pointers.length === 1) {
      this.dx += e.clientX - p.x;
      this.dy += e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;
    const span = this.pinchSpan();
    if (span > 1 && this.pinchDistance > 1) this.zoom *= this.pinchDistance / span;
    this.pinchDistance = span;
  };

  private readonly onPointerEnd = (e: PointerEvent): void => {
    const index = this.pointers.findIndex((p) => p.id === e.pointerId);
    if (index < 0) return;
    this.pointers.splice(index, 1);
    if (this.element) this.release(this.element, e.pointerId);
    this.pinchDistance = 0;
    this.updateCursor();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const unit =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? WHEEL_LINE_PIXELS
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? this.height
          : 1;
    const step = Math.max(-WHEEL_MAX_STEP, Math.min(WHEEL_MAX_STEP, e.deltaY * unit));
    this.zoom *= Math.exp(step * WHEEL_ZOOM_PER_PIXEL);
  };
}
