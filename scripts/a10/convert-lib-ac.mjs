/**
 * AC3D (.ac) reader for the A-10 model converter (scripts/a10/convert-ac3d.mjs).
 *
 * Reads the text format as data only. Supports everything the FlightGear A-10 files use
 * (MATERIAL, OBJECT world/group/poly, name, data, texture, texrep, texoff, crease, loc, rot,
 * url, numvert, numsurf/SURF/mat/refs, kids) and tolerates truncated files (declared kids that
 * never come are reported, not fatal).
 */

/** Split a line into tokens, honouring double-quoted strings. */
function tokens(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i >= n) break;
    if (line[i] === '"') {
      const end = line.indexOf('"', i + 1);
      if (end < 0) {
        out.push(line.slice(i + 1));
        break;
      }
      out.push(line.slice(i + 1, end));
      i = end + 1;
    } else {
      let j = i;
      while (j < n && line[j] !== ' ' && line[j] !== '\t') j++;
      out.push(line.slice(i, j));
      i = j;
    }
  }
  return out;
}

/**
 * Parse an AC3D file.
 * @param {string} text file contents (latin-1 decoded)
 * @param {string} file path, for messages
 * @returns {{ materials: object[], root: object, warnings: string[] }}
 *   Object: { type, name, line, data, texture, texrep, texoff, crease, loc, rot, url,
 *             verts: Float64Array (x,y,z…), surfs: [{flags, mat, refs: Int32Array, uvs: Float64Array, line}],
 *             kids: Object[] }
 */
export function parseAC(text, file) {
  const lines = text.split(/\r?\n/);
  const warnings = [];
  let i = 0;
  if (!lines[0] || !lines[0].startsWith('AC3D')) throw new Error(`${file}: not an AC3D file`);
  i = 1;
  const materials = [];

  function nextNonEmpty() {
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) return null;
    return lines[i];
  }

  function parseMaterial(line, lineNo) {
    const tk = tokens(line);
    const m = {
      name: tk[1],
      rgb: [1, 1, 1],
      amb: [0.2, 0.2, 0.2],
      emis: [0, 0, 0],
      spec: [0, 0, 0],
      shi: 0,
      trans: 0,
      line: lineNo,
    };
    for (let j = 2; j < tk.length;) {
      const k = tk[j];
      if (k === 'rgb' || k === 'amb' || k === 'emis' || k === 'spec') {
        m[k] = [Number(tk[j + 1]), Number(tk[j + 2]), Number(tk[j + 3])];
        j += 4;
      } else if (k === 'shi' || k === 'trans') {
        m[k] = Number(tk[j + 1]);
        j += 2;
      } else j++;
    }
    return m;
  }

  function parseObject() {
    const head = nextNonEmpty();
    if (head === null) throw new EOFError();
    const lineNo = i + 1;
    const ht = tokens(head);
    if (ht[0] !== 'OBJECT') throw new Error(`${file}:${lineNo}: expected OBJECT, got "${head}"`);
    i++;
    const o = {
      type: ht[1],
      name: null,
      line: lineNo,
      data: null,
      texture: null,
      texrep: null,
      texoff: null,
      crease: null,
      loc: null,
      rot: null,
      url: null,
      verts: new Float64Array(0),
      surfs: [],
      kids: [],
    };
    for (;;) {
      const raw = nextNonEmpty();
      if (raw === null) throw new EOFError();
      const tk = tokens(raw);
      const key = tk[0];
      i++;
      switch (key) {
        case 'name':
          o.name = tk[1] ?? '';
          break;
        case 'data': {
          const count = Number(tk[1]);
          let buf = '';
          while (buf.length < count && i < lines.length) {
            buf += lines[i++];
            if (buf.length < count) buf += '\n';
          }
          o.data = buf;
          break;
        }
        case 'texture':
          o.texture = tk[1];
          break;
        case 'texrep':
          o.texrep = [Number(tk[1]), Number(tk[2])];
          break;
        case 'texoff':
          o.texoff = [Number(tk[1]), Number(tk[2])];
          break;
        case 'crease':
          o.crease = Number(tk[1]);
          break;
        case 'loc':
          o.loc = [Number(tk[1]), Number(tk[2]), Number(tk[3])];
          break;
        case 'rot':
          o.rot = tk.slice(1, 10).map(Number);
          break;
        case 'url':
          o.url = tk[1];
          break;
        case 'subdiv':
        case 'hidden':
        case 'locked':
        case 'folded':
          break;
        case 'numvert': {
          const nv = Number(tk[1]);
          const v = new Float64Array(nv * 3);
          for (let k = 0; k < nv; k++) {
            const p = lines[i++].trim().split(/\s+/);
            v[k * 3] = Number(p[0]);
            v[k * 3 + 1] = Number(p[1]);
            v[k * 3 + 2] = Number(p[2]);
          }
          o.verts = v;
          break;
        }
        case 'numsurf': {
          const ns = Number(tk[1]);
          for (let s = 0; s < ns; s++) {
            const sl = nextNonEmpty();
            if (sl === null) throw new EOFError();
            const st = tokens(sl);
            if (st[0] !== 'SURF') throw new Error(`${file}:${i + 1}: expected SURF, got "${sl}"`);
            // flags are written 0x30 or 0X30 (Blender exports)
            const surf = { flags: Number(st[1]) | 0, mat: 0, refs: null, uvs: null, line: i + 1 };
            i++;
            for (;;) {
              const ml = nextNonEmpty();
              if (ml === null) throw new EOFError();
              const mt = tokens(ml);
              i++;
              if (mt[0] === 'mat') surf.mat = Number(mt[1]);
              else if (mt[0] === 'refs') {
                const nr = Number(mt[1]);
                const refs = new Int32Array(nr);
                const uvs = new Float64Array(nr * 2);
                for (let r = 0; r < nr; r++) {
                  const p = lines[i++].trim().split(/\s+/);
                  refs[r] = Number(p[0]);
                  uvs[r * 2] = p.length > 1 ? Number(p[1]) : 0;
                  uvs[r * 2 + 1] = p.length > 2 ? Number(p[2]) : 0;
                }
                surf.refs = refs;
                surf.uvs = uvs;
                break;
              } else warnings.push(`${file}:${i}: unknown surface token "${mt[0]}"`);
            }
            o.surfs.push(surf);
          }
          break;
        }
        case 'kids': {
          const nk = Number(tk[1]);
          for (let k = 0; k < nk; k++) {
            try {
              o.kids.push(parseObject());
            } catch (e) {
              if (e instanceof EOFError) {
                warnings.push(`${file}: "${o.name}" declares ${nk} kids, file ends after ${k}`);
                return o;
              }
              throw e;
            }
          }
          return o;
        }
        default:
          warnings.push(`${file}:${i}: unknown token "${key}"`);
      }
    }
  }

  for (;;) {
    const l = nextNonEmpty();
    if (l === null) throw new Error(`${file}: no OBJECT`);
    if (l.startsWith('MATERIAL')) {
      materials.push(parseMaterial(l, i + 1));
      i++;
      continue;
    }
    if (l.startsWith('OBJECT')) break;
    warnings.push(`${file}:${i + 1}: unexpected line before OBJECT`);
    i++;
  }
  let root;
  try {
    root = parseObject();
  } catch (e) {
    if (e instanceof EOFError) throw new Error(`${file}: truncated before the root object ended`);
    throw e;
  }
  return { materials, root, warnings };
}

