/**
 * Builds one terrain tile's buffers from the Terrain (runs in the terrain worker; pure and
 * unit-testable). A tile is a square of the LOD quadtree (lod.ts) drawn in ONE draw call:
 *
 *   ground   (TILE_QUADS + 1)² vertices ON heightAt (one height function, contract §4), with
 *            per-vertex normals and a geomorph delta toward the parent tile's surface;
 *   skirts   a strip hanging below every edge, hiding cracks between tiles of different levels;
 *   ribbons  roads (highway, road, track), the river and the airbase pavements, draped on THIS
 *            tile's surface (so they lie on the drawn ground at every level of detail), clipped
 *            exactly at the tile's edges, with their own geomorph deltas;
 *   canopy   the forest canopy as a shell: marching squares on canopyAt give smooth stand
 *            outlines with vertical walls, so tree lines and forest edges read from 3,000 m and
 *            break the ridge silhouettes (instanced trees stand on it near the aircraft);
 *   texture  (T+1)² texels of albedo + detail class (palette.ts).
 *
 * Vertex data is LOCAL to the tile (contract §2): x, z relative to the tile centre, y relative
 * to the tile's lowest ground; the mesh is placed with its object position.
 */
import type { RiverPolyline, RoadPolyline, Terrain } from '../../core/world/types';
import { bakeTexel, createBakeScratch, type BakeScratch } from './palette';

/** Vertex kinds (aInfo.x). */
export const KIND = {
  ground: 0,
  skirt: 1,
  road: 2,
  water: 3,
  paved: 4,
  canopy: 5,
  canopyWall: 6,
} as const;

/** aInfo.y for roads and pavements. */
export const ROAD_CODE = { highway: 0, road: 1, track: 2 } as const;
export const PAVED_CODE = { runway: 0, taxiway: 1, apron: 2 } as const;

/** Canopy heights below this are not forest (bushes, hedge feet), m. */
const CANOPY_THRESHOLD = 2.5;
/** The shell sits a little below the real canopy: instanced trees stand out of it up close. */
export const CANOPY_SHELL_FACTOR = 0.86;

export interface TileSpec {
  key: number;
  level: number;
  /** West and north edges, m. */
  x0: number;
  z0: number;
  size: number;
  /** Quads per edge. */
  quads: number;
  /** Texture texels per edge (the texture has texels + 1 samples). */
  texels: number;
  roads: boolean;
  tracks: boolean;
  rivers: boolean;
  paved: boolean;
  canopy: boolean;
}

export interface TileData {
  key: number;
  /** Mesh origin, world m: tile centre, lowest ground. */
  ox: number;
  oy: number;
  oz: number;
  /** World height bounds of everything in the tile (ground, canopy). */
  minY: number;
  maxY: number;
  vertexCount: number;
  triangleCount: number;
  position: Float32Array;
  /** xyz normal (int8, normalised) + 1 spare byte. */
  normal: Int8Array;
  morph: Float32Array;
  /** kind, sub-kind, 0, 0 */
  info: Uint8Array;
  /** ribbons: across 0..1, along (m); canopy walls: height fraction, 0 */
  ribbon: Float32Array;
  /** ribbons: lateral unit vector (x, z) and half width (m), so the shader can keep thin
   * roads at least a pixel wide far away; zero elsewhere */
  side: Float32Array;
  index: Uint16Array | Uint32Array;
  texels: number;
  texture: Uint8Array;
}

/** Road / river / pavement data prepared once per worker (bounding boxes, tangents). */
export interface FeatureIndex {
  roads: PreparedLine[];
  rivers: PreparedLine[];
  paved: PreparedPaved[];
}

