/**
 * The converted LAU-68 rocket pod (public/a10/models/stores/lau68.glb), read from the file: its
 * seven Hydra 70 noses split into tubes in FlightGear's firing order (`prepareRocketPod`), so the
 * rockets can leave the pod one by one; and the converted GBU-12 (gbu12.glb): its four canards
 * split out of the kit's mesh onto pivots at their hinges (`prepareCanards`), so the stores view
 * can deflect them (STORES-VIEW module, wave 2).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BufferAttribute, BufferGeometry, Group, Mesh, Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  canardPivotsOf,
  podTubesOf,
  prepareCanards,
  prepareRocketPod,
  setCanardsLive,
} from '../../../src/a10/assets/models';

const ROOT = resolve(__dirname, '../../..');

interface Json {
  nodes: {
    name?: string;
    mesh?: number;
    children?: number[];
    translation?: number[];
    scale?: number[];
    extras?: Record<string, unknown>;
  }[];
  meshes: { primitives: { attributes: { POSITION: number }; indices?: number }[] }[];
  accessors: {
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    normalized?: boolean;
    count: number;
    type: string;
  }[];
  bufferViews: { byteOffset?: number; byteStride?: number }[];
  scenes: { nodes: number[] }[];
}

/** A three.js Group built from a GLB: geometry (positions, indices) and the marker nodes' extras. */
function readGlb(file: string): Group {
  const b = readFileSync(file);
  const jsonLength = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLength).toString('utf8')) as Json;
  const bin = b.subarray(20 + jsonLength + 8);
  const read = (i: number): Float32Array | Uint32Array => {
    const a = json.accessors[i];
    const view = json.bufferViews[a.bufferView];
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type] ?? 1;
    const size = { 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType] ?? 4;
    const stride = view.byteStride ?? comps * size;
    const base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const int = a.componentType === 5123 || a.componentType === 5125 || a.componentType === 5121;
    const out = int && comps === 1 ? new Uint32Array(a.count) : new Float32Array(a.count * comps);
    for (let i = 0; i < a.count; i++)
      for (let k = 0; k < comps; k++) {
        const o = base + i * stride + k * size;
        let v: number;
        if (a.componentType === 5126) v = bin.readFloatLE(o);
        else if (a.componentType === 5122) {
          v = bin.readInt16LE(o);
          if (a.normalized) v = Math.max(v / 32767, -1);
        } else if (a.componentType === 5123) v = bin.readUInt16LE(o);
        else if (a.componentType === 5125) v = bin.readUInt32LE(o);
        else v = bin.readUInt8(o);
        out[i * comps + k] = v;
      }
    return out;
  };
  const build = (ni: number): Object3D => {
    const n = json.nodes[ni];
    const o = n.mesh !== undefined ? new Group() : new Object3D();
    o.name = n.name ?? '';
    if (n.extras) o.userData = { ...n.extras };
    if (n.translation) o.position.fromArray(n.translation);
    if (n.scale) o.scale.fromArray(n.scale);
    if (n.mesh !== undefined) {
      for (const p of json.meshes[n.mesh].primitives) {
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(read(p.attributes.POSITION), 3));
        if (p.indices !== undefined) g.setIndex(new BufferAttribute(read(p.indices), 1));
        o.add(new Mesh(g));
      }
    }
    for (const c of n.children ?? []) o.add(build(c));
    return o;
  };
  const root = new Group();
  for (const ni of json.scenes[0].nodes) root.add(build(ni));
  const top = root.children[0];
  top.removeFromParent();
  const g = new Group();
  g.add(...top.children);
  g.name = top.name;
  g.updateMatrixWorld(true);
  return g;
}

