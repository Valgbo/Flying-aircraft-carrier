/**
 * Analytic terrain features laid over the smooth height grid: road beds, the river (flat water
 * surface and its banks) and flat pads (range areas, the airfield). The grid (62.5 m) cannot hold
 * a 7 m road or a 40 m river, so heightAt evaluates these exactly from their centre lines:
 *
 *   h ← h + W·(h_f − h)        (one blend per polyline or pad, in a fixed priority order)
 *
 * where h_f is the feature's own surface (road-bed profile, water level, pad plane) and W is 1
 * inside the flat core and falls to 0 across the blend zone (a smoothstep: the cut or fill
 * slope). Inside the core the result is exactly h_f, so roads, runways and range pads are flat
 * whatever the micro-detail does. For a polyline, h_f is the ω-weighted mean of the segments'
 * height ramps (each extended past its ends) and W = max ω: continuous everywhere, and flat across
 * the road to the centimetre on gentle grades. Priority (later wins): river, tracks, roads,
 * highways, pads, airfield; so a road crosses the river on a causeway and ends flush on the apron.
 *
 * A uniform grid of 125 m cells lists, in priority order, every feature whose blend zone touches
 * the cell. Most cells are empty, so heightAt pays one array read for the feature layer there.
 */
import type { RiverPolyline, RoadKind, RoadPolyline, WorldExtra } from './types';

/** Feature group kinds (priority order). */
export const KIND_RIVER = 0;
export const KIND_TRACK = 1;
export const KIND_ROAD = 2;
export const KIND_HIGHWAY = 3;

export const ROAD_KIND_CODE: Record<RoadKind, number> = {
  track: KIND_TRACK,
  road: KIND_ROAD,
  highway: KIND_HIGHWAY,
};

/**
 * Segment record layout (Float64Array, stride SEG): endpoints a, b; surface heights at a and b;
 * flat-core half widths at a and b; blend width; surface ("core") half widths at a and b
 * (paved width or water width); precomputed b − a and 1/|b − a|²; arc length at a.
 */
const SEG = 16;
const S_AX = 0;
const S_AZ = 1;
const S_BX = 2;
const S_BZ = 3;
const S_HA = 4;
const S_HB = 5;
const S_IA = 6;
const S_IB = 7;
const S_BL = 8;
const S_CA = 9;
const S_CB = 10;
const S_DX = 11;
const S_DZ = 12;
const S_INV = 13;
const S_ARC = 14;
const S_REACH = 15;

/**
 * Pad record layout (stride PAD): shape (0 disc, 1 rectangle), centre, axis cos/sin (rectangle
 * long axis as a unit vector in x/z), half length / radius, half width, blend, plane (h0, gx, gz).
 */
const PAD = 12;
const P_SHAPE = 0;
const P_CX = 1;
const P_CZ = 2;
const P_EX = 3;
const P_EZ = 4;
const P_HL = 5;
const P_HW = 6;
const P_BL = 7;
const P_H0 = 8;
const P_GX = 9;
const P_GZ = 10;

export interface PadSpec {
  shape: 'disc' | 'rect';
  x: number;
  z: number;
  /** Rectangle long axis (unit vector in x/z); ignored for discs. */
  ex: number;
  ez: number;
  /** Disc radius, or rectangle half length. */
  halfLength: number;
  /** Rectangle half width (unused for discs). */
  halfWidth: number;
  blend: number;
  elevation: number;
  gx: number;
  gz: number;
  /** Which feature this pad represents: 'range' pad or the 'airfield'. */
  role: 'range' | 'airfield';
}

export interface FeatureSet {
  segCount: number;
  seg: Float64Array;
  /** Group (polyline) of each segment. */
  segGroup: Int32Array;
  /** Kind of each group (KIND_*). */
  groupKind: Int8Array;
  /** Index of the group's polyline in `roads` (roads) or `rivers` (river). */
  groupRef: Int32Array;
  /** Bank width of river groups (0 for roads). */
  groupBank: Float64Array;
  padCount: number;
  pad: Float64Array;
  padRole: Int8Array;
  /** Spatial index: `cells` × `cells` cells of `cellSize` metres from (origin, origin). */
  cellSize: number;
  cells: number;
  origin: number;
  cellStart: Int32Array;
  /** Items: segment index (≥ 0) or −1 − pad index. Sorted in priority order per cell. */
  cellItems: Int32Array;
}