interface PreparedLine {
  kind: number;
  /** x, z pairs. */
  points: Float64Array;
  /** Per-vertex half widths, m. */
  halfWidth: Float64Array;
  /** Per-vertex miter directions (unit, x z pairs) for smooth joins. */
  miter: Float64Array;
  /** Cumulative distance per vertex, m. */
  arc: Float64Array;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface PreparedPaved {
  code: number;
  /** Corners (x, z) × 4, counter-clockwise from above. */
  corners: number[];
  cx: number;
  cz: number;
  /** Unit vector along the long side (x, z) and across. */
  ax: number;
  az: number;
  length: number;
  width: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function prepareLine(kind: number, points: Float64Array, halfWidth: Float64Array): PreparedLine {
  const n = points.length / 2;
  const miter = new Float64Array(n * 2);
  const arc = new Float64Array(n);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = points[i * 2];
    const z = points[i * 2 + 1];
    const w = halfWidth[i];
    minX = Math.min(minX, x - w);
    maxX = Math.max(maxX, x + w);
    minZ = Math.min(minZ, z - w);
    maxZ = Math.max(maxZ, z + w);
    if (i > 0) arc[i] = arc[i - 1] + Math.hypot(x - points[i * 2 - 2], z - points[i * 2 - 1]);
    // average of the incoming and outgoing directions
    let tx = 0;
    let tz = 0;
    if (i > 0) {
      const dx = x - points[i * 2 - 2];
      const dz = z - points[i * 2 - 1];
      const l = Math.hypot(dx, dz) || 1;
      tx += dx / l;
      tz += dz / l;
    }
    if (i < n - 1) {
      const dx = points[i * 2 + 2] - x;
      const dz = points[i * 2 + 3] - z;
      const l = Math.hypot(dx, dz) || 1;
      tx += dx / l;
      tz += dz / l;
    }
    const l = Math.hypot(tx, tz) || 1;
    miter[i * 2] = tx / l;
    miter[i * 2 + 1] = tz / l;
  }
  return { kind, points, halfWidth, miter, arc, minX, maxX, minZ, maxZ };
}

/** Prepare the terrain's roads, rivers and airbase pavements for fast per-tile clipping. */
export function prepareFeatures(terrain: Terrain): FeatureIndex {
  const roads = terrain.roads.map((r: RoadPolyline) => {
    const n = r.points.length / 2;
    const hw = new Float64Array(n).fill(r.width / 2);
    return prepareLine(ROAD_CODE[r.kind] ?? 1, r.points, hw);
  });
  const rivers = (terrain.rivers ?? []).map((r: RiverPolyline) => {
    const n = r.points.length / 2;
    const hw = new Float64Array(n);
    for (let i = 0; i < n; i++) hw[i] = (r.widths[i] ?? 30) / 2;
    return prepareLine(0, r.points, hw);
  });
  const paved: PreparedPaved[] = [];
  const base = terrain.airbase;
  const areas =
    base?.paved ??
    (base
      ? [
          {
            kind: 'runway' as const,
            x: base.x,
            z: base.z,
            heading: base.heading,
            length: base.runwayLength,
            width: base.runwayWidth,
          },
        ]
      : []);
  for (const a of areas) {
    // compass heading → direction in x/z (north = −z, east = +x)
    const ax = Math.sin(a.heading);
    const az = -Math.cos(a.heading);
    const bx = -az;
    const bz = ax;
    const hl = a.length / 2;
    const hw = a.width / 2;
    const corners = [
      a.x - ax * hl - bx * hw,
      a.z - az * hl - bz * hw,
      a.x + ax * hl - bx * hw,
      a.z + az * hl - bz * hw,
      a.x + ax * hl + bx * hw,
      a.z + az * hl + bz * hw,
      a.x - ax * hl + bx * hw,
      a.z - az * hl + bz * hw,
    ];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let k = 0; k < 4; k++) {
      minX = Math.min(minX, corners[k * 2]);
      maxX = Math.max(maxX, corners[k * 2]);
      minZ = Math.min(minZ, corners[k * 2 + 1]);
      maxZ = Math.max(maxZ, corners[k * 2 + 1]);
    }
    paved.push({
      code: PAVED_CODE[a.kind],
      corners,
      cx: a.x,
      cz: a.z,
      ax,
      az,
      length: a.length,
      width: a.width,
      minX,
      maxX,
      minZ,
      maxZ,
    });
  }
  return { roads, rivers, paved };
}

/** Growable vertex/index storage for one tile build. */
class GeometryWriter {
  count = 0;
  position: Float32Array;
  normal: Int8Array;
  morph: Float32Array;
  info: Uint8Array;
  ribbon: Float32Array;
  side: Float32Array;
  index: Uint32Array;
  indexCount = 0;

