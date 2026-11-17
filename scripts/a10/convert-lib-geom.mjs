/**
 * Geometry core of the A-10 model converter (scripts/a10/convert-ac3d.mjs): affine transforms,
 * Newell normals, AC3D/OSG crease smoothing, ear-clipping triangulation, vertex welding and a
 * small vertex-clustering simplifier.
 */
import { ShapeUtils, Vector2 } from 'three';

// ---------------------------------------------------------------------------------------------
// 3×4 affine transforms { R: number[9] row-major, t: number[3] }, p' = R p + t
// ---------------------------------------------------------------------------------------------

export const IDENTITY = Object.freeze({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });

/** a ∘ b (apply b first). */
export function compose(a, b) {
  const R = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      R[r * 3 + c] =
        a.R[r * 3] * b.R[c] + a.R[r * 3 + 1] * b.R[3 + c] + a.R[r * 3 + 2] * b.R[6 + c];
  const t = [
    a.R[0] * b.t[0] + a.R[1] * b.t[1] + a.R[2] * b.t[2] + a.t[0],
    a.R[3] * b.t[0] + a.R[4] * b.t[1] + a.R[5] * b.t[2] + a.t[1],
    a.R[6] * b.t[0] + a.R[7] * b.t[1] + a.R[8] * b.t[2] + a.t[2],
  ];
  return { R, t };
}

export function applyPoint(m, x, y, z, out = [0, 0, 0]) {
  out[0] = m.R[0] * x + m.R[1] * y + m.R[2] * z + m.t[0];
  out[1] = m.R[3] * x + m.R[4] * y + m.R[5] * z + m.t[1];
  out[2] = m.R[6] * x + m.R[7] * y + m.R[8] * z + m.t[2];
  return out;
}

export function applyDir(m, x, y, z, out = [0, 0, 0]) {
  out[0] = m.R[0] * x + m.R[1] * y + m.R[2] * z;
  out[1] = m.R[3] * x + m.R[4] * y + m.R[5] * z;
  out[2] = m.R[6] * x + m.R[7] * y + m.R[8] * z;
  return out;
}

/** AC file axes → FlightGear model axes: x_fg = x_ac, y_fg = −z_ac, z_fg = y_ac. */
export const AC_TO_FG = Object.freeze({ R: [1, 0, 0, 0, 0, -1, 0, 1, 0], t: [0, 0, 0] });

/** FlightGear model point → our BODY frame (origin R = FG (7.65, 0, 0.30)). */
export const FG_ORIGIN = [7.65, 0, 0.3];
export const FG_TO_BODY = Object.freeze({
  R: [0, 1, 0, 0, 0, 1, 1, 0, 0],
  t: [0, -FG_ORIGIN[2], -FG_ORIGIN[0]],
});
/** FlightGear axes → BODY axes without the origin shift (stores use their own origin). */
export const FG_TO_BODY_AXES = Object.freeze({ R: [0, 1, 0, 0, 0, 1, 1, 0, 0], t: [0, 0, 0] });

const D2R = Math.PI / 180;

function rotX(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { R: [1, 0, 0, 0, c, -s, 0, s, c], t: [0, 0, 0] };
}
function rotY(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { R: [c, 0, s, 0, 1, 0, -s, 0, c], t: [0, 0, 0] };
}
function rotZ(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { R: [c, -s, 0, s, c, 0, 0, 0, 1], t: [0, 0, 0] };
}

/**
 * FlightGear sub-model <offsets> (FG axes, degrees): v' = Rz(h)·Rx(r)·Ry(p)·v + (x, y, z).
 * Pitch is applied first, then roll, then heading; all right-handed about the parent's axes.
 */
export function offsetsTransform(o) {
  const R = compose(
    rotZ((o.h ?? 0) * D2R),
    compose(rotX((o.r ?? 0) * D2R), rotY((o.p ?? 0) * D2R)),
  );
  R.t = [o.x ?? 0, o.y ?? 0, o.z ?? 0];
  return R;
}

