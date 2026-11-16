/**
 * FlightGear model assembly for the A-10 converter: reads a model XML, its AC3D file and its
 * sub-models (with <offsets>), bakes every vertex into the output frame, and applies the XML's
 * <animation> list with FlightGear's semantics:
 *
 *  - an animation inserts ONE transform node per parent group, between the named nodes and that
 *    parent; a later animation on the same node is inserted inside the earlier one (the first
 *    declared animation is the outermost transform);
 *  - centres and axes are in the XML's model frame (sub-model offsets applied), angles in
 *    degrees, positive = right-handed about the axis;
 *  - sub-models are loaded (with their own animations) before the parent's animations run.
 *
 * Nothing from the package is executed; Nasal and bindings are recorded as text only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { acWorldTransforms, parseAC } from './convert-lib-ac.mjs';
import {
  AC_TO_FG,
  applyDir,
  applyPoint,
  buildObjectGeometry,
  compose,
  normalize3,
  offsetsTransform,
} from './convert-lib-geom.mjs';
import { all, child, num, parseXml, text } from './convert-lib-xml.mjs';

const D2R = Math.PI / 180;

/** Reads files of the FlightGear package (relative paths), remembering what was read. */
export class SourceTree {
  constructor(root) {
    this.root = root;
    this.used = new Set();
  }
  abs(rel) {
    return posix.join(this.root, rel);
  }
  exists(rel) {
    return existsSync(this.abs(rel));
  }
  bytes(rel) {
    this.used.add(rel);
    return readFileSync(this.abs(rel));
  }
  text(rel) {
    return this.bytes(rel).toString('latin1');
  }
  /** Resolve a path written in a file of directory `dir` (FG accepts Aircraft/A-10/… paths). */
  resolve(dir, ref) {
    const r = ref.trim().replace(/\\/g, '/');
    const m = /^\/?Aircraft\/A-10\/(.*)$/.exec(r);
    if (m) return posix.normalize(m[1]);
    if (r.startsWith('/')) return null; // outside the package (FGData)
    return posix.normalize(posix.join(dir, r));
  }
}

let nodeSerial = 0;
export function makeNode(kind, name, extra = {}) {
  return {
    id: nodeSerial++,
    kind,
    name: name ?? '',
    children: [],
    parent: null,
    toggles: [],
    uvAnims: [],
    picks: [],
    lods: [],
    materialAnims: [],
    ...extra,
  };
}

export function appendChild(parent, node) {
  if (node.parent) {
    const i = node.parent.children.indexOf(node);
    if (i >= 0) node.parent.children.splice(i, 1);
  }
  node.parent = parent;
  parent.children.push(node);
}

export function* walk(node) {
  yield node;
  for (const c of node.children) yield* walk(c);
}

export function findByName(root, name) {
  const out = [];
  for (const n of walk(root)) if (n.name === name) out.push(n);
  return out;
}

/** Load an AC3D file into nodes, baking every object into the output frame through `xf`. */
export function loadAC(src, acRel, xf, ctx) {
  const parsed = parseAC(src.text(acRel), acRel);
  for (const w of parsed.warnings) ctx.warn(w);
  return acTreeToNodes(parsed, acRel, xf, ctx, (t) => src.resolve(posix.dirname(acRel), t));
}

/**
 * Turn a parsed AC tree ({ materials, root }) into scene nodes. Also used for geometry built in
 * code (convert-lib-build.mjs), which produces the same structure.
 */
export function acTreeToNodes(parsed, acRel, xf, ctx, resolveTexture) {
  const worldOf = acWorldTransforms(parsed.root);
  const convertObj = (o) => {
    const name = o.name ?? '';
    const kind = o.type === 'poly' ? 'object' : 'group';
    const node = makeNode(kind, name, { file: acRel, line: o.line, acType: o.type });
    if (o.type === 'poly') {
      const W = worldOf.get(o);
      const total = compose(xf, compose(AC_TO_FG, W));
      node.xf = total;
      node.texture = o.texture ? resolveTexture(o.texture) : null;
      node.materials = parsed.materials;
      if (ctx.filterObject && !ctx.filterObject(acRel, name, o)) node.excluded = true;
      else node.geom = buildObjectGeometry(o, total, { crease: 61 });
      // 2-vertex line objects define hinge axes
      const lineOnly = o.surfs.length > 0 && o.surfs.every((s) => (s.flags & 0xf) !== 0);
      if (lineOnly && o.verts.length === 6) {
        node.lineVerts = [
          applyPoint(total, o.verts[0], o.verts[1], o.verts[2]),
          applyPoint(total, o.verts[3], o.verts[4], o.verts[5]),
        ];
      }
    }
    for (const k of o.kids) appendChild(node, convertObj(k));
    return node;
  };
  // the AC "world" becomes a transparent group: its kids are the file's top-level objects
  const root = makeNode('group', '', { file: acRel, line: parsed.root.line, acType: 'world' });
  if (parsed.root.type === 'world') for (const k of parsed.root.kids) appendChild(root, convertObj(k));
  else appendChild(root, convertObj(parsed.root));
  return root;
}

