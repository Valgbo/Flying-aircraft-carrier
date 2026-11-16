/**
 * View-only controls (head look, zoom, view changes): written by the INPUT module, read by the
 * camera rig and the cockpit. Interface FIXED by the foundation (docs/a10/ARCHITECTURE.md §8);
 * the input module owns the values.
 */
export interface ViewInput {
  /** Head-look rates from keys / sticks, -1..1 (+ right, + up). */
  lookX: number;
  lookY: number;
  /** Mouse look movement since the camera rig last consumed it, pixels (+ right, + down). */
  lookDeltaX: number;
  lookDeltaY: number;
  /** Zoom steps since last consumed (+ in), from the wheel or keys. */
  zoomSteps: number;
  /** "Hold to zoom" held (narrow field of view while held). */
  zoomHeld: boolean;
  /** Look at the SPI while held. */
  lookAtSpi: boolean;
  /** The mouse cursor is free to click cockpit switches (no mouse look / mouse stick). */
  cursorFree: boolean;
  /** Pointer position in normalised device coordinates (-1..1), when over the canvas. */
  pointerX: number;
  pointerY: number;
  /** A click on the canvas waiting to be handled by the cockpit (consumed by it). */
  click: { x: number; y: number; button: number } | null;
  /** Reset head position/orientation requested. */
  centerView: boolean;
}

export const viewInput: ViewInput = {
  lookX: 0,
  lookY: 0,
  lookDeltaX: 0,
  lookDeltaY: 0,
  zoomSteps: 0,
  zoomHeld: false,
  lookAtSpi: false,
  cursorFree: false,
  pointerX: 0,
  pointerY: 0,
  click: null,
  centerView: false,
};

/** Read and zero the accumulated mouse-look movement. */
export function consumeLook(out: { x: number; y: number }): { x: number; y: number } {
  out.x = viewInput.lookDeltaX;
  out.y = viewInput.lookDeltaY;
  viewInput.lookDeltaX = 0;
  viewInput.lookDeltaY = 0;
  return out;
}

/** Read and zero the accumulated zoom steps. */
export function consumeZoom(): number {
  const z = viewInput.zoomSteps;
  viewInput.zoomSteps = 0;
  return z;
}