  constructor(vertices: number, indices: number) {
    this.position = new Float32Array(vertices * 3);
    this.normal = new Int8Array(vertices * 4);
    this.morph = new Float32Array(vertices);
    this.info = new Uint8Array(vertices * 4);
    this.ribbon = new Float32Array(vertices * 2);
    this.side = new Float32Array(vertices * 3);
    this.index = new Uint32Array(indices);
  }

  setSide(i: number, lx: number, lz: number, halfWidth: number): void {
    this.side[i * 3] = lx;
    this.side[i * 3 + 1] = lz;
    this.side[i * 3 + 2] = halfWidth;
  }

  private growVertices(): void {
    const cap = this.morph.length * 2;
    const grow = <T extends Float32Array | Int8Array | Uint8Array>(a: T, k: number): T => {
      const b = new (a.constructor as { new (n: number): T })(cap * k);
      b.set(a);
      return b;
    };
    this.position = grow(this.position, 3);
    this.normal = grow(this.normal, 4);
    this.morph = grow(this.morph, 1);
    this.info = grow(this.info, 4);
    this.ribbon = grow(this.ribbon, 2);
    this.side = grow(this.side, 3);
  }

  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    morph: number,
    kind: number,
    sub: number,
    u: number,
    v: number,
    extra2 = 0,
    extra3 = 0,
  ): number {
    if (this.count >= this.morph.length) this.growVertices();
    const i = this.count++;
    this.position[i * 3] = x;
    this.position[i * 3 + 1] = y;
    this.position[i * 3 + 2] = z;
    this.normal[i * 4] = Math.round(nx * 127);
    this.normal[i * 4 + 1] = Math.round(ny * 127);
    this.normal[i * 4 + 2] = Math.round(nz * 127);
    this.morph[i] = morph;
    this.info[i * 4] = kind;
    this.info[i * 4 + 1] = sub;
    this.info[i * 4 + 2] = extra2;
    this.info[i * 4 + 3] = extra3;
    this.ribbon[i * 2] = u;
    this.ribbon[i * 2 + 1] = v;
    return i;
  }

  triangle(a: number, b: number, c: number): void {
    if (this.indexCount + 3 > this.index.length) {
      const next = new Uint32Array(this.index.length * 2);
      next.set(this.index);
      this.index = next;
    }
    this.index[this.indexCount++] = a;
    this.index[this.indexCount++] = b;
    this.index[this.indexCount++] = c;
  }
}

/** The tile's own surface: heights of the fine grid and of its parent's (coarse) grid. */
class TileSurface {
  /** Heights on the (n+3)² grid with a one-sample border. */
  readonly h: Float32Array;
  readonly g: number;
  constructor(
    readonly x0: number,
    readonly z0: number,
    readonly s: number,
    readonly n: number,
    heights: Float32Array,
  ) {
    this.h = heights;
    this.g = n + 3;
  }

  /** Grid height at vertex (i, j), i, j ∈ [-1, n + 1]. */
  at(i: number, j: number): number {
    return this.h[(j + 1) * this.g + i + 1];
  }

  /** Height of the fine triangle mesh at world (x, z) (clamped to the tile). */
  fine(x: number, z: number): number {
    return this.interp(x, z, 1);
  }

  /** Height of the parent's mesh (every second vertex, same diagonal) at world (x, z). */
  coarse(x: number, z: number): number {
    return this.interp(x, z, 2);
  }

  private interp(x: number, z: number, step: number): number {
    const n = this.n;
    const cs = this.s * step;
    let gx = (x - this.x0) / cs;
    let gz = (z - this.z0) / cs;
    const cells = n / step;
    gx = gx < 0 ? 0 : gx > cells ? cells : gx;
    gz = gz < 0 ? 0 : gz > cells ? cells : gz;
    let i = Math.floor(gx);
    let j = Math.floor(gz);
    if (i >= cells) i = cells - 1;
    if (j >= cells) j = cells - 1;
    const fx = gx - i;
    const fz = gz - j;
    const a = this.at(i * step, j * step);
    const b = this.at((i + 1) * step, j * step);
    const c = this.at(i * step, (j + 1) * step);
    const d = this.at((i + 1) * step, (j + 1) * step);
    // diagonal a–d: triangles (a, d, b) where fx ≥ fz and (a, c, d) where fx < fz
    return fx >= fz ? a * (1 - fx) + b * (fx - fz) + d * fz : a * (1 - fz) + c * (fz - fx) + d * fx;
  }