/**
 * Load a model XML with its AC file and sub-models.
 * @param {SourceTree} src
 * @param {string} xmlRel
 * @param {{R:number[], t:number[]}} xf FG frame of this XML → output frame
 * @param {object} ctx { warn, skipModel(rel) → reason|null, filterObject, anims: [] }
 * @param {string} [modelName]
 */
export function loadModel(src, xmlRel, xf, ctx, modelName = '') {
  const xml = parseXml(src.text(xmlRel), xmlRel);
  const dir = posix.dirname(xmlRel);
  const model = makeNode('model', modelName, { file: xmlRel, line: 1, xf, xml });
  const acPath = text(xml, 'path');
  if (acPath) {
    const acRel = src.resolve(dir, acPath);
    if (acRel && src.exists(acRel)) {
      model.ac = acRel;
      const acRoot = loadAC(src, acRel, xf, ctx);
      // splice the AC root's children into the model node (the world is transparent)
      for (const c of [...acRoot.children]) appendChild(model, c);
    } else {
      model.missing = acPath;
      const standIn = ctx.standIn?.(xmlRel);
      if (standIn) {
        const label = `(built in code for ${xmlRel})`;
        const world = { type: 'world', name: null, line: 0, kids: standIn.kids, verts: new Float64Array(0), surfs: [] };
        const nodes = acTreeToNodes({ materials: standIn.materials, root: world }, label, xf, ctx, () => null);
        for (const c of [...nodes.children]) appendChild(model, c);
        model.standIn = true;
      } else ctx.warn(`${xmlRel}: model geometry ${acPath} is not in the package`);
    }
  }
  for (const m of all(xml, 'model')) {
    const subPath = text(m, 'path');
    if (!subPath) continue;
    const subRel = src.resolve(dir, subPath);
    const reason = !subRel || !src.exists(subRel) ? 'missing' : ctx.skipModel?.(subRel, m);
    const name = text(m, 'name') ?? '';
    const o = child(m, 'offsets');
    const offsets = {
      x: num(o, 'x-m', 0),
      y: num(o, 'y-m', 0),
      z: num(o, 'z-m', 0),
      h: num(o, 'heading-deg', 0),
      p: num(o, 'pitch-deg', 0),
      r: num(o, 'roll-deg', 0),
    };
    if (reason) {
      model.skipped ??= [];
      model.skipped.push({ path: subRel ?? subPath, name, reason, line: m.line, offsets });
      continue;
    }
    const subXf = compose(xf, offsetsTransform(offsets));
    const sub = loadModel(src, subRel, subXf, ctx, name);
    sub.offsets = offsets;
    sub.includeLine = m.line;
    sub.includedFrom = xmlRel;
    appendChild(model, sub);
  }
  for (const a of all(xml, 'animation')) applyAnimation(model, a, xmlRel, xf, ctx);
  return model;
}

/** Serialise a FlightGear <condition> to a compact readable string. */
export function conditionString(c) {
  if (!c) return 'true';
  const parts = c.children.filter((k) => k.tag);
  const one = (k) => {
    switch (k.tag) {
      case 'and':
      case 'or':
        return `${k.tag}(${k.children
          .filter((x) => x.tag)
          .map(one)
          .join(', ')})`;
      case 'not':
        return `not(${k.children
          .filter((x) => x.tag)
          .map(one)
          .join(', ')})`;
      case 'property':
        return k.text;
      case 'value':
        return JSON.stringify(k.text);
      default:
        return `${k.tag}(${k.children
          .filter((x) => x.tag)
          .map(one)
          .join(', ')})`;
    }
  };
  return parts.length === 1 ? one(parts[0]) : `and(${parts.map(one).join(', ')})`;
}

/**
 * Evaluate a <condition> with every property at its default (0 / '' / false), giving the
 * visibility FlightGear shows with nothing switched on.
 */
