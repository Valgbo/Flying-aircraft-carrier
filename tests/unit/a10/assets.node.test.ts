/**
 * Self-checks of the converted FlightGear A-10 (scripts/a10/convert-ac3d.mjs → public/a10/):
 * the GLB files are read with a small reader below, their pivots are posed from the meta file,
 * and the results are compared with the measurements of the conversion spec, data/geometry.ts and
 * CREDITS.md (PLAN_A10.md §3.1, §14, §16 "Assets"). CREDITS.md must list every file under
 * public/a10/models, public/a10/textures and public/a10/sounds.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { A10Meta, PivotMeta } from '../../../src/a10/assets/meta';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import { STORES } from '../../../src/a10/data/munitions';

const ROOT = resolve(__dirname, '../../..');
const PUB = join(ROOT, 'public/a10');
const MODELS = join(PUB, 'models');
const meta = JSON.parse(readFileSync(join(MODELS, 'a10-meta.json'), 'utf8')) as A10Meta;

// ---------------------------------------------------------------------------------------------
// minimal GLB reader
// ---------------------------------------------------------------------------------------------
interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extras?: Record<string, unknown>;
}
interface Gltf {
  json: {
    nodes: GltfNode[];
    meshes?: {
      primitives: { attributes: Record<string, number>; indices?: number; material?: number }[];
    }[];
    accessors: {
      bufferView?: number;
      byteOffset?: number;
      componentType: number;
      normalized?: boolean;
      count: number;
      type: string;
    }[];
    bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[];
    images?: { uri?: string }[];
    scenes: { nodes: number[] }[];
    extensionsRequired?: string[];
  };
  bin: Uint8Array;
}

function readGlb(file: string): Gltf {
  const b = readFileSync(file);
  expect(b.readUInt32LE(0)).toBe(0x46546c67);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8')) as Gltf['json'];
  const binStart = 20 + jsonLen;
  const bin =
    binStart < b.length
      ? new Uint8Array(b.buffer, b.byteOffset + binStart + 8, b.readUInt32LE(binStart))
      : new Uint8Array(0);
  return { json, bin };
}

const SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** An accessor as floats (normalised integers mapped back to −1..1 / 0..1). */
function readAccessor(g: Gltf, index: number): { data: Float64Array; n: number; count: number } {
  const a = g.json.accessors[index];
  const v = g.json.bufferViews[a.bufferView ?? 0];
  const n = COMPONENTS[a.type];
  const size = SIZE[a.componentType];
  const stride = v.byteStride ?? n * size;
  const dv = new DataView(
    g.bin.buffer,
    g.bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0),
  );
  const out = new Float64Array(a.count * n);
  for (let i = 0; i < a.count; i++)
    for (let c = 0; c < n; c++) {
      const o = i * stride + c * size;
      let x: number;
      switch (a.componentType) {
        case 5120:
          x = dv.getInt8(o);
          if (a.normalized) x = Math.max(x / 127, -1);
          break;
        case 5121:
          x = dv.getUint8(o);
          if (a.normalized) x /= 255;
          break;
        case 5122:
          x = dv.getInt16(o, true);
          if (a.normalized) x = Math.max(x / 32767, -1);
          break;
        case 5123:
          x = dv.getUint16(o, true);
          if (a.normalized) x /= 65535;
          break;
        case 5125:
          x = dv.getUint32(o, true);
          break;
        default:
          x = dv.getFloat32(o, true);
      }
      out[i * n + c] = x;
    }
  return { data: out, n, count: a.count };
}

interface Posed {
  g: Gltf;
  byName: Map<string, number>;
  parent: Int32Array;
  world: Matrix4[];
}

