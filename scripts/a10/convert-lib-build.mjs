/**
 * Geometry built in code for parts the FlightGear package does not have (scripts/a10/
 * convert-ac3d.mjs): the altimeter (its model lives in FGData, not in the package), the GBU-12
 * Paveway II guidance and wing kits for the Mk-82 body, and the LAU-117 single-rail launcher.
 *
 * Builders write FlightGear-frame coordinates (x aft, y right, z up) with faces wound
 * counter-clockwise seen from outside, and return AC-like objects (AC file axes: x aft, y up,
 * z left) so they go through exactly the same pipeline as the converted files.
 */

/** FG point → AC file axes. */
function fgToAc(p) {
  return [p[0], p[2], -p[1]];
}

/**
 * An AC-like poly object.
 * @param {string} name
 * @param {{verts:number[][], faces:number[][]}} part FG coordinates
 * @param {object} o { mat, smooth, twoSided, crease }
 */
export function acObject(name, part, o = {}) {
  const v = new Float64Array(part.verts.length * 3);
  part.verts.forEach((p, i) => v.set(fgToAc(p), i * 3));
  const flags = (o.smooth ? 0x10 : 0) | (o.twoSided ? 0x20 : 0);
  return {
    type: 'poly',
    name,
    line: 0,
    data: null,
    texture: null,
    texrep: null,
    texoff: null,
    crease: o.crease ?? 50,
    loc: null,
    rot: null,
    url: null,
    verts: v,
    surfs: part.faces.map((f) => ({
      flags,
      mat: o.mat ?? 0,
      refs: Int32Array.from(f),
      uvs: new Float64Array(f.length * 2),
      line: 0,
    })),
    kids: [],
  };
}

/**
 * Surface of revolution about the FG x axis. profile: [[x, r]…]; the surface faces outward
 * when x increases along the profile (and toward −x where r increases at constant x).
 */
export function lathe(profile, segments = 16, { capStart = false, capEnd = false } = {}) {
  const N = segments;
  const verts = [];
  const faces = [];
  for (const [x, r] of profile)
    for (let s = 0; s < N; s++) {
      const a = (s / N) * Math.PI * 2;
      verts.push([x, r * Math.cos(a), r * Math.sin(a)]);
    }
  for (let i = 0; i < profile.length - 1; i++)
    for (let s = 0; s < N; s++) {
      const a = i * N + s;
      const b = i * N + ((s + 1) % N);
      const c = (i + 1) * N + ((s + 1) % N);
      const d = (i + 1) * N + s;
      faces.push([a, b, c, d]);
    }
  if (capStart) faces.push([...Array(N).keys()].reverse());
  const L = profile.length - 1;
  if (capEnd) faces.push([...Array(N).keys()].map((s) => L * N + s));
  return { verts, faces };
}

/** Axis-aligned box (FG). */
export function box(min, max) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    verts: [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
    faces: [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [2, 3, 7, 6],
      [1, 2, 6, 5],
      [0, 4, 7, 3],
    ],
  };
}

/**
 * A thin plate radiating from the x axis at roll angle `roll` (0 = +y, π/2 = +z). outline:
 * [[x, r]…] counter-clockwise in the (x, r) plane; thickness t.
 */
export function fin(outline, roll, t) {
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  const verts = [];
  for (const side of [-1, 1])
    for (const [x, r] of outline)
      verts.push([x, r * c - side * s * (t / 2), r * s + side * c * (t / 2)]);
  const n = outline.length;
  const faces = [[...Array(n).keys()].map((i) => n + i), [...Array(n).keys()].reverse()];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([i, j, n + j, n + i]);
  }
  return { verts, faces };
}

/** Concatenate parts. */
export function merge(...parts) {
  const verts = [];
  const faces = [];
  for (const p of parts) {
    const o = verts.length;
    verts.push(...p.verts);
    for (const f of p.faces) faces.push(f.map((i) => i + o));
  }
  return { verts, faces };
}

