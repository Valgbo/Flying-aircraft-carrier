/**
 * Loading of the converted FlightGear A-10 (public/a10/models, scripts/a10/convert-ac3d.mjs).
 * OWNED BY THE AIRCRAFT (ASSETS) MODULE.
 *
 * The exterior, cockpit, pilot, every store model and the meta file load once, behind the loading
 * screen (`registerFlightLoader('aircraft-models', …)`), and stay as TEMPLATES: instances are
 * clones that share geometry, materials and textures. Textures that two files use are merged into
 * one GPU texture; THREE.Cache keeps repeated downloads away.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Cache,
  Color,
  Group,
  Material,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Texture,
  Vector3,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { StoreType } from '../core/weapons/types';
import { registerFlightLoader } from '../state/flow';
import type { A10Meta } from './meta';
import { a10Asset } from './urls';

Cache.enabled = true;

export interface AircraftTemplates {
  meta: A10Meta;
  exterior: Group;
  cockpit: Group;
  pilot: Group;
  /** Store model id (meta.stores key) → template, origin at the lugs. */
  stores: Map<string, Group>;
  /**
   * The exterior's landing-gear meshes merged at rest (gear up), one mesh per material: drawn
   * instead of the forty gear parts while the gear is fully retracted.
   */
  gearUp: Group;
  /** Pivot node names of the gear (hidden while gearUp is shown). */
  gearPivots: string[];
}

let templates: AircraftTemplates | null = null;
let loading: Promise<AircraftTemplates> | null = null;
const listeners = new Set<(t: AircraftTemplates) => void>();

/** The loaded templates, or null before the loader finished. */
export function getAircraftTemplates(): AircraftTemplates | null {
  return templates;
}

/** Called once when the models are loaded (immediately if they already are). */
export function onAircraftTemplates(fn: (t: AircraftTemplates) => void): () => void {
  if (templates) fn(templates);
  else listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The meta file (after loading). */
export function getA10Meta(): A10Meta | null {
  return templates?.meta ?? null;
}

const loader = new GLTFLoader();
/** One Texture per image URL across every file (GLTFLoader makes one per file and material). */
const imageTextures = new Map<string, Texture>();

async function loadGLB(
  path: string,
  onBytes: (loaded: number, total: number) => void,
): Promise<GLTF> {
  const url = a10Asset(path);
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (g) => resolve(g),
      (e) => onBytes(e.loaded, e.total || e.loaded),
      (err) => reject(err instanceof Error ? err : new Error(`${path}: ${String(err)}`)),
    );
  });
}

/** Share textures by image URL and give the materials their run-time flags. */
function prepare(gltf: GLTF, fileUrl: string): Group {
  const parser = gltf.parser;
  const json = parser.json as {
    textures?: { source?: number }[];
    images?: { uri?: string }[];
  };
  const urlOf = (tex: Texture): string | null => {
    const ref = parser.associations.get(tex) as { textures?: number } | undefined;
    if (ref?.textures === undefined) return null;
    const src = json.textures?.[ref.textures]?.source;
    const uri = src === undefined ? undefined : json.images?.[src]?.uri;
    return uri ? new URL(uri, fileUrl).href : null;
  };
  const shareSource = (tex: Texture | null) => {
    if (!tex) return;
    const url = urlOf(tex);
    if (!url) return;
    const canonical = imageTextures.get(url);
    if (canonical && canonical.source !== tex.source) tex.source = canonical.source;
    else if (!canonical) imageTextures.set(url, tex);
  };
  const root = gltf.scene.children[0] as Group;
  root.removeFromParent();
  root.traverse((o) => {
    // static nodes do not need their matrix recomposed every frame
    o.matrixAutoUpdate = Boolean(o.userData.pivot);
    o.updateMatrix();
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats as MeshStandardMaterial[]) {
      shareSource(m.map);
      shareSource(m.emissiveMap);
      if (m.userData.glass) {
        // FlightGear's glass is tinted purple for its own lighting; ours reads as clear, slightly
        // blue-grey acrylic with highlights
        m.color = new Color(0.62, 0.68, 0.74);
        m.roughness = 0.06;
        m.metalness = 0;
        m.depthWrite = false;
        m.opacity = Math.min(m.opacity, 0.22);
      }
    }
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  });
  root.updateMatrixWorld(true);
  return root;
}

// ---------------------------------------------------------------------------------------------
// rocket pods: the rockets in their tubes, leaving one by one
// ---------------------------------------------------------------------------------------------