describe('LAU-68 pod tubes (the converted model)', () => {
  const pod = readGlb(join(ROOT, 'public/a10/models/stores/lau68.glb'));

  it('splits the seven rockets into tubes in firing order', () => {
    expect(prepareRocketPod(pod)).toBe(7);
    let rockets: Mesh | null = null;
    pod.traverse((o) => {
      if ((o as Mesh).isMesh && podTubesOf(o as Mesh)) rockets = o as Mesh;
    });
    const mesh = rockets as Mesh | null;
    expect(mesh).not.toBeNull();
    const tubes = podTubesOf(mesh!)!;
    expect(tubes.stages.length).toBe(8);
    expect(mesh!.geometry).toBe(tubes.stages[0]);
    // the pod's axis: the centre tube (fired last, FlightGear's Hydra70_7)
    const centre = tubes.axes[6];
    expect(centre.x).toBeCloseTo(0, 1);
    expect(centre.y).toBeCloseTo(-0.158, 2);
    // six tubes on a ring of ≈93 mm around it, 60° apart, Hydra70_1 … _6 going round
    const angles: number[] = [];
    for (let k = 0; k < 6; k++) {
      const r = Math.hypot(tubes.axes[k].x - centre.x, tubes.axes[k].y - centre.y);
      expect(r).toBeGreaterThan(0.085);
      expect(r).toBeLessThan(0.1);
      angles.push(Math.atan2(tubes.axes[k].y - centre.y, tubes.axes[k].x - centre.x));
    }
    for (let k = 1; k < 6; k++) {
      let d = Math.abs(angles[k] - angles[k - 1]);
      if (d > Math.PI) d = 2 * Math.PI - d;
      expect(d * (180 / Math.PI)).toBeCloseTo(60, -1);
    }
    // the noses stand ≈0.1 m out of the pod's front (z −0.785)
    expect(tubes.noseZ).toBeLessThan(-0.85);
    // each stage leaves out one more tube: 240 triangles each
    const total = tubes.stages[0].drawRange.count;
    expect(total).toBe(7 * 240 * 3);
    for (let k = 0; k <= 7; k++) {
      expect(tubes.stages[k].drawRange.start).toBe(k * 240 * 3);
      expect(tubes.stages[k].drawRange.count).toBe((7 - k) * 240 * 3);
      // every stage shares the buffers: one upload whatever is left
      expect(tubes.stages[k].index).toBe(tubes.stages[0].index);
      expect(tubes.stages[k].getAttribute('position')).toBe(
        tubes.stages[0].getAttribute('position'),
      );
    }
  });

  it('the first tube of the stage order holds FlightGear Hydra70_1 (fired first)', () => {
    const fresh = readGlb(join(ROOT, 'public/a10/models/stores/lau68.glb'));
    prepareRocketPod(fresh);
    let mesh: Mesh | null = null;
    fresh.traverse((o) => {
      if ((o as Mesh).isMesh && podTubesOf(o as Mesh)) mesh = o as Mesh;
    });
    const tubes = podTubesOf(mesh!)!;
    // Hydra70_1 is the object at the top right of the ring in the model (≈ +60°)
    const a = tubes.axes[0];
    const c = tubes.axes[6];
    expect((Math.atan2(a.y - c.y, a.x - c.x) * 180) / Math.PI).toBeCloseTo(60, -1);
  });
});

/** Every drawn triangle of a model (its world corners), as sorted keys, and per mesh. */
function drawnTriangles(root: Object3D): string[] {
  root.updateMatrixWorld(true);
  const out: string[] = [];
  const v = new Vector3();
  // what the renderer draws: visible meshes under visible parents
  root.traverseVisible((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const g = m.geometry as BufferGeometry;
    const index = g.index!;
    const pos = g.getAttribute('position');
    const start = g.drawRange.start;
    const end = Math.min(index.count, start + g.drawRange.count);
    for (let i = start; i < end; i += 3) {
      const corners: string[] = [];
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, index.getX(i + k)).applyMatrix4(m.matrixWorld);
        corners.push(`${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`);
      }
      out.push(corners.sort().join(' '));
    }
  });
  return out.sort();
}

