/**
 * The converted LAU-68 rocket pod (public/a10/models/stores/lau68.glb), read from the file: its
 * seven Hydra 70 noses split into tubes in FlightGear's firing order (`prepareRocketPod`), so the
 * rockets can leave the pod one by one (STORES-VIEW module, wave 2).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BufferAttribute, BufferGeometry, Group, Mesh, Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { podTubesOf, prepareRocketPod } from '../../../src/a10/assets/models';

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