/**
 * A rocket pod's rockets (the noses in the tube mouths), tube by tube in firing order. The
 * converter merges the seven `Hydra70_n` objects into one mesh, each object's triangles
 * contiguous in node order; at load their triangles are re-ordered by firing order (FlightGear's
 * LAU-68 hides `Hydra70_1` first and the centre tube `Hydra70_7` last) so that `stages[k]`, a
 * geometry sharing the same buffers with a draw range that starts after the first k tubes, shows
 * the rockets left after k have been fired. One draw call whatever is left; the stage
 * geometries are shared by every instance (switch `mesh.geometry`, never dispose them).
 */
export interface PodTubes {
  /** `stages[k]`: the rockets left after k were fired (k = 0 … tubes). */
  stages: BufferGeometry[];
  /** Tube axes in the pod's frame (lugs origin), in firing order, and the noses' front, z. */
  axes: { x: number; y: number }[];
  noseZ: number;
}

const podTubes = new WeakMap<BufferGeometry, PodTubes>();

/** The pod tubes of a mesh of a rocket pod (any stage geometry), or null. */
export function podTubesOf(mesh: Mesh): PodTubes | null {
  return podTubes.get(mesh.geometry as BufferGeometry) ?? null;
}

const _pv = new Vector3();

/**
 * Split a rocket pod template's merged rockets into firing-order stages (see PodTubes). Checks
 * that each object's triangles form one compact tube; anything unexpected leaves the pod whole.
 * Returns the number of tubes found (0 when the pod was left as it was).
 */
export function prepareRocketPod(template: Object3D): number {
  const tubes: { n: number; tris: number }[] = [];
  template.traverse((o) => {
    const m = /^Hydra70_(\d+)$/.exec(String(o.userData?.acName ?? ''));
    if (m && Number(o.userData.triangles) > 0)
      tubes.push({ n: Number(m[1]), tris: Number(o.userData.triangles) });
  });
  if (tubes.length < 2) return 0;
  const total = tubes.reduce((a, t) => a + t.tris, 0);
  let mesh: Mesh | null = null;
  template.traverse((o) => {
    const g = (o as Mesh).isMesh ? ((o as Mesh).geometry as BufferGeometry) : null;
    if (g?.index && g.index.count === total * 3) mesh = o as Mesh;
  });
  const found = mesh as Mesh | null;
  if (!found) return 0;
  const geometry = found.geometry as BufferGeometry;
  const index = geometry.index!;
  const position = geometry.getAttribute('position');
  template.updateMatrixWorld(true);
  const toPod = new Matrix4()
    .copy(template.matrixWorld)
    .invert()
    .multiply(found.matrixWorld);
  // each object's block: its tube axis (mean x, y) and that every vertex lies within the tube
  const blocks: { n: number; start: number; tris: number; x: number; y: number }[] = [];
  let start = 0;
  let noseZ = Infinity;
  for (const t of tubes) {
    let sx = 0;
    let sy = 0;
    const count = t.tris * 3;
    for (let i = start * 3; i < (start + t.tris) * 3; i++) {
      _pv.fromBufferAttribute(position, index.getX(i)).applyMatrix4(toPod);
      sx += _pv.x;
      sy += _pv.y;
      if (_pv.z < noseZ) noseZ = _pv.z;
    }
    const x = sx / count;
    const y = sy / count;
    for (let i = start * 3; i < (start + t.tris) * 3; i++) {
      _pv.fromBufferAttribute(position, index.getX(i)).applyMatrix4(toPod);
      // a 70 mm rocket in its tube: nothing farther than about 4 cm from the tube's axis
      if (Math.hypot(_pv.x - x, _pv.y - y) > 0.06) return 0;
    }
    blocks.push({ n: t.n, start, tris: t.tris, x, y });
    start += t.tris;
  }
  blocks.sort((a, b) => a.n - b.n);
  const src = index.array;
  const reordered = new (src.constructor as Uint16ArrayConstructor | Uint32ArrayConstructor)(
    src.length,
  );
  let o = 0;
  for (const b of blocks) {
    for (let i = b.start * 3; i < (b.start + b.tris) * 3; i++) reordered[o++] = src[i];
  }
  const newIndex = new BufferAttribute(reordered, 1);
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const info: PodTubes = {
    stages: [],
    axes: blocks.map((b) => ({ x: b.x, y: b.y })),
    noseZ,
  };
  let first = 0;
  for (let k = 0; k <= blocks.length; k++) {
    const g = new BufferGeometry();
    g.name = `${geometry.name || 'rockets'}-stage${k}`;
    g.setIndex(newIndex);
    for (const name of Object.keys(geometry.attributes)) g.setAttribute(name, geometry.attributes[name]);
    g.boundingSphere = geometry.boundingSphere;
    g.boundingBox = geometry.boundingBox;
    g.setDrawRange(first * 3, (total - first) * 3);
    info.stages.push(g);
    podTubes.set(g, info);
    if (k < blocks.length) first += blocks[k].tris;
  }
  found.geometry = info.stages[0];
  return blocks.length;
}

