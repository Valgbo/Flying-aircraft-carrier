/**
 * Texture atlas for the A-10 converter: packs opaque, non-tiling textures of one planned GLB into
 * a few pages so that the static meshes that used ninety textures draw with a handful of calls.
 *
 * Each texture gets a power-of-two slot sized by the texel density its geometry needs
 * (`texelsPerMetre`), capped by the source size and `maxSlot`. Inside the slot the image is
 * shrunk by `pad` pixels per side and its edge pixels are extended into the border, so bilinear
 * filtering and the first mip levels do not bleed between neighbours.
 */
import { execFileSync } from 'node:child_process';

function ceilPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
function floorPow2(n) {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/** Texel density demand of each texture in a plan: { physArea m², uvArea } by texture id. */
export function textureDemand(plan) {
  const out = new Map();
  for (const fm of plan.merged.values())
    for (const [key, acc] of fm) {
      const d = plan.matKeys.get(key);
      if (!d.map) continue;
      let e = out.get(d.map);
      if (!e) out.set(d.map, (e = { physArea: 0, uvArea: 0 }));
      for (let t = 0; t < acc.idx.length; t += 3) {
        const a = acc.idx[t];
        const b = acc.idx[t + 1];
        const c = acc.idx[t + 2];
        const P = acc.pos;
        const ux = P[b * 3] - P[a * 3];
        const uy = P[b * 3 + 1] - P[a * 3 + 1];
        const uz = P[b * 3 + 2] - P[a * 3 + 2];
        const vx = P[c * 3] - P[a * 3];
        const vy = P[c * 3 + 1] - P[a * 3 + 1];
        const vz = P[c * 3 + 2] - P[a * 3 + 2];
        e.physArea += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
        const U = acc.uv;
        e.uvArea +=
          Math.abs(
            (U[b * 2] - U[a * 2]) * (U[c * 2 + 1] - U[a * 2 + 1]) -
              (U[c * 2] - U[a * 2]) * (U[b * 2 + 1] - U[a * 2 + 1]),
          ) / 2;
      }
    }
  return out;
}

/** Slot size (pixels, power of two) for a texture. */
export function slotSize(demand, srcW, srcH, { texelsPerMetre, maxSlot, minSlot = 32 }) {
  const src = floorPow2(Math.min(srcW, srcH));
  if (!demand || demand.uvArea <= 1e-9) return Math.min(src, maxSlot);
  const need = texelsPerMetre * Math.sqrt(demand.physArea / demand.uvArea);
  return Math.max(minSlot, Math.min(src, maxSlot, ceilPow2(need)));
}

/**
 * Atlas the eligible materials of a plan in place.
 * @param {object} plan from planGLB
 * @param {object} o { prefix, page, pad, sizeOf(texId) → slot px, eligible(desc) → bool }
 * @returns {{ pages: {id:string, size:number, tiles:{tex:string,x:number,y:number,s:number}[]}[] }}
 */
export function atlasPlan(plan, o) {
  const { page, pad } = o;
  // which (frame, key) accumulators qualify
  const cand = [];
  const texSet = new Set();
  for (const [frame, fm] of plan.merged)
    for (const [key, acc] of fm) {
      const d = plan.matKeys.get(key);
      if (!d.map || !o.eligible(d) || !acc.idx.length) continue;
      let ok = true;
      for (let i = 0; i < acc.uv.length && ok; i++)
        if (acc.uv[i] < -0.004 || acc.uv[i] > 1.004) ok = false;
      if (!ok) continue;
      cand.push({ frame, key, acc, d });
      texSet.add(d.map);
    }
  // pack: largest first into square pages (power-of-two slots pack without gaps)
  const tiles = [...texSet]
    .map((tex) => ({ tex, s: o.sizeOf(tex) }))
    .sort((a, b) => b.s - a.s || (a.tex < b.tex ? -1 : 1));
  const pages = [];
  const where = new Map();
  for (const t of tiles) {
    let placed = false;
    for (const p of pages) {
      const spot = findSpot(p, t.s);
      if (spot) {
        p.tiles.push({ ...t, ...spot });
        p.used.push({ x: spot.x, y: spot.y, s: t.s });
        where.set(t.tex, { page: p, x: spot.x, y: spot.y, s: t.s });
        placed = true;
        break;
      }
    }
    if (!placed) {
      const p = { id: `${o.prefix}-${pages.length}`, size: page, tiles: [], used: [] };
      pages.push(p);
      const spot = findSpot(p, t.s);
      p.tiles.push({ ...t, ...spot });
      p.used.push({ x: spot.x, y: spot.y, s: t.s });
      where.set(t.tex, { page: p, x: spot.x, y: spot.y, s: t.s });
    }
  }
  // shrink pages that are less than half full to the smallest square that holds them
  for (const p of pages) {
    let ext = 0;
    for (const u of p.used) ext = Math.max(ext, u.x + u.s, u.y + u.s);
    p.size = ceilPow2(ext);
  }
  // remap UVs and re-merge per frame under the page material
  for (const c of cand) {
    const w = where.get(c.d.map);
    const W = w.page.size;
    const inner = w.s - 2 * pad;
    const { acc } = c;
    for (let i = 0; i < acc.uv.length; i += 2) {
      acc.uv[i] = (w.x + pad + Math.min(1, Math.max(0, acc.uv[i])) * inner) / W;
      acc.uv[i + 1] = (w.y + pad + Math.min(1, Math.max(0, acc.uv[i + 1])) * inner) / W;
    }
    const nd = { ...c.d, map: w.page.id, name: w.page.id };
    const nkey = JSON.stringify(nd);
    if (!plan.matKeys.has(nkey)) plan.matKeys.set(nkey, nd);
    const r0 = plan.roughOf.get(nkey);
    const r1 = plan.roughOf.get(c.key) ?? 0.7;
    plan.roughOf.set(nkey, r0 === undefined ? r1 : Math.round(((r0 + r1) / 2) * 100) / 100);
    const fm = plan.merged.get(c.frame);
    fm.delete(c.key);
    const into = fm.get(nkey);
    if (!into) fm.set(nkey, acc);
    else {
      const base = into.pos.length / 3;
      into.pos.push(...acc.pos);
      into.nrm.push(...acc.nrm);
      into.uv.push(...acc.uv);
      into.col.push(...acc.col);
      for (const i of acc.idx) into.idx.push(i + base);
    }
  }
  return {
    pages: pages.map((p) => ({
      id: p.id,
      size: p.size,
      tiles: p.tiles.map(({ tex, x, y, s }) => ({ tex, x, y, s })),
    })),
  };
}

/** First free power-of-two-aligned spot for an s×s tile (quadtree order). */
function findSpot(p, s) {
  for (let y = 0; y + s <= p.size; y += s)
    for (let x = 0; x + s <= p.size; x += s) {
      if (!p.used.some((u) => x < u.x + u.s && u.x < x + s && y < u.y + u.s && u.y < y + s))
        return { x, y };
    }
  return null;
}

/**
 * Build a page image with ImageMagick (one command, no temporary files).
 * @param {{size:number, tiles:{tex:string,x:number,y:number,s:number}[]}} page
 * @param {(tex) => string} srcOf absolute source path of a texture
 */
export function buildPage(page, srcOf, out, { pad, quality = 85 }) {
  const args = ['-size', `${page.size}x${page.size}`, 'xc:#202020'];
  for (const t of page.tiles) {
    const inner = t.s - 2 * pad;
    args.push(
      '(',
      srcOf(t.tex),
      '-alpha',
      'off',
      '-filter',
      'Lanczos',
      '-resize',
      `${inner}x${inner}!`,
      '-set',
      'option:distort:viewport',
      `${t.s}x${t.s}-${pad}-${pad}`,
      '-virtual-pixel',
      'Edge',
      '-distort',
      'SRT',
      '0',
      '+repage',
      ')',
      '-geometry',
      `+${t.x}+${t.y}`,
      '-composite',
    );
  }
  args.push('-strip', '-sampling-factor', '4:2:0', '-quality', String(quality), out);
  execFileSync('convert', args, { maxBuffer: 64 * 1024 * 1024 });
}