function smooth01(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/** Cross-section of each road kind: flat core half-width beyond the paved half-width, blend. */
export function roadSection(
  kind: RoadKind,
  width: number,
  blends: { highway: number; road: number; track: number },
): { core: number; inner: number; blend: number } {
  const core = width / 2;
  // Shoulder: gravel either side of the pavement stays flat with it.
  const shoulder = kind === 'track' ? 0.6 : 1.5;
  return { core, inner: core + shoulder, blend: blends[kind] };
}

/**
 * Build the feature tables and the spatial index. `roads` and `rivers` must carry heights
 * (road beds) and levels (water). Order of the result = priority order.
 */
export function buildFeatureSet(
  size: number,
  rivers: readonly RiverPolyline[],
  roads: readonly RoadPolyline[],
  pads: readonly PadSpec[],
  blends: { highway: number; road: number; track: number },
  /**
   * Extra index reach beyond the blend zone, m: queries (riverside trees, mud, road distance)
   * look this much farther than the height blend does.
   */
  margins: { river: number; road: number } = { river: 25, road: 10 },
): FeatureSet {
  // Count segments and groups.
  let segCount = 0;
  const groups: Array<{ kind: number; ref: number }> = [];
  for (let r = 0; r < rivers.length; r++) {
    segCount += rivers[r].points.length / 2 - 1;
    groups.push({ kind: KIND_RIVER, ref: r });
  }
  const roadOrder: number[] = [];
  for (const kind of [KIND_TRACK, KIND_ROAD, KIND_HIGHWAY]) {
    for (let r = 0; r < roads.length; r++) {
      if (ROAD_KIND_CODE[roads[r].kind] === kind) roadOrder.push(r);
    }
  }
  for (const r of roadOrder) {
    segCount += roads[r].points.length / 2 - 1;
    groups.push({ kind: ROAD_KIND_CODE[roads[r].kind], ref: r });
  }
  const seg = new Float64Array(segCount * SEG);
  const segGroup = new Int32Array(segCount);
  const groupKind = new Int8Array(groups.length);
  const groupRef = new Int32Array(groups.length);
  const groupBank = new Float64Array(groups.length);
  groups.forEach((g, i) => {
    groupKind[i] = g.kind;
    groupRef[i] = g.ref;
  });

  let s = 0;
  let g = 0;
  for (const river of rivers) {
    const p = river.points;
    const n = p.length / 2;
    groupBank[g] = river.bankWidth;
    for (let i = 0; i < n - 1; i++, s++) {
      const hwA = river.widths[i] / 2;
      const hwB = river.widths[i + 1] / 2;
      writeSeg(seg, s, p, i, river.levels[i], river.levels[i + 1], hwA, hwB, river.bankWidth);
      seg[s * SEG + S_CA] = hwA;
      seg[s * SEG + S_CB] = hwB;
      seg[s * SEG + S_ARC] = river.arc[i];
      segGroup[s] = g;
    }
    g++;
  }
  for (const r of roadOrder) {
    const road = roads[r];
    const p = road.points;
    const n = p.length / 2;
    const h = road.heights;
    const sec = roadSection(road.kind, road.width, blends);
    let arc = 0;
    for (let i = 0; i < n - 1; i++, s++) {
      const ha = h ? h[i] : 0;
      const hb = h ? h[i + 1] : 0;
      writeSeg(seg, s, p, i, ha, hb, sec.inner, sec.inner, sec.blend);
      seg[s * SEG + S_CA] = sec.core;
      seg[s * SEG + S_CB] = sec.core;
      seg[s * SEG + S_ARC] = road.arc ? road.arc[i] : arc;
      arc += Math.hypot(p[2 * i + 2] - p[2 * i], p[2 * i + 3] - p[2 * i + 1]);
      segGroup[s] = g;
    }
    g++;
  }

  // Pads: range discs first, the airfield last (highest priority).
  const orderedPads = [
    ...pads.filter((q) => q.role === 'range'),
    ...pads.filter((q) => q.role === 'airfield'),
  ];
  const pad = new Float64Array(Math.max(1, orderedPads.length) * PAD);
  const padRole = new Int8Array(orderedPads.length);
  orderedPads.forEach((q, i) => {
    const o = i * PAD;
    pad[o + P_SHAPE] = q.shape === 'disc' ? 0 : 1;
    pad[o + P_CX] = q.x;
    pad[o + P_CZ] = q.z;
    pad[o + P_EX] = q.ex;
    pad[o + P_EZ] = q.ez;
    pad[o + P_HL] = q.halfLength;
    pad[o + P_HW] = q.halfWidth;
    pad[o + P_BL] = q.blend;
    pad[o + P_H0] = q.elevation;
    pad[o + P_GX] = q.gx;
    pad[o + P_GZ] = q.gz;
    padRole[i] = q.role === 'range' ? 0 : 1;
  });

  // Spatial index (counting sort into CSR arrays; items appended in priority order).
  const cellSize = 125;
  const cells = Math.ceil(size / cellSize);
  const origin = -size / 2;
  const counts = new Int32Array(cells * cells + 1);
  const visit = (fill: Int32Array | null, cursor: Int32Array | null) => {
    for (let k = 0; k < segCount; k++) {
      const o = k * SEG;
      const reach = Math.max(seg[o + S_IA], seg[o + S_IB]) + seg[o + S_BL];
      seg[o + S_REACH] = reach;
      const r = reach + (groupKind[segGroup[k]] === KIND_RIVER ? margins.river : margins.road);
      const x0 = Math.min(seg[o + S_AX], seg[o + S_BX]) - r;
      const x1 = Math.max(seg[o + S_AX], seg[o + S_BX]) + r;
      const z0 = Math.min(seg[o + S_AZ], seg[o + S_BZ]) - r;
      const z1 = Math.max(seg[o + S_AZ], seg[o + S_BZ]) + r;
      forCells(x0, z0, x1, z1, (c) => {
        if (fill && cursor) fill[cursor[c]++] = k;
        else counts[c]++;
      });
    }
    for (let k = 0; k < orderedPads.length; k++) {
      const o = k * PAD;
      const r =
        (pad[o + P_SHAPE] === 0 ? pad[o + P_HL] : Math.hypot(pad[o + P_HL], pad[o + P_HW])) +
        pad[o + P_BL];
      forCells(pad[o + P_CX] - r, pad[o + P_CZ] - r, pad[o + P_CX] + r, pad[o + P_CZ] + r, (c) => {
        if (fill && cursor) fill[cursor[c]++] = -1 - k;
        else counts[c]++;
      });
    }
  };
  function forCells(x0: number, z0: number, x1: number, z1: number, fn: (c: number) => void) {
    const i0 = Math.max(0, Math.floor((x0 - origin) / cellSize));
    const i1 = Math.min(cells - 1, Math.floor((x1 - origin) / cellSize));
    const j0 = Math.max(0, Math.floor((z0 - origin) / cellSize));
    const j1 = Math.min(cells - 1, Math.floor((z1 - origin) / cellSize));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * cells + i);
  }
  visit(null, null);
  const cellStart = new Int32Array(cells * cells + 1);
  let total = 0;
  for (let c = 0; c < cells * cells; c++) {
    cellStart[c] = total;
    total += counts[c];
  }
  cellStart[cells * cells] = total;
  const cellItems = new Int32Array(Math.max(1, total));
  const cursor = cellStart.slice(0, cells * cells);
  visit(cellItems, cursor);

  return {
    segCount,
    seg,
    segGroup,
    groupKind,
    groupRef,
    groupBank,
    padCount: orderedPads.length,
    pad,
    padRole,
    cellSize,
    cells,
    origin,
    cellStart,
    cellItems,
  };
}

