/**
 * A small geometry builder for the procedural vehicle models. Everything is built once at start-up
 * into ONE BufferGeometry per vehicle kind and level of detail, with per-vertex data the vehicle
 * material uses to animate and shade parts without separate meshes:
 *
 *   color   linear albedo
 *   aZone   heat weights (engine deck, exhaust, running gear, hull) for the thermal picture
 *   aAux    part data; aAux.w = part id (PART):
 *             wheel        (axle y, axle z, radius, PART.wheel)       rotates with distance driven
 *             track        (s along the loop, 0, 0, PART.track)       link pattern scrolls
 *             turret/gun   (turret pivot z, gun pivot y, gun pivot z) yaw, elevation, bend
 *             panel face   (u, v, 0, PART.panel)                      bullseye
 *
 * Vehicle-local frame (docs/a10/ARCHITECTURE.md §2): +X right, +Y up, -Z forward, origin on the
 * ground under the hull centre. Flat-shaded faces for armour plates, smooth for round parts.
 */
import { BufferGeometry, Color, Float32BufferAttribute, Matrix3, Matrix4, ShapeUtils, Vector2, Vector3 } from 'three';

export const PART = {
  hull: 0,
  turret: 1,
  gun: 2,
  wheel: 3,
  track: 4,
  thrownTrack: 5,
  tarp: 6,
  panel: 7,
  /** Unpainted hull fittings: rubber, steel, wood, glass (no paint weathering). */
  bare: 8,
  /** Unpainted fittings on the turret (rotate with it). */
  turretBare: 9,
  glass: 10,
} as const;

/** Heat-zone weights: engine deck, exhaust, running gear, hull. */
export const ZONE = {
  hull: [0, 0, 0, 1],
  engine: [1, 0, 0, 0],
  exhaust: [0, 1, 0, 0],
  running: [0, 0, 1, 0],
  engineHull: [0.55, 0, 0, 0.45],
} as const satisfies Record<string, readonly [number, number, number, number]>;

const _v = new Vector3();
const _n = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _e1 = new Vector3();
const _e2 = new Vector3();