  /** Smooth normal at world (x, z) from the grid gradient (into out, returns ny). */
  normal(x: number, z: number, out: Float64Array): void {
    const s = this.s;
    const hx = this.fine(x + s, z) - this.fine(x - s, z);
    const hz = this.fine(x, z + s) - this.fine(x, z - s);
    const nx = -hx;
    const ny = 4 * s;
    const nz = -hz;
    const l = Math.hypot(nx, ny, nz);
    out[0] = nx / l;
    out[1] = ny / l;
    out[2] = nz / l;
  }
}

const _n = new Float64Array(3);

/** Liang–Barsky: clip segment (ax, az)→(bx, bz) to the box; returns false when outside. */
function clipSegment(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  out: [number, number],
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  const p = [-dx, dx, -dz, dz];
  const q = [ax - minX, maxX - ax, az - minZ, maxZ - az];
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) {
      if (q[k] < 0) return false;
    } else {
      const r = q[k] / p[k];
      if (p[k] < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  out[0] = t0;
  out[1] = t1;
  return t1 > t0;
}

const _clip: [number, number] = [0, 0];

/** Build everything of one tile. */
export function buildTile(
  terrain: Terrain,
  spec: TileSpec,
  features: FeatureIndex | null,
  scratch: BakeScratch = createBakeScratch(terrain.seed, terrain),
): TileData {
  if (scratch.terrain !== terrain) {
    scratch.terrain = terrain;
    scratch.extra = createBakeScratch(terrain.seed, terrain).extra;
  }
  const n = spec.quads;
  const s = spec.size / n;
  const g = n + 3;
  const x0 = spec.x0;
  const z0 = spec.z0;

  // ---- heights on the grid plus a one-sample border (for normals) ----
  const heights = new Float32Array(g * g);
  if (terrain.heightGrid) terrain.heightGrid(x0 - s, z0 - s, s, g, heights);
  else {
    for (let j = 0; j < g; j++) {
      const z = z0 + (j - 1) * s;
      for (let i = 0; i < g; i++) heights[j * g + i] = terrain.heightAt(x0 + (i - 1) * s, z);
    }
  }
  const surface = new TileSurface(x0, z0, s, n, heights);

  let minY = Infinity;
  let maxY = -Infinity;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const h = surface.at(i, j);
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
    }
  }
  const ox = x0 + spec.size / 2;
  const oz = z0 + spec.size / 2;
  const oy = Math.floor(minY);

  const vn = (n + 1) * (n + 1);
  const w = new GeometryWriter(vn + 4 * (n + 1) + 1024, n * n * 6 + 8 * n * 3 + 4096);

  // ---- ground grid ----
  const nxs = new Float32Array(vn);
  const nys = new Float32Array(vn);
  const nzs = new Float32Array(vn);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const h = surface.at(i, j);
      const dx = surface.at(i + 1, j) - surface.at(i - 1, j);
      const dz = surface.at(i, j + 1) - surface.at(i, j - 1);
      let nx = -dx;
      let ny = 2 * s;
      let nz = -dz;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const v = j * (n + 1) + i;
      nxs[v] = nx;
      nys[v] = ny;
      nzs[v] = nz;
      // geomorph target: the parent's surface (diagonal (i, j)→(i+1, j+1) at both levels)
      let coarse = h;
      const oddI = (i & 1) === 1;
      const oddJ = (j & 1) === 1;
      if (oddI && oddJ) coarse = (surface.at(i - 1, j - 1) + surface.at(i + 1, j + 1)) / 2;
      else if (oddI) coarse = (surface.at(i - 1, j) + surface.at(i + 1, j)) / 2;
      else if (oddJ) coarse = (surface.at(i, j - 1) + surface.at(i, j + 1)) / 2;
      w.vertex(x0 + i * s - ox, h - oy, z0 + j * s - oz, nx, ny, nz, coarse - h, KIND.ground, 0, 0, 0);
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      w.triangle(a, c, d);
      w.triangle(a, d, b);
    }
  }

  // ---- skirts ----
  const skirt = Math.max(4, s * 0.6);
  const edge = (i: number, j: number) => {
    const v = j * (n + 1) + i;
    const p = v * 3;
    return w.vertex(
      w.position[p],
      w.position[p + 1] - skirt,
      w.position[p + 2],
      nxs[v],
      nys[v],
      nzs[v],
      w.morph[v],
      KIND.skirt,
      0,
      0,
      0,
    );
  };
  const skirtStrip = (fromI: number, fromJ: number, di: number, dj: number) => {
    let ai = fromI;
    let aj = fromJ;
    let aLow = edge(ai, aj);
    for (let k = 0; k < n; k++) {
      const bi = ai + di;
      const bj = aj + dj;
      const bLow = edge(bi, bj);
      const a = aj * (n + 1) + ai;
      const b = bj * (n + 1) + bi;
      w.triangle(a, b, bLow);
      w.triangle(a, bLow, aLow);
      ai = bi;
      aj = bj;
      aLow = bLow;
    }
  };
  skirtStrip(0, 0, 1, 0); // north edge, eastward
  skirtStrip(n, 0, 0, 1); // east edge, southward
  skirtStrip(n, n, -1, 0); // south edge, westward
  skirtStrip(0, n, 0, -1); // west edge, northward

  // ---- ribbons draped on this tile's surface ----
  const lift = s <= 16 ? 0.12 : s * 0.012;
  if (features) {
    const minX = x0;
    const minZ = z0;
    const maxX = x0 + spec.size;
    const maxZ = z0 + spec.size;
    const ribbon = (line: PreparedLine, kind: number, sub: number, step: number) => {
      if (line.maxX < minX || line.minX > maxX || line.maxZ < minZ || line.minZ > maxZ) return;
      const pts = line.points;
      const count = pts.length / 2;
      let prevL = -1;
      let prevR = -1;
      let runOpen = false;
      const section = (px: number, pz: number, dx: number, dz: number, hw: number, along: number) => {
        // lateral = direction rotated 90° (to the right of travel in x/z)
        const lx = -dz;
        const lz = dx;
        const xl = px - lx * hw;
        const zl = pz - lz * hw;
        const xr = px + lx * hw;
        const zr = pz + lz * hw;
        surface.normal(px, pz, _n);
        const hl = surface.fine(xl, zl);
        const hr = surface.fine(xr, zr);
        const ml = surface.coarse(xl, zl) - hl;
        const mr = surface.coarse(xr, zr) - hr;
        // the ribbon's full width (dm) rides along for markings and edge shading
        const wdm = Math.min(255, Math.round(hw * 20));
        const l = w.vertex(xl - ox, hl + lift - oy, zl - oz, _n[0], _n[1], _n[2], ml, kind, sub, 0, along, wdm);
        const r = w.vertex(xr - ox, hr + lift - oy, zr - oz, _n[0], _n[1], _n[2], mr, kind, sub, 1, along, wdm);
        w.setSide(l, lx, lz, hw);
        w.setSide(r, lx, lz, hw);
        if (runOpen && prevL >= 0) {
          // faces up: (prevL, r, l) and (prevL, prevR, r)
          w.triangle(prevL, r, l);
          w.triangle(prevL, prevR, r);
        }
        prevL = l;
        prevR = r;
        runOpen = true;
      };
      for (let k = 0; k < count - 1; k++) {
        const ax = pts[k * 2];
        const az = pts[k * 2 + 1];
        const bx = pts[k * 2 + 2];
        const bz = pts[k * 2 + 3];
        if (!clipSegment(ax, az, bx, bz, minX, minZ, maxX, maxZ, _clip)) {
          runOpen = false;
          continue;
        }
        const t0 = _clip[0];
        const t1 = _clip[1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-6) continue;
        const dx = (bx - ax) / len;
        const dz = (bz - az) / len;
        const hwA = line.halfWidth[k];
        const hwB = line.halfWidth[k + 1];
        const arcA = line.arc[k];
        const pieces = Math.max(1, Math.ceil(((t1 - t0) * len) / step));
        const startAt = runOpen && t0 === 0 ? 1 : 0;
        if (t0 > 0) runOpen = false;
        for (let q = startAt; q <= pieces; q++) {
          const t = t0 + ((t1 - t0) * q) / pieces;
          const atVertexA = t === 0;
          const atVertexB = t === 1;
          const mdx = atVertexA ? line.miter[k * 2] : atVertexB ? line.miter[k * 2 + 2] : dx;
          const mdz = atVertexA ? line.miter[k * 2 + 1] : atVertexB ? line.miter[k * 2 + 3] : dz;
          section(ax + (bx - ax) * t, az + (bz - az) * t, mdx, mdz, hwA + (hwB - hwA) * t, arcA + len * t);
        }
        if (t1 < 1) runOpen = false;
      }
    };
    const step = Math.max(3, s);
    if (spec.rivers) for (const r of features.rivers) ribbon(r, KIND.water, 0, Math.min(step, 40));
    if (spec.roads || spec.tracks) {
      for (const r of features.roads) {
        if (r.kind === ROAD_CODE.track ? !spec.tracks : !spec.roads) continue;
        ribbon(r, KIND.road, r.kind, step);
      }
    }
    if (spec.paved) {
      for (const p of features.paved) {
        if (p.maxX < minX || p.minX > maxX || p.maxZ < minZ || p.minZ > maxZ) continue;
        pavedPolygon(p, minX, minZ, maxX, maxZ, surface, w, ox, oy, oz, lift);
      }
    }
  }

  // ---- forest canopy shell ----
  if (spec.canopy) {
    const top = buildCanopy(terrain, surface, w, ox, oy, oz, n, s);
    if (top > maxY) maxY = top;
  }

  // ---- texture: albedo + detail class ----
  const t = spec.texels;
  const tex = new Uint8Array((t + 1) * (t + 1) * 4);
  const ts = spec.size / t;
  for (let j = 0; j <= t; j++) {
    const z = z0 + j * ts;
    for (let i = 0; i <= t; i++) {
      const x = x0 + i * ts;
      // normal from the grid (bilinear over the vertex normals' y)
      const gx = Math.min(n - 1e-6, (i * ts) / s);
      const gz = Math.min(n - 1e-6, (j * ts) / s);
      const vi = Math.floor(gx);
      const vj = Math.floor(gz);
      const fx = gx - vi;
      const fz = gz - vj;
      const v = vj * (n + 1) + vi;
      const ny =
        (nys[v] * (1 - fx) + nys[v + 1] * fx) * (1 - fz) +
        (nys[v + n + 1] * (1 - fx) + nys[v + n + 2] * fx) * fz;
      bakeTexel(terrain, x, z, ny, ts, scratch, tex, (j * (t + 1) + i) * 4);
    }
  }

  const vertexCount = w.count;
  const index =
    vertexCount <= 65535
      ? Uint16Array.from(w.index.subarray(0, w.indexCount))
      : w.index.slice(0, w.indexCount);
  return {
    key: spec.key,
    ox,
    oy,
    oz,
    minY,
    maxY,
    vertexCount,
    triangleCount: w.indexCount / 3,
    position: w.position.slice(0, vertexCount * 3),
    normal: w.normal.slice(0, vertexCount * 4),
    morph: w.morph.slice(0, vertexCount),
    info: w.info.slice(0, vertexCount * 4),
    ribbon: w.ribbon.slice(0, vertexCount * 2),
    side: w.side.slice(0, vertexCount * 3),
    index,
    texels: t,
    texture: tex,
  };
}

