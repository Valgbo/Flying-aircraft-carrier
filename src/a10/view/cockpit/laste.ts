/**
 * The LASTE control panel on the front of the left console — the low-altitude safety and
 * targeting enhancement panel the FlightGear cockpit models: EAC, RDR ALTM, the autopilot's
 * ENGAGE/DISENGAGE button and its PATH – ALT/HDG – ALT mode switch. OWNED BY THE COCKPIT MODULE.
 *
 * The A-10C's low-altitude autopilot is engaged and its mode chosen on this panel, so the
 * cockpit's two autopilot controls are the model's own button and lever (wave 1 had put them on
 * an add-on box beside the left MFCD, which hung in the air in front of the canopy frame):
 *
 *   ENGAGE/DISENGAGE   left click engages or disengages, right click disengages
 *   mode switch        a click steps PATH → ALT/HDG → ALT (the flight's autopilot `mode`
 *                      command); the lever shows the mode: PATH forward, ALT/HDG centre, ALT aft
 *
 * The converter merged the panel's parts into the cockpit's one static mesh, so they cannot be
 * moved as nodes. They are moved the way a vertex animation would: the vertices of the lever's
 * bat and shaft (everything of the switch above its bezel) and of the button's cap are found by
 * position when the cockpit is built, in a private copy of each primitive that holds them (the
 * template stays untouched), and rewritten from their original positions — the lever turned
 * about its pivot, the cap pushed in. That happens only when the mode changes and during the
 * 0.16 s of a press, never otherwise, and uploads only the moved vertices' range.
 */
import {
  Box3,
  Matrix3,
  Matrix4,
  Vector3,
  type BufferAttribute,
  type BufferGeometry,
  type InterleavedBufferAttribute,
  type Mesh,
  type Object3D,
} from 'three';
import type { AutopilotMode } from '../../core/flight/types';
import { LASTE } from './panelData';
import type { CockpitControlId, CockpitSwitchState } from './switches';

/** The autopilot modes in the order of the switch's positions, forward to aft. */
export const LASTE_MODE_ORDER: readonly AutopilotMode[] = ['PATH', 'ALT_HDG', 'ALT'];

/** The LASTE controls that are clickable. */
export type LasteControlId = Extract<CockpitControlId, 'autopilot' | 'autopilotMode'>;

/**
 * The lever's angle for a mode, rad, as a rotation about BODY +X: negative tips the bat forward
 * (toward −Z, the nose), so PATH = −throw, ALT/HDG = 0, ALT = +throw. An unknown mode shows the
 * centre position.
 */
export function lasteLeverAngle(mode: string): number {
  const i = LASTE_MODE_ORDER.indexOf(mode as AutopilotMode);
  return i < 0 ? 0 : (i - 1) * LASTE.leverThrow;
}

/** How far the button cap is pushed in, m, with `left` seconds of its press to go. */
export function lastePressDepth(left: number): number {
  if (!(left > 0)) return 0;
  const t = 1 - left / LASTE.buttonPressTime; // 0 → 1 over the press
  if (t < 0.6) return LASTE.buttonTravel;
  return LASTE.buttonTravel * (1 - (t - 0.6) / 0.4);
}

/** A control's click box in BODY coordinates (the cockpit root's frame). */
export function lasteControlBox(id: LasteControlId, out: Box3): Box3 {
  if (id === 'autopilot') {
    const b = LASTE.button;
    return out.set(
      new Vector3(b.x - 0.0055, b.top - 0.006, b.z - 0.0055),
      new Vector3(b.x + 0.0055, b.top + 0.002, b.z + 0.0055),
    );
  }
  const l = LASTE.lever;
  // the bat sweeps ±(tip − pivot)·sin(throw) fore and aft
  const sweep = (l.tip - l.pivot) * Math.sin(LASTE.leverThrow) + l.radius;
  return out.set(
    new Vector3(l.x - 0.0055, l.pivot - 0.003, l.z - sweep),
    new Vector3(l.x + 0.0055, l.tip + 0.002, l.z + sweep),
  );
}