/** Plain AC materials: [name, rgb, spec, shininess, trans]. */
export function acMaterials(list) {
  return list.map(([name, rgb, spec = 0.2, shi = 20, trans = 0]) => ({
    name,
    rgb,
    amb: rgb,
    emis: [0, 0, 0],
    spec: [spec, spec, spec],
    shi,
    trans,
  }));
}

// ---------------------------------------------------------------------------------------------
// Altimeter stand-in. FG altimeter.xml animates objects named mount, face and needle; the dial
// centre is the sub-model origin, the face looks toward +x (the pilot) and the needle turns
// about −x (clockwise as the pilot sees it), pointing up at 0 ft.
// ---------------------------------------------------------------------------------------------
export function buildAltimeter() {
  const materials = acMaterials([
    ['bezel', [0.08, 0.08, 0.085], 0.3, 40],
    ['face', [0.025, 0.025, 0.025], 0.1, 10],
    ['marks', [0.85, 0.85, 0.82], 0.1, 10],
    ['needle', [0.92, 0.92, 0.9], 0.2, 20],
  ]);
  const kids = [];
  const plate = box([-0.012, -0.043, -0.043], [-0.004, 0.043, 0.043]);
  const ring = lathe(
    [
      [-0.004, 0.0405],
      [-0.001, 0.0405],
      [-0.001, 0.037],
      [-0.004, 0.037],
    ],
    32,
  );
  kids.push(acObject('mount', merge(plate, ring), { mat: 0 }));
  const face = lathe(
    [
      [-0.0038, 0.0],
      [-0.0038, 0.037],
    ],
    32,
  );
  face.faces = face.faces.map((f) => f.slice().reverse()); // toward +x
  kids.push(acObject('face', face, { mat: 1 }));
  const verts = [];
  const faces = [];
  for (let k = 0; k < 50; k++) {
    const a = (k / 50) * Math.PI * 2;
    const major = k % 5 === 0;
    const r0 = major ? 0.0285 : 0.0318;
    const w = major ? 0.0017 : 0.0008;
    const ry = Math.sin(a);
    const rz = Math.cos(a);
    const ty = Math.cos(a);
    const tz = -Math.sin(a);
    const x = -0.0034;
    const p = (r, side) => [x, ry * r + side * w * ty, rz * r + side * w * tz];
    const base = verts.length;
    verts.push(p(r0, -1), p(0.0362, -1), p(0.0362, 1), p(r0, 1));
    faces.push([base, base + 3, base + 2, base + 1]);
  }
  kids.push(acObject('marks', { verts, faces }, { mat: 2 }));
  kids.push(
    acObject(
      'needle',
      {
        verts: [
          [-0.002, -0.0015, -0.006],
          [-0.002, 0.0015, -0.006],
          [-0.002, 0.0008, 0.031],
          [-0.002, -0.0008, 0.031],
          [-0.002, 0, 0.0345],
        ],
        faces: [[0, 1, 2, 4, 3]],
      },
      { mat: 3 },
    ),
  );
  return { materials, kids };
}