/** Rotation by angle about an arbitrary unit axis (Rodrigues), as an affine with no translation. */
export function axisAngle(ax, ay, az, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const k = 1 - c;
  return {
    R: [
      c + ax * ax * k,
      ax * ay * k - az * s,
      ax * az * k + ay * s,
      ay * ax * k + az * s,
      c + ay * ay * k,
      ay * az * k - ax * s,
      az * ax * k - ay * s,
      az * ay * k + ax * s,
      c + az * az * k,
    ],
    t: [0, 0, 0],
  };
}

/** Rotation about an axis through a centre. */
export function rotateAbout(centre, axis, angle) {
  const r = axisAngle(axis[0], axis[1], axis[2], angle);
  const c = centre;
  const rc = applyDir(r, c[0], c[1], c[2]);
  r.t = [c[0] - rc[0], c[1] - rc[1], c[2] - rc[2]];
  return r;
}

export function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// ---------------------------------------------------------------------------------------------
// Polygon processing
// ---------------------------------------------------------------------------------------------

/** Newell normal (unnormalised; length = 2 × area) of polygon P (flat xyz array, indices). */
function newell(pos, refs) {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const n = refs.length;
  for (let i = 0; i < n; i++) {
    const a = refs[i] * 3;
    const b = refs[(i + 1) % n] * 3;
    nx += (pos[a + 1] - pos[b + 1]) * (pos[a + 2] + pos[b + 2]);
    ny += (pos[a + 2] - pos[b + 2]) * (pos[a] + pos[b]);
    nz += (pos[a] - pos[b]) * (pos[a + 1] + pos[b + 1]);
  }
  return [nx, ny, nz];
}

const _v2pool = [];
function v2(i, x, y) {
  let v = _v2pool[i];
  if (!v) v = _v2pool[i] = new Vector2();
  v.set(x, y);
  return v;
}

/**
 * Triangulate a polygon (indices into pos) in the plane of its Newell normal. Returns local
 * corner index triples (0..n-1), oriented like the polygon (CCW about n).
 */
export function triangulatePolygon(pos, refs, n) {
  const count = refs.length;
  if (count === 3) return [[0, 1, 2]];
  // plane basis
  const nl = Math.hypot(n[0], n[1], n[2]);
  const nx = n[0] / nl;
  const ny = n[1] / nl;
  const nz = n[2] / nl;
  let ux;
  let uy;
  let uz;
  if (Math.abs(nx) < 0.9) {
    // u = x × n... use cross(n, X)
    ux = 0;
    uy = nz;
    uz = -ny;
  } else {
    ux = -nz;
    uy = 0;
    uz = nx;
  }
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  // v = n × u
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;
  const contour = [];
  for (let i = 0; i < count; i++) {
    const p = refs[i] * 3;
    const x = pos[p];
    const y = pos[p + 1];
    const z = pos[p + 2];
    contour.push(v2(i, x * ux + y * uy + z * uz, x * vx + y * vy + z * vz));
  }
  let tris = [];
  if (count === 4 && isConvex(contour)) {
    // split along the shorter diagonal
    const d02 = contour[0].distanceToSquared(contour[2]);
    const d13 = contour[1].distanceToSquared(contour[3]);
    tris =
      d02 <= d13
        ? [
            [0, 1, 2],
            [0, 2, 3],
          ]
        : [
            [0, 1, 3],
            [1, 2, 3],
          ];
  } else {
    // ShapeUtils may drop a closing duplicate point; give it a copy
    const copy = contour.slice();
    try {
      tris = ShapeUtils.triangulateShape(copy, []);
    } catch {
      tris = [];
    }
    if (tris.length < count - 2) {
      // degenerate projection: fall back to a fan, which is what a renderer would do
      const fan = [];
      for (let i = 1; i < count - 1; i++) fan.push([0, i, i + 1]);
      if (tris.length === 0) tris = fan;
    }
  }
  // orient every triangle like the polygon normal
  const out = [];
  for (const t of tris) {
    const a = refs[t[0]] * 3;
    const b = refs[t[1]] * 3;
    const c = refs[t[2]] * 3;
    const e1x = pos[b] - pos[a];
    const e1y = pos[b + 1] - pos[a + 1];
    const e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a];
    const e2y = pos[c + 1] - pos[a + 1];
    const e2z = pos[c + 2] - pos[a + 2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    if (cx * nx + cy * ny + cz * nz < 0) out.push([t[0], t[2], t[1]]);
    else out.push([t[0], t[1], t[2]]);
  }
  return out;
}

