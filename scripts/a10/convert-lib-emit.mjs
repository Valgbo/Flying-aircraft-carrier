/**
 * Turns an assembled FlightGear subtree (convert-lib-scene.mjs) into a GLB:
 *
 *  - pivot nodes sit on their hinge: node translation = hinge centre − parent hinge centre, and
 *    geometry is stored relative to the innermost pivot, so setting a pivot's quaternion (or
 *    adding axis·d to its position) moves the part exactly as FlightGear does;
 *  - geometry is MERGED per material inside each "merge frame" (a pivot, a toggled or otherwise
 *    special node, or the file root), which keeps draw calls low; every AC object still gets a
 *    node with its (sanitised) name, and `extras` say where its triangles went;
 *  - materials follow the AC material (sRGB colours → linear), the object's texture, the
 *    two-sided flag and the texture's alpha where the geometry samples it.
 *
 * Planning (`planGLB`) and writing (`writeGLB`) are separate so the texture formats can be
 * decided across every file first (a texture shared by two files gets one encoding).
 */
import { GltfBuilder } from './convert-lib-gltf.mjs';
import { simplifyGroup } from './convert-lib-geom.mjs';
import { walk } from './convert-lib-scene.mjs';
import { alphaAt } from './convert-lib-tex.mjs';

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
export const round3 = (v) => v.map(r4);