export function evalConditionDefault(c, props = {}) {
  if (!c) return true;
  const val = (k) => {
    if (k.tag === 'property') return props[k.text.replace(/^\//, '')] ?? 0;
    if (k.tag === 'value') {
      const n = Number(k.text);
      return k.text.trim() !== '' && Number.isFinite(n) ? n : k.text;
    }
    return ev(k) ? 1 : 0;
  };
  const cmp = (k, f) => {
    const [a, b] = k.children.filter((x) => x.tag).map(val);
    if (typeof a === 'number' && typeof b === 'number') return f(a, b);
    return f(String(a), String(b));
  };
  const ev = (k) => {
    const kids = k.children.filter((x) => x.tag);
    switch (k.tag) {
      case 'condition':
      case 'and':
        return kids.every(ev);
      case 'or':
        return kids.some(ev);
      case 'not':
        return !kids.every(ev);
      case 'property':
        return Boolean(val(k));
      case 'equals':
        return cmp(k, (a, b) => a === b);
      case 'not-equals':
        return cmp(k, (a, b) => a !== b);
      case 'greater-than':
        return cmp(k, (a, b) => a > b);
      case 'greater-than-equals':
        return cmp(k, (a, b) => a >= b);
      case 'less-than':
        return cmp(k, (a, b) => a < b);
      case 'less-than-equals':
        return cmp(k, (a, b) => a <= b);
      default:
        return true;
    }
  };
  return ev(c);
}

function parseTable(a) {
  const t = all(child(a, 'interpolation'), 'entry').map((e) => [num(e, 'ind', 0), num(e, 'dep', 0)]);
  t.sort((p, q) => p[0] - q[0]);
  return t.length ? t : null;
}

function parseBindings(a) {
  const out = [];
  for (const tag of ['action', 'increase', 'decrease', 'release']) {
    for (const act of all(a, tag)) {
      for (const b of all(act, 'binding')) {
        const e = { on: tag, command: text(b, 'command') ?? '' };
        for (const k of ['property', 'value', 'step', 'min', 'max', 'wrap', 'factor', 'offset']) {
          const v = text(b, k);
          if (v !== null) e[k] = v;
        }
        const script = text(b, 'script');
        if (script) e.script = script.replace(/\s+/g, ' ').trim().slice(0, 200);
        out.push(e);
      }
    }
  }
  return out;
}

/** Transform-type animation → pivot description in the output frame. */
function parseTransformAnim(model, a, type, xf, file, ctx) {
  const property = text(a, 'property');
  const factor = num(a, 'factor', 1);
  const isRot = type === 'rotate' || type === 'spin' || type === 'knob';
  const offset = isRot ? num(a, 'offset-deg', 0) : num(a, 'offset-m', 0);
  const min = isRot ? num(a, 'min-deg', null) : num(a, 'min-m', null);
  const max = isRot ? num(a, 'max-deg', null) : num(a, 'max-m', null);
  const table = parseTable(a);
  let centre = null;
  let axis = null;
  const c = child(a, 'center');
  if (c) centre = [num(c, 'x-m', 0), num(c, 'y-m', 0), num(c, 'z-m', 0)];
  const ax = child(a, 'axis');
  let axisFromLine = null;
  if (ax) {
    if (child(ax, 'x1-m') || child(ax, 'x2-m')) {
      const p1 = [num(ax, 'x1-m', 0), num(ax, 'y1-m', 0), num(ax, 'z1-m', 0)];
      const p2 = [num(ax, 'x2-m', 0), num(ax, 'y2-m', 0), num(ax, 'z2-m', 0)];
      axis = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
      centre = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2];
    } else if (child(ax, 'object-name')) {
      axisFromLine = text(ax, 'object-name');
    } else {
      axis = [num(ax, 'x', 0), num(ax, 'y', 0), num(ax, 'z', 0)];
    }
  }
  let centreOut;
  let axisOut;
  if (axisFromLine) {
    const lines = findByName(model, axisFromLine).filter((n) => n.lineVerts);
    if (!lines.length) {
      ctx.warn(`${file}:${a.line}: axis object ${axisFromLine} not found`);
      return null;
    }
    const [p0, p1] = lines[0].lineVerts;
    let d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    if (child(ax, 'swap-axis-direction') && text(ax, 'swap-axis-direction') !== 'false')
      d = [-d[0], -d[1], -d[2]];
    axisOut = normalize3(d);
    centreOut = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
  } else {
    if (!axis || Math.hypot(...axis) < 1e-12) {
      if (type === 'translate' || type === 'slider') axis = [1, 0, 0];
      else {
        ctx.warn(`${file}:${a.line}: ${type} without an axis`);
        return null;
      }
    }
    axisOut = normalize3(applyDir(xf, axis[0], axis[1], axis[2]));
    const cc = centre ?? [0, 0, 0];
    centreOut = applyPoint(xf, cc[0], cc[1], cc[2]);
  }
  const unit = isRot ? D2R : 1;
  return {
    type: type === 'knob' ? 'rotate' : type === 'slider' ? 'translate' : type,
    fgType: type,
    axis: axisOut,
    centre: centreOut,
    property,
    factor,
    offset,
    min,
    max,
    table,
    // the same in SI (rad or m per property unit)
    gain: factor * unit,
    offsetSI: offset * unit,
    minSI: min === null ? null : min * unit,
    maxSI: max === null ? null : max * unit,
    tableSI: table ? table.map(([i, d]) => [i, d * unit]) : null,
    file,
    line: a.line,
    axisFromLine,
  };
}

/** Insert one pivot per parent group around the named nodes (FlightGear semantics). */
export function insertPivots(root, names, info, animName) {
  const created = [];
  const visit = (g) => {
    for (const c of [...g.children]) visit(c);
    const matched = [];
    for (const nm of names)
      for (const c of g.children) if (c.name === nm && !matched.includes(c) && !c.isPivotOf) matched.push(c);
    if (!matched.length) return;
    const p = makeNode('pivot', animName ?? '', { pivot: { ...info }, targets: matched.map((m) => m.name) });
    p.isPivotOf = true;
    appendChild(g, p);
    for (const m of matched) appendChild(p, m);
    created.push(p);
  };
  visit(root);
  for (const p of created) delete p.isPivotOf;
  return created;
}

export function applyAnimation(model, a, file, xf, ctx) {
  const type = (text(a, 'type') ?? '').trim();
  const names = all(a, 'object-name').map((n) => n.text.trim());
  const animName = text(a, 'name');
  const targets = () => {
    const out = [];
    for (const nm of names) out.push(...findByName(model, nm));
    return out;
  };
  const rec = { file, line: a.line, type };
  switch (type) {
    case 'rotate':
    case 'spin':
    case 'knob':
    case 'translate':
    case 'slider': {
      const hasAxis = child(a, 'axis') || child(a, 'property');
      if ((type === 'knob' || type === 'slider') && !hasAxis) {
        // a knob that only clicks (increase/decrease bindings): a pick, no transform
        const bindings = parseBindings(a);
        for (const t of targets()) t.picks.push({ ...rec, kind: type, property: null, bindings });
        return;
      }
      const info = parseTransformAnim(model, a, type, xf, file, ctx);
      if (!info) return;
      if (!names.length) {
        ctx.warn(`${file}:${a.line}: ${type} without object-name ignored`);
        return;
      }
      const created = insertPivots(model, names, info, animName);
      if (!created.length) ctx.warn(`${file}:${a.line}: ${type} targets not found: ${names.join(', ')}`);
      if (type === 'knob' || type === 'slider') {
        const bindings = parseBindings(a);
        for (const t of targets()) t.picks.push({ ...rec, kind: type, property: info.property, bindings });
      }
      ctx.anims?.push({ ...rec, names, created: created.length });
      break;
    }
    case 'select': {
      const c = child(a, 'condition');
      const cond = conditionString(c);
      const dflt = evalConditionDefault(c, ctx.defaultProps);
      const ts = targets();
      if (!ts.length) ctx.warn(`${file}:${a.line}: select targets not found: ${names.join(', ')}`);
      for (const t of ts) t.toggles.push({ ...rec, cond, default: dflt });
      break;
    }
    case 'textranslate': {
      const ax = child(a, 'axis');
      const info = {
        ...rec,
        property: text(a, 'property'),
        factor: num(a, 'factor', 1),
        offset: num(a, 'offset', 0),
        step: num(a, 'step', null),
        scroll: num(a, 'scroll', null),
        min: num(a, 'min', null),
        max: num(a, 'max', null),
        table: parseTable(a),
        axis: [num(ax, 'x', 0), num(ax, 'y', 0), num(ax, 'z', 0)],
      };
      for (const t of targets()) t.uvAnims.push(info);
      break;
    }
    case 'pick': {
      const bindings = parseBindings(a);
      for (const t of targets()) t.picks.push({ ...rec, kind: 'pick', bindings });
      break;
    }
    case 'range': {
      const r = { ...rec, min: num(a, 'min-m', 0), max: num(a, 'max-m', Infinity) };
      if (names.length) for (const t of targets()) t.lods.push(r);
      else model.lods.push(r);
      break;
    }
    case 'noshadow':
      for (const t of targets()) t.noshadow = true;
      break;
    case 'material': {
      const em = child(a, 'emission');
      const info = {
        ...rec,
        texture: text(a, 'texture'),
        textureProp: text(a, 'texture-prop'),
        emission: em
          ? {
              factorProp: text(em, 'factor-prop'),
              rgb: [num(em, 'red', 0), num(em, 'green', 0), num(em, 'blue', 0)],
            }
          : null,
      };
      for (const t of targets()) t.materialAnims.push(info);
      break;
    }
    default:
      ctx.skippedAnims ??= {};
      ctx.skippedAnims[type] = (ctx.skippedAnims[type] ?? 0) + 1;
  }
}