class EOFError extends Error {
  constructor() {
    super('unexpected end of file');
  }
}

/**
 * Walk an AC object tree, giving each object its cumulative transform as a function that maps a
 * local AC point to the file's root frame. AC/OSG semantics: v' = v·rot + loc (row vector),
 * the child's transform first, then each parent's.
 */
export function acWorldTransforms(root) {
  const out = new Map();
  function rec(o, parent) {
    // 3x4 matrix, column-vector form: p' = R p + t
    const R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const t = [0, 0, 0];
    if (o.rot) {
      // row-vector v·rot ⇒ column form R = rotᵀ
      const r = o.rot;
      R[0] = r[0];
      R[1] = r[3];
      R[2] = r[6];
      R[3] = r[1];
      R[4] = r[4];
      R[5] = r[7];
      R[6] = r[2];
      R[7] = r[5];
      R[8] = r[8];
    }
    if (o.loc) {
      t[0] = o.loc[0];
      t[1] = o.loc[1];
      t[2] = o.loc[2];
    }
    // world = parent ∘ local
    let W;
    if (!parent) W = { R, t };
    else {
      const P = parent;
      const R2 = new Array(9);
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++)
          R2[r * 3 + c] = P.R[r * 3] * R[c] + P.R[r * 3 + 1] * R[3 + c] + P.R[r * 3 + 2] * R[6 + c];
      const t2 = [
        P.R[0] * t[0] + P.R[1] * t[1] + P.R[2] * t[2] + P.t[0],
        P.R[3] * t[0] + P.R[4] * t[1] + P.R[5] * t[2] + P.t[1],
        P.R[6] * t[0] + P.R[7] * t[1] + P.R[8] * t[2] + P.t[2],
      ];
      W = { R: R2, t: t2 };
    }
    out.set(o, W);
    for (const k of o.kids) rec(k, W);
  }
  rec(root, null);
  return out;
}
