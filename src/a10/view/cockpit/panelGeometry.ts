/**
 * A small builder for the A-10C panels made in code (MFCDs, AHCP, UFC). OWNED BY THE COCKPIT
 * MODULE. Each panel's static parts (housing, face, walls, guards, rockers, knobs) are added in
 * the panel's FACE frame (+X right, +Y up, +Z toward the pilot, origin on the front face) and
 * baked into one BufferGeometry in BODY coordinates, so a whole panel — or both MFCDs — is one
 * draw call with one material. Faces carry UVs into the panel's label texture: the front face
 * maps its rectangle onto the texture, every other surface samples one plain spot of it.
 */
import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, Vector3 } from 'three';

const _a = new Vector3();
const _b = new Vector3();
const _n = new Vector3();
const _m3 = new Matrix3();

/** A UV spot of the label texture painted in the plain housing colour (texture corner). */
export const PLAIN_UV: readonly [number, number] = [0.004, 0.004];

export class PanelGeometryBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];

  /**
   * A quad a-b-c-d, counter-clockwise as seen from its front; `uv` per corner (default: the
   * plain spot).
   */
  quad(
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    d: readonly number[],
    uv?: readonly (readonly [number, number])[],
  ): void {
    _a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    _b.set(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    _n.crossVectors(_a, _b).normalize();
    const corners = [a, b, c, d];
    const order = [0, 1, 2, 0, 2, 3];
    for (const i of order) {
      const p = corners[i];
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(_n.x, _n.y, _n.z);
      const t = uv ? uv[i] : PLAIN_UV;
      this.uvs.push(t[0], t[1]);
    }
  }

  /**
   * An axis-aligned box in the face frame without its back face (it sits on a surface).
   * `frontUv` maps the +Z face (default plain).
   */
  box(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    frontUv?: readonly (readonly [number, number])[],
  ): void {
    // front (+Z)
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], frontUv);
    // top (+Y), bottom (−Y), right (+X), left (−X)
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
  }

  /**
   * A rectangular frame on the plane z (outer rectangle minus an inner window), its UVs mapped
   * over the outer rectangle (the label texture covers the whole face).
   */
  frame(
    ox0: number,
    oy0: number,
    ox1: number,
    oy1: number,
    ix0: number,
    iy0: number,
    ix1: number,
    iy1: number,
    z: number,
  ): void {
    const uv = (x: number, y: number): [number, number] => [
      (x - ox0) / (ox1 - ox0),
      (y - oy0) / (oy1 - oy0),
    ];
    const q = (x0: number, y0: number, x1: number, y1: number) =>
      this.quad(
        [x0, y0, z],
        [x1, y0, z],
        [x1, y1, z],
        [x0, y1, z],
        [uv(x0, y0), uv(x1, y0), uv(x1, y1), uv(x0, y1)],
      );
    q(ox0, iy1, ox1, oy1); // top band
    q(ox0, oy0, ox1, iy0); // bottom band
    q(ox0, iy0, ix0, iy1); // left band
    q(ix1, iy0, ox1, iy1); // right band
  }

  /**
   * The inside walls of a window from the face (z = 0) back to depth `z1` (< 0), each facing the
   * window's centre, and its back plate at z1 facing the pilot. (Normal = (b − a) × (d − a).)
   */
  window(x0: number, y0: number, x1: number, y1: number, z1: number, back = true): void {
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, 0], [x0, y1, 0]); // top wall, faces −Y
    this.quad([x0, y0, 0], [x1, y0, 0], [x1, y0, z1], [x0, y0, z1]); // bottom wall, faces +Y
    this.quad([x0, y0, 0], [x0, y0, z1], [x0, y1, z1], [x0, y1, 0]); // left wall, faces +X
    this.quad([x1, y0, z1], [x1, y0, 0], [x1, y1, 0], [x1, y1, z1]); // right wall, faces −X
    if (back) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  }

  /** The housing's side walls, from the front face (z = 0) back to z = −depth, facing out. */
  sides(x0: number, y0: number, x1: number, y1: number, depth: number): void {
    const z1 = -depth;
    this.quad([x0, y1, 0], [x1, y1, 0], [x1, y1, z1], [x0, y1, z1]); // top, faces +Y
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y0, 0], [x0, y0, 0]); // bottom, faces −Y
    this.quad([x1, y0, 0], [x1, y0, z1], [x1, y1, z1], [x1, y1, 0]); // right, faces +X
    this.quad([x0, y0, z1], [x0, y0, 0], [x0, y1, 0], [x0, y1, z1]); // left, faces −X
  }

  /** A cylinder along +Z from z0 to z1 (side and front cap), centred at (cx, cy). */
  cylinder(cx: number, cy: number, r: number, z0: number, z1: number, segments = 14): void {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const x0 = cx + Math.cos(a0) * r;
      const y0 = cy + Math.sin(a0) * r;
      const x1 = cx + Math.cos(a1) * r;
      const y1 = cy + Math.sin(a1) * r;
      this.quad([x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z1]);
      // front cap: one fan triangle (the quad's second triangle has no area)
      this.quad([cx, cy, z1], [x0, y0, z1], [x1, y1, z1], [x1, y1, z1]);
    }
  }

  /** Append another builder's triangles transformed by `m` (face → BODY). */
  appendTo(out: PanelGeometryBuilder, m: Matrix4): void {
    _m3.getNormalMatrix(m);
    for (let i = 0; i < this.positions.length; i += 3) {
      _a.set(this.positions[i], this.positions[i + 1], this.positions[i + 2]).applyMatrix4(m);
      _n.set(this.normals[i], this.normals[i + 1], this.normals[i + 2])
        .applyMatrix3(_m3)
        .normalize();
      out.positions.push(_a.x, _a.y, _a.z);
      out.normals.push(_n.x, _n.y, _n.z);
    }
    for (const v of this.uvs) out.uvs.push(v);
  }

  /** The triangles as a non-indexed BufferGeometry (optionally transformed by `m`). */
  build(m?: Matrix4): BufferGeometry {
    const src: PanelGeometryBuilder = m ? new PanelGeometryBuilder() : this;
    if (m) this.appendTo(src, m);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(src.positions), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(src.normals), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(src.uvs), 2));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  get triangles(): number {
    return this.positions.length / 9;
  }
}