function writeSeg(
  seg: Float64Array,
  s: number,
  p: Float64Array,
  i: number,
  ha: number,
  hb: number,
  innerA: number,
  innerB: number,
  blend: number,
): void {
  const o = s * SEG;
  const ax = p[2 * i];
  const az = p[2 * i + 1];
  const bx = p[2 * i + 2];
  const bz = p[2 * i + 3];
  seg[o + S_AX] = ax;
  seg[o + S_AZ] = az;
  seg[o + S_BX] = bx;
  seg[o + S_BZ] = bz;
  seg[o + S_HA] = ha;
  seg[o + S_HB] = hb;
  seg[o + S_IA] = innerA;
  seg[o + S_IB] = innerB;
  seg[o + S_BL] = blend;
  const dx = bx - ax;
  const dz = bz - az;
  seg[o + S_DX] = dx;
  seg[o + S_DZ] = dz;
  const l2 = dx * dx + dz * dz;
  seg[o + S_INV] = l2 > 1e-12 ? 1 / l2 : 0;
}

/** Cell index of world (x, z) (clamped). */
export function featureCell(fs: FeatureSet, x: number, z: number): number {
  let i = Math.floor((x - fs.origin) / fs.cellSize);
  let j = Math.floor((z - fs.origin) / fs.cellSize);
  if (i < 0) i = 0;
  else if (i >= fs.cells) i = fs.cells - 1;
  if (j < 0) j = 0;
  else if (j >= fs.cells) j = fs.cells - 1;
  return j * fs.cells + i;
}