export class ModelBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private zone: number[] = [];
  private aux: number[] = [];
  /** Current vertex state. */
  color = new Color(0.3, 0.32, 0.25);
  zoneW: readonly number[] = ZONE.hull;
  auxV: [number, number, number, number] = [0, 0, 0, PART.hull];
  /** Segment multiplier from the detail level. */
  readonly detail: number;
  private matrix = new Matrix4();
  private normalMatrix = new Matrix3();
  private stack: Matrix4[] = [];

  constructor(detail = 1) {
    this.detail = detail;
  }

  /** Segments for a round part, scaled by detail, at least `min`. */
  seg(n: number, min = 3): number {
    return Math.max(min, Math.round(n * this.detail));
  }

  setColor(c: Color | string | number): this {
    if (c instanceof Color) this.color.copy(c);
    else this.color.set(c);
    return this;
  }

  setZone(z: readonly number[]): this {
    this.zoneW = z;
    return this;
  }

  setPart(part: number, x = 0, y = 0, z = 0): this {
    this.auxV = [x, y, z, part];
    return this;
  }

  /** Push a transform applied to everything added until the matching pop. */
  push(m: Matrix4): this {
    this.stack.push(this.matrix.clone());
    this.matrix.multiply(m);
    this.normalMatrix.getNormalMatrix(this.matrix);
    return this;
  }

  pop(): this {
    const m = this.stack.pop();
    if (m) {
      this.matrix.copy(m);
      this.normalMatrix.getNormalMatrix(this.matrix);
    }
    return this;
  }

  /** Transformed position of a local point (for anchoring aux data such as wheel axles). */
  transformPoint(x: number, y: number, z: number): Vector3 {
    return new Vector3(x, y, z).applyMatrix4(this.matrix);
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, aux?: readonly number[]): void {
    _v.set(x, y, z).applyMatrix4(this.matrix);
    _n.set(nx, ny, nz).applyMatrix3(this.normalMatrix).normalize();
    this.pos.push(_v.x, _v.y, _v.z);
    this.nor.push(_n.x, _n.y, _n.z);
    this.col.push(this.color.r, this.color.g, this.color.b);
    const z4 = this.zoneW;
    this.zone.push(z4[0], z4[1], z4[2], z4[3]);
    const a = aux ?? this.auxV;
    this.aux.push(a[0], a[1], a[2], a[3]);
  }

  /** Flat-shaded triangle (counter-clockwise seen from outside). */
  tri(a: Vector3, b: Vector3, c: Vector3): void {
    _e1.subVectors(b, a);
    _e2.subVectors(c, a);
    _n.crossVectors(_e1, _e2);
    if (_n.lengthSq() < 1e-14) return;
    _n.normalize();
    const nx = _n.x;
    const ny = _n.y;
    const nz = _n.z;
    this.vertex(a.x, a.y, a.z, nx, ny, nz);
    this.vertex(b.x, b.y, b.z, nx, ny, nz);
    this.vertex(c.x, c.y, c.z, nx, ny, nz);
  }

  /** Flat-shaded quad a-b-c-d (counter-clockwise seen from outside). */
  quad(a: Vector3, b: Vector3, c: Vector3, d: Vector3): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** Axis-aligned box centred at (cx, cy, cz) with full sizes (sx, sy, sz). */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void {
    const x0 = cx - sx / 2;
    const x1 = cx + sx / 2;
    const y0 = cy - sy / 2;
    const y1 = cy + sy / 2;
    const z0 = cz - sz / 2;
    const z1 = cz + sz / 2;
    const p = (x: number, y: number, z: number) => new Vector3(x, y, z);
    this.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)); // +z (rear)
    this.quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0)); // -z (front)
    this.quad(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1)); // +x
    this.quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)); // -x
    this.quad(p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), p(x0, y1, z0)); // +y
    this.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)); // -y
  }

  /**
   * Loft through cross-sections along z (front first): each section is a closed polygon of
   * (x, y) pairs listed counter-clockwise in the usual x-right, y-up sense, all with the same
   * vertex count. Faces are flat (armour plates); both ends are capped.
   */
  loft(sections: { z: number; pts: number[] }[], capStart = true, capEnd = true): void {
    const n = sections[0].pts.length / 2;
    const P = (s: number, i: number) => {
      const sec = sections[s];
      const k = ((i % n) + n) % n;
      return new Vector3(sec.pts[k * 2], sec.pts[k * 2 + 1], sec.z);
    };
    for (let s = 0; s < sections.length - 1; s++) {
      for (let i = 0; i < n; i++) {
        // section s is in front (smaller z); faces point outward
        const a = P(s, i);
        const b = P(s, i + 1);
        const c = P(s + 1, i + 1);
        const d = P(s + 1, i);
        this.quad(a, b, c, d);
      }
    }
    const cap = (s: number, front: boolean) => {
      const sec = sections[s];
      const contour: Vector2[] = [];
      for (let i = 0; i < n; i++) contour.push(new Vector2(sec.pts[i * 2], sec.pts[i * 2 + 1]));
      const tris = ShapeUtils.triangulateShape(contour, []);
      for (const t of tris) {
        const a = new Vector3(contour[t[0]].x, contour[t[0]].y, sec.z);
        const b = new Vector3(contour[t[1]].x, contour[t[1]].y, sec.z);
        const c = new Vector3(contour[t[2]].x, contour[t[2]].y, sec.z);
        // make the cap face -z (front) or +z (rear)
        _a.subVectors(b, a);
        _b.subVectors(c, a);
        _c.crossVectors(_a, _b);
        const facesFront = _c.z < 0;
        if (facesFront === front) this.tri(a, b, c);
        else this.tri(a, c, b);
      }
    };
    if (capStart) cap(0, true);
    if (capEnd) cap(sections.length - 1, false);
  }

  /**
   * Cylinder along X from x0 to x1 (wheels, drums, rollers): smooth sides, flat caps.
   * `aux` per vertex lets wheels carry their axle for rotation.
   */
  cylinderX(x0: number, x1: number, cy: number, cz: number, r: number, segs: number, caps = true, aux?: number[]): void {
    for (let i = 0; i < segs; i++) {
      const t0 = (i / segs) * Math.PI * 2;
      const t1 = ((i + 1) / segs) * Math.PI * 2;
      const y0 = Math.cos(t0);
      const z0 = Math.sin(t0);
      const y1 = Math.cos(t1);
      const z1 = Math.sin(t1);
      this.vertex(x0, cy + y0 * r, cz + z0 * r, 0, y0, z0, aux);
      this.vertex(x1, cy + y1 * r, cz + z1 * r, 0, y1, z1, aux);
      this.vertex(x1, cy + y0 * r, cz + z0 * r, 0, y0, z0, aux);
      this.vertex(x0, cy + y0 * r, cz + z0 * r, 0, y0, z0, aux);
      this.vertex(x0, cy + y1 * r, cz + z1 * r, 0, y1, z1, aux);
      this.vertex(x1, cy + y1 * r, cz + z1 * r, 0, y1, z1, aux);
      if (caps) {
        this.vertex(x1, cy, cz, 1, 0, 0, aux);
        this.vertex(x1, cy + y0 * r, cz + z0 * r, 1, 0, 0, aux);
        this.vertex(x1, cy + y1 * r, cz + z1 * r, 1, 0, 0, aux);
        this.vertex(x0, cy, cz, -1, 0, 0, aux);
        this.vertex(x0, cy + y1 * r, cz + z1 * r, -1, 0, 0, aux);
        this.vertex(x0, cy + y0 * r, cz + z0 * r, -1, 0, 0, aux);
      }
    }
  }

  /** Disc facing ±X (hub caps, wheel faces). */
  discX(x: number, cy: number, cz: number, r: number, segs: number, facing: 1 | -1, aux?: number[]): void {
    for (let i = 0; i < segs; i++) {
      const t0 = (i / segs) * Math.PI * 2;
      const t1 = ((i + 1) / segs) * Math.PI * 2;
      const a0 = cy + Math.cos(t0) * r;
      const b0 = cz + Math.sin(t0) * r;
      const a1 = cy + Math.cos(t1) * r;
      const b1 = cz + Math.sin(t1) * r;
      if (facing > 0) {
        this.vertex(x, cy, cz, 1, 0, 0, aux);
        this.vertex(x, a0, b0, 1, 0, 0, aux);
        this.vertex(x, a1, b1, 1, 0, 0, aux);
      } else {
        this.vertex(x, cy, cz, -1, 0, 0, aux);
        this.vertex(x, a1, b1, -1, 0, 0, aux);
        this.vertex(x, a0, b0, -1, 0, 0, aux);
      }
    }
  }

  /**
   * Tapered tube along Z from (cx, cy, z0) radius r0 to z1 radius r1 (gun barrels, tanks).
   * z0 < z1. Smooth sides; caps optional.
   */
  tubeZ(cx: number, cy: number, z0: number, z1: number, r0: number, r1: number, segs: number, capFront = true, capRear = true, ry = 1): void {
    const slope = (r0 - r1) / (z1 - z0);
    for (let i = 0; i < segs; i++) {
      const t0 = (i / segs) * Math.PI * 2;
      const t1 = ((i + 1) / segs) * Math.PI * 2;
      const c0 = Math.cos(t0);
      const s0 = Math.sin(t0);
      const c1 = Math.cos(t1);
      const s1 = Math.sin(t1);
      const n0 = _a.set(c0, s0 * ry, slope).normalize().clone();
      const n1 = _b.set(c1, s1 * ry, slope).normalize().clone();
      this.vertex(cx + c0 * r0, cy + s0 * r0 * ry, z0, n0.x, n0.y, n0.z);
      this.vertex(cx + c1 * r1, cy + s1 * r1 * ry, z1, n1.x, n1.y, n1.z);
      this.vertex(cx + c0 * r1, cy + s0 * r1 * ry, z1, n0.x, n0.y, n0.z);
      this.vertex(cx + c0 * r0, cy + s0 * r0 * ry, z0, n0.x, n0.y, n0.z);
      this.vertex(cx + c1 * r0, cy + s1 * r0 * ry, z0, n1.x, n1.y, n1.z);
      this.vertex(cx + c1 * r1, cy + s1 * r1 * ry, z1, n1.x, n1.y, n1.z);
      if (capFront) {
        this.vertex(cx, cy, z0, 0, 0, -1);
        this.vertex(cx + c1 * r0, cy + s1 * r0 * ry, z0, 0, 0, -1);
        this.vertex(cx + c0 * r0, cy + s0 * r0 * ry, z0, 0, 0, -1);
      }
      if (capRear) {
        this.vertex(cx, cy, z1, 0, 0, 1);
        this.vertex(cx + c0 * r1, cy + s0 * r1 * ry, z1, 0, 0, 1);
        this.vertex(cx + c1 * r1, cy + s1 * r1 * ry, z1, 0, 0, 1);
      }
    }
  }

  /** Vertical cylinder (cupolas, hatches, posts) from y0 to y1. */
  cylinderY(cx: number, cz: number, y0: number, y1: number, r: number, segs: number, capTop = true): void {
    for (let i = 0; i < segs; i++) {
      const t0 = (i / segs) * Math.PI * 2;
      const t1 = ((i + 1) / segs) * Math.PI * 2;
      const x0 = Math.cos(t0);
      const z0 = Math.sin(t0);
      const x1 = Math.cos(t1);
      const z1 = Math.sin(t1);
      this.vertex(cx + x0 * r, y0, cz + z0 * r, x0, 0, z0);
      this.vertex(cx + x0 * r, y1, cz + z0 * r, x0, 0, z0);
      this.vertex(cx + x1 * r, y1, cz + z1 * r, x1, 0, z1);
      this.vertex(cx + x0 * r, y0, cz + z0 * r, x0, 0, z0);
      this.vertex(cx + x1 * r, y1, cz + z1 * r, x1, 0, z1);
      this.vertex(cx + x1 * r, y0, cz + z1 * r, x1, 0, z1);
      if (capTop) {
        this.vertex(cx, y1, cz, 0, 1, 0);
        this.vertex(cx + x1 * r, y1, cz + z1 * r, 0, 1, 0);
        this.vertex(cx + x0 * r, y1, cz + z0 * r, 0, 1, 0);
      }
    }
  }

  /**
   * Smooth dome over an ellipse-like footprint: `radiusAt(theta)` gives the horizontal radius
   * at the base for azimuth theta (0 = forward, -Z; π/2 = right, +X); the profile follows a
   * superellipse so the dome is low and wide (cast tank turrets).
   */
  dome(cx: number, cz: number, y0: number, height: number, radiusAt: (theta: number) => number, segs: number, rings: number, shape = 0.55): void {
    const pt = (ti: number, ri: number, out: Vector3) => {
      const th = (ti / segs) * Math.PI * 2;
      const u = ri / rings; // 0 base … 1 top
      const ang = u * Math.PI * 0.5;
      const horiz = Math.pow(Math.cos(ang), shape);
      const vert = Math.pow(Math.sin(ang), 1 / (1 + shape));
      const r = radiusAt(th) * horiz;
      return out.set(cx + Math.sin(th) * r, y0 + vert * height, cz - Math.cos(th) * r);
    };
    const P = new Vector3();
    const grid: Vector3[][] = [];
    for (let ri = 0; ri <= rings; ri++) {
      const row: Vector3[] = [];
      for (let ti = 0; ti <= segs; ti++) row.push(pt(ti, ri, P).clone());
      grid.push(row);
    }
    // smooth normals from the grid
    const normal = (ri: number, ti: number) => {
      const tPrev = grid[ri][(ti - 1 + segs) % segs];
      const tNext = grid[ri][(ti + 1) % segs];
      const rPrev = grid[Math.max(0, ri - 1)][ti];
      const rNext = grid[Math.min(rings, ri + 1)][ti];
      _e1.subVectors(tNext, tPrev);
      _e2.subVectors(rNext, rPrev);
      const n = new Vector3().crossVectors(_e2, _e1).normalize();
      if (ri === rings) n.set(0, 1, 0);
      return n;
    };
    for (let ri = 0; ri < rings; ri++) {
      for (let ti = 0; ti < segs; ti++) {
        const a = grid[ri][ti];
        const b = grid[ri][ti + 1];
        const c = grid[ri + 1][ti + 1];
        const d = grid[ri + 1][ti];
        const na = normal(ri, ti % segs);
        const nb = normal(ri, (ti + 1) % segs);
        const nc = normal(ri + 1, (ti + 1) % segs);
        const nd = normal(ri + 1, ti % segs);
        // outward winding: a, d, c and a, c, b (seen from outside)
        this.vertex(a.x, a.y, a.z, na.x, na.y, na.z);
        this.vertex(d.x, d.y, d.z, nd.x, nd.y, nd.z);
        this.vertex(c.x, c.y, c.z, nc.x, nc.y, nc.z);
        this.vertex(a.x, a.y, a.z, na.x, na.y, na.z);
        this.vertex(c.x, c.y, c.z, nc.x, nc.y, nc.z);
        this.vertex(b.x, b.y, b.z, nb.x, nb.y, nb.z);
      }
    }
  }

  /**
   * A track belt: a closed path of (y, z) points around the wheels (listed going FORWARD along
   * the bottom run: increasing z is rearward), extruded from x0 to x1 with thickness `thick`
   * inward. aAux.x carries the distance along the loop (for the moving link pattern).
   */
  trackLoop(x0: number, x1: number, pathIn: Vector2[], thick: number, part: number): void {
    // work on a counter-clockwise loop in the (y, z) plane: then the faces below wind outward
    let area0 = 0;
    for (let i = 0; i < pathIn.length; i++) {
      const p = pathIn[i];
      const q = pathIn[(i + 1) % pathIn.length];
      area0 += p.x * q.y - q.x * p.y;
    }
    const path = area0 > 0 ? pathIn : pathIn.slice().reverse();
    // counter-clockwise, the bottom run goes forward (-z); the link pattern must run rearward
    // along it as the vehicle drives, so the loop coordinate is stored negated
    const dir = -1;
    const n = path.length;
    // cumulative distance
    const dist: number[] = [0];
    for (let i = 1; i <= n; i++) dist.push(dist[i - 1] + path[i % n].distanceTo(path[i - 1]));
    // outward normals per point (2-D, from the polygon's orientation)
    let area = 0;
    for (let i = 0; i < n; i++) {
      const p = path[i];
      const q = path[(i + 1) % n];
      area += p.x * q.y - q.x * p.y;
    }
    const sign = area > 0 ? 1 : -1;
    const outN: Vector2[] = [];
    for (let i = 0; i < n; i++) {
      const prev = path[(i - 1 + n) % n];
      const next = path[(i + 1) % n];
      const t = new Vector2().subVectors(next, prev).normalize();
      // (y, z) plane: outward = rotate tangent
      outN.push(new Vector2(t.y, -t.x).multiplyScalar(sign));
    }
    const aux = (s: number) => [dir * s, 0, 0, part];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p = path[i];
      const q = path[j];
      const np = outN[i];
      const nq = outN[j];
      const s0 = dist[i];
      const s1 = dist[i + 1];
      const pin = new Vector2(p.x - np.x * thick, p.y - np.y * thick);
      const qin = new Vector2(q.x - nq.x * thick, q.y - nq.y * thick);
      // outer surface (y = .x of the Vector2, z = .y)
      this.vertex(x0, p.x, p.y, 0, np.x, np.y, aux(s0));
      this.vertex(x1, q.x, q.y, 0, nq.x, nq.y, aux(s1));
      this.vertex(x1, p.x, p.y, 0, np.x, np.y, aux(s0));
      this.vertex(x0, p.x, p.y, 0, np.x, np.y, aux(s0));
      this.vertex(x0, q.x, q.y, 0, nq.x, nq.y, aux(s1));
      this.vertex(x1, q.x, q.y, 0, nq.x, nq.y, aux(s1));
      // inner surface
      this.vertex(x0, pin.x, pin.y, 0, -np.x, -np.y, aux(s0));
      this.vertex(x1, pin.x, pin.y, 0, -np.x, -np.y, aux(s0));
      this.vertex(x1, qin.x, qin.y, 0, -nq.x, -nq.y, aux(s1));
      this.vertex(x0, pin.x, pin.y, 0, -np.x, -np.y, aux(s0));
      this.vertex(x1, qin.x, qin.y, 0, -nq.x, -nq.y, aux(s1));
      this.vertex(x0, qin.x, qin.y, 0, -nq.x, -nq.y, aux(s1));
      // the two side edges
      for (const [x, nx] of [
        [x1, 1],
        [x0, -1],
      ] as const) {
        const flip = nx > 0;
        const v = [
          [x, p.x, p.y, s0],
          [x, q.x, q.y, s1],
          [x, qin.x, qin.y, s1],
          [x, pin.x, pin.y, s0],
        ];
        const order = flip === sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
        for (const k of order) this.vertex(v[k][0], v[k][1], v[k][2], nx, 0, 0, aux(v[k][3]));
      }
    }
  }

  /** Number of vertices so far. */
  get vertexCount(): number {
    return this.pos.length / 3;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    g.setAttribute('aZone', new Float32BufferAttribute(this.zone, 4));
    g.setAttribute('aAux', new Float32BufferAttribute(this.aux, 4));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Rotation about Y by `a` rad (for placing parts). */
export function rotY(a: number): Matrix4 {
  return new Matrix4().makeRotationY(a);
}

export function translate(x: number, y: number, z: number): Matrix4 {
  return new Matrix4().makeTranslation(x, y, z);
}
