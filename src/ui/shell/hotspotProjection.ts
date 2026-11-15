/**
 * Hangar hotspot projection — the bridge between the 3D scene and the DOM pins.
 *
 * The in-canvas projector (src/scene/HangarHotspots.tsx) calls `projectHotspots()` once per
 * rendered frame. It turns every HOTSPOTS anchor into viewport pixels, a depth and a
 * visibility flag, moves pins that would sit on top of each other apart, hides the ones a DOM
 * panel covers, stores the result here and notifies the subscribers before it returns. The DOM
 * pin layer (HangarPins.tsx) subscribes and moves its buttons with transforms inside that
 * call — that is, inside the very animation frame that draws the canvas. A pin therefore
 * never trails the model by a frame. A second requestAnimationFrame loop on the DOM side
 * could not promise that: which of two loops runs first flips whenever the renderer's loop
 * restarts (for example when the canvas is re-created after a quality change).
 *
 * No React and no store in here, and nothing is allocated per frame.
 */
import { Vector3, type OrthographicCamera, type PerspectiveCamera } from 'three';
import { HOTSPOTS } from '../../config/layout';
import { sim } from '../../state/sim';
import { carrierLocalToWorld } from '../../state/simHelpers';

export interface HotspotProjection {
  /**
   * Position of the pin in viewport (client) pixels: its anchor, moved aside where pins would
   * otherwise overlap. Keeps its last value while hidden.
   */
  x: number;
  y: number;
  /** Distance in front of the camera along its view axis, m (≤ near plane = behind it). */
  depth: number;
  /** False while the anchor is behind the camera, outside the viewport or under a panel. */
  visible: boolean;
}

/** A rectangle in viewport (client) pixels. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Strips along the viewport edges, px. */
export interface ScreenInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The rectangle the camera renders into, in viewport (client) pixels. */
export interface HotspotViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Hysteresis at the viewport edge, px: a hidden pin has to come this far inside before it
 * shows again, a visible one stays until it is this close to the edge. The gap is wider than
 * the idle bob of the ship, so a pin sitting on the edge cannot flicker.
 */
export const PIN_ENTER_INSET = 14;
export const PIN_EXIT_INSET = 4;

/** Smallest distance between two pin centres, px — the size of a pin's clickable area. */
export const PIN_MIN_SPACING = 44;

/**
 * What the DOM panels of the hangar take away from the 3D view. HangarOverlay measures and
 * writes it (`setHangarObstruction`); the projector reads it every frame.
 */
export const hangarObstruction: {
  /** Panels lying over the pin layer: a pin with its centre under one could not be clicked. */
  readonly panels: ScreenRect[];
  /** The edge strips the panels cover; the projector frames the ship in what is left. */
  readonly insets: ScreenInsets;
} = {
  panels: [],
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
};

export function setHangarObstruction(panels: readonly ScreenRect[], insets: ScreenInsets): void {
  hangarObstruction.panels.length = 0;
  for (const panel of panels) hangarObstruction.panels.push(panel);
  Object.assign(hangarObstruction.insets, insets);
}

/** No panels (HangarOverlay calls this when it unmounts). */
export function clearHangarObstruction(): void {
  setHangarObstruction([], { top: 0, right: 0, bottom: 0, left: 0 });
}

/** One entry per HOTSPOTS entry, in the same order. Mutated in place by the projector. */
export const hotspotProjections: readonly HotspotProjection[] = HOTSPOTS.map(() => ({
  x: 0,
  y: 0,
  depth: 0,
  visible: false,
}));

/** Frame-level data published together with the projections. */
export const hotspotFrame = {
  /** Bumped on every publish; 0 = nothing has been projected yet. */
  stamp: 0,
  /** View depth of the ship's origin, m — the reference for "nearer / farther than the ship". */
  shipDepth: 0,
  viewportWidth: 0,
  viewportHeight: 0,
};

type FrameListener = () => void;

const listeners: FrameListener[] = [];

/** Run `listener` synchronously after every publish. Returns the unsubscribe function. */
export function subscribeHotspotFrame(listener: FrameListener): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function publish(): void {
  hotspotFrame.stamp++;
  for (let i = 0; i < listeners.length; i++) listeners[i]();
}

/**
 * Edge test with hysteresis: `wasVisible` decides which inset applies. Exported for tests.
 */
export function insideViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  wasVisible: boolean,
): boolean {
  const inset = wasVisible ? PIN_EXIT_INSET : PIN_ENTER_INSET;
  return x >= inset && x <= width - inset && y >= inset && y <= height - inset;
}

/**
 * True when the point lies under one of `panels` — with the same hysteresis as the viewport
 * edge: a visible pin hides PIN_EXIT_INSET before its centre slips under a panel, a hidden one
 * returns once it is PIN_ENTER_INSET clear of it. Exported for tests.
 */
export function underPanel(
  x: number,
  y: number,
  panels: readonly ScreenRect[],
  wasVisible: boolean,
): boolean {
  const margin = wasVisible ? PIN_EXIT_INSET : PIN_ENTER_INSET;
  for (let i = 0; i < panels.length; i++) {
    const r = panels[i];
    if (
      x > r.left - margin &&
      x < r.right + margin &&
      y > r.top - margin &&
      y < r.bottom + margin
    ) {
      return true;
    }
  }
  return false;
}