function isConvex(c) {
  let sign = 0;
  const n = c.length;
  for (let i = 0; i < n; i++) {
    const a = c[i];
    const b = c[(i + 1) % n];
    const d = c[(i + 2) % n];
    const cross = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
    if (Math.abs(cross) < 1e-14) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Build triangle geometry for one AC object.
 * @param {object} obj parsed AC object
 * @param {object} xf affine AC-local → output frame (proper rotation + translation)
 * @param {object} [opts] { crease default 61 }
 * @returns {{ groups: Map<string, {mat:number, twoSided:boolean, pos:number[], nrm:number[], uv:number[], idx:number[]}>,
 *   triangles: number, bbox: {min:number[], max:number[]}, centroid: number[], degenerate: number }}
 */
export function buildObjectGeometry(obj, xf, opts = {}) {
  const nv = obj.verts.length / 3;
  const pos = new Float64Array(nv * 3);
  const tmp = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) {
    applyPoint(xf, obj.verts[i * 3], obj.verts[i * 3 + 1], obj.verts[i * 3 + 2], tmp);
    pos[i * 3] = tmp[0];
    pos[i * 3 + 1] = tmp[1];
    pos[i * 3 + 2] = tmp[2];
  }
  const crease = obj.crease ?? opts.crease ?? 61;
  const cosc = crease >= 180 ? -2 : crease <= 0 ? 1 : Math.cos(crease * D2R);
  const rep = obj.texrep ?? [1, 1];
  const off = obj.texoff ?? [0, 0];

  // faces
  const faces = [];
  let degenerate = 0;
  for (const s of obj.surfs) {
    if ((s.flags & 0xf) !== 0) continue; // lines
    if (!s.refs || s.refs.length < 3) continue;
    const n = newell(pos, s.refs);
    const len = Math.hypot(n[0], n[1], n[2]);
    // zero-area: below 1e-10 m² (0.01 mm²)
    if (len < 2e-10) {
      degenerate++;
      continue;
    }
    faces.push({ s, n, len });
  }

  // smoothing sets per vertex index (only smooth faces take part)
  const vertFaces = new Map();
  for (let f = 0; f < faces.length; f++) {
    const { s } = faces[f];
    if (!(s.flags & 0x10)) continue;
    for (let k = 0; k < s.refs.length; k++) {
      const vi = s.refs[k];
      let l = vertFaces.get(vi);
      if (!l) vertFaces.set(vi, (l = []));
      if (l[l.length - 1] !== f) l.push(f);
    }
  }
  /** (vi * faces.length + f) → normal [x,y,z] */
  const smoothN = new Map();
  for (const [vi, fl] of vertFaces) {
    const m = fl.length;
    const set = new Int32Array(m).fill(-1);
    let sets = 0;
    for (let a = 0; a < m; a++) {
      if (set[a] >= 0) continue;
      set[a] = sets;
      const stack = [a];
      while (stack.length) {
        const g = stack.pop();
        const fg = faces[fl[g]];
        for (let h = 0; h < m; h++) {
          if (set[h] >= 0) continue;
          const fh = faces[fl[h]];
          const dot = fg.n[0] * fh.n[0] + fg.n[1] * fh.n[1] + fg.n[2] * fh.n[2];
          if (cosc * fg.len * fh.len <= dot) {
            set[h] = sets;
            stack.push(h);
          }
        }
      }
      sets++;
    }
    const sums = new Float64Array(sets * 3);
    for (let a = 0; a < m; a++) {
      const fn = faces[fl[a]].n;
      sums[set[a] * 3] += fn[0];
      sums[set[a] * 3 + 1] += fn[1];
      sums[set[a] * 3 + 2] += fn[2];
    }
    for (let a = 0; a < m; a++) {
      const k = set[a] * 3;
      smoothN.set(vi * faces.length + fl[a], normalize3([sums[k], sums[k + 1], sums[k + 2]]));
    }
  }

  const groups = new Map();
  let triangles = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let area = 0;
  for (let f = 0; f < faces.length; f++) {
    const { s, n, len } = faces[f];
    const twoSided = (s.flags & 0x20) !== 0;
    const key = `${s.mat}|${twoSided ? 1 : 0}`;
    let g = groups.get(key);
    if (!g) {
      g = { mat: s.mat, twoSided, pos: [], nrm: [], uv: [], idx: [], weld: new Map() };
      groups.set(key, g);
    }
    const flatN = [n[0] / len, n[1] / len, n[2] / len];
    const smooth = (s.flags & 0x10) !== 0;
    const corner = new Array(s.refs.length);
    for (let k = 0; k < s.refs.length; k++) {
      const vi = s.refs[k];
      const nn = smooth ? smoothN.get(vi * faces.length + f) : flatN;
      const u = s.uvs[k * 2] * rep[0] + off[0];
      const v = 1 - (s.uvs[k * 2 + 1] * rep[1] + off[1]);
      const wkey = `${vi}|${nn[0].toFixed(5)},${nn[1].toFixed(5)},${nn[2].toFixed(5)}|${u.toFixed(6)},${v.toFixed(6)}`;
      let id = g.weld.get(wkey);
      if (id === undefined) {
        id = g.pos.length / 3;
        g.weld.set(wkey, id);
        g.pos.push(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
        g.nrm.push(nn[0], nn[1], nn[2]);
        g.uv.push(u, v);
      }
      corner[k] = id;
    }
    const tris = triangulatePolygon(pos, s.refs, n);
    for (const t of tris) {
      g.idx.push(corner[t[0]], corner[t[1]], corner[t[2]]);
      triangles++;
    }
    // area-weighted centroid (polygon vertex mean × area)
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let k = 0; k < s.refs.length; k++) {
      const p = s.refs[k] * 3;
      mx += pos[p];
      my += pos[p + 1];
      mz += pos[p + 2];
    }
    const a = len / 2;
    cx += (mx / s.refs.length) * a;
    cy += (my / s.refs.length) * a;
    cz += (mz / s.refs.length) * a;
    area += a;
  }
  for (const g of groups.values()) {
    for (let i = 0; i < g.pos.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        if (g.pos[i + c] < min[c]) min[c] = g.pos[i + c];
        if (g.pos[i + c] > max[c]) max[c] = g.pos[i + c];
      }
    }
    delete g.weld;
  }
  return {
    groups,
    triangles,
    bbox: { min, max },
    centroid: area > 0 ? [cx / area, cy / area, cz / area] : [0, 0, 0],
    area,
    degenerate,
  };
}