/** A pavement rectangle clipped to the tile (Sutherland–Hodgman) and fanned. */
function pavedPolygon(
  p: PreparedPaved,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  surface: TileSurface,
  w: GeometryWriter,
  ox: number,
  oy: number,
  oz: number,
  lift: number,
): void {
  let poly = p.corners.slice();
  const clip = (inside: (x: number, z: number) => boolean, cut: (ax: number, az: number, bx: number, bz: number) => number) => {
    const out: number[] = [];
    const m = poly.length / 2;
    for (let k = 0; k < m; k++) {
      const ax = poly[k * 2];
      const az = poly[k * 2 + 1];
      const bx = poly[((k + 1) % m) * 2];
      const bz = poly[((k + 1) % m) * 2 + 1];
      const ia = inside(ax, az);
      const ib = inside(bx, bz);
      if (ia) out.push(ax, az);
      if (ia !== ib) {
        const t = cut(ax, az, bx, bz);
        out.push(ax + (bx - ax) * t, az + (bz - az) * t);
      }
    }
    poly = out;
  };
  clip((x) => x >= minX, (ax, _az, bx) => (minX - ax) / (bx - ax));
  clip((x) => x <= maxX, (ax, _az, bx) => (maxX - ax) / (bx - ax));
  clip((_x, z) => z >= minZ, (_ax, az, _bx, bz) => (minZ - az) / (bz - az));
  clip((_x, z) => z <= maxZ, (_ax, az, _bx, bz) => (maxZ - az) / (bz - az));
  const m = poly.length / 2;
  if (m < 3) return;
  const first = w.count;
  for (let k = 0; k < m; k++) {
    const x = poly[k * 2];
    const z = poly[k * 2 + 1];
    surface.normal(x, z, _n);
    const h = surface.fine(x, z);
    const along = (x - p.cx) * p.ax + (z - p.cz) * p.az;
    const across = (x - p.cx) * -p.az + (z - p.cz) * p.ax;
    w.vertex(
      x - ox,
      h + lift - oy,
      z - oz,
      _n[0],
      _n[1],
      _n[2],
      surface.coarse(x, z) - h,
      KIND.paved,
      p.code,
      across,
      along,
      Math.min(255, Math.round(p.width)),
      Math.min(255, Math.round(p.length / 20)),
    );
  }
  // the corners run clockwise seen from above (north up): fan them reversed so faces point up
  for (let k = 1; k < m - 1; k++) w.triangle(first, first + k + 1, first + k);
}