/** World matrices of every node, with pivot rotations/translations from `angles` (rad or m). */
function pose(g: Gltf, angles: Map<string, number> = new Map()): Posed {
  const nodes = g.json.nodes;
  const byName = new Map<string, number>();
  const parent = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => {
    if (n.name) byName.set(n.name, i);
    for (const c of n.children ?? []) parent[c] = i;
  });
  const world: Matrix4[] = new Array(nodes.length);
  const local = (i: number) => {
    const n = nodes[i];
    const t = new Vector3().fromArray(n.translation ?? [0, 0, 0]);
    const q = new Quaternion().fromArray(n.rotation ?? [0, 0, 0, 1]);
    const s = new Vector3().fromArray(n.scale ?? [1, 1, 1]);
    const pv = n.extras?.pivot as { type: string; axis: number[] } | undefined;
    const a = n.name ? angles.get(n.name) : undefined;
    if (pv && a !== undefined) {
      const axis = new Vector3().fromArray(pv.axis).normalize();
      if (pv.type === 'translate') t.addScaledVector(axis, a);
      else q.setFromAxisAngle(axis, a);
    }
    return new Matrix4().compose(t, q, s);
  };
  const visit = (i: number, m: Matrix4) => {
    world[i] = m.clone().multiply(local(i));
    for (const c of nodes[i].children ?? []) visit(c, world[i]);
  };
  for (const r of g.json.scenes[0].nodes) visit(r, new Matrix4());
  return { g, byName, parent, world };
}

/** World-space vertex positions of every mesh below a node. */
function pointsUnder(p: Posed, name: string): Vector3[] {
  const start = p.byName.get(name);
  expect(start, `node ${name}`).toBeDefined();
  const out: Vector3[] = [];
  const visit = (i: number) => {
    const n = p.g.json.nodes[i];
    if (n.mesh !== undefined)
      for (const prim of p.g.json.meshes![n.mesh].primitives) {
        const a = readAccessor(p.g, prim.attributes.POSITION);
        for (let k = 0; k < a.count; k++)
          out.push(
            new Vector3(a.data[k * 3], a.data[k * 3 + 1], a.data[k * 3 + 2]).applyMatrix4(
              p.world[i],
            ),
          );
      }
    for (const c of n.children ?? []) visit(c);
  };
  visit(start!);
  return out;
}

function triangles(g: Gltf): number {
  let t = 0;
  for (const m of g.json.meshes ?? [])
    for (const pr of m.primitives) t += g.json.accessors[pr.indices!].count / 3;
  return t;
}

function drive(p: PivotMeta, x: number): number {
  const d = p.drive;
  let y: number;
  if (d.table) {
    const t = d.table;
    if (x <= t[0][0]) y = t[0][1];
    else if (x >= t[t.length - 1][0]) y = t[t.length - 1][1];
    else {
      let i = 1;
      while (t[i][0] < x) i++;
      const [x0, y0] = t[i - 1];
      const [x1, y1] = t[i];
      y = y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  } else y = (d.gain ?? 0) * x + (d.offset ?? 0);
  return Math.min(d.max ?? Infinity, Math.max(d.min ?? -Infinity, y));
}

const exterior = readGlb(join(MODELS, 'a10-exterior.glb'));
const cockpit = readGlb(join(MODELS, 'a10-cockpit.glb'));
const pilot = readGlb(join(MODELS, 'a10-pilot.glb'));

const close = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number) => {
  for (let i = 0; i < b.length; i++)
    expect(Math.abs(a[i] - b[i]), `component ${i}: ${a[i]} vs ${b[i]}`).toBeLessThan(tol);
};

