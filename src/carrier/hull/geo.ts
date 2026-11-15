/**
 * MeshBuilder — accumulates flat- or smooth-shaded triangles with per-vertex colour and UVs
 * into ONE non-indexed BufferGeometry. Everything static on the ship that shares a material is
 * emitted through one builder, so it ends up in a single draw call.
 *
 * Conventions:
 *  - Triangles are counter-clockwise seen from outside (three.js front faces).
 *  - Colours are linear-sRGB `Color`s (what `new Color('#rrggbb')` yields); the material
 *    multiplies them in via `vertexColors`.
 *  - UVs are in texture repeats. When a primitive does not supply them they are projected
 *    from the vertex position along the face's dominant axis (`uvScale` repeats per metre),
 *    which is all a tiling plating texture needs.
 */
import {
  BufferGeometry,
  Float32BufferAttribute,
  Matrix4,
  ShapeUtils,
  Vector2,
  Vector3,
  type Color,
} from 'three';

export type V3 = readonly [x: number, y: number, z: number];
export type V2 = readonly [u: number, v: number];

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _e1 = new Vector3();
const _e2 = new Vector3();
const _n = new Vector3();
const _na = new Vector3();
const _nb = new Vector3();
const _nc = new Vector3();

export function v3add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function v3sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function v3scale(a: V3, s: number): V3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function v3lerp(a: V3, b: V3, t: number): V3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function v3cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function v3dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function v3length(a: V3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function v3normalize(a: V3): V3 {
  const l = v3length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

function centroid(points: readonly V3[]): V3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  const k = 1 / points.length;
  return [x * k, y * k, z * k];
}

/** Newell normal of a (possibly concave) planar polygon; its direction follows the winding. */
function polygonNormal(points: readonly V3[]): V3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  return v3normalize([nx, ny, nz]);
}

export interface LoftOptions {
  /** Close the first / last ring with a flat cap. Default true. */
  capStart?: boolean;
  capEnd?: boolean;
  /** Colour of the caps (defaults to the first / last band colour). */
  capColor?: Color;
}

export interface CylinderOptions {
  capStart?: boolean;
  capEnd?: boolean;
  /** Radial (smooth) normals on the wall. Default true. */
  smooth?: boolean;
  capColor?: Color;
}