/**
 * The forest canopy shell over the tile: marching squares on canopyAt at the tile's vertices.
 * Inside: a surface at ground + canopy × CANOPY_SHELL_FACTOR. Along the outline: a vertical
 * wall down to the ground. Returns the highest canopy point (world y).
 */
function buildCanopy(
  terrain: Terrain,
  surface: TileSurface,
  w: GeometryWriter,
  ox: number,
  oy: number,
  oz: number,
  n: number,
  s: number,
): number {
  const x0 = surface.x0;
  const z0 = surface.z0;
  const vn = (n + 1) * (n + 1);
  const canopy = new Float32Array(vn);
  // coarse tiles outline the stands from the smooth forest density (no hedgerow slivers)
  const density = s > 12 && terrain.forestDensityAt ? terrain.forestDensityAt.bind(terrain) : null;
  let any = false;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = x0 + i * s;
      const z = z0 + j * s;
      let c = 0;
      if (density) {
        const d = density(x, z);
        if (d > 0.45) c = Math.max(terrain.canopyAt(x, z), 9 + 10 * d);
      } else c = terrain.canopyAt(x, z);
      canopy[j * (n + 1) + i] = c;
      if (c > CANOPY_THRESHOLD) any = true;
    }
  }
  if (!any) return -Infinity;
  let top = -Infinity;
  // shared top vertices at grid corners (index or -1)
  const cornerVertex = new Int32Array(vn).fill(-1);
  const topVertex = (x: number, z: number, c: number, wallFrac: number, kind: number): number => {
    surface.normal(x, z, _n);
    // a canopy is rounder than the ground: tilt its normal halfway to vertical
    const nx = _n[0] * 0.5;
    const ny = _n[1] * 0.5 + 0.5;
    const nz = _n[2] * 0.5;
    const l = Math.hypot(nx, ny, nz);
    const h = surface.fine(x, z);
    const y = h + c * CANOPY_SHELL_FACTOR;
    if (y > top) top = y;
    return w.vertex(x - ox, y - oy, z - oz, nx / l, ny / l, nz / l, surface.coarse(x, z) - h, kind, 0, wallFrac, c);
  };
  const corner = (i: number, j: number): number => {
    const v = j * (n + 1) + i;
    if (cornerVertex[v] < 0) cornerVertex[v] = topVertex(x0 + i * s, z0 + j * s, canopy[v], 1, KIND.canopy);
    return cornerVertex[v];
  };
  const T = CANOPY_THRESHOLD;
  // an outline vertex on a cell edge between corner a (inside) and b (outside)
  const crossing = (ia: number, ja: number, ib: number, jb: number): [number, number, number] => {
    const ca = canopy[ja * (n + 1) + ia];
    const cb = canopy[jb * (n + 1) + ib];
    const t = Math.max(0.05, Math.min(0.95, (ca - T) / Math.max(1e-6, ca - cb)));
    const x = x0 + (ia + (ib - ia) * t) * s;
    const z = z0 + (ja + (jb - ja) * t) * s;
    return [x, z, ca];
  };
  const wall = (ax: number, az: number, ac: number, bx: number, bz: number, bc: number) => {
    // vertical wall under the outline segment a→b (inside on the left when seen from above)
    const ha = surface.fine(ax, az);
    const hb = surface.fine(bx, bz);
    const ma = surface.coarse(ax, az) - ha;
    const mb = surface.coarse(bx, bz) - hb;
    // outward normal: segment direction rotated
    let wx = bz - az;
    let wz = -(bx - ax);
    const l = Math.hypot(wx, wz) || 1;
    wx /= l;
    wz /= l;
    const ta = ha + ac * CANOPY_SHELL_FACTOR;
    const tb = hb + bc * CANOPY_SHELL_FACTOR;
    const a0 = w.vertex(ax - ox, ha - 0.5 - oy, az - oz, wx, 0.15, wz, ma, KIND.canopyWall, 0, 0, ac);
    const b0 = w.vertex(bx - ox, hb - 0.5 - oy, bz - oz, wx, 0.15, wz, mb, KIND.canopyWall, 0, 0, bc);
    const a1 = w.vertex(ax - ox, ta - oy, az - oz, wx, 0.15, wz, ma, KIND.canopyWall, 0, 1, ac);
    const b1 = w.vertex(bx - ox, tb - oy, bz - oz, wx, 0.15, wz, mb, KIND.canopyWall, 0, 1, bc);
    // faces outward (the side away from the stand)
    w.triangle(a0, b1, b0);
    w.triangle(a0, a1, b1);
  };
  const poly: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // corners counter-clockwise from above: (i,j) → (i,j+1) → (i+1,j+1) → (i+1,j)
      const ci = [i, i, i + 1, i + 1];
      const cj = [j, j + 1, j + 1, j];
      let mask = 0;
      for (let k = 0; k < 4; k++) if (canopy[cj[k] * (n + 1) + ci[k]] > T) mask |= 1 << k;
      if (mask === 0) continue;
      poly.length = 0;
      if (mask === 15) {
        const a = corner(ci[0], cj[0]);
        const b = corner(ci[1], cj[1]);
        const c = corner(ci[2], cj[2]);
        const d = corner(ci[3], cj[3]);
        // same diagonal as the ground: (i,j)–(i+1,j+1)
        w.triangle(a, b, c);
        w.triangle(a, c, d);
        continue;
      }
      // walk the cell outline counter-clockwise, emitting inside corners and crossings
      const verts: number[] = [];
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) & 3;
        const inA = (mask >> k) & 1;
        const inB = (mask >> k2) & 1;
        if (inA) verts.push(corner(ci[k], cj[k]));
        if (inA !== inB) {
          const [x, z, c] = inA
            ? crossing(ci[k], cj[k], ci[k2], cj[k2])
            : crossing(ci[k2], cj[k2], ci[k], cj[k]);
          verts.push(topVertex(x, z, c, 1, KIND.canopy));
          poly.push(x, z, c, inA ? 1 : 0);
        }
      }
      for (let k = 1; k < verts.length - 1; k++) w.triangle(verts[0], verts[k], verts[k + 1]);
      // walls: the outline runs from each exit crossing to the next crossing (an entry) in the
      // walk order; the stand is on its left, so the wall goes entry → exit
      const crossings = poly.length / 4;
      for (let q = 0; q < crossings; q++) {
        if (poly[q * 4 + 3] !== 1) continue;
        const e = q * 4;
        const en = ((q + 1) % crossings) * 4;
        wall(poly[en], poly[en + 1], poly[en + 2], poly[e], poly[e + 1], poly[e + 2]);
      }
    }
  }
  return top;
}