/** Where the vertices of a merged part are searched: a vertical cylinder in BODY coordinates. */
export interface MergedPartRegion {
  x: number;
  z: number;
  radius: number;
  /** Heights (BODY y) the part's moving vertices lie between. */
  yMin: number;
  yMax: number;
}

interface PrimitiveVertices {
  mesh: Mesh;
  geometry: BufferGeometry;
  /** The selected vertices' indices in the primitive's attributes. */
  index: Uint32Array;
  /** Their original positions and normals in the primitive's local frame. */
  position: Float32Array;
  normal: Float32Array | null;
  /** The primitive's local frame → BODY (the root's frame), and back. */
  toBody: Matrix4;
  fromBody: Matrix4;
  /** The range of selected vertex indices (for a partial upload). */
  first: number;
  last: number;
}

const _v = new Vector3();
const _n = new Vector3();
const _m = new Matrix4();
const _m3 = new Matrix3();
const _box = new Box3();
const _region = new Box3();

/**
 * A part merged into static meshes, moved by rewriting its vertices. `find` copies the
 * geometry of every mesh under `root` that holds vertices inside the region (so templates the
 * meshes share stay as they were; a geometry already in `ownGeometries` is a private copy
 * made for another part and is shared) and remembers those vertices' original positions;
 * `transform(m)` then places them at m × original (m in BODY coordinates).
 */
export class MergedPart {
  readonly primitives: PrimitiveVertices[] = [];

  /** Every vertex inside `region` of the meshes under `root` (root's frame = BODY). */
  static find(
    root: Object3D,
    region: MergedPartRegion,
    ownGeometries: BufferGeometry[],
  ): MergedPart {
    const part = new MergedPart();
    root.updateMatrixWorld(true);
    const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
    _region.min.set(region.x - region.radius, region.yMin, region.z - region.radius);
    _region.max.set(region.x + region.radius, region.yMax, region.z + region.radius);
    const r2 = region.radius * region.radius;
    const meshes: Mesh[] = [];
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh && mesh.geometry?.attributes.position) meshes.push(mesh);
    });
    for (const mesh of meshes) {
      const toBody = new Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld);
      const g = mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      if (!g.boundingBox || !_box.copy(g.boundingBox).applyMatrix4(toBody).intersectsBox(_region))
        continue;
      const pos = g.attributes.position;
      const hits: number[] = [];
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(toBody);
        if (_v.y < region.yMin || _v.y > region.yMax) continue;
        const dx = _v.x - region.x;
        const dz = _v.z - region.z;
        if (dx * dx + dz * dz <= r2) hits.push(i);
      }
      if (hits.length === 0) continue;
      // a private copy of the primitive (the template's geometry stays as it was) — made once:
      // another part found in the same primitive earlier already owns one
      let copy = g;
      if (!ownGeometries.includes(g)) {
        copy = g.clone();
        ownGeometries.push(copy);
        mesh.geometry = copy;
      }
      const normalAttr = copy.attributes.normal;
      const position = new Float32Array(hits.length * 3);
      const normal = normalAttr ? new Float32Array(hits.length * 3) : null;
      hits.forEach((vi, k) => {
        _v.fromBufferAttribute(copy.attributes.position, vi).toArray(position, k * 3);
        if (normal && normalAttr) _n.fromBufferAttribute(normalAttr, vi).toArray(normal, k * 3);
      });
      part.primitives.push({
        mesh,
        geometry: copy,
        index: Uint32Array.from(hits),
        position,
        normal,
        toBody,
        fromBody: new Matrix4().copy(toBody).invert(),
        first: hits[0],
        last: hits[hits.length - 1],
      });
    }
    return part;
  }

  /** How many vertices the part has (0: not found in the model). */
  get count(): number {
    let n = 0;
    for (const p of this.primitives) n += p.index.length;
    return n;
  }

  /** Place the part's vertices at `m` × their original BODY positions. */
  transform(m: Matrix4): void {
    for (const p of this.primitives) {
      // local → BODY → moved → local
      _m.multiplyMatrices(m, p.toBody).premultiply(p.fromBody);
      _m3.getNormalMatrix(_m);
      const pos = p.geometry.attributes.position;
      const nrm = p.geometry.attributes.normal;
      for (let k = 0; k < p.index.length; k++) {
        const vi = p.index[k];
        _v.fromArray(p.position, k * 3).applyMatrix4(_m);
        pos.setXYZ(vi, _v.x, _v.y, _v.z);
        if (p.normal && nrm) {
          _n.fromArray(p.normal, k * 3)
            .applyMatrix3(_m3)
            .normalize();
          nrm.setXYZ(vi, _n.x, _n.y, _n.z);
        }
      }
      markRange(pos, p.first, p.last);
      if (p.normal && nrm) markRange(nrm, p.first, p.last);
    }
  }
}