/**
 * Apply every feature at (x, z) to the natural ground height `h` (see the file comment).
 * Hot path of heightAt: no allocation, early exit in empty cells.
 */
export function blendFeatures(fs: FeatureSet, x: number, z: number, h: number): number {
  const c = featureCell(fs, x, z);
  const start = fs.cellStart[c];
  const end = fs.cellStart[c + 1];
  if (start === end) return h;
  const seg = fs.seg;
  const items = fs.cellItems;
  let group = -1;
  let sw = 0;
  let swh = 0;
  let wmax = 0;
  for (let k = start; k < end; k++) {
    const item = items[k];
    if (item >= 0) {
      const g = fs.segGroup[item];
      if (g !== group) {
        if (wmax > 0) h += wmax * (swh / sw - h);
        group = g;
        sw = 0;
        swh = 0;
        wmax = 0;
      }
      const o = item * SEG;
      const ax = seg[o + S_AX];
      const az = seg[o + S_AZ];
      const px = x - ax;
      const pz = z - az;
      const reach = seg[o + S_REACH];
      const dx = seg[o + S_DX];
      const dz = seg[o + S_DZ];
      const tu = (px * dx + pz * dz) * seg[o + S_INV];
      const tc = tu < 0 ? 0 : tu > 1 ? 1 : tu;
      const qx = px - dx * tc;
      const qz = pz - dz * tc;
      const d2 = qx * qx + qz * qz;
      if (d2 >= reach * reach) continue;
      const inner = seg[o + S_IA] + (seg[o + S_IB] - seg[o + S_IA]) * tc;
      const d = Math.sqrt(d2);
      let w: number;
      if (d <= inner) w = 1;
      else {
        const t = (d - inner) / seg[o + S_BL];
        if (t >= 1) continue;
        w = 1 - t * t * (3 - 2 * t);
      }
      const hf = seg[o + S_HA] + (seg[o + S_HB] - seg[o + S_HA]) * tu;
      sw += w;
      swh += w * hf;
      if (w > wmax) wmax = w;
    } else {
      if (wmax > 0) {
        h += wmax * (swh / sw - h);
        wmax = 0;
      }
      group = -1;
      h = blendPad(fs.pad, -1 - item, x, z, h);
    }
  }
  if (wmax > 0) h += wmax * (swh / sw - h);
  return h;
}

/**
 * Distance outside a pad's flat area (0 inside) for a point (px, pz) relative to the pad centre:
 * a disc of radius hl, or a rectangle of half sides hl (along the unit axis (ex, ez)) and hw.
 */