/** three.js-safe node name (GLTFLoader would strip `[ ] . : /` and replace whitespace). */
export function safeName(n) {
  return (n || 'node')
    .replace(/\s+/g, '_')
    .replace(/[.:/[\]]/g, '_')
    .replace(/[^\w\-+#@]/g, '_');
}

/**
 * @param {object} p
 * @param {string} p.name file label
 * @param {object[]} p.roots FG subtrees to include (children of the output root)
 * @param {(node) => string|null} p.channelOf names a pivot's channel
 * @param {(texRel) => object|null} p.textureInfo alpha data of a texture, or null to drop it
 * @param {object} [p.options] { separate: Set<name>, display: Map<name, kind>, hide: Set<name>,
 *   simplify: Map<name, cellSize>, lights: Map<name, id>, glass: Set<name> }
 */
export function planGLB(p) {
  const opt = p.options ?? {};
  const nodes = [];
  for (const r of p.roots) for (const n of walk(r)) nodes.push(n);

  // ---- rest origins and frames -------------------------------------------------------------
  const origin = new Map();
  const frameOf = new Map();
  const isRotPivot = (n) =>
    n.kind === 'pivot' && (n.pivot.type === 'rotate' || n.pivot.type === 'spin');
  const special = (n) =>
    n.kind === 'pivot' ||
    n.toggles.length > 0 ||
    n.uvAnims.length > 0 ||
    opt.separate?.has(n.name) ||
    opt.display?.has(n.name) ||
    opt.lights?.has(n.name) ||
    opt.glass?.has(n.name) ||
    n.forceSeparate;
  const visit = (n, parentOrigin, parentFrame) => {
    const o = isRotPivot(n) ? n.pivot.centre : parentOrigin;
    origin.set(n, o);
    const f = special(n) ? n : parentFrame;
    frameOf.set(n, f);
    for (const c of n.children) visit(c, o, f);
  };
  const ROOT = { kind: 'root', name: p.name, children: p.roots, toggles: [], uvAnims: [] };
  const rootOrigin = p.rootOrigin ?? [0, 0, 0];
  origin.set(ROOT, rootOrigin);
  for (const r of p.roots) visit(r, rootOrigin, ROOT);

  // ---- unique, stable names ----------------------------------------------------------------
  const nameOf = new Map();
  const base = new Map();
  const modelKey = (n) => {
    let m = n.parent;
    while (m && m.kind !== 'model') m = m.parent;
    return m ? m.outKey : '';
  };
  for (const n of nodes) {
    if (n.kind === 'model')
      n.outKey = safeName(
        n.name ||
          n.file
            .split('/')
            .pop()
            .replace(/\.xml$/, ''),
      );
  }
  for (const n of nodes) {
    let b;
    if (n.kind === 'model') b = n.outKey;
    else if (n.kind === 'pivot') b = null;
    else b = safeName(n.name);
    base.set(n, b);
  }
  // qualify names that occur in several sub-models with the sub-model key
  const owners = new Map();
  for (const n of nodes) {
    const b = base.get(n);
    if (!b || n.kind === 'model') continue;
    const k = modelKey(n);
    if (!owners.has(b)) owners.set(b, new Set());
    owners.get(b).add(k);
  }
  const used = new Map();
  const claim = (b) => {
    const k = used.get(b) ?? 0;
    used.set(b, k + 1);
    return k === 0 ? b : `${b}__${k + 1}`;
  };
  claim(safeName(p.name));
  for (const n of nodes) {
    if (n.kind === 'pivot') continue;
    let b = base.get(n);
    if (n.kind !== 'model' && (owners.get(b)?.size ?? 0) > 1 && modelKey(n))
      b = `${modelKey(n)}-${b}`;
    nameOf.set(n, claim(b));
  }
  // pivots: <first target>__<channel>
  for (const n of nodes) {
    if (n.kind !== 'pivot') continue;
    let first = null;
    for (const d of walk(n))
      if (d !== n && d.kind !== 'pivot' && d.name === n.targets[0]) {
        first = d;
        break;
      }
    const firstName = first ? nameOf.get(first) : safeName(n.targets[0]);
    const ch = safeName(p.channelOf?.(n) ?? 'anim');
    nameOf.set(n, claim(`${firstName}__${ch}`));
  }
  nameOf.set(ROOT, safeName(p.name));

  // ---- geometry: decide materials, merge per (frame, material) -------------------------------
  // The merge key leaves out the colour (kept per vertex, COLOR_0, when it varies) and the
  // roughness (one area-weighted value per key), so AC materials that differ only in shade or
  // shininess share a draw call.
  const matKeys = new Map(); // merge key → material description (colour/roughness filled later)
  const rough = new Map(); // merge key → { sum, weight }
  const merged = new Map(); // frame → Map(merge key → {pos,nrm,uv,col,idx})
  const objStats = new Map();
  const texUse = new Map(); // texRel → { needsAlpha }
  const partStats = [];
  for (const n of nodes) {
    if (n.kind !== 'object' || !n.geom || n.excluded) continue;
    if (opt.hide?.has(n.name) || opt.hidePattern?.test(n.name)) continue;
    const frame = frameOf.get(n);
    const fo = origin.get(frame === ROOT ? ROOT : frame) ?? [0, 0, 0];
    let tri = 0;
    for (const g of n.geom.groups.values()) {
      if (opt.simplify?.has(n.name)) simplifyGroup(g, opt.simplify.get(n.name));
      const acMat = n.materials[g.mat] ?? n.materials[0];
      const tex = n.texture ? p.textureInfo(n.texture) : null;
      const desc = describeMaterial(acMat, g, n, tex, opt);
      if (desc.hotspot) continue; // invisible click target: meta keeps its box
      if (tex && desc.map) {
        const u = texUse.get(n.texture) ?? { needsAlpha: false, materials: 0 };
        if (desc.alphaMode !== 'OPAQUE') u.needsAlpha = true;
        u.materials++;
        texUse.set(n.texture, u);
      }
      const { color, roughness, ...rest } = desc;
      if (rest.alphaMode !== 'BLEND') delete rest.opacity;
      const key = JSON.stringify(rest);
      if (!matKeys.has(key)) matKeys.set(key, rest);
      const ntri = g.idx.length / 3;
      const rw = rough.get(key) ?? { sum: 0, weight: 0 };
      rw.sum += roughness * Math.max(1, ntri);
      rw.weight += Math.max(1, ntri);
      rough.set(key, rw);
      let fm = merged.get(frame);
      if (!fm) merged.set(frame, (fm = new Map()));
      let acc = fm.get(key);
      if (!acc)
        fm.set(
          key,
          (acc = {
            pos: [],
            nrm: [],
            uv: [],
            col: [],
            idx: [],
            hasUv: !!rest.map || !!rest.keepUv,
          }),
        );
      const base0 = acc.pos.length / 3;
      for (let i = 0; i < g.pos.length; i += 3) {
        acc.pos.push(g.pos[i] - fo[0], g.pos[i + 1] - fo[1], g.pos[i + 2] - fo[2]);
        acc.col.push(color[0], color[1], color[2]);
      }
      for (let i = 0; i < g.nrm.length; i++) acc.nrm.push(g.nrm[i]);
      for (let i = 0; i < g.uv.length; i++) acc.uv.push(g.uv[i]);
      for (let i = 0; i < g.idx.length; i++) acc.idx.push(g.idx[i] + base0);
      tri += ntri;
    }
    objStats.set(n, tri);
    partStats.push({ name: nameOf.get(n), triangles: tri });
  }
  const roughOf = new Map(
    [...rough].map(([k, v]) => [k, Math.round((v.sum / v.weight) * 100) / 100]),
  );
  return {
    ...p,
    nodes,
    ROOT,
    origin,
    frameOf,
    nameOf,
    matKeys,
    roughOf,
    merged,
    objStats,
    texUse,
    partStats,
  };
}

/** Material description for one AC material on one object (merge key). */
function describeMaterial(m, g, node, tex, opt) {
  const trans = m.trans ?? 0;
  if (trans >= 0.999) return { hotspot: true };
  const name = node.name;
  const display = opt.display?.get(name) ?? null;
  const light = opt.lights?.get(name) ?? null;
  const glass = opt.glass?.has(name) ?? false;
  let alphaMode = 'OPAQUE';
  if (trans > 0) alphaMode = 'BLEND';
  let map = tex ? tex.out : null;
  if (tex && tex.alpha) {
    // sample the alpha where this geometry actually reads the texture
    let transparent = 0;
    let partial = 0;
    let samples = 0;
    const s = (u, v) => {
      const a = alphaAt(tex, u, v);
      samples++;
      if (a < 128) transparent++;
      if (a > 7 && a < 248) partial++;
    };
    for (let t = 0; t < g.idx.length; t += 3) {
      const a = g.idx[t] * 2;
      const b = g.idx[t + 1] * 2;
      const c = g.idx[t + 2] * 2;
      s(g.uv[a], g.uv[a + 1]);
      s((g.uv[a] + g.uv[b] + g.uv[c]) / 3, (g.uv[a + 1] + g.uv[b + 1] + g.uv[c + 1]) / 3);
      s((g.uv[a] + g.uv[b]) / 2, (g.uv[a + 1] + g.uv[b + 1]) / 2);
    }
    if (samples && (transparent || partial)) {
      if (alphaMode !== 'BLEND')
        alphaMode = partial / samples > 0.15 && tex.blendable ? 'BLEND' : 'MASK';
    }
  }
  if (display) map = null; // replaced at run time by a render target
  const rgb = m.rgb.map((c) => r4(srgbToLinear(Math.min(1, Math.max(0, c)))));
  const emis = m.emis.map((c) => r4(srgbToLinear(Math.min(1, Math.max(0, c)))));
  const spec = Math.max(...m.spec);
  const shi = m.shi ?? 0;
  let roughness = 1 - 0.75 * spec * Math.sqrt(Math.min(128, Math.max(0, shi)) / 128);
  roughness = Math.round(Math.min(0.9, Math.max(0.3, roughness)) * 10) / 10;
  const metallic = /chrome/i.test(m.name ?? '') ? 1 : 0;
  const d = {
    name: map ? map.replace(/\.(jpg|png)$/, '') : /chrome/i.test(m.name ?? '') ? 'chrome' : 'paint',
    color: rgb,
    opacity: r4(1 - trans),
    map,
    emissive: emis,
    alphaMode,
    doubleSided: g.twoSided,
    roughness,
    metallic,
  };
  if (display) {
    d.display = display;
    d.keepUv = true;
    d.color = [0.004, 0.006, 0.005];
    d.roughness = 0.3;
  }
  if (light) d.light = light;
  if (glass) d.glass = true;
  if (node.uvAnims.length) d.uvAnim = `${node.file}:${node.line}`;
  return d;
}

/**
 * Write a planned GLB. `texUri(texRel)` gives the image URI and mime type of a texture.
 * @returns {{ glb: Buffer, stats: object, names: Map }}
 */
export function writeGLB(plan, texUri, generator) {
  const b = new GltfBuilder(generator);
  // final material per (merge key, uniform colour or vertex colours)
  const finalKey = new Map(); // acc → final key
  const finals = new Map(); // final key → { desc, color, vc, uv: {min,max} }
  for (const fm of plan.merged.values())
    for (const [key, acc] of fm) {
      if (!acc.idx.length) continue;
      const c0 = acc.col.slice(0, 3);
      let uniform = true;
      for (let i = 3; i < acc.col.length && uniform; i += 3)
        if (
          Math.abs(acc.col[i] - c0[0]) +
            Math.abs(acc.col[i + 1] - c0[1]) +
            Math.abs(acc.col[i + 2] - c0[2]) >
          2e-4
        )
          uniform = false;
      const fk = `${key}|${uniform ? c0.join(',') : 'vc'}`;
      finalKey.set(acc, fk);
      acc.vc = !uniform;
      let f = finals.get(fk);
      if (!f)
        finals.set(fk, (f = { key, color: uniform ? c0 : [1, 1, 1], vc: !uniform, uv: null }));
      if (acc.hasUv) {
        f.uv ??= { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
        for (let i = 0; i < acc.uv.length; i += 2)
          for (let c = 0; c < 2; c++) {
            if (acc.uv[i + c] < f.uv.min[c]) f.uv.min[c] = acc.uv[i + c];
            if (acc.uv[i + c] > f.uv.max[c]) f.uv.max[c] = acc.uv[i + c];
          }
      }
    }
  const matIndex = new Map();
  const uvQuant = new Map();
  for (const [fk, f] of finals) {
    const d = plan.matKeys.get(f.key);
    const opacity = d.alphaMode === 'BLEND' ? (d.opacity ?? 1) : 1;
    const m = {
      name: d.name,
      pbrMetallicRoughness: {
        baseColorFactor: [...f.color, opacity],
        metallicFactor: d.metallic,
        roughnessFactor: plan.roughOf.get(f.key) ?? 0.7,
      },
      doubleSided: d.doubleSided,
      alphaMode: d.alphaMode,
    };
    if (d.alphaMode === 'MASK') m.alphaCutoff = 0.5;
    if (d.emissive.some((c) => c > 0)) m.emissiveFactor = d.emissive;
    const extras = {};
    if (d.map) {
      const r = f.uv;
      const min = r ? [r6(r.min[0]), r6(r.min[1])] : [0, 0];
      const scale = r
        ? [r6(Math.max(1e-6, r.max[0] - r.min[0])), r6(Math.max(1e-6, r.max[1] - r.min[1]))]
        : [1, 1];
      uvQuant.set(fk, { min, scale });
      const { uri, mimeType } = texUri(d.map);
      const tex = b.addTexture(uri, mimeType);
      const info = { index: tex, extensions: { KHR_texture_transform: { offset: min, scale } } };
      b.extensionsUsed.add('KHR_texture_transform');
      b.extensionsRequired.add('KHR_texture_transform');
      m.pbrMetallicRoughness.baseColorTexture = info;
      if (m.emissiveFactor) m.emissiveTexture = JSON.parse(JSON.stringify(info));
      extras.texture = d.map;
    }
    if (d.display) extras.display = d.display;
    if (d.light) extras.light = d.light;
    if (d.glass) extras.glass = true;
    if (d.uvAnim) extras.uvAnim = true;
    if (Object.keys(extras).length) m.extras = extras;
    matIndex.set(fk, b.addMaterial(m));
  }

  const emitNode = (n) => {
    const parent = n.parent && plan.origin.has(n.parent) ? n.parent : plan.ROOT;
    const o = plan.origin.get(n) ?? [0, 0, 0];
    const po = plan.origin.get(parent) ?? [0, 0, 0];
    const node = { name: plan.nameOf.get(n) };
    const t = [o[0] - po[0], o[1] - po[1], o[2] - po[2]];
    if (n !== plan.ROOT && t.some((v) => Math.abs(v) > 1e-9)) node.translation = t.map(r6);
    const extras = {};
    if (n.kind === 'object' || n.kind === 'group') {
      extras.acName = n.name;
      extras.src = `${n.file}:${n.line}`;
      if (plan.objStats.has(n)) extras.triangles = plan.objStats.get(n);
    }
    if (n.kind === 'model') {
      extras.model = n.file;
      if (n.offsets) extras.offsets = n.offsets;
    }
    if (n.kind === 'pivot') extras.pivot = pivotExtras(n.pivot, n.targets);
    if (Object.keys(extras).length) node.extras = extras;
    const children = [];
    // merged geometry of this frame
    const fm = plan.merged.get(n);
    if (fm && fm.size) {
      const prims = [];
      for (const [key, acc] of fm) {
        if (!acc.idx.length) continue;
        const d = plan.matKeys.get(key);
        const fk = finalKey.get(acc);
        prims.push({
          pos: acc.pos,
          nrm: acc.nrm,
          uv: acc.hasUv ? acc.uv : null,
          col: acc.vc ? acc.col : null,
          idx: acc.idx,
          material: matIndex.get(fk),
          uvRange: d.map ? uvQuant.get(fk) : null,
          uvFloat: !d.map && acc.hasUv,
        });
      }
      if (prims.length) {
        const holderName = `${node.name}__geo`;
        const { mesh, translation, scale } = b.addMesh(holderName, prims);
        children.push(
          b.addNode({
            name: holderName,
            mesh,
            translation: translation.map(r6),
            scale: [scale, scale, scale].map((v) => Number(v.toPrecision(9))),
          }),
        );
      }
    }
    for (const c of n.children) children.push(emitNode(c));
    if (children.length) node.children = children;
    return b.addNode(node);
  };
  const root = emitNode(plan.ROOT);
  b.json.scenes[0].nodes.push(root);
  const glb = b.toGLB();
  return {
    glb,
    stats: { ...b.stats, materials: b.json.materials?.length ?? 0, nodes: b.json.nodes.length },
  };
}

export function pivotExtras(pv, targets) {
  const e = {
    type: pv.type,
    axis: round3(pv.axis),
    centre: round3(pv.centre),
  };
  if (pv.property) e.property = pv.property;
  if (targets) e.targets = targets;
  return e;
}