/**
 * Vertex-clustering simplification of one group (in place): vertices snap to a grid cell
 * representative (the first vertex seen in the cell); collapsed triangles are dropped.
 * Normals are re-averaged per cell. Used for tiny, over-detailed parts (cockpit screws, knobs).
 */
export function simplifyGroup(g, cell) {
  const n = g.pos.length / 3;
  const cellOf = new Map();
  const remap = new Int32Array(n);
  const pos = [];
  const nrm = [];
  const uv = [];
  for (let i = 0; i < n; i++) {
    const kx = Math.floor(g.pos[i * 3] / cell);
    const ky = Math.floor(g.pos[i * 3 + 1] / cell);
    const kz = Math.floor(g.pos[i * 3 + 2] / cell);
    const key = `${kx},${ky},${kz}`;
    let id = cellOf.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      cellOf.set(key, id);
      pos.push(g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]);
      nrm.push(0, 0, 0);
      uv.push(g.uv[i * 2], g.uv[i * 2 + 1]);
    }
    nrm[id * 3] += g.nrm[i * 3];
    nrm[id * 3 + 1] += g.nrm[i * 3 + 1];
    nrm[id * 3 + 2] += g.nrm[i * 3 + 2];
    remap[i] = id;
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
    nrm[i] /= l;
    nrm[i + 1] /= l;
    nrm[i + 2] /= l;
  }
  const idx = [];
  const seen = new Set();
  for (let t = 0; t < g.idx.length; t += 3) {
    const a = remap[g.idx[t]];
    const b = remap[g.idx[t + 1]];
    const c = remap[g.idx[t + 2]];
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    idx.push(a, b, c);
  }
  g.pos = pos;
  g.nrm = nrm;
  g.uv = uv;
  g.idx = idx;
}
