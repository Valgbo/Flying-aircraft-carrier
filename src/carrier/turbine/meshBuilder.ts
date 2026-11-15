/**
 * A small non-indexed mesh builder for the turbine parts: bodies of revolution from (r, y)
 * profiles and transformed three.js primitives, all merged into one BufferGeometry with
 * position / normal / uv / color attributes so a whole nacelle is a single draw call.
 * Build-time only — nothing here runs per frame.
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Matrix3,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import { TAU } from '../../utils/math';
import type { ProfilePoint } from './model';

export interface LatheOptions {
  segments: number;
  /** Smooth normals along and around the profile; otherwise every facet is flat. */
  smooth?: boolean;
  /** One colour, or one colour per profile point (interpolated along the profile). */
  color: Color | readonly Color[];
  /** Per-quad colour override (e.g. painted stripes); return null to keep `color`. */
  paint?: (ring: number, segment: number) => Color | null;
  /** Texture v per profile point; u runs `uRepeat` times around. Omit for a constant uv. */
  v?: readonly number[];
  uRepeat?: number;
  /** Constant uv used when `v` is omitted. */
  uv?: readonly [number, number];
}

const _p = new Vector3();
const _n = new Vector3();
const _normalMatrix = new Matrix3();
const _up = new Vector3(0, 1, 0);

export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly colors: number[] = [];

  get triangleCount(): number {
    return this.positions.length / 9;
  }

  private push(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    c: Color,
  ): void {
    this.positions.push(x, y, z);
    this.normals.push(nx, ny, nz);
    this.uvs.push(u, v);
    this.colors.push(c.r, c.g, c.b);
  }

  /**
   * Surface of revolution about +Y. The profile runs counter-clockwise in the (r, y) plane:
   * the surface normal is on the right of the direction of travel (see model.ts).
   */
  lathe(profile: readonly ProfilePoint[], o: LatheOptions): void {
    const count = profile.length;
    // 2D normal of every profile edge, then per-point normals for smooth shading
    const edgeN: { r: number; y: number }[] = [];
    for (let j = 0; j < count - 1; j++) {
      const dr = profile[j + 1].r - profile[j].r;
      const dy = profile[j + 1].y - profile[j].y;
      const len = Math.hypot(dr, dy) || 1;
      edgeN.push({ r: dy / len, y: -dr / len });
    }
    const pointN = profile.map((_, j) => {
      const a = edgeN[Math.max(0, j - 1)];
      const b = edgeN[Math.min(count - 2, j)];
      const len = Math.hypot(a.r + b.r, a.y + b.y) || 1;
      return { r: (a.r + b.r) / len, y: (a.y + b.y) / len };
    });
    const colorAt = (j: number): Color => (o.color instanceof Color ? o.color : o.color[j]);
    const uRepeat = o.uRepeat ?? 1;

    for (let j = 0; j < count - 1; j++) {
      const p0 = profile[j];
      const p1 = profile[j + 1];
      for (let i = 0; i < o.segments; i++) {
        const a0 = (i / o.segments) * TAU;
        const a1 = ((i + 1) / o.segments) * TAU;
        const am = (a0 + a1) / 2;
        const painted = o.paint?.(j, i) ?? null;
        const c0 = painted ?? colorAt(j);
        const c1 = painted ?? colorAt(j + 1);
        const u0 = o.v ? (i / o.segments) * uRepeat : (o.uv?.[0] ?? 0.5);
        const u1 = o.v ? ((i + 1) / o.segments) * uRepeat : (o.uv?.[0] ?? 0.5);
        const v0 = o.v ? o.v[j] : (o.uv?.[1] ?? 0.5);
        const v1 = o.v ? o.v[j + 1] : (o.uv?.[1] ?? 0.5);

        // corner (profile point, angle): A = (p0, a0), B = (p0, a1), C = (p1, a1), D = (p1, a0)
        const corner = (p: ProfilePoint, pn: { r: number; y: number }, a: number, u: number, v: number, c: Color) => {
          const en = edgeN[j];
          const na = o.smooth ? a : am;
          const nr = o.smooth ? pn.r : en.r;
          const ny = o.smooth ? pn.y : en.y;
          this.push(
            p.r * Math.sin(a),
            p.y,
            p.r * Math.cos(a),
            nr * Math.sin(na),
            ny,
            nr * Math.cos(na),
            u,
            v,
            c,
          );
        };
        if (p0.r > 1e-6) {
          corner(p0, pointN[j], a0, u0, v0, c0);
          corner(p0, pointN[j], a1, u1, v0, c0);
          corner(p1, pointN[j + 1], a1, u1, v1, c1);
        }
        if (p1.r > 1e-6) {
          corner(p0, pointN[j], a0, u0, v0, c0);
          corner(p1, pointN[j + 1], a1, u1, v1, c1);
          corner(p1, pointN[j + 1], a0, u0, v1, c1);
        }
      }
    }
  }

  /** A quad a→b→c→d (counter-clockwise seen from the side `normal` points to). */
  quad(
    a: Vector3,
    b: Vector3,
    c: Vector3,
    d: Vector3,
    normal: Vector3,
    colors: readonly [Color, Color, Color, Color],
    uvs?: readonly [number, number, number, number, number, number, number, number],
  ): void {
    const corners = [a, b, c, d];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const p = corners[k];
      this.push(
        p.x,
        p.y,
        p.z,
        normal.x,
        normal.y,
        normal.z,
        uvs ? uvs[k * 2] : 0.5,
        uvs ? uvs[k * 2 + 1] : 0.5,
        colors[k],
      );
    }
  }

  /** Append a (temporary) geometry transformed by `matrix`, with one colour and a constant uv. */
  add(
    geometry: BufferGeometry,
    matrix: Matrix4,
    color: Color,
    uv: readonly [number, number],
    flat = false,
  ): void {
    let source = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat) {
      if (source === geometry) source = geometry.clone();
      source.computeVertexNormals();
    }
    const pos = source.getAttribute('position');
    const nor = source.getAttribute('normal');
    _normalMatrix.getNormalMatrix(matrix);
    for (let i = 0; i < pos.count; i++) {
      _p.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      _n.fromBufferAttribute(nor, i).applyMatrix3(_normalMatrix).normalize();
      this.push(_p.x, _p.y, _p.z, _n.x, _n.y, _n.z, uv[0], uv[1], color);
    }
    if (source !== geometry) source.dispose();
    geometry.dispose();
  }

  /** Axis-aligned box of the given size placed by `matrix`. */
  box(
    size: readonly [number, number, number],
    matrix: Matrix4,
    color: Color,
    uv: readonly [number, number],
  ): void {
    this.add(new BoxGeometry(size[0], size[1], size[2]), matrix, color, uv);
  }

  /** Cylinder (or cone frustum) between two points. */
  rod(
    from: Vector3,
    to: Vector3,
    radiusFrom: number,
    radiusTo: number,
    sides: number,
    color: Color,
    uv: readonly [number, number],
    flat = false,
  ): void {
    const axis = new Vector3().subVectors(to, from);
    const length = axis.length();
    const matrix = new Matrix4().compose(
      new Vector3().addVectors(from, to).multiplyScalar(0.5),
      new Quaternion().setFromUnitVectors(_up, axis.normalize()),
      new Vector3(1, 1, 1),
    );
    this.add(new CylinderGeometry(radiusTo, radiusFrom, length, sides), matrix, color, uv, flat);
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(this.uvs, 2));
    geometry.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return geometry;
  }
}
