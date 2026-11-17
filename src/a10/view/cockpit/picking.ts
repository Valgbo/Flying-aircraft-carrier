/**
 * Picking the cockpit's controls with the free cursor, and the hover highlight (an amber box
 * around the control and a label with its name and position). OWNED BY THE COCKPIT MODULE.
 *
 * Every control is a box in the local frame of a node of the cockpit model (FlightGear's pick
 * boxes from meta.pick, the bounds of a moving part) or of one of the panels built in code (the
 * MFCDs' faces, the AHCP, the UFC, the autopilot box). A ray from
 * the cockpit camera through the pointer is tested against the boxes in their own frames, so
 * moving parts (the gear handle, the flap lever) stay clickable wherever they are.
 */
import {
  AdditiveBlending,
  Box3,
  BoxGeometry,
  CanvasTexture,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Ray,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  type Camera,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import type { ClickId } from './clickables';

export interface PickTarget {
  id: ClickId;
  label: string;
  /** The node whose local frame the box is in. */
  frame: Object3D;
  box: Box3;
  /**
   * Margin around the box, m (default PICK_PAD; rows of small buttons use less so that
   * neighbours do not overlap).
   */
  pad?: number;
}

/** Extra margin around every box, m (small switches are hard to hit otherwise). */
export const PICK_PAD = 0.006;

const _inv = new Matrix4();
const _local = new Ray();
const _hit = new Vector3();
const _ndc = new Vector2();
const _centre = new Vector3();
const _size = new Vector3();
const _m = new Matrix4();
const _box = new Box3();

/** Ray through a pointer position (NDC) from a perspective camera, in the camera's world frame. */
export function rayFromCamera(camera: Camera, x: number, y: number, out: Ray): Ray {
  camera.updateMatrixWorld();
  out.origin.setFromMatrixPosition(camera.matrixWorld);
  _ndc.set(x, y);
  out.direction.set(_ndc.x, _ndc.y, 0.5).unproject(camera).sub(out.origin).normalize();
  return out;
}

/**
 * The nearest target the ray hits (boxes grown by PICK_PAD), or null. `ray` in the scene's
 * frame (the cockpit scene: BODY).
 */
export function pickTarget(targets: readonly PickTarget[], ray: Ray): PickTarget | null {
  let best: PickTarget | null = null;
  let bestD = Infinity;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!isShown(t.frame)) continue;
    _inv.copy(t.frame.matrixWorld).invert();
    _local.copy(ray).applyMatrix4(_inv);
    _box.copy(t.box).expandByScalar(t.pad ?? PICK_PAD);
    if (!_local.intersectBox(_box, _hit)) continue;
    // distance along the original ray (the frame may be scaled)
    _hit.applyMatrix4(t.frame.matrixWorld);
    const d = _hit.distanceToSquared(ray.origin);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

function isShown(o: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/** The amber hover box and the name label. */
export class PickHighlight {
  readonly group = new Object3D();
  private readonly edges: LineSegments;
  private readonly fill: Mesh;
  private readonly label: Sprite;
  private readonly canvas: HTMLCanvasElement | null;
  private readonly texture: CanvasTexture | null;
  private readonly edgeGeo: EdgesGeometry;
  private readonly boxGeo: BoxGeometry;
  private readonly lineMat: LineBasicMaterial;
  private readonly fillMat: MeshBasicMaterial;
  private readonly labelMat: SpriteMaterial;
  private text = '';
  private aspect = 8;

  constructor(scene: Scene) {
    this.group.name = 'cockpit-pick-highlight';
    this.boxGeo = new BoxGeometry(1, 1, 1);
    this.edgeGeo = new EdgesGeometry(this.boxGeo);
    this.lineMat = new LineBasicMaterial({
      color: 0xffb53a,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.fillMat = new MeshBasicMaterial({
      color: 0xff9a20,
      transparent: true,
      opacity: 0.16,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.edges = new LineSegments(this.edgeGeo, this.lineMat);
    this.fill = new Mesh(this.boxGeo, this.fillMat);
    for (const o of [this.edges, this.fill]) {
      o.matrixAutoUpdate = false;
      o.frustumCulled = false;
      o.renderOrder = 1000;
    }
    this.canvas =
      typeof document === 'undefined'
        ? null
        : (document.createElement('canvas') as HTMLCanvasElement);
    if (this.canvas) {
      this.canvas.width = 512;
      this.canvas.height = 64;
      this.texture = new CanvasTexture(this.canvas);
      this.texture.colorSpace = SRGBColorSpace;
    } else this.texture = null;
    this.labelMat = new SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.label = new Sprite(this.labelMat);
    this.label.renderOrder = 1001;
    this.label.frustumCulled = false;
    this.group.add(this.edges, this.fill, this.label);
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Show the highlight on `t` (null hides it) with a label, sized for `camera` and screen height. */
  show(t: PickTarget | null, text: string, camera: PerspectiveCamera, screenHeight: number): void {
    if (!t) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    _box.copy(t.box).expandByScalar((t.pad ?? PICK_PAD) * 0.5);
    _box.getCenter(_centre);
    _box.getSize(_size);
    _m.makeScale(Math.max(_size.x, 1e-3), Math.max(_size.y, 1e-3), Math.max(_size.z, 1e-3));
    _m.setPosition(_centre);
    this.edges.matrix.multiplyMatrices(t.frame.matrixWorld, _m);
    this.fill.matrix.copy(this.edges.matrix);
    this.edges.matrixWorldNeedsUpdate = true;
    this.fill.matrixWorldNeedsUpdate = true;
    if (text !== this.text) {
      this.text = text;
      this.paint(text);
    }
    // the label above the box, a constant ≈20 px tall
    _centre.applyMatrix4(t.frame.matrixWorld);
    const dist = Math.max(0.05, _centre.distanceTo(camera.position));
    const worldPerPx =
      (2 * dist * Math.tan(((camera.fov / camera.zoom) * Math.PI) / 360)) /
      Math.max(1, screenHeight);
    const h = 22 * worldPerPx;
    this.label.scale.set(h * this.aspect, h, 1);
    this.label.position.copy(_centre);
    this.label.position.y += Math.max(_size.y, 0.01) * 0.5 + h * 0.9;
  }

  private paint(text: string): void {
    const c = this.canvas;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !this.texture) return;
    ctx.font = 'bold 34px Arial, Helvetica, sans-serif';
    const w = Math.min(c.width, Math.ceil(ctx.measureText(text).width) + 28);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(10,12,14,0.78)';
    ctx.fillRect((c.width - w) / 2, 6, w, c.height - 12);
    ctx.strokeStyle = 'rgba(255,181,58,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect((c.width - w) / 2 + 1, 7, w - 2, c.height - 14);
    ctx.fillStyle = '#ffd38a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, c.width / 2, c.height / 2 + 1);
    this.texture.needsUpdate = true;
    this.aspect = c.width / c.height;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.boxGeo.dispose();
    this.edgeGeo.dispose();
    this.lineMat.dispose();
    this.fillMat.dispose();
    this.labelMat.dispose();
    this.texture?.dispose();
  }
}

/** A box from a mesh's geometry bounds, in that mesh's parent frame (for moving parts). */
export function boundsInFrame(frame: Object3D, out: Box3): Box3 {
  out.makeEmpty();
  frame.updateMatrixWorld(true);
  _inv.copy(frame.matrixWorld).invert();
  frame.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || !m.geometry) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox;
    if (!bb) return;
    _m.multiplyMatrices(_inv, m.matrixWorld);
    _box.copy(bb).applyMatrix4(_m);
    out.union(_box);
  });
  return out;
}