function shapeDistance(
  disc: boolean,
  px: number,
  pz: number,
  ex: number,
  ez: number,
  hl: number,
  hw: number,
): number {
  if (disc) {
    const d = Math.sqrt(px * px + pz * pz) - hl;
    return d > 0 ? d : 0;
  }
  const along = Math.abs(px * ex + pz * ez) - hl;
  const across = Math.abs(-px * ez + pz * ex) - hw;
  const ax = along > 0 ? along : 0;
  const az = across > 0 ? across : 0;
  return Math.sqrt(ax * ax + az * az);
}

/** Signed-free distance outside a pad's flat area (0 inside). */
function padDistance(pad: Float64Array, o: number, x: number, z: number): number {
  return shapeDistance(
    pad[o + P_SHAPE] === 0,
    x - pad[o + P_CX],
    z - pad[o + P_CZ],
    pad[o + P_EX],
    pad[o + P_EZ],
    pad[o + P_HL],
    pad[o + P_HW],
  );
}

/**
 * The flat pads of a generated world as PadSpecs, in the order blendFeatures applies them
 * (range discs, then the airfield). The terrain and the generator (which lays road beds flush
 * with the pads) both build them here, so they agree to the bit.
 */
export function padSpecsOf(pads: WorldExtra['pads'], airfield: WorldExtra['airfield']): PadSpec[] {
  const out: PadSpec[] = pads.map((p) => ({
    shape: 'disc',
    x: p.x,
    z: p.z,
    ex: 1,
    ez: 0,
    halfLength: p.radius,
    halfWidth: p.radius,
    blend: p.blend,
    elevation: p.elevation,
    gx: p.gx,
    gz: p.gz,
    role: 'range',
  }));
  if (airfield) {
    out.push({
      shape: 'rect',
      x: airfield.x,
      z: airfield.z,
      ex: Math.sin(airfield.heading),
      ez: -Math.cos(airfield.heading),
      halfLength: airfield.halfLength,
      halfWidth: airfield.halfWidth,
      blend: airfield.blend,
      elevation: airfield.elevation,
      gx: airfield.gx,
      gz: airfield.gz,
      role: 'airfield',
    });
  }
  return out;
}

/**
 * Blend weight of a pad at (x, z): 1 on its flat area, falling smoothly to 0 at `blend` metres
 * outside it (the weight blendFeatures gives the pad's plane there).
 */
export function padWeight(p: PadSpec, x: number, z: number): number {
  const d = shapeDistance(
    p.shape === 'disc',
    x - p.x,
    z - p.z,
    p.ex,
    p.ez,
    p.halfLength,
    p.halfWidth,
  );
  return d >= p.blend ? 0 : 1 - smooth01(d / p.blend);
}

/** Height of a pad's plane at (x, z), m. */
export function padPlaneAt(p: PadSpec, x: number, z: number): number {
  return p.elevation + p.gx * (x - p.x) + p.gz * (z - p.z);
}

function blendPad(pad: Float64Array, k: number, x: number, z: number, h: number): number {
  const o = k * PAD;
  const d = padDistance(pad, o, x, z);
  const bl = pad[o + P_BL];
  if (d >= bl) return h;
  const w = 1 - smooth01(d / bl);
  const hf =
    pad[o + P_H0] + pad[o + P_GX] * (x - pad[o + P_CX]) + pad[o + P_GZ] * (z - pad[o + P_CZ]);
  return h + w * (hf - h);
}

/** What the feature layer says about a point (surface classification, canopy clearing…). */
export interface FeatureQuery {
  /** Nearest road: distance to its centre line (Infinity if none in range), its kind and half width. */
  roadDistance: number;
  roadKind: number;
  roadHalfWidth: number;
  /** Index into `roads` of the nearest road, and distance along it at the nearest point. */
  roadIndex: number;
  roadArc: number;
  /** River: distance from the centre line, water half width there, water level there, bank. */
  riverDistance: number;
  riverHalfWidth: number;
  waterLevel: number;
  riverBank: number;
  riverIndex: number;
  /** Inside a range pad's flat area (index) or −1; distance outside the nearest range pad. */
  padIndex: number;
  padDistance: number;
  /** Distance outside the airfield rectangle (0 inside; Infinity if none near). */
  airfieldDistance: number;
}

