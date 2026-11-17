/**
 * The cockpit's two display surfaces for wave 2's multifunction displays (PLAN_A10.md §7: the
 * A-10C's left and right MFCDs). OWNED BY THE COCKPIT MODULE.
 *
 *   right  the A-10A television monitor's screen (meta.displays.tv: the screen of the monitor
 *          right of the ADI; the A-10A+'s colour display, meta.displays.mpcd, sits in the same
 *          place). The monitor's own screen mesh is hidden and this surface replaces it.
 *   left   a placeholder where an A-10C left MFCD sits: the mirror image of the right screen
 *          across the centreline, mounted on a thin bezel just proud of the panel, left of the
 *          ADI and the airspeed indicator (body X −0.30 … −0.17 m, Y 0.78 … 0.92 m). It covers
 *          the A-10A's AoA gauge, clock and UHF read-out, which the A-10C does not have there:
 *          it is hidden until wave 2 calls `show(true)` (the A-10C variant), so the A-10A
 *          instruments stay visible meanwhile.
 *
 * Each surface owns a canvas and a CanvasTexture (the slot): draw into `canvas` and set
 * `texture.needsUpdate = true`, or hand over another texture (a render target's) with
 * `setPicture`. Until then each shows a dark, powered-off screen. The screens are unlit
 * (MeshBasicMaterial, not tone-mapped), so a page shows its own colours.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
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

/** BODY corners of the right screen if the meta lacks them (the TV monitor, meta.displays.tv). */
const TV_CORNERS: [number, number, number][] = [
  [0.1655, 0.9229, -5.2622],
  [0.3033, 0.9229, -5.2622],
  [0.3033, 0.7835, -5.2519],
  [0.1655, 0.7835, -5.2519],
];

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
      const bezel = mesh.userData.bezel as Mesh | undefined;
      if (bezel) bezel.visible = visible;
    },
  };
  return surface;
}

/** A thin dark bezel around the left placeholder screen (the right one has the TV's own). */
function createBezel(s: DisplaySurface): Mesh {
  const [tl, tr, br, bl] = s.corners;
  const m = 0.012;
  const across = new Vector3().subVectors(tr, tl).normalize();
  const down = new Vector3().subVectors(bl, tl).normalize();
  const back = s.normal.clone().multiplyScalar(-0.0008);
  const o = (p: Vector3, a: number, d: number) =>
    p.clone().addScaledVector(across, a).addScaledVector(down, d).add(back);
  const c = [o(tl, -m, -m), o(tr, m, -m), o(br, m, m), o(bl, -m, m)];
  const g = quadGeometry(c);
  const mat = new MeshStandardMaterial({
    name: 'display-bezel',
    color: 0x1a1c1d,
    roughness: 0.7,
    metalness: 0.1,
    side: DoubleSide,
  });
  const bezel = new Mesh(g, mat);
  bezel.name = `display-${s.id}-bezel`;
  return bezel;
}

/**
 * Build the two surfaces into `parent` (the cockpit scene) and publish them. `tvCorners` comes
 * from the meta (displays.tv) when available.
 */
export function createDisplaySurfaces(
  parent: Group | { add(...o: Mesh[]): unknown },
  tvCorners?: readonly (readonly [number, number, number])[],
): { left: DisplaySurface; right: DisplaySurface } {
  const right3 = (tvCorners ?? TV_CORNERS).map(
    (p) => [p[0], p[1], p[2]] as [number, number, number],
  );
  // meta corners run TL, TR, BR, BL as seen from the seat
  const right = createSurface('right', right3, 0.0015);
  // the mirror image across the centreline: TL ← mirrored TR, TR ← mirrored TL, …
  const mirror = (p: [number, number, number]): [number, number, number] => [-p[0], p[1], p[2]];
  const left3 = [mirror(right3[1]), mirror(right3[0]), mirror(right3[3]), mirror(right3[2])];
  // stand the placeholder just proud of the instruments it covers (their bezels reach ≈2 cm)
  const left = createSurface('left', left3, 0.024);
  const bezel = createBezel(left);
  left.mesh.userData.bezel = bezel;
  parent.add(right.mesh, left.mesh, bezel);
  left.show(false);
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
    const bezel = s.mesh.userData.bezel as Mesh | undefined;
    if (bezel) {
      bezel.removeFromParent();
      bezel.geometry.dispose();
      (bezel.material as MeshStandardMaterial).dispose();
    }
  }
  current = null;
}