/**
 * Upload only the vertex range [first, last] of an attribute. The converted models are quantized
 * with padded strides, so GLTFLoader gives interleaved attributes: their range is on the buffer.
 */
function markRange(
  attr: BufferAttribute | InterleavedBufferAttribute,
  first: number,
  last: number,
): void {
  if ((attr as InterleavedBufferAttribute).isInterleavedBufferAttribute) {
    const data = (attr as InterleavedBufferAttribute).data;
    data.clearUpdateRanges();
    data.addUpdateRange(first * data.stride, (last - first + 1) * data.stride);
    data.needsUpdate = true;
    return;
  }
  const a = attr as BufferAttribute;
  a.clearUpdateRanges();
  a.addUpdateRange(first * a.itemSize, (last - first + 1) * a.itemSize);
  a.needsUpdate = true;
}

const _pivot = new Vector3();
const _t = new Matrix4();
const _r = new Matrix4();
/** The move handed to MergedPart.transform (which uses _m itself). */
const _move = new Matrix4();

/** The LASTE panel's autopilot button and mode lever. */
export class LastePanel {
  readonly lever: MergedPart;
  readonly button: MergedPart;
  /** The lever angle and button depth shown (NaN: not drawn yet). */
  private shownAngle = Number.NaN;
  private shownDepth = Number.NaN;
  private pressLeft = 0;

  /** `root`: the cockpit model (BODY frame). Copied geometries go to `ownGeometries`. */
  constructor(root: Object3D, ownGeometries: BufferGeometry[]) {
    const l = LASTE.lever;
    const b = LASTE.button;
    this.lever = MergedPart.find(
      root,
      { x: l.x, z: l.z, radius: l.radius + 0.0005, yMin: l.pivot, yMax: l.tip + 0.001 },
      ownGeometries,
    );
    this.button = MergedPart.find(
      root,
      { x: b.x, z: b.z, radius: b.radius + 0.0005, yMin: b.top - 0.0015, yMax: b.top + 0.001 },
      ownGeometries,
    );
  }

  /** The click box of a control, BODY coordinates. */
  controlBox(id: LasteControlId, out: Box3): Box3 {
    return lasteControlBox(id, out);
  }

  /** A click on ENGAGE/DISENGAGE: the cap goes in and springs back. */
  press(): void {
    this.pressLeft = LASTE.buttonPressTime;
  }

  /** The lever angle (rad about BODY +X) and the cap depth (m) shown now. */
  get angle(): number {
    return this.shownAngle;
  }

  get depth(): number {
    return this.shownDepth;
  }

  /** Show the autopilot mode on the lever and advance the press (real seconds). */
  update(s: CockpitSwitchState, dt: number): void {
    if (this.pressLeft > 0) this.pressLeft = Math.max(0, this.pressLeft - Math.max(0, dt));
    const angle = lasteLeverAngle(s.autopilotMode);
    if (angle !== this.shownAngle) {
      this.shownAngle = angle;
      const l = LASTE.lever;
      _pivot.set(l.x, l.pivot, l.z);
      // rotate about the X axis through the pivot
      _t.makeTranslation(_pivot.x, _pivot.y, _pivot.z);
      _r.makeRotationX(angle);
      _move.copy(_t).multiply(_r);
      _t.makeTranslation(-_pivot.x, -_pivot.y, -_pivot.z);
      _move.multiply(_t);
      this.lever.transform(_move);
    }
    const depth = lastePressDepth(this.pressLeft);
    if (depth !== this.shownDepth) {
      this.shownDepth = depth;
      _move.makeTranslation(0, -depth, 0);
      this.button.transform(_move);
    }
  }
}