/** Relaxation passes of `spreadPins`; a tight cluster of all eight pins settles well within. */
const SPREAD_PASSES = 12;

/**
 * Screen-space declutter: push the visible pins apart, pair by pair, until their centres are
 * PIN_MIN_SPACING apart (as far as SPREAD_PASSES get), so that no pin lies under another one.
 * Starts from the anchors every frame, hence follows the camera without a memory of its own.
 * Allocation-free. Exported for tests.
 */
export function spreadPins(projections: readonly HotspotProjection[]): void {
  const n = projections.length;
  for (let pass = 0; pass < SPREAD_PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const a = projections[i];
      if (!a.visible) continue;
      for (let j = i + 1; j < n; j++) {
        const b = projections[j];
        if (!b.visible) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= PIN_MIN_SPACING) continue;
        if (distance < 1e-3) {
          // coincident anchors: split them sideways, the lower index to the left
          dx = 1;
          dy = 0;
          distance = 1;
        }
        const push = (PIN_MIN_SPACING - distance) / 2 / distance;
        a.x -= dx * push;
        a.y -= dy * push;
        b.x += dx * push;
        b.y += dy * push;
        moved = true;
      }
    }
    if (!moved) return;
  }
}

const _world = new Vector3();
const _view = new Vector3();
const wasVisible = new Uint8Array(HOTSPOTS.length);

/**
 * Project every hotspot anchor through `camera` and publish the result.
 * The camera's world matrices must be current (call `camera.updateMatrixWorld()` after moving
 * it); `viewport` is the rectangle it renders into.
 */
export function projectHotspots(
  camera: PerspectiveCamera | OrthographicCamera,
  viewport: HotspotViewport,
): void {
  const { left, top, width, height } = viewport;
  hotspotFrame.viewportWidth = width;
  hotspotFrame.viewportHeight = height;
  hotspotFrame.shipDepth = -_view.copy(sim.carrier.position).applyMatrix4(camera.matrixWorldInverse)
    .z;

  for (let i = 0; i < HOTSPOTS.length; i++) {
    const p = hotspotProjections[i];
    wasVisible[i] = p.visible ? 1 : 0;
    carrierLocalToWorld(HOTSPOTS[i].anchor, _world);
    _view.copy(_world).applyMatrix4(camera.matrixWorldInverse);
    p.depth = -_view.z;
    if (!(p.depth > camera.near)) {
      p.visible = false;
      continue;
    }
    // view space → normalised device coordinates (applyMatrix4 does the perspective divide)
    _view.applyMatrix4(camera.projectionMatrix);
    const x = (_view.x * 0.5 + 0.5) * width;
    const y = (0.5 - _view.y * 0.5) * height;
    p.visible = insideViewport(x, y, width, height, p.visible);
    if (p.visible) {
      p.x = left + x;
      p.y = top + y;
    }
  }

  spreadPins(hotspotProjections);
  // last, on the final positions: whatever is still shown can be clicked
  const { panels } = hangarObstruction;
  for (let i = 0; i < HOTSPOTS.length; i++) {
    const p = hotspotProjections[i];
    if (p.visible && underPanel(p.x, p.y, panels, wasVisible[i] === 1)) p.visible = false;
  }
  publish();
}

/** Hide every pin (the projector calls this when it unmounts). */
export function clearHotspotProjections(): void {
  for (let i = 0; i < hotspotProjections.length; i++) hotspotProjections[i].visible = false;
  publish();
}

/**
 * Draw order for overlapping pins: writes into `out` the stacking rank of every hotspot,
 * 1 = farthest from the camera … n = nearest, so nearer pins end up on top.
 * Allocation-free; `out` must be at least as long as `projections`.
 */
export function rankByDepth(projections: readonly HotspotProjection[], out: Int8Array): void {
  const n = projections.length;
  for (let i = 0; i < n; i++) {
    const depth = projections[i].depth;
    let rank = 1;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const other = projections[j].depth;
      // ties resolve by index so the order is stable from frame to frame
      if (other > depth || (other === depth && j < i)) rank++;
    }
    out[i] = rank;
  }
}

/** Limits of the depth cue: the marker of a far pin shrinks to 84 %, a near one grows to 112 %. */
const PIN_SCALE_MIN = 0.84;
const PIN_SCALE_MAX = 1.12;

/**
 * Size factor for a pin's marker from its depth relative to the ship: farther than the ship's
 * centre → slightly smaller, nearer → slightly larger. (The clickable area never shrinks.)
 */
export function pinScaleForDepth(depth: number, shipDepth: number): number {
  if (!(depth > 0) || !(shipDepth > 0)) return 1;
  const scale = shipDepth / depth;
  return scale < PIN_SCALE_MIN ? PIN_SCALE_MIN : scale > PIN_SCALE_MAX ? PIN_SCALE_MAX : scale;
}
