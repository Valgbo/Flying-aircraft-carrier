/**
 * The cockpit's two display surfaces: the screens of the A-10C's left and right multifunction
 * colour displays (PLAN_A10.md §7; the bezels and buttons are mfcd.ts). OWNED BY THE COCKPIT
 * MODULE. The MFD module (view/mfd) draws its pages on them (ARCHITECTURE §6, §12.7).
 *
 *   right  over the A-10A television monitor, right of the ADI
 *   left   its mirror image left of the ADI, over the A-10A standby attitude indicator, angle-of-
 *          attack gauge, clock and HUD control panel (hidden by the cockpit: the A-10C has none
 *          of them there)
 *
 * Both are shown from the start (the A-10C variant, decided at M6). Each surface owns a canvas
 * and a CanvasTexture (the slot): draw into `canvas` and set `texture.needsUpdate = true`, or hand
 * over another texture (a render target's) with `setPicture`. Until then each shows a dark,
 * powered-off screen. The screens are unlit (MeshBasicMaterial, not tone-mapped), so a page shows
 * its own colours. `show(false)` hides a screen: the dark glass of the bezel's window shows.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Vector3,
  type Texture,
} from 'three';

export type DisplayId = 'left' | 'right';

export interface DisplaySurface {
  readonly id: DisplayId;
  /** The screen quad in the cockpit scene (BODY coordinates), UV (0,0) bottom-left. */
  readonly mesh: Mesh;
  /** The canvas behind the slot texture (null outside a browser). */
  readonly canvas: HTMLCanvasElement | null;
  /** The slot: a CanvasTexture of `canvas`. Set needsUpdate after drawing. */
  readonly texture: CanvasTexture | null;
  /** Screen corners, BODY: top-left, top-right, bottom-right, bottom-left. */
  readonly corners: readonly [Vector3, Vector3, Vector3, Vector3];
  /** Unit normal toward the pilot. */
  readonly normal: Vector3;
  /** Screen size, m. */
  readonly width: number;
  readonly height: number;
  /** Show another texture instead of the canvas (null: back to the canvas). */
  setPicture(texture: Texture | null): void;
  /** Paint the idle (powered-off) screen into the canvas again. */
  clear(): void;
  /** Show or hide the surface (the left one starts hidden: see the file comment). */
  show(visible: boolean): void;
}

export const DISPLAY_CANVAS_SIZE = 512;

let current: { left: DisplaySurface; right: DisplaySurface } | null = null;
const listeners = new Set<(d: { left: DisplaySurface; right: DisplaySurface }) => void>();

/**
 * The two display surfaces, or null before the cockpit model is loaded. Wave 2's MFDs draw into
 * `texture` (canvas) or call `setPicture` with their own texture.
 */
export function getDisplaySurfaces(): { left: DisplaySurface; right: DisplaySurface } | null {
  return current;
}

/** Called when the display surfaces exist (immediately if they do). Returns an unsubscribe. */
export function onDisplaySurfaces(
  fn: (d: { left: DisplaySurface; right: DisplaySurface }) => void,
): () => void {
  if (current) fn(current);
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function paintIdle(canvas: HTMLCanvasElement | null): void {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  // a powered-off screen: near black glass with a faint sheen from the canopy
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#11161a');
  g.addColorStop(0.45, '#080a0c');
  g.addColorStop(1, '#050607');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const s = ctx.createLinearGradient(0, 0, w * 0.6, h * 0.6);
  s.addColorStop(0, 'rgba(120,140,150,0.10)');
  s.addColorStop(1, 'rgba(120,140,150,0)');
  ctx.fillStyle = s;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w * 0.55, 0);
  ctx.lineTo(0, h * 0.55);
  ctx.closePath();
  ctx.fill();
}

function quadGeometry(c: readonly Vector3[]): BufferGeometry {
  const g = new BufferGeometry();
  const pos = new Float32Array(12);
  c.forEach((v, i) => pos.set([v.x, v.y, v.z], i * 3));
  g.setAttribute('position', new BufferAttribute(pos, 3));
  // TL, TR, BR, BL → UV (0,1) (1,1) (1,0) (0,0)
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2));
  g.setIndex([0, 3, 2, 0, 2, 1]);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function createSurface(
  id: DisplayId,
  corners: [number, number, number][],
  lift: number,
): DisplaySurface {
  const c = corners.map((p) => new Vector3(p[0], p[1], p[2])) as [
    Vector3,
    Vector3,
    Vector3,
    Vector3,
  ];
  const across = new Vector3().subVectors(c[1], c[0]);
  const down = new Vector3().subVectors(c[3], c[0]);
  const normal = new Vector3().crossVectors(down, across).normalize();
  if (normal.z < 0) normal.negate();
  for (const v of c) v.addScaledVector(normal, lift);
  const width = across.length();
  const height = down.length();

  const canvas =
    typeof document === 'undefined'
      ? null
      : (document.createElement('canvas') as HTMLCanvasElement);
  let texture: CanvasTexture | null = null;
  if (canvas) {
    canvas.width = DISPLAY_CANVAS_SIZE;
    canvas.height = Math.round((DISPLAY_CANVAS_SIZE * height) / Math.max(1e-3, width));
    paintIdle(canvas);
    texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = 4;
    texture.name = `display-${id}`;
  }
  const material = new MeshBasicMaterial({
    name: `display-${id}`,
    map: texture,
    color: texture ? 0xffffff : 0x07090a,
    toneMapped: false,
  });
  const mesh = new Mesh(quadGeometry(c), material);
  mesh.name = `display-${id}`;
  mesh.renderOrder = 0;
  const surface: DisplaySurface = {
    id,
    mesh,
    canvas,
    texture,
    corners: c,
    normal,
    width,
    height,
    setPicture(t) {
      material.map = t ?? texture;
      material.needsUpdate = true;
    },
    clear() {
      paintIdle(canvas);
      if (texture) texture.needsUpdate = true;
    },
    show(visible) {
      mesh.visible = visible;
    },
  };
  return surface;
}

/** Screen corners (BODY) of both displays: top-left, top-right, bottom-right, bottom-left. */
export interface DisplayCorners {
  left: readonly Vector3[];
  right: readonly Vector3[];
}

/**
 * Build the two surfaces into `parent` (the cockpit scene) at the given screen corners (the
 * MFCD bezels' windows, mfcd.ts) and publish them. Both are shown.
 */
export function createDisplaySurfaces(
  parent: Group | { add(...o: Mesh[]): unknown },
  corners: DisplayCorners,
): { left: DisplaySurface; right: DisplaySurface } {
  const toArray = (c: readonly Vector3[]) =>
    c.map((v) => [v.x, v.y, v.z] as [number, number, number]);
  // a hair in front of the bezel's dark back plate
  const right = createSurface('right', toArray(corners.right), 0.0004);
  const left = createSurface('left', toArray(corners.left), 0.0004);
  parent.add(right.mesh, left.mesh);
  current = { left, right };
  for (const l of listeners) l(current);
  return current;
}

/** Remove and dispose the surfaces (cockpit unmounted). */
export function disposeDisplaySurfaces(): void {
  if (!current) return;
  for (const s of [current.left, current.right]) {
    s.mesh.removeFromParent();
    s.mesh.geometry.dispose();
    (s.mesh.material as MeshBasicMaterial).dispose();
    s.texture?.dispose();
  }
  current = null;
}