describe('GBU-12 canards (the converted model)', () => {
  const meta = JSON.parse(readFileSync(join(ROOT, 'public/a10/models/a10-meta.json'), 'utf8')) as {
    stores: Record<string, { centre: number[] }>;
  };
  const centre = meta.stores.gbu12.centre;

  it('splits the four canards out of the kit mesh, each on a pivot at its hinge', () => {
    const g = readGlb(join(ROOT, 'public/a10/models/stores/gbu12.glb'));
    const before = drawnTriangles(g);
    let meshes = 0;
    g.traverse((o) => void ((o as Mesh).isMesh && meshes++));
    expect(prepareCanards(g, centre)).toBe(4);
    const pivots: Object3D[] = [];
    expect(canardPivotsOf(g, pivots)).toBe(4);
    // on a pylon: merged, the pivots hidden, nothing more to draw than before
    let drawn = 0;
    g.traverseVisible((o) => void ((o as Mesh).isMesh && drawn++));
    expect(drawn).toBe(meshes);
    expect(drawnTriangles(g)).toEqual(before);
    // in flight: the kit without its canards, and the four pivoted canards
    setCanardsLive(g, true);
    for (let k = 0; k < 4; k++) {
      const p = pivots[k];
      // an X of fins (45° + k·90° about the store axis), hinged on the axis at mid-chord
      const [ax, ay, az] = p.userData.axis as number[];
      expect(az).toBe(0);
      const deg = (((Math.atan2(ay, ax) * 180) / Math.PI + 360) % 360) - (45 + 90 * k);
      expect(Math.abs(deg)).toBeLessThan(2);
      expect(p.position.x).toBeCloseTo(centre[0], 3);
      expect(p.position.y).toBeCloseTo(centre[1], 3);
      // the converter's canards: chord from FlightGear x −1.6 to −1.4 (z = x + 0.0793 here)
      expect(p.position.z).toBeGreaterThan(-1.53);
      expect(p.position.z).toBeLessThan(-1.31);
      // twelve triangles a fin
      const fin = p.children[0] as Mesh;
      expect((fin.geometry as BufferGeometry).drawRange.count).toBe(12 * 3);
    }
    // neutral: exactly what the merged mesh drew, nothing lost, nothing twice
    expect(drawnTriangles(g)).toEqual(before);
    // back to the merged form: neutral again
    pivots[2].quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.3);
    setCanardsLive(g, false);
    expect(pivots[2].quaternion.w).toBe(1);
    expect(drawnTriangles(g)).toEqual(before);
  });

  it('a deflection turns its own fin about its span, leading edge first, and nothing else', () => {
    const g = readGlb(join(ROOT, 'public/a10/models/stores/gbu12.glb'));
    prepareCanards(g, centre);
    setCanardsLive(g, true);
    const pivots: Object3D[] = [];
    canardPivotsOf(g, pivots);
    const before = new Set(drawnTriangles(g));
    const fin = pivots[1].children[0] as Mesh;
    // the fin's most forward corner (its leading edge at the root), before and after
    const front = (): Vector3 => {
      g.updateMatrixWorld(true);
      const geo = fin.geometry as BufferGeometry;
      const pos = geo.getAttribute('position');
      const best = new Vector3(0, 0, Infinity);
      const v = new Vector3();
      for (let i = geo.drawRange.start; i < geo.drawRange.start + geo.drawRange.count; i++) {
        v.fromBufferAttribute(pos, geo.index!.getX(i)).applyMatrix4(fin.matrixWorld);
        if (v.z < best.z) best.copy(v);
      }
      return best;
    };
    const a = new Vector3().fromArray(pivots[1].userData.axis as number[]);
    const le0 = front();
    pivots[1].quaternion.setFromAxisAngle(a, 0.15);
    const le1 = front();
    // the leading edge moves toward (−a.y, a.x): the side the canard then lifts to
    const moved = le1.clone().sub(le0);
    expect(moved.dot(new Vector3(-a.y, a.x, 0))).toBeGreaterThan(0.005);
    expect(Math.abs(moved.dot(a))).toBeLessThan(1e-3);
    // only that fin's twelve triangles moved
    const after = drawnTriangles(g);
    expect(after.filter((t) => !before.has(t)).length).toBe(12);
  });
});