// ---------------------------------------------------------------------------------------------
// GBU-12 Paveway II kit on the Mk-82 body (FG store frame: x aft, nose at −x; the Mk-82 nose
// fuze tip is at x = −1.11, its tail fins end at x = 1.05, body radius about 0.137 m). Overall
// length with the kit ≈ 3.3 m, wing span ≈ 1.2 m (published: 3.33 m, 1.32 m deployed).
// ---------------------------------------------------------------------------------------------
export function buildGbu12Kit() {
  const materials = acMaterials([
    ['kit_olive', [0.3, 0.32, 0.25], 0.15, 15],
    ['kit_dark', [0.1, 0.1, 0.095], 0.25, 20],
    ['seeker_glass', [0.05, 0.06, 0.08], 0.9, 100],
  ]);
  const kids = [];
  const ccg = lathe(
    [
      [-1.88, 0.0],
      [-1.86, 0.092],
      [-1.66, 0.092],
      [-1.62, 0.1],
      [-1.06, 0.1],
      [-0.99, 0.085],
    ],
    20,
  );
  // the profile runs aft, so this faces outward
  kids.push(acObject('GBU-12_Guidance', ccg, { mat: 0, smooth: true }));
  const head = lathe(
    [
      [-2.06, 0.058],
      [-2.02, 0.07],
      [-1.86, 0.07],
    ],
    20,
  );
  kids.push(acObject('GBU-12_Seeker', head, { mat: 1, smooth: true }));
  const ring = lathe(
    [
      [-1.97, 0.112],
      [-1.88, 0.12],
    ],
    20,
  );
  kids.push(acObject('GBU-12_SeekerRing', ring, { mat: 0, twoSided: true }));
  const dome = lathe(
    [
      [-2.08, 0.0],
      [-2.078, 0.03],
      [-2.07, 0.05],
      [-2.06, 0.058],
    ],
    20,
  );
  kids.push(acObject('GBU-12_SeekerGlass', dome, { mat: 2, smooth: true }));
  const canards = [];
  for (let k = 0; k < 4; k++)
    canards.push(
      fin(
        [
          [-1.6, 0.1],
          [-1.4, 0.1],
          [-1.47, 0.255],
          [-1.56, 0.255],
        ],
        Math.PI / 4 + (k * Math.PI) / 2,
        0.008,
      ),
    );
  kids.push(acObject('GBU-12_Canards', merge(...canards), { mat: 0 }));
  const tail = lathe(
    [
      [0.62, 0.127],
      [0.66, 0.13],
      [1.12, 0.1],
      [1.2, 0.085],
    ],
    20,
    { capEnd: true },
  );
  kids.push(acObject('GBU-12_Tail', tail, { mat: 0, smooth: true }));
  const wings = [];
  for (let k = 0; k < 4; k++)
    wings.push(
      fin(
        [
          [0.72, 0.12],
          [1.18, 0.09],
          [1.18, 0.6],
          [1.02, 0.6],
        ],
        Math.PI / 4 + (k * Math.PI) / 2,
        0.01,
      ),
    );
  kids.push(acObject('GBU-12_Wings', merge(...wings), { mat: 0 }));
  return { materials, kids };
}

// ---------------------------------------------------------------------------------------------
// LAU-117 single-rail Maverick launcher (FG store frame, origin at the top attach point, x aft).
// About 2.2 m long, 0.19 m wide, 0.21 m deep; the missile's hooks run in the rail underneath.
// ---------------------------------------------------------------------------------------------
export function buildLau117() {
  const materials = acMaterials([
    ['lau117_grey', [0.42, 0.44, 0.45], 0.2, 20],
    ['lau117_dark', [0.16, 0.16, 0.16], 0.2, 20],
  ]);
  // cross-sections: x, top half-width, bottom half-width, top z, bottom z
  const st = [
    [-1.12, 0.03, 0.02, -0.03, -0.12],
    [-1.0, 0.085, 0.06, 0.0, -0.2],
    [0.85, 0.095, 0.065, 0.0, -0.21],
    [1.05, 0.07, 0.05, -0.02, -0.16],
    [1.1, 0.04, 0.03, -0.04, -0.1],
  ];
  const verts = [];
  const faces = [];
  for (const [x, wt, wb, zt, zb] of st)
    verts.push([x, -wt, zt], [x, wt, zt], [x, wb, zb], [x, -wb, zb]);
  for (let i = 0; i < st.length - 1; i++)
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      faces.push([i * 4 + k, (i + 1) * 4 + k, (i + 1) * 4 + k2, i * 4 + k2]);
    }
  const L = (st.length - 1) * 4;
  faces.push([0, 1, 2, 3], [L + 3, L + 2, L + 1, L]);
  const kids = [acObject('LAU-117_Body', { verts, faces }, { mat: 0 })];
  kids.push(acObject('LAU-117_Rail', box([-0.95, -0.03, -0.235], [0.8, 0.03, -0.205]), { mat: 1 }));
  kids.push(
    acObject(
      'LAU-117_Lugs',
      merge(
        box([-0.2, -0.02, 0.0], [-0.14, 0.02, 0.035]),
        box([0.34, -0.02, 0.0], [0.4, 0.02, 0.035]),
      ),
      { mat: 1 },
    ),
  );
  return { materials, kids };
}