describe('converted A-10: files', () => {
  it('uses only extensions three.js loads, and every image exists', () => {
    for (const g of [exterior, cockpit, pilot]) {
      for (const e of g.json.extensionsRequired ?? [])
        expect(['KHR_mesh_quantization', 'KHR_texture_transform']).toContain(e);
      for (const im of g.json.images ?? []) expect(existsSync(join(MODELS, im.uri!))).toBe(true);
    }
    for (const s of Object.values(meta.stores)) {
      const g = readGlb(join(PUB, s.file));
      for (const im of g.json.images ?? [])
        expect(existsSync(join(PUB, s.file, '..', im.uri!))).toBe(true);
    }
  });

  it('keeps the download under 10 MB (models + textures)', () => {
    let total = 0;
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else total += statSync(p).size;
      }
    };
    walk(MODELS);
    walk(join(PUB, 'textures'));
    expect(total).toBeLessThan(10 * 1024 * 1024);
  });

  it('every file under public/a10/models, textures and sounds is credited in CREDITS.md', () => {
    const credits = readFileSync(join(ROOT, 'CREDITS.md'), 'utf8');
    const missing: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (!credits.includes('| `' + relative(ROOT, p).split('\\').join('/') + '` |'))
          missing.push(relative(ROOT, p));
      }
    };
    walk(MODELS);
    walk(join(PUB, 'textures'));
    walk(join(PUB, 'sounds'));
    expect(missing).toEqual([]);
  });

  it('credits every sound as sounds-credits.json says, and keeps its FlightGear original unchanged', () => {
    const credits = readFileSync(join(ROOT, 'CREDITS.md'), 'utf8');
    const json = JSON.parse(
      readFileSync(join(ROOT, 'scripts/a10/sounds-credits.json'), 'utf8'),
    ) as {
      files: Record<string, { original?: string; originalSha256?: string; changes: string }>;
    };
    const files = readdirSync(join(PUB, 'sounds'));
    expect(Object.keys(json.files).sort()).toEqual(files.sort());
    for (const [file, s] of Object.entries(json.files)) {
      const row = credits
        .split('\n')
        .find((l) => l.startsWith(`| \`public/a10/sounds/${file}\` |`));
      expect(row, file).toBeDefined();
      // regenerate the table with `node scripts/a10/convert-credits.mjs` when this fails
      expect(row, file).toContain(s.changes);
      if (!s.original) continue;
      expect(s.original.startsWith('third_party/flightgear-a10/Sounds/'), file).toBe(true);
      const sha = createHash('sha256')
        .update(readFileSync(join(ROOT, s.original)))
        .digest('hex');
      expect(sha, s.original).toBe(s.originalSha256);
      expect(row, file).toContain(sha);
      expect(row, file).toContain('GPL-2.0 (package COPYING)');
    }
  });

  it('keeps the original FlightGear files with the licence', () => {
    for (const f of [
      'COPYING',
      'README.md',
      'A-10-readme.txt',
      'SOURCE.md',
      'Models/A10-004-015l3.ac',
      'Models/A-10-model.xml',
    ])
      expect(existsSync(join(ROOT, 'third_party/flightgear-a10', f)), f).toBe(true);
  });
});