/** Merge the gear meshes of the exterior at rest into one Float32 mesh per material. */
function buildGearUp(exterior: Group, meta: A10Meta): { group: Group; pivots: string[] } {
  const isGear = (input: string | null | undefined, node: string) =>
    !!input && (/^(gear|compression|wheel)/.test(input) || node.endsWith('__steer'));
  const gearNames = new Set(
    meta.exterior.pivots.filter((p) => isGear(p.drive.input, p.node)).map((p) => p.node),
  );
  // outermost gear pivots only
  const roots: Object3D[] = [];
  for (const name of gearNames) {
    const o = exterior.getObjectByName(name);
    if (!o) continue;
    let p = o.parent;
    let inner = false;
    while (p) {
      if (gearNames.has(p.name)) inner = true;
      p = p.parent;
    }
    if (!inner) roots.push(o);
  }
  const inv = new Matrix4().copy(exterior.matrixWorld).invert();
  const rel = new Matrix4();
  const nm = new Matrix3();
  const v = new Vector3();
  const byMat = new Map<
    Material,
    { pos: number[]; nrm: number[]; uv: number[]; col: number[]; idx: number[] }
  >();
  for (const r of roots)
    r.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry as BufferGeometry;
      const mat = mesh.material as Material;
      let acc = byMat.get(mat);
      if (!acc) byMat.set(mat, (acc = { pos: [], nrm: [], uv: [], col: [], idx: [] }));
      rel.multiplyMatrices(inv, mesh.matrixWorld);
      nm.getNormalMatrix(rel);
      const P = g.getAttribute('position');
      const N = g.getAttribute('normal');
      const U = g.getAttribute('uv');
      const C = g.getAttribute('color');
      const base = acc.pos.length / 3;
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(rel);
        acc.pos.push(v.x, v.y, v.z);
        v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
        acc.nrm.push(v.x, v.y, v.z);
        if (U) acc.uv.push(U.getX(i), U.getY(i));
        if (C) acc.col.push(C.getX(i), C.getY(i), C.getZ(i));
      }
      const I = g.getIndex();
      if (I) for (let i = 0; i < I.count; i++) acc.idx.push(I.getX(i) + base);
    });
  const group = new Group();
  group.name = 'gear-up';
  for (const [mat, acc] of byMat) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(acc.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(acc.nrm), 3));
    if (acc.uv.length) g.setAttribute('uv', new BufferAttribute(new Float32Array(acc.uv), 2));
    if (acc.col.length) g.setAttribute('color', new BufferAttribute(new Float32Array(acc.col), 3));
    g.setIndex(
      acc.pos.length / 3 > 65535
        ? new BufferAttribute(new Uint32Array(acc.idx), 1)
        : new BufferAttribute(new Uint16Array(acc.idx), 1),
    );
    g.computeBoundingSphere();
    const m = new Mesh(g, mat);
    m.name = `gear-up-${mat.name}`;
    m.matrixAutoUpdate = false;
    group.add(m);
  }
  group.matrixAutoUpdate = false;
  return { group, pivots: [...gearNames] };
}

/**
 * Load every aircraft file once. Progress reports (fraction, label) for the loading screen.
 */