export function createFeatureQuery(): FeatureQuery {
  return {
    roadDistance: Infinity,
    roadKind: -1,
    roadHalfWidth: 0,
    roadIndex: -1,
    roadArc: 0,
    riverDistance: Infinity,
    riverHalfWidth: 0,
    waterLevel: -Infinity,
    riverBank: 0,
    riverIndex: -1,
    padIndex: -1,
    padDistance: Infinity,
    airfieldDistance: Infinity,
  };
}

/**
 * Nearest road, river and pads at (x, z) within the index reach (≈ blend zones; road distances
 * up to `extraReach` metres further are found too because the index cell is 125 m).
 */
export function queryFeatures(fs: FeatureSet, x: number, z: number, q: FeatureQuery): FeatureQuery {
  q.roadDistance = Infinity;
  q.roadKind = -1;
  q.roadHalfWidth = 0;
  q.roadIndex = -1;
  q.roadArc = 0;
  q.riverDistance = Infinity;
  q.riverHalfWidth = 0;
  q.waterLevel = -Infinity;
  q.riverBank = 0;
  q.riverIndex = -1;
  q.padIndex = -1;
  q.padDistance = Infinity;
  q.airfieldDistance = Infinity;
  const c = featureCell(fs, x, z);
  const start = fs.cellStart[c];
  const end = fs.cellStart[c + 1];
  const seg = fs.seg;
  for (let k = start; k < end; k++) {
    const item = fs.cellItems[k];
    if (item >= 0) {
      const o = item * SEG;
      const px = x - seg[o + S_AX];
      const pz = z - seg[o + S_AZ];
      const dx = seg[o + S_DX];
      const dz = seg[o + S_DZ];
      const tu = (px * dx + pz * dz) * seg[o + S_INV];
      const tc = tu < 0 ? 0 : tu > 1 ? 1 : tu;
      const qx = px - dx * tc;
      const qz = pz - dz * tc;
      const d = Math.sqrt(qx * qx + qz * qz);
      const g = fs.segGroup[item];
      const kind = fs.groupKind[g];
      if (kind === KIND_RIVER) {
        // Compare by distance beyond the water edge (width varies along the river).
        const hw = seg[o + S_CA] + (seg[o + S_CB] - seg[o + S_CA]) * tc;
        if (d - hw < q.riverDistance - q.riverHalfWidth) {
          q.riverDistance = d;
          q.riverHalfWidth = hw;
          q.waterLevel = seg[o + S_HA] + (seg[o + S_HB] - seg[o + S_HA]) * tc;
          q.riverBank = fs.groupBank[g];
          q.riverIndex = fs.groupRef[g];
        }
      } else {
        const hw = seg[o + S_CA];
        // Prefer the road whose pavement is nearest (a highway's edge beats a track's centre).
        if (d - hw < q.roadDistance - q.roadHalfWidth) {
          q.roadDistance = d;
          q.roadKind = kind;
          q.roadHalfWidth = hw;
          q.roadIndex = fs.groupRef[g];
          q.roadArc = seg[o + S_ARC] + tc * Math.sqrt(dx * dx + dz * dz);
        }
      }
    } else {
      const p = -1 - item;
      const o = p * PAD;
      const d = padDistance(fs.pad, o, x, z);
      if (fs.padRole[p] === 1) {
        if (d < q.airfieldDistance) q.airfieldDistance = d;
      } else if (d < q.padDistance) {
        q.padDistance = d;
        q.padIndex = p;
      }
    }
  }
  return q;
}

/** Pad accessors for bounds and surface rules. */
export function padCentre(fs: FeatureSet, k: number): { x: number; z: number; radius: number } {
  const o = k * PAD;
  return { x: fs.pad[o + P_CX], z: fs.pad[o + P_CZ], radius: fs.pad[o + P_HL] };
}

/**
 * Bounds the feature layer adds inside one index cell, for the ray-query hierarchy:
 * the highest and lowest feature surface any item can produce there, and the extra slope its
 * blends can add (Σ over groups and pads of grade + |cut/fill| · 1.5 / blend, where the
 * cut/fill depth is bounded by `depth(k)` supplied by the caller).
 */