describe('converted A-10: exterior geometry', () => {
  const rest = pose(exterior);

  it('has the source triangle count (52,343 in the AC file, minus zero-area and hidden lamp faces)', () => {
    const t = triangles(exterior);
    expect(t).toBeGreaterThan(52343 * 0.99);
    expect(t).toBeLessThanOrEqual(52343);
  });

  it('matches the source dimensions within 1 %', () => {
    const pts = pointsUnder(rest, 'a10-exterior');
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of pts) {
      min.min(p);
      max.max(p);
    }
    // spec: X ±8.952 (strobes), Y −1.640…2.455, Z −7.816 (muzzle)…8.439 (tail light)
    const want = { min: [-8.952, -1.64, -7.816], max: [8.952, 2.455, 8.439] };
    const span = [17.904, 4.095, 16.255];
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(min.getComponent(c) - want.min[c])).toBeLessThan(span[c] * 0.01);
      expect(Math.abs(max.getComponent(c) - want.max[c])).toBeLessThan(span[c] * 0.01);
    }
    // the model is 16.26 m long like the real aircraft (gun muzzle to tail light: 16.25 m)
    expect(max.z - min.z).toBeGreaterThan(16.26 * 0.99);
    expect(max.z - min.z).toBeLessThan(16.26 * 1.01);
  });

  it('has every pivot of the meta file, named <target>__<channel>', () => {
    for (const [g, list] of [
      [exterior, meta.exterior.pivots],
      [cockpit, meta.cockpit.pivots],
      [pilot, meta.pilot.pivots],
    ] as const) {
      const names = new Set(g.json.nodes.map((n) => n.name));
      for (const p of list) {
        expect(names.has(p.node), p.node).toBe(true);
        expect(p.node).toMatch(/__/);
      }
    }
    const ext = new Set(meta.exterior.pivots.map((p) => p.node));
    for (const n of [
      'LUAileron__aileron',
      'LUAileron__speedbrake',
      'LLAileron__speedbrake',
      'RUAileron__aileron',
      'LElevator__elevator',
      'LRudder-L__rudder',
      'LIFlap-F__flap',
      'L-Wing-Slat__slat',
      'UC-LeftTop__retract',
      'UC-LeftLower__compress',
      'LEFan__fan',
      'REFan__fan',
      'Cannon__spin',
    ])
      expect(ext.has(n), n).toBe(true);
  });

  it('keeps the AC part names as nodes', () => {
    const names = new Set(exterior.json.nodes.map((n) => n.name));
    for (const n of [
      'Fuselage',
      'Fuselage__2',
      'L-Wing-T',
      'R-Wing-B',
      'LEFan',
      'Cannon',
      'UC-NoseTyre',
      'BCanopyGlass',
    ])
      expect(names.has(n), n).toBe(true);
  });

  it('spins the fans about axes through their hubs (< 5 mm)', () => {
    for (const fan of ['LEFan', 'REFan']) {
      const pts = pointsUnder(rest, `${fan}__fan`);
      const c = pts.reduce((a, p) => a.add(p), new Vector3()).divideScalar(pts.length);
      const pv = meta.exterior.pivots.find((p) => p.node === `${fan}__fan`)!;
      const axis = new Vector3().fromArray(pv.axis);
      const d = c.clone().sub(new Vector3().fromArray(pv.centre));
      const perp = d.sub(axis.clone().multiplyScalar(d.dot(axis)));
      expect(perp.length()).toBeLessThan(0.005);
    }
  });

  it('lowers the gear onto the measured contacts (gear down: within 1 cm of the spec)', () => {
    const angles = new Map<string, number>();
    for (const p of meta.exterior.pivots)
      if (/^gear/.test(p.drive.input ?? '')) angles.set(p.node, drive(p, 1));
    const down = pose(exterior, angles);
    // the tyre geometry lives under its wheel-spin pivot
    const spec = {
      'UC-NoseTyre__wheel': [0.31, -2.646, -4.796],
      'UC-LeftTyre__wheel': [-2.678, -2.712, 0.546],
      'UC-RightTyre__wheel': [2.678, -2.712, 0.546],
    };
    for (const [tyre, contact] of Object.entries(spec)) {
      const pts = pointsUnder(down, tyre);
      const low = pts.reduce((a, b) => (b.y < a.y ? b : a));
      expect(Math.abs(low.y - contact[1])).toBeLessThan(0.01);
      expect(Math.abs(low.z - contact[2])).toBeLessThan(0.03);
      const xs = pts.map((p) => p.x);
      expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - contact[0])).toBeLessThan(0.01);
    }
    // the meta file says the same
    close(meta.gear.contacts.nose.contact, spec['UC-NoseTyre__wheel'], 0.01);
    close(meta.gear.contacts.left.contact, spec['UC-LeftTyre__wheel'], 0.01);
    // retracted, the main wheels are up in their pods
    const up = pointsUnder(rest, 'UC-LeftTyre__wheel');
    expect(Math.min(...up.map((p) => p.y))).toBeGreaterThan(-1.3);
  });

  it('moves the control surfaces the way the simulation means them', () => {
    // part geometry is merged into its innermost pivot: measure the pivots' trailing edges
    const tip = (pivot: string, angles: Map<string, number>) => {
      const pts = pointsUnder(pose(exterior, angles), pivot);
      return pts.reduce((a, b) => (b.z > a.z ? b : a)); // aftmost point = trailing edge
    };
    const set = (input: string, x: number) => {
      const m = new Map<string, number>();
      for (const p of meta.exterior.pivots) if (p.drive.input === input) m.set(p.node, drive(p, x));
      return m;
    };
    const none = new Map<string, number>();
    // + aileron (roll right): left trailing edge down, right trailing edge up
    const restL = tip('LUAileron__speedbrake', none);
    const restR = tip('RUAileron__speedbrake', none);
    expect(tip('LUAileron__speedbrake', set('aileron', 1)).y).toBeLessThan(restL.y - 0.1);
    expect(tip('RUAileron__speedbrake', set('aileron', 1)).y).toBeGreaterThan(restR.y + 0.1);
    // + elevator: trailing edge up
    expect(tip('LElevator__elevator', set('elevator', 1)).y).toBeGreaterThan(
      tip('LElevator__elevator', none).y + 0.1,
    );
    // + rudder (nose right): trailing edges to the right
    expect(tip('LRudder-L__rudder', set('rudder', 1)).x).toBeGreaterThan(
      tip('LRudder-L__rudder', none).x + 0.1,
    );
    // speed brake: upper half up, lower half down, on both wings
    expect(tip('LUAileron__speedbrake', set('speedBrake', 1)).y).toBeGreaterThan(restL.y + 0.1);
    expect(tip('LLAileron__speedbrake', set('speedBrake', 1)).y).toBeLessThan(
      tip('LLAileron__speedbrake', none).y - 0.1,
    );
    expect(tip('RUAileron__speedbrake', set('speedBrake', 1)).y).toBeGreaterThan(restR.y + 0.1);
    // flaps 20°: trailing edge down and aft
    const f0 = tip('LIFlap-F__flap', none);
    const f20 = tip('LIFlap-F__flap', set('flaps', (20 * Math.PI) / 180));
    expect(f20.y).toBeLessThan(f0.y - 0.2);
    expect(f20.z).toBeGreaterThan(f0.z);
    // slats out: forward
    const s0 = pointsUnder(pose(exterior, none), 'L-Wing-Slat__slat');
    const s1 = pointsUnder(pose(exterior, set('slats', 1)), 'L-Wing-Slat__slat');
    expect(Math.min(...s1.map((p) => p.z))).toBeLessThan(Math.min(...s0.map((p) => p.z)) - 0.1);
  });
});

