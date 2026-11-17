/**
 * Placeholder aircraft templates: the real meta file (stations, racks, store sizes) with a plain
 * box for every model, for unit tests in Node (no GLB loading there) and for sandboxes that run
 * without the downloaded models. OWNED BY THE STORES-VIEW MODULE (wave 2).
 *
 * The rocket pod is built like the converted LAU-68: a shell, and seven rocket noses merged in
 * ONE mesh in FlightGear's node order (Hydra70_1 … _4, _6, _5, _7) with a marker node per rocket
 * giving its triangle count — so `prepareRocketPod` does here exactly what it does to the real
 * model. The Mk 82 AIR has its hidden `MK-82AIR_Chute` part. The GBU-12's four canards are thin
 * fins merged into its kit mesh behind a `GBU-12_Canards` marker, as the converter builds them, so
 * `prepareCanards` splits them here as it does the real model.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
} from 'three';
import type { A10Meta } from './meta';
import { prepareCanards, prepareRocketPod, type AircraftTemplates } from './models';

const material = new MeshBasicMaterial({ color: 0x808878 });

function box(name: string, min: readonly number[], max: readonly number[]): Mesh {
  const g = new BoxGeometry(
    Math.max(0.01, max[0] - min[0]),
    Math.max(0.01, max[1] - min[1]),
    Math.max(0.01, max[2] - min[2]),
  );
  const m = new Mesh(g, material);
  m.name = name;
  m.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  return m;
}

/** Tube axes of the converted LAU-68 (pod frame), FlightGear's Hydra70_1 … _7. */
const TUBES: [number, number][] = [
  [0.0454, -0.0757],
  [0.0917, -0.1588],
  [0.0447, -0.2383],
  [-0.051, -0.2387],
  [-0.0935, -0.1598],
  [-0.0496, -0.0747],
  [-0.0043, -0.1581],
];
/** The model's node (and merge) order: Hydra70_1 … _4, _6, _5, _7. */
const NODE_ORDER = [1, 2, 3, 4, 6, 5, 7];
const TRIS_PER_ROCKET = 6;

function podTemplate(id: string): Group {
  const root = new Group();
  root.name = id;
  root.add(box(`${id}__shell`, [-0.16, -0.32, -0.785], [0.16, 0, 0.881]));
  // the rockets' noses: a small pyramid fan per tube, merged in node order
  const pos: number[] = [];
  const idx: number[] = [];
  for (const n of NODE_ORDER) {
    const [x, y] = TUBES[n - 1];
    const base = pos.length / 3;
    pos.push(x, y, -0.881);
    for (let k = 0; k < TRIS_PER_ROCKET; k++) {
      const a = (k / TRIS_PER_ROCKET) * Math.PI * 2;
      pos.push(x + 0.032 * Math.cos(a), y + 0.032 * Math.sin(a), -0.76);
    }
    for (let k = 0; k < TRIS_PER_ROCKET; k++)
      idx.push(base, base + 1 + k, base + 1 + ((k + 1) % TRIS_PER_ROCKET));
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(new BufferAttribute(new Uint16Array(idx), 1));
  const rockets = new Mesh(g, material);
  rockets.name = `${id}__rockets`;
  root.add(rockets);
  const parts = new Group();
  parts.name = `${id}__2`;
  for (const n of NODE_ORDER) {
    const marker = new Object3D();
    marker.name = `Hydra70_${n}`;
    marker.userData = { acName: `Hydra70_${n}`, triangles: TRIS_PER_ROCKET };
    parts.add(marker);
  }
  root.add(parts);
  return root;
}

/**
 * The GBU-12: a box body and the kit mesh with the four canards merged at its end (the converter's
 * planform: root chord 0.2 m at r = 0.1 m, tip chord 0.09 m at r = 0.255 m, 8 mm thick, in an X),
 * 12 triangles a fin, with the `GBU-12_Canards` marker.
 */
function gbu12Template(id: string, s: A10Meta['stores'][string]): Group {
  const root = new Group();
  root.name = id;
  root.add(box(`${id}__geo`, s.bounds.min, s.bounds.max));
  const [cx, cy] = s.centre;
  // the kit: a few triangles of guidance section ahead of the canards
  const pos: number[] = [cx, cy + 0.1, -1.9, cx + 0.1, cy, -1.9, cx, cy - 0.1, -1.9];
  const idx: number[] = [0, 1, 2];
  const plan: [number, number][] = [
    [-1.521, 0.1],
    [-1.321, 0.1],
    [-1.391, 0.255],
    [-1.481, 0.255],
  ];
  for (let f = 0; f < 4; f++) {
    const a = Math.PI / 4 + (f * Math.PI) / 2;
    const base = pos.length / 3;
    for (const side of [-0.004, 0.004])
      for (const [z, r] of plan)
        pos.push(
          cx + r * Math.cos(a) - side * Math.sin(a),
          cy + r * Math.sin(a) + side * Math.cos(a),
          z,
        );
    // two faces, four edges: 12 triangles
    const quad = (a0: number, a1: number, a2: number, a3: number) =>
      idx.push(base + a0, base + a1, base + a2, base + a0, base + a2, base + a3);
    quad(0, 1, 2, 3);
    quad(4, 7, 6, 5);
    for (let e = 0; e < 4; e++) quad(e, e + 4, ((e + 1) % 4) + 4, (e + 1) % 4);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(new BufferAttribute(new Uint16Array(idx), 1));
  const kit = new Mesh(g, material);
  kit.name = `${id}__kit`;
  root.add(kit);
  const parts = new Group();
  parts.name = `${id}__2`;
  const marker = new Object3D();
  marker.name = 'GBU-12_Canards';
  marker.userData = { acName: 'GBU-12_Canards', triangles: 48 };
  parts.add(marker);
  root.add(parts);
  return root;
}

/** Templates with box models (the real meta's stations, racks and store sizes). */
export function createPlaceholderTemplates(meta: A10Meta): AircraftTemplates {
  const stores = new Map<string, Group>();
  for (const [id, s] of Object.entries(meta.stores)) {
    let g: Group;
    if (id === 'lau68') g = podTemplate(id);
    else if (id === 'gbu12') g = gbu12Template(id, s);
    else {
      g = new Group();
      g.name = id;
      g.add(box(`${id}__geo`, s.bounds.min, s.bounds.max));
      for (const t of s.toggles ?? []) {
        const part = box(t.node, s.bounds.min, s.bounds.max);
        part.visible = t.default;
        g.add(part);
      }
    }
    g.updateMatrixWorld(true);
    prepareRocketPod(g);
    prepareCanards(g, s.centre);
    stores.set(id, g);
  }
  const exterior = new Group();
  exterior.name = 'exterior';
  return {
    meta,
    exterior,
    cockpit: new Group(),
    pilot: new Group(),
    stores,
    gearUp: new Group(),
    gearPivots: [],
  };
}