export function cellFeatureBounds(
  fs: FeatureSet,
  cell: number,
  depthOfSegment: (seg: number) => number,
  depthOfPad: (pad: number) => number,
  /** Upper limit of any cut/fill depth in the cell (its whole height range). */
  depthCap: number,
  out: { hMax: number; hMin: number; slope: number },
): boolean {
  const start = fs.cellStart[cell];
  const end = fs.cellStart[cell + 1];
  out.hMax = -Infinity;
  out.hMin = Infinity;
  out.slope = 0;
  if (start === end) return false;
  const seg = fs.seg;
  let group = -1;
  let gSlope = 0;
  for (let k = start; k < end; k++) {
    const item = fs.cellItems[k];
    if (item >= 0) {
      const o = item * SEG;
      const g = fs.segGroup[item];
      if (g !== group) {
        out.slope += gSlope;
        gSlope = 0;
        group = g;
      }
      const ha = seg[o + S_HA];
      const hb = seg[o + S_HB];
      const len2 = seg[o + S_INV] > 0 ? 1 / seg[o + S_INV] : 0;
      const len = Math.sqrt(len2);
      // Extrapolated ramp: within reach of the segment, |t| can exceed [0,1] by reach/len.
      const ext = len > 0 ? seg[o + S_REACH] / len : 0;
      const dh = Math.abs(hb - ha);
      out.hMax = Math.max(out.hMax, Math.max(ha, hb) + dh * ext);
      out.hMin = Math.min(out.hMin, Math.min(ha, hb) - dh * ext);
      const grade = len > 0 ? dh / len : 0;
      const depth = Math.min(depthOfSegment(item), depthCap);
      const s = grade + (depth * 1.5) / seg[o + S_BL] + 0.1;
      if (s > gSlope) gSlope = s;
    } else {
      out.slope += gSlope;
      gSlope = 0;
      group = -1;
      const p = -1 - item;
      const o = p * PAD;
      const r =
        fs.pad[o + P_SHAPE] === 0
          ? fs.pad[o + P_HL]
          : Math.hypot(fs.pad[o + P_HL], fs.pad[o + P_HW]);
      const reach = r + fs.pad[o + P_BL];
      const grad = Math.hypot(fs.pad[o + P_GX], fs.pad[o + P_GZ]);
      const h0 = fs.pad[o + P_H0];
      out.hMax = Math.max(out.hMax, h0 + grad * reach);
      out.hMin = Math.min(out.hMin, h0 - grad * reach);
      out.slope += grad + (Math.min(depthOfPad(p), depthCap) * 1.5) / fs.pad[o + P_BL];
    }
  }
  out.slope += gSlope;
  return true;
}

/** Raw access for bounds computations (segment endpoints and surface heights). */
export function segmentEnds(
  fs: FeatureSet,
  k: number,
  out: { ax: number; az: number; bx: number; bz: number; ha: number; hb: number; reach: number },
): void {
  const o = k * SEG;
  out.ax = fs.seg[o + S_AX];
  out.az = fs.seg[o + S_AZ];
  out.bx = fs.seg[o + S_BX];
  out.bz = fs.seg[o + S_BZ];
  out.ha = fs.seg[o + S_HA];
  out.hb = fs.seg[o + S_HB];
  out.reach = fs.seg[o + S_REACH];
}

export function padPlane(
  fs: FeatureSet,
  k: number,
  out: { x: number; z: number; reach: number; h0: number; gx: number; gz: number },
): void {
  const o = k * PAD;
  out.x = fs.pad[o + P_CX];
  out.z = fs.pad[o + P_CZ];
  const r =
    fs.pad[o + P_SHAPE] === 0 ? fs.pad[o + P_HL] : Math.hypot(fs.pad[o + P_HL], fs.pad[o + P_HW]);
  out.reach = r + fs.pad[o + P_BL];
  out.h0 = fs.pad[o + P_H0];
  out.gx = fs.pad[o + P_GX];
  out.gz = fs.pad[o + P_GZ];
}