describe('converted A-10: meta file and data/geometry.ts', () => {
  it('agrees with data/geometry.ts', () => {
    const g = A10_GEOMETRY;
    close(meta.eye.position, [g.eye.x, g.eye.y, g.eye.z], 0.005);
    expect(Math.abs(meta.eye.pitch - g.eyeDefaultPitch)).toBeLessThan(1e-3);
    meta.hud.glassCorners.forEach((c, i) =>
      close(c, [g.hudCorners[i].x, g.hudCorners[i].y, g.hudCorners[i].z], 0.002),
    );
    close(meta.hud.normal, [g.hudNormal.x, g.hudNormal.y, g.hudNormal.z], 0.002);
    close(meta.gun.muzzle, [g.muzzle.x, g.muzzle.y, g.muzzle.z], 0.005);
    close(
      meta.gun.direction,
      [g.muzzleDirection.x, g.muzzleDirection.y, g.muzzleDirection.z],
      0.002,
    );
    for (const s of meta.stations) {
      const want = g.stations[s.station]!;
      close(s.suspension, [want.x, want.y, want.z], 0.015);
    }
    for (const s of meta.stations)
      expect(Math.abs(s.pitch - g.stationPitch[s.station]!), `station ${s.station}`).toBeLessThan(
        5e-4,
      );
    expect(g.eyeDefaultFovDeg).toBe(meta.eye.fovDeg);
    // the HUD glass centre and size follow from its corners
    const c = g.hudCorners;
    close(
      [g.hudCenter.x, g.hudCenter.y, g.hudCenter.z],
      [0, 1, 2].map((k) => (meta.hud.glassCorners[0][k] + meta.hud.glassCorners[2][k]) / 2),
      0.002,
    );
    expect(Math.abs(g.hudSize.width - (c[1].x - c[0].x))).toBeLessThan(0.002);
    expect(Math.abs(g.hudSize.height - Math.hypot(c[3].y - c[0].y, c[3].z - c[0].z))).toBeLessThan(
      0.002,
    );
    close(
      [g.gunClusterAxisPoint.x, g.gunClusterAxisPoint.y, g.gunClusterAxisPoint.z],
      meta.gun.clusterAxisPoint,
      0.002,
    );
    for (const [id, want] of Object.entries(g.gearContacts)) {
      const m = meta.gear.contacts[id as 'nose' | 'left' | 'right'];
      close(m.contact, [want.x, want.y, want.z], 0.002);
      expect(Math.abs(m.radius - want.radius)).toBeLessThan(0.002);
    }
    meta.engines.forEach((e, i) => {
      close(e.fan, [g.engines[i].fan.x, g.engines[i].fan.y, g.engines[i].fan.z], 0.002);
      close(
        e.exhaust,
        [g.engines[i].exhaust.x, g.engines[i].exhaust.y, g.engines[i].exhaust.z],
        0.002,
      );
    });
  });

  it('gives the simulation the hull points measured on the model (gear up)', () => {
    const g = A10_GEOMETRY;
    const h = meta.hull;
    const v = (p: { x: number; y: number; z: number }) => [p.x, p.y, p.z];
    close(v(g.hull.noseTip), h.noseTip, 0.002);
    close(v(g.hull.tailTip), h.tailTip, 0.002);
    close(v(g.hull.belly), h.belly, 0.002);
    close(v(g.hull.aftBelly), h.aftBelly, 0.002);
    close(v(g.hull.wingTip.outer), h.wingTip.outer, 0.002);
    close(v(g.hull.wingTip.leading), h.wingTip.leading, 0.002);
    close(v(g.hull.wingTip.trailing), h.wingTip.trailing, 0.002);
    expect(Math.abs(g.hull.fin.x - h.fin.x)).toBeLessThan(0.002);
    close(v(g.hull.fin.top), h.fin.top, 0.002);
    close(v(g.hull.fin.bottom), h.fin.bottom, 0.002);
    close(v(g.hull.gearPod.tyre), h.gearPod.tyre, 0.002);
    close(v(g.hull.gearPod.front), h.gearPod.front, 0.002);
    close(v(g.hull.gearPod.rear), h.gearPod.rear, 0.002);
    close(v(g.hull.pavePenny), h.pavePenny, 0.002);
    // the older single numbers say the same
    expect(Math.abs(g.noseZ - h.noseTip[2])).toBeLessThan(0.002);
    expect(Math.abs(g.tailZ - h.tailTip[2])).toBeLessThan(0.002);
    expect(Math.abs(g.wingTipX - h.wingTip.outer[0])).toBeLessThan(0.002);
    expect(Math.abs(g.finTopY - h.fin.top[1])).toBeLessThan(0.002);
    expect(Math.abs(g.bellyY - h.belly[1])).toBeLessThan(0.002);
    // the muzzle is ahead of the nose; the fins are the highest part of the clean model
    expect(g.muzzle.z).toBeLessThan(g.noseZ);
    expect(Math.abs(meta.exterior.bounds.max[1] - g.finTopY)).toBeLessThan(0.002);
  });

  it('measures the hull on the drawn parts: the retracted wheels are the lowest point', () => {
    // every vertex of the exterior with the gear up, except the hidden 600-gal tanks
    const tanks = new Set(
      meta.exterior.toggles.filter((t) => t.semantic?.station !== undefined).map((t) => t.node),
    );
    const rest = pose(exterior);
    let lowest = Infinity;
    const visit = (i: number) => {
      const n = exterior.json.nodes[i];
      if (n.name && tanks.has(n.name)) return;
      if (n.mesh !== undefined)
        for (const prim of exterior.json.meshes![n.mesh].primitives) {
          const a = readAccessor(exterior, prim.attributes.POSITION);
          const p = new Vector3();
          for (let k = 0; k < a.count; k++) {
            p.set(a.data[k * 3], a.data[k * 3 + 1], a.data[k * 3 + 2]).applyMatrix4(rest.world[i]);
            lowest = Math.min(lowest, p.y);
          }
        }
      for (const ch of n.children ?? []) visit(ch);
    };
    visit(rest.byName.get('a10-exterior')!);
    // quantized positions: a few millimetres
    expect(Math.abs(lowest - A10_GEOMETRY.hull.gearPod.tyre.y)).toBeLessThan(0.005);
    // the hidden tanks reach lower (the old bellyY of −1.64 was theirs)
    expect(meta.exterior.bounds.min[1]).toBeLessThan(-1.6);
    expect(A10_GEOMETRY.bellyY).toBeGreaterThan(A10_GEOMETRY.hull.gearPod.tyre.y);
  });

  it('places every store type the simulation knows on a model', () => {
    const types = [
      'AGM-65D',
      'AGM-65H',
      'AGM-65G',
      'AGM-65K',
      'MK-82',
      'MK-82AIR',
      'GBU-12',
      'LAU-131-M151',
      'LAU-131-M156',
      'LAU-68-M151',
      'LAU-68-M156',
      'CBU-97',
      'AN/AAQ-28',
      'AN/ALQ-184',
      'AIM-9M',
      'TER-9A',
      'LAU-117',
      'LAU-88',
    ];
    for (const t of types) {
      const id = meta.storeTypes[t];
      expect(id, t).toBeDefined();
      expect(existsSync(join(PUB, meta.stores[id].file)), t).toBe(true);
    }
    for (const r of ['ter9a', 'lau88', 'lau117', 'lau114'])
      expect(meta.racks[r].mounts.length).toBeGreaterThan(0);
    expect(meta.racks.ter9a.mounts).toHaveLength(3);
    expect(meta.racks.lau88.mounts).toHaveLength(3);
    // the Mk 82 AIR's ballute (deployed after a high-drag release) is hidden on the rack, as in
    // FlightGear, so the bomb measures like a Mk 82
    const chute = meta.stores.mk82air.toggles?.find((t) => t.node === 'MK-82AIR_Chute');
    expect(chute?.default).toBe(false);
    // the models are as long as the weapons the simulation flies (bombs, missiles, pods of rockets)
    for (const t of types) {
      const d = STORES[t as keyof typeof STORES];
      if (!['bomb', 'guidedBomb', 'missile', 'dispenser', 'airToAir', 'rocketPod'].includes(d.kind))
        continue;
      const model = meta.stores[meta.storeTypes[t]];
      expect(Math.abs(model.length - d.length) / d.length, t).toBeLessThan(0.05);
    }
    // a Mk 82 hangs from station 4 with its lugs at the pylon bottom (FlightGear's placement)
    const s4 = meta.stations[3];
    expect(Math.abs(s4.placements.mk82.position[1] - s4.suspension[1])).toBeLessThan(0.03);
    expect(meta.stations).toHaveLength(11);
  });

  it("leaves FlightGear's HUD out of the cockpit (our HUD draws itself), keeping the combiner", () => {
    const nodes = cockpit.json.nodes;
    const idx = (name: string) => nodes.findIndex((n) => n.name === name);
    // the canvas quad is kept only as an empty marker: no mesh below it
    const quad = idx('hud-screen');
    if (quad >= 0) {
      expect(nodes[quad].mesh).toBeUndefined();
      expect(nodes[quad].children ?? []).toEqual([]);
    }
    // nothing of A-10-hud.ac (the legacy 3-D symbols, e.g. its gun cross)
    for (const n of nodes) expect(n.name ?? '').not.toMatch(/gun-?cross|A-10-hud(?!-panel)/i);
    expect(meta.cockpit.models.some((m) => /A-10-hud\.xml$/.test(m.file))).toBe(false);
    // the tinted combiner stays, as glass
    const glass = idx('CPT-hud-screen');
    expect(glass).toBeGreaterThanOrEqual(0);
    expect(pointsUnder(pose(cockpit), 'CPT-hud-screen').length).toBeGreaterThan(0);
  });

  it('keeps the cockpit displays, HUD glass and clickable controls', () => {
    expect(meta.displays.tv.corners).toHaveLength(4);
    expect(meta.displays.mpcd.corners).toHaveLength(4);
    const names = new Set(cockpit.json.nodes.map((n) => n.name));
    expect(names.has('CPT-video-screen')).toBe(true);
    expect(names.has('canvas_disp')).toBe(true);
    expect(names.has('master-arm-switch')).toBe(true);
    expect(meta.pick.some((p) => p.node === 'master-arm-switch')).toBe(true);
    const pilotNames = new Set(pilot.json.nodes.map((n) => n.name));
    for (const p of meta.pick) {
      const set = p.file === 'pilot' ? pilotNames : names;
      expect(set.has(p.node), p.node).toBe(true);
      expect(set.has(p.frame), p.frame).toBe(true);
    }
  });

  it('stays inside the draw-call budget in flight (exterior ≤ 60)', () => {
    const b = meta.budget['a10-exterior.glb'];
    expect(b.triangles).toBeLessThan(60000);
    // in flight the forty gear parts are drawn as one merged mesh per material (models.ts
    // buildGearUp), and the inner glass and the hidden tanks are not drawn from outside
    const gear = new Set(
      meta.exterior.pivots
        .filter(
          (p) => /^(gear|compression|wheel)/.test(p.drive.input ?? '') || /__steer$/.test(p.node),
        )
        .map((p) => p.node),
    );
    const hidden = new Set(
      meta.exterior.toggles
        .filter((t) => t.semantic?.view === 'inside' || t.semantic?.station !== undefined)
        .map((t) => t.node),
    );
    const nodes = exterior.json.nodes;
    const parent = new Int32Array(nodes.length).fill(-1);
    nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parent[c] = i)));
    const under = (i: number, set: Set<string>) => {
      for (let p = i; p >= 0; p = parent[p]) if (set.has(nodes[p].name ?? '')) return true;
      return false;
    };
    let draws = 0;
    const gearMaterials = new Set<number>();
    nodes.forEach((n, i) => {
      if (n.mesh === undefined || under(i, hidden)) return;
      const prims = exterior.json.meshes![n.mesh].primitives;
      if (under(i, gear)) prims.forEach((p) => gearMaterials.add(p.material ?? -1));
      else draws += prims.length;
    });
    expect(draws + gearMaterials.size).toBeLessThanOrEqual(60);
  });
});