export function loadAircraftModels(
  onProgress: (fraction: number, label: string) => void = () => {},
): Promise<AircraftTemplates> {
  if (templates) return Promise.resolve(templates);
  if (loading) return loading;
  loading = (async () => {
    const metaUrl = a10Asset('models/a10-meta.json');
    const res = await fetch(metaUrl);
    if (!res.ok) throw new Error(`a10-meta.json: HTTP ${res.status}`);
    const meta = (await res.json()) as A10Meta;
    const files: string[] = [meta.files.exterior, meta.files.cockpit, meta.files.pilot];
    const storeIds = Object.keys(meta.stores);
    for (const id of storeIds) files.push(meta.stores[id].file);
    const expected = new Map<string, number>();
    for (const f of files)
      expected.set(f, meta.budget[f.replace(/^models\//, '')]?.bytes ?? 100_000);
    const loaded = new Map<string, number>();
    const totalBytes = [...expected.values()].reduce((a, b) => a + b, 0);
    const report = (label: string) => {
      let sum = 0;
      for (const v of loaded.values()) sum += v;
      onProgress(Math.min(0.99, sum / totalBytes), label);
    };
    const one = async (f: string): Promise<Group> => {
      const g = await loadGLB(f, (l) => {
        loaded.set(f, Math.min(l, expected.get(f) ?? l));
        report('Aircraft model');
      });
      loaded.set(f, expected.get(f) ?? 0);
      report('Aircraft model');
      return prepare(g, a10Asset(f));
    };
    const [exterior, cockpit, pilot, ...storeGroups] = await Promise.all(files.map(one));
    const stores = new Map<string, Group>();
    storeIds.forEach((id, i) => {
      // parts shown only in some states (the Mk 82 AIR ballute) start at their default
      for (const t of meta.stores[id].toggles ?? []) {
        const o = storeGroups[i].getObjectByName(t.node);
        if (o) o.visible = t.default;
      }
      // rocket pods: the rockets leave their tubes one by one (stations and jettisoned pods)
      prepareRocketPod(storeGroups[i]);
      stores.set(id, storeGroups[i]);
    });
    const gear = buildGearUp(exterior, meta);
    templates = {
      meta,
      exterior,
      cockpit,
      pilot,
      stores,
      gearUp: gear.group,
      gearPivots: gear.pivots,
    };
    onProgress(1, 'Aircraft model');
    for (const l of listeners) l(templates);
    listeners.clear();
    return templates;
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

registerFlightLoader('aircraft-models', 3, (onProgress) =>
  loadAircraftModels(onProgress).then(() => undefined),
);

/**
 * Store model id for a simulation StoreType (null when the type has no model), from `meta`
 * (default: the loaded templates' meta file).
 */
export function storeModelId(
  type: StoreType | string,
  meta: A10Meta | null = templates?.meta ?? null,
): string | null {
  if (!meta) return null;
  if (meta.stores[type]) return type;
  return meta.storeTypes[type] ?? null;
}

/**
 * The template of a store (origin at the top of its suspension lugs, BODY-aligned axes, −Z
 * forward), or null before the models are loaded or for an unknown type. Clone it to draw it.
 */
export function getStoreTemplate(type: StoreType | string): Group | null {
  const id = storeModelId(type);
  return id ? (templates?.stores.get(id) ?? null) : null;
}

/** Like getStoreTemplate, waiting for the models to load. */
export async function loadStoreModel(type: StoreType | string): Promise<Group | null> {
  await loadAircraftModels();
  return getStoreTemplate(type);
}

/**
 * A drawable copy of a store. origin 'centre' puts the store's own reference point (mid-length on
 * its axis: use it for a store in flight, whose sim position is its centre of mass); 'lugs'
 * keeps the suspension point at the origin (mounting on a pylon or rack).
 */
export function createStoreInstance(
  type: StoreType | string,
  origin: 'centre' | 'lugs' = 'centre',
  from: AircraftTemplates | null = templates,
): Group | null {
  if (!from) return null;
  const id = storeModelId(type, from.meta);
  const tpl = id ? from.stores.get(id) : undefined;
  if (!tpl || !id) return null;
  const g = new Group();
  g.name = `store-${id}`;
  const c = tpl.clone(true);
  if (origin === 'centre') {
    const [x, y, z] = from.meta.stores[id].centre;
    c.position.set(-x, -y, -z);
    c.updateMatrix();
  }
  g.add(c);
  return g;
}

/** A copy of the cockpit (instruments, consoles, tub) in BODY coordinates for the cockpit pass. */
export function createCockpitModel(): Group | null {
  if (!templates) return null;
  const root = templates.cockpit.clone(true);
  // distance LODs from FlightGear: the near panel and instruments, not the far stand-in panel
  for (const l of templates.meta.cockpit.lods) {
    const o = root.getObjectByName(l.node);
    if (o) o.visible = l.min < 1;
  }
  for (const t of templates.meta.cockpit.toggles) {
    const o = root.getObjectByName(t.node);
    if (o) o.visible = t.default;
  }
  return root;
}