export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];
  private readonly uvs: number[] = [];
  private matrix = new Matrix4();
  private mirrored = false;
  private hasTransform = false;

  /** `uvScale` = texture repeats per metre for projected UVs. */
  constructor(private readonly uvScale = 1 / 40) {}

  get triangleCount(): number {
    return this.positions.length / 9;
  }

  /**
   * Emit everything `fn` adds through `m` (composed after any enclosing transform).
   * Mirroring transforms are fine: the winding is corrected automatically.
   */
  transformed(m: Matrix4, fn: () => void): void {
    const prevMatrix = this.matrix;
    const prevMirrored = this.mirrored;
    const prevHas = this.hasTransform;
    this.matrix = prevMatrix.clone().multiply(m);
    this.mirrored = this.matrix.determinant() < 0;
    this.hasTransform = true;
    try {
      fn();
    } finally {
      this.matrix = prevMatrix;
      this.mirrored = prevMirrored;
      this.hasTransform = prevHas;
    }
  }

  private projectUv(p: Vector3, n: Vector3): void {
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    const s = this.uvScale;
    if (ay >= ax && ay >= az) this.uvs.push(p.z * s, p.x * s);
    else if (ax >= az) this.uvs.push(p.z * s, p.y * s);
    else this.uvs.push(p.x * s, p.y * s);
  }

  /** One flat-shaded triangle. Degenerate triangles are dropped. */
  tri(a: V3, b: V3, c: V3, color: Color, uvA?: V2, uvB?: V2, uvC?: V2): void {
    _a.set(a[0], a[1], a[2]);
    _b.set(b[0], b[1], b[2]);
    _c.set(c[0], c[1], c[2]);
    if (this.hasTransform) {
      _a.applyMatrix4(this.matrix);
      _b.applyMatrix4(this.matrix);
      _c.applyMatrix4(this.matrix);
    }
    let pb = _b;
    let pc = _c;
    let ub = uvB;
    let uc = uvC;
    if (this.mirrored) {
      pb = _c;
      pc = _b;
      ub = uvC;
      uc = uvB;
    }
    _e1.subVectors(pb, _a);
    _e2.subVectors(pc, _a);
    _n.crossVectors(_e1, _e2);
    const len = _n.length();
    if (len < 1e-9) return;
    _n.multiplyScalar(1 / len);
    this.positions.push(_a.x, _a.y, _a.z, pb.x, pb.y, pb.z, pc.x, pc.y, pc.z);
    for (let i = 0; i < 3; i++) {
      this.normals.push(_n.x, _n.y, _n.z);
      this.colors.push(color.r, color.g, color.b);
    }
    if (uvA && ub && uc) {
      this.uvs.push(uvA[0], uvA[1], ub[0], ub[1], uc[0], uc[1]);
    } else {
      this.projectUv(_a, _n);
      this.projectUv(pb, _n);
      this.projectUv(pc, _n);
    }
  }

  /** One triangle with explicit per-vertex normals (smooth shading). */
  smoothTri(a: V3, na: V3, b: V3, nb: V3, c: V3, nc: V3, color: Color): void {
    _a.set(a[0], a[1], a[2]);
    _b.set(b[0], b[1], b[2]);
    _c.set(c[0], c[1], c[2]);
    _na.set(na[0], na[1], na[2]);
    _nb.set(nb[0], nb[1], nb[2]);
    _nc.set(nc[0], nc[1], nc[2]);
    if (this.hasTransform) {
      _a.applyMatrix4(this.matrix);
      _b.applyMatrix4(this.matrix);
      _c.applyMatrix4(this.matrix);
      // rigid motions and mirrors only, so the matrix itself transforms normals correctly
      _na.transformDirection(this.matrix);
      _nb.transformDirection(this.matrix);
      _nc.transformDirection(this.matrix);
    }
    let pb = _b;
    let pc = _c;
    let nB = _nb;
    let nC = _nc;
    if (this.mirrored) {
      pb = _c;
      pc = _b;
      nB = _nc;
      nC = _nb;
    }
    _e1.subVectors(pb, _a);
    _e2.subVectors(pc, _a);
    _n.crossVectors(_e1, _e2);
    if (_n.lengthSq() < 1e-18) return;
    _n.normalize();
    this.positions.push(_a.x, _a.y, _a.z, pb.x, pb.y, pb.z, pc.x, pc.y, pc.z);
    this.normals.push(_na.x, _na.y, _na.z, nB.x, nB.y, nB.z, nC.x, nC.y, nC.z);
    for (let i = 0; i < 3; i++) this.colors.push(color.r, color.g, color.b);
    this.projectUv(_a, _n);
    this.projectUv(pb, _n);
    this.projectUv(pc, _n);
  }

  /** Flat quad a→b→c→d (counter-clockwise seen from outside). */
  quad(a: V3, b: V3, c: V3, d: V3, color: Color): void {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }

  /** Flat quad wound so that it faces `facing` (any vector pointing to its outer side). */
  quadFacing(a: V3, b: V3, c: V3, d: V3, color: Color, facing: V3): void {
    const normal = v3cross(v3sub(c, a), v3sub(d, b));
    if (v3dot(normal, facing) >= 0) this.quad(a, b, c, d, color);
    else this.quad(d, c, b, a, color);
  }

  /**
   * A shallow raised panel: `base` are its four corners on the surface (in order round the
   * panel), `outward` the surface normal. The face stands `proud` metres off the surface and
   * a rim closes the gap — real relief, so it cannot z-fight the way a coplanar decal would.
   */
  raisedPanel(base: readonly V3[], outward: V3, proud: number, face: Color, rim: Color): void {
    const lift = v3scale(v3normalize(outward), proud);
    const front = base.map((p) => v3add(p, lift));
    const centre = centroid(base);
    this.quadFacing(front[0], front[1], front[2], front[3], face, outward);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const edgeMid = v3lerp(base[i], base[j], 0.5);
      this.quadFacing(base[i], base[j], front[j], front[i], rim, v3sub(edgeMid, centre));
    }
  }

  /**
   * Planar polygon (convex or concave, optional holes), triangulated without adding
   * vertices so shared edges stay watertight. If `facing` is given the result faces it.
   */
  polygon(points: readonly V3[], color: Color, facing?: V3, holes: readonly V3[][] = []): void {
    if (points.length < 3) return;
    const normal = polygonNormal(points);
    const reverse = facing ? v3dot(normal, facing) < 0 : false;
    // project onto the plane's dominant axes for the 2D triangulation
    const ax = Math.abs(normal[0]);
    const ay = Math.abs(normal[1]);
    const az = Math.abs(normal[2]);
    const drop = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    const to2 = (p: V3): Vector2 =>
      drop === 0
        ? new Vector2(p[1], p[2])
        : drop === 1
          ? new Vector2(p[2], p[0])
          : new Vector2(p[0], p[1]);
    const contour = points.map(to2);
    const holes2 = holes.map((h) => h.map(to2));
    const all: V3[] = [...points];
    for (const h of holes) all.push(...h);
    const faces = ShapeUtils.triangulateShape(contour, holes2);
    for (const f of faces) {
      const a = all[f[0]];
      const b = all[f[1]];
      const c = all[f[2]];
      // triangulateShape keeps or flips the contour order; orient each face explicitly
      const n = v3cross(v3sub(b, a), v3sub(c, a));
      const want = reverse ? v3scale(normal, -1) : normal;
      if (v3dot(n, want) >= 0) this.tri(a, b, c, color);
      else this.tri(a, c, b, color);
    }
  }

  /** Axis-aligned box. `faceColors` overrides individual faces (key = outward axis, e.g. '+x'). */
  box(
    min: V3,
    max: V3,
    color: Color,
    faceColors: Partial<Record<'+x' | '-x' | '+y' | '-y' | '+z' | '-z', Color>> = {},
  ): void {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], faceColors['+x'] ?? color);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], faceColors['-x'] ?? color);
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], faceColors['+y'] ?? color);
    this.quad([x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], faceColors['-y'] ?? color);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], faceColors['+z'] ?? color);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], faceColors['-z'] ?? color);
  }

  /**
   * Skin consecutive rings (same vertex count, same starting corner) with flat quads and cap
   * the ends. Faces are oriented away from the loft's own axis, so the ring winding does not
   * matter. `colors` is one colour, or one per band between rings.
   */
  loft(
    rings: readonly (readonly V3[])[],
    colors: Color | readonly Color[],
    opts: LoftOptions = {},
  ): void {
    if (rings.length < 2) return;
    const bandColor = (i: number): Color =>
      Array.isArray(colors)
        ? (colors as readonly Color[])[Math.min(i, colors.length - 1)]
        : (colors as Color);
    const centers = rings.map(centroid);
    const n = rings[0].length;
    for (let r = 0; r < rings.length - 1; r++) {
      const lo = rings[r];
      const hi = rings[r + 1];
      const axisMid = v3lerp(centers[r], centers[r + 1], 0.5);
      const color = bandColor(r);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = lo[i];
        const b = lo[j];
        const c = hi[j];
        const d = hi[i];
        const mid = centroid([a, b, c, d]);
        const normal = v3cross(v3sub(c, a), v3sub(d, b));
        if (v3dot(normal, v3sub(mid, axisMid)) >= 0) this.quad(a, b, c, d, color);
        else this.quad(d, c, b, a, color);
      }
    }
    const last = rings.length - 1;
    if (opts.capStart !== false) {
      this.polygon(rings[0], opts.capColor ?? bandColor(0), v3sub(centers[0], centers[1]));
    }
    if (opts.capEnd !== false) {
      this.polygon(
        rings[last],
        opts.capColor ?? bandColor(last - 1),
        v3sub(centers[last], centers[last - 1]),
      );
    }
  }

  /** Straight box beam from p0 to p1. `width` is measured across `up`, `height` along it. */
  beam(p0: V3, p1: V3, width: number, height: number, color: Color, up: V3 = [0, 1, 0]): void {
    const dir = v3normalize(v3sub(p1, p0));
    let side = v3cross(dir, up);
    if (v3length(side) < 1e-6) side = v3cross(dir, [1, 0, 0]);
    side = v3normalize(side);
    const top = v3normalize(v3cross(side, dir));
    const hw = v3scale(side, width / 2);
    const hh = v3scale(top, height / 2);
    const ring = (p: V3): V3[] => [
      v3sub(v3sub(p, hw), hh),
      v3sub(v3add(p, hw), hh),
      v3add(v3add(p, hw), hh),
      v3add(v3sub(p, hw), hh),
    ];
    this.loft([ring(p0), ring(p1)], color);
  }

  /** Cylinder / cone frustum from p0 (radius r0) to p1 (radius r1). */
  cylinder(
    p0: V3,
    p1: V3,
    r0: number,
    r1: number,
    segments: number,
    color: Color,
    opts: CylinderOptions = {},
  ): void {
    const axis = v3normalize(v3sub(p1, p0));
    let u = v3cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
    u = v3normalize(u);
    const v = v3cross(axis, u);
    const length = v3length(v3sub(p1, p0));
    // tilt of the wall normal for cones
    const slope = length > 1e-9 ? (r0 - r1) / length : 0;
    const smooth = opts.smooth !== false;
    const dirAt = (k: number): V3 => {
      const a = (k / segments) * Math.PI * 2;
      return v3add(v3scale(u, Math.cos(a)), v3scale(v, Math.sin(a)));
    };
    for (let k = 0; k < segments; k++) {
      const d0 = dirAt(k);
      const d1 = dirAt(k + 1);
      const a = v3add(p0, v3scale(d0, r0));
      const b = v3add(p0, v3scale(d1, r0));
      const c = v3add(p1, v3scale(d1, r1));
      const d = v3add(p1, v3scale(d0, r1));
      if (smooth) {
        const n0 = v3normalize(v3add(d0, v3scale(axis, slope)));
        const n1 = v3normalize(v3add(d1, v3scale(axis, slope)));
        this.smoothTri(a, n0, b, n1, c, n1, color);
        this.smoothTri(a, n0, c, n1, d, n0, color);
      } else {
        this.tri(a, b, c, color);
        this.tri(a, c, d, color);
      }
    }
    const capColor = opts.capColor ?? color;
    if (opts.capStart !== false && r0 > 1e-6) {
      for (let k = 0; k < segments; k++) {
        this.tri(
          p0,
          v3add(p0, v3scale(dirAt(k + 1), r0)),
          v3add(p0, v3scale(dirAt(k), r0)),
          capColor,
        );
      }
    }
    if (opts.capEnd !== false && r1 > 1e-6) {
      for (let k = 0; k < segments; k++) {
        this.tri(
          p1,
          v3add(p1, v3scale(dirAt(k), r1)),
          v3add(p1, v3scale(dirAt(k + 1), r1)),
          capColor,
        );
      }
    }
  }

  /**
   * Low-poly sphere (or its upper part down to `minLat` radians of latitude) with smooth
   * normals — radomes and light globes.
   */
  sphere(
    center: V3,
    radius: number,
    widthSegments: number,
    heightSegments: number,
    color: Color,
    minLat = -Math.PI / 2,
  ): void {
    const point = (lat: number, lon: number): V3 => [
      Math.cos(lat) * Math.cos(lon),
      Math.sin(lat),
      Math.cos(lat) * Math.sin(lon),
    ];
    for (let i = 0; i < heightSegments; i++) {
      const lat0 = minLat + ((Math.PI / 2 - minLat) * i) / heightSegments;
      const lat1 = minLat + ((Math.PI / 2 - minLat) * (i + 1)) / heightSegments;
      for (let j = 0; j < widthSegments; j++) {
        const lon0 = (j / widthSegments) * Math.PI * 2;
        const lon1 = ((j + 1) / widthSegments) * Math.PI * 2;
        const n00 = point(lat0, lon0);
        const n01 = point(lat0, lon1);
        const n10 = point(lat1, lon0);
        const n11 = point(lat1, lon1);
        const p = (n: V3): V3 => v3add(center, v3scale(n, radius));
        // counter-clockwise seen from outside: lon increases toward +z, lat toward +y
        this.smoothTri(p(n00), n00, p(n10), n10, p(n11), n11, color);
        this.smoothTri(p(n00), n00, p(n11), n11, p(n01), n01, color);
      }
    }
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(this.uvs, 2));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return geometry;
  }
}
