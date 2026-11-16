/**
 * The road network: a highway along the valley, a secondary road on the far side of the river,
 * bridges between them, the airbase access road, roads over the ridges, and dirt tracks to the
 * range, the woods and the hills.
 *
 * Each road is routed by A* over a 250 m cost grid (16 move directions) where cost grows with
 * the square of the grade relative to the road's design grade, river crossings cost a bridge
 * (tracks may not cross), flood plains and the airfield / range pads are avoided, and running
 * along an existing road is penalised (a road that should join one is routed TO the network and
 * ends at the junction). The route is simplified, rounded (Chaikin), resampled every 15 m and
 * given a road-bed profile: the natural ground (micro-relief included) smoothed along the road,
 * limited to the design grade (cut and fill), and raised over the river on a causeway. When the
 * network is complete, every road is pinned to the bed of any higher-ranked road its pavement
 * meets (junctions, crossings) and its profile is rounded into vertical curves.
 */
import { Rng } from '../../rng';
import { RANGE_WORLD } from '../params';
import type { RiverPolyline, RoadKind, RoadPolyline } from '../types';
import { gridBSpline, sampleBilinear, type Grid } from './grid';
import { axisV, fromUVx, fromUVz, halfWidth, toU, toV, valleyT, type Layout } from './layout';
import { FAR, riverSideOf, type RiverField } from './river';
import type { AirbaseSite, RangePad } from './sites';

const CELL = 250;
const RESAMPLE = 15;
/** Smallest curve radius of each road kind, m (hairpins any tighter are opened out). */
const MIN_RADIUS: Record<RoadKind, number> = { highway: 250, road: 60, track: 35 };

interface CostGrid {
  n: number;
  half: number;
  h: Float32Array;
  side: Int8Array;
  flood: Uint8Array;
  blocked: Uint8Array;
  road: Int32Array;
  forest: Float32Array;
}

/** The 16 move directions (king and knight moves) and their lengths in cells. */
const MOVE_I = new Int8Array([1, -1, 0, 0, 1, 1, -1, -1, 2, 2, -2, -2, 1, 1, -1, -1]);
const MOVE_J = new Int8Array([0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 2, -2, 2, -2]);
const MOVE_L = new Float64Array(16).map((_, k) => Math.hypot(MOVE_I[k], MOVE_J[k]));

function maxGrade(kind: RoadKind): number {
  return kind === 'highway'
    ? RANGE_WORLD.highwayMaxGrade
    : kind === 'road'
      ? RANGE_WORLD.roadMaxGrade
      : RANGE_WORLD.trackMaxGrade;
}

function widthOf(kind: RoadKind): number {
  return kind === 'highway'
    ? RANGE_WORLD.highwayWidth
    : kind === 'road'
      ? RANGE_WORLD.roadWidth
      : RANGE_WORLD.trackWidth;
}

function buildCostGrid(
  g: Grid,
  rf: RiverField,
  site: AirbaseSite,
  pads: RangePad[],
  forestAt: (x: number, z: number) => number,
): CostGrid {
  const n = Math.round(g.size / CELL);
  const half = g.half;
  const h = new Float32Array(n * n);
  const side = new Int8Array(n * n);
  const flood = new Uint8Array(n * n);
  const blocked = new Uint8Array(n * n);
  const road = new Int32Array(n * n).fill(-1);
  const forest = new Float32Array(n * n);
  const a = site.airfield;
  const ex = Math.sin(a.heading);
  const ez = -Math.cos(a.heading);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + (i + 0.5) * CELL;
      const z = -half + (j + 0.5) * CELL;
      const k = j * n + i;
      h[k] = gridBSpline(g, x, z);
      // Side of the river: from the nearest grid sample's splat.
      const gi = Math.round((x + half) / g.spacing);
      const gj = Math.round((z + half) / g.spacing);
      const gk = gj * g.n + gi;
      const d = rf.dist[gk];
      if (d < FAR) side[k] = rf.side[gk];
      if (d < 380) flood[k] = 1;
      // Airfield (+ margin) and range pads (+ margin) are off limits.
      const px = x - a.x;
      const pz = z - a.z;
      const al = Math.abs(px * ex + pz * ez) - a.halfLength - 250;
      const ac = Math.abs(-px * ez + pz * ex) - a.halfWidth - 250;
      if (al < 0 && ac < 0) blocked[k] = 1;
      for (const p of pads) if (Math.hypot(x - p.x, z - p.z) < p.radius + 420) blocked[k] = 1;
      forest[k] = forestAt(x, z);
    }
  }
  return { n, half, h, side, flood, blocked, road, forest };
}

/** Binary min-heap of node indices keyed by Float64 priorities (preallocated). */
class Heap {
  private items: Int32Array;
  private keys: Float64Array;
  size = 0;
  constructor(capacity: number) {
    this.items = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
  }
  clear(): void {
    this.size = 0;
  }
  push(item: number, key: number): void {
    if (this.size >= this.items.length) {
      const ni = new Int32Array(this.items.length * 2);
      ni.set(this.items);
      const nk = new Float64Array(this.keys.length * 2);
      nk.set(this.keys);
      this.items = ni;
      this.keys = nk;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.items[i] = this.items[p];
      this.keys[i] = this.keys[p];
      i = p;
    }
    this.items[i] = item;
    this.keys[i] = key;
  }
  pop(): number {
    const top = this.items[0];
    const last = --this.size;
    const item = this.items[last];
    const key = this.keys[last];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= last) break;
      if (c + 1 < last && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.items[i] = this.items[c];
      this.keys[i] = this.keys[c];
      i = c;
    }
    this.items[i] = item;
    this.keys[i] = key;
    return top;
  }
}

interface Search {
  gScore: Float64Array;
  parent: Int32Array;
  closed: Uint8Array;
  heap: Heap;
}

function createSearch(n: number): Search {
  return {
    gScore: new Float64Array(n * n),
    parent: new Int32Array(n * n),
    closed: new Uint8Array(n * n),
    heap: new Heap(n * n),
  };
}

/**
 * A* from `start` to `goal` (a node) or to any node with goalMask set. Returns the node path
 * (start … goal) or null.
 */
function route(
  cg: CostGrid,
  S: Search,
  kind: RoadKind,
  start: number,
  goal: number,
  goalMask: Uint8Array | null,
  selfId: number,
): number[] | null {
  const n = cg.n;
  S.gScore.fill(Infinity);
  S.closed.fill(0);
  S.parent.fill(-1);
  S.heap.clear();
  const gx = goal % n;
  const gz = (goal / n) | 0;
  const gm = maxGrade(kind);
  const hScale = goalMask ? 0 : CELL * 0.98;
  S.gScore[start] = 0;
  S.heap.push(start, 0);
  // Short roads give up rather than search the whole map when the target is cut off.
  let budget = kind === 'track' ? 30000 : Infinity;
  while (S.heap.size > 0) {
    const a = S.heap.pop();
    if (S.closed[a]) continue;
    S.closed[a] = 1;
    if (--budget < 0) return null;
    if (goalMask ? goalMask[a] === 1 && a !== start : a === goal) {
      const path: number[] = [];
      for (let p = a; p >= 0; p = S.parent[p]) path.push(p);
      return path.reverse();
    }
    const ai = a % n;
    const aj = (a / n) | 0;
    for (let mv = 0; mv < 16; mv++) {
      const bi = ai + MOVE_I[mv];
      const bj = aj + MOVE_J[mv];
      if (bi < 0 || bj < 0 || bi >= n || bj >= n) continue;
      const b = bj * n + bi;
      if (S.closed[b]) continue;
      const isGoal = goalMask ? goalMask[b] === 1 : b === goal;
      if (cg.blocked[b] && !isGoal) continue;
      const L = CELL * MOVE_L[mv];
      const grade = Math.abs(cg.h[b] - cg.h[a]) / L;
      let c = L * (1 + 3 * (grade / gm) * (grade / gm));
      if (grade > gm * 1.5) c *= 25;
      if (cg.side[a] !== 0 && cg.side[b] !== 0 && cg.side[a] !== cg.side[b]) {
        if (kind === 'track') continue;
        c += 2500;
      }
      if (cg.flood[b]) c *= kind === 'highway' ? 1.8 : kind === 'road' ? 1.25 : 1.1;
      if (kind !== 'track') c *= 1 + 0.25 * cg.forest[b];
      // Do not run along an existing road (leaving one at the start, or crossing, is fine).
      if (cg.road[b] >= 0 && cg.road[b] !== selfId && a !== start && !isGoal) c *= 3;
      const t = S.gScore[a] + c;
      if (t < S.gScore[b]) {
        S.gScore[b] = t;
        S.parent[b] = a;
        const hx = bi - gx;
        const hz = bj - gz;
        S.heap.push(b, t + hScale * Math.sqrt(hx * hx + hz * hz));
      }
    }
  }
  return null;
}

function nodeOf(cg: CostGrid, x: number, z: number): number {
  const i = Math.min(cg.n - 1, Math.max(0, Math.floor((x + cg.half) / CELL)));
  const j = Math.min(cg.n - 1, Math.max(0, Math.floor((z + cg.half) / CELL)));
  return j * cg.n + i;
}

function nodeX(cg: CostGrid, k: number): number {
  return -cg.half + ((k % cg.n) + 0.5) * CELL;
}

function nodeZ(cg: CostGrid, k: number): number {
  return -cg.half + (((k / cg.n) | 0) + 0.5) * CELL;
}

/** Douglas–Peucker simplification of an (x, z) list. */
function simplify(pts: number[], tol: number): number[] {
  const n = pts.length / 2;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[2 * a];
    const az = pts[2 * a + 1];
    const dx = pts[2 * b] - ax;
    const dz = pts[2 * b + 1] - az;
    const l = Math.hypot(dx, dz) || 1;
    let best = -1;
    let bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[2 * i] - ax) * dz - (pts[2 * i + 1] - az) * dx) / l;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

/** Chaikin corner cutting (endpoints kept). */
function chaikin(pts: number[], iterations: number): number[] {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    const n = p.length / 2;
    if (n < 3) return p;
    const q: number[] = [p[0], p[1]];
    for (let i = 0; i < n - 1; i++) {
      const ax = p[2 * i];
      const az = p[2 * i + 1];
      const bx = p[2 * i + 2];
      const bz = p[2 * i + 3];
      if (i > 0) q.push(0.75 * ax + 0.25 * bx, 0.75 * az + 0.25 * bz);
      if (i < n - 2) q.push(0.25 * ax + 0.75 * bx, 0.25 * az + 0.75 * bz);
    }
    q.push(p[2 * n - 2], p[2 * n - 1]);
    p = q;
  }
  return p;
}

/** Resample a polyline at a fixed spacing (last point kept). */
function resample(pts: number[], step: number): Float64Array {
  const n = pts.length / 2;
  const out: number[] = [pts[0], pts[1]];
  let carry = 0;
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[2 * i];
    const az = pts[2 * i + 1];
    const dx = pts[2 * i + 2] - ax;
    const dz = pts[2 * i + 3] - az;
    const l = Math.hypot(dx, dz);
    let s = step - carry;
    while (s < l) {
      out.push(ax + (dx * s) / l, az + (dz * s) / l);
      s += step;
    }
    carry = l - (s - step);
  }
  const lx = out[out.length - 2];
  const lz = out[out.length - 1];
  const ex = pts[2 * n - 2];
  const ez = pts[2 * n - 1];
  if (Math.hypot(ex - lx, ez - lz) < step * 0.4 && out.length > 4) {
    out[out.length - 2] = ex;
    out[out.length - 1] = ez;
  } else out.push(ex, ez);
  return new Float64Array(out);
}

/**
 * Open out curves tighter than `radius`: Laplacian smoothing (each vertex pulled toward the
 * midpoint of its neighbours) of the stretches whose turn per segment exceeds RESAMPLE / radius,
 * then resampling, until none do. Ends stay fixed. Switchback legs move apart this way, so the
 * road beds of two legs never blend into each other.
 */
function limitCurvature(points: Float64Array, radius: number): Float64Array {
  const maxTurn = RESAMPLE / radius;
  let p = points;
  for (let round = 0; round < 40; round++) {
    const n = p.length / 2;
    if (n < 4) return p;
    const mark = new Uint8Array(n);
    let any = false;
    for (let i = 1; i < n - 1; i++) {
      const ax = p[2 * i] - p[2 * i - 2];
      const az = p[2 * i + 1] - p[2 * i - 1];
      const bx = p[2 * i + 2] - p[2 * i];
      const bz = p[2 * i + 3] - p[2 * i + 1];
      const turn = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
      if (turn > maxTurn) {
        any = true;
        for (let k = Math.max(1, i - 6); k <= Math.min(n - 2, i + 6); k++) mark[k] = 1;
      }
    }
    if (!any) return p;
    const q = Float64Array.from(p);
    for (let it = 0; it < 12; it++) {
      for (let i = 1; i < n - 1; i++) {
        if (!mark[i]) continue;
        q[2 * i] += 0.5 * (0.5 * (q[2 * i - 2] + q[2 * i + 2]) - q[2 * i]);
        q[2 * i + 1] += 0.5 * (0.5 * (q[2 * i - 1] + q[2 * i + 3]) - q[2 * i + 1]);
      }
    }
    p = resample(Array.from(q), RESAMPLE);
  }
  return p;
}

/** Nearest point on a road polyline: index of the segment, fraction, distance, point. */
function nearestOnRoad(
  r: RoadPolyline,
  x: number,
  z: number,
): { seg: number; t: number; d: number; x: number; z: number } {
  const p = r.points;
  let best = { seg: 0, t: 0, d: Infinity, x: p[0], z: p[1] };
  for (let i = 0; i < p.length / 2 - 1; i++) {
    const ax = p[2 * i];
    const az = p[2 * i + 1];
    const dx = p[2 * i + 2] - ax;
    const dz = p[2 * i + 3] - az;
    const l2 = dx * dx + dz * dz || 1;
    let t = ((x - ax) * dx + (z - az) * dz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t;
    const qz = az + dz * t;
    const d = Math.hypot(x - qx, z - qz);
    if (d < best.d) best = { seg: i, t, d, x: qx, z: qz };
  }
  return best;
}

export interface RoadBuild {
  roads: RoadPolyline[];
  /** Ends of the dirt tracks (for dug-in positions). */
  trackEnds: Array<{ x: number; z: number }>;
}

/** Build the whole network. */
export function buildRoads(
  L: Layout,
  g: Grid,
  rf: RiverField,
  site: AirbaseSite,
  pads: RangePad[],
  river: RiverPolyline,
  rng: Rng,
  forestAt: (x: number, z: number) => number,
  /** The natural ground the roads are laid on (B-spline + micro-relief), m. */
  natural: (x: number, z: number) => number,
): RoadBuild {
  const cg = buildCostGrid(g, rf, site, pads, forestAt);
  const S = createSearch(cg.n);
  const roads: RoadPolyline[] = [];
  const trackEnds: Array<{ x: number; z: number }> = [];
  const half = L.half;

  /** Where the valley line at side offset vf meets the map edge going toward sign(dir)·u. */
  function edgePoint(dir: number, vf: number): { x: number; z: number } {
    let u = 0;
    let x = 0;
    let z = 0;
    for (let k = 0; k < 400; k++) {
      u += dir * 200;
      const v = axisV(L, u) + vf * halfWidth(L, u);
      x = fromUVx(L, u, v);
      z = fromUVz(L, u, v);
      if (Math.abs(x) > half - 60 || Math.abs(z) > half - 60) break;
    }
    return { x: Math.max(-half + 60, Math.min(half - 60, x)), z: Math.max(-half + 60, Math.min(half - 60, z)) };
  }

  /** Route, smooth, profile and register one road. Returns it or null. */
  function addRoad(
    kind: RoadKind,
    from: { x: number; z: number },
    to: { x: number; z: number } | null,
    joinsStart: number,
  ): RoadPolyline | null {
    const id = roads.length;
    const start = nodeOf(cg, from.x, from.z);
    let goalMask: Uint8Array | null = null;
    if (!to) {
      goalMask = new Uint8Array(cg.n * cg.n);
      let any = false;
      for (let k = 0; k < cg.road.length; k++) {
        if (cg.road[k] >= 0 && cg.road[k] !== joinsStart) {
          goalMask[k] = 1;
          any = true;
        }
      }
      if (!any) return null;
    }
    const goal = to ? nodeOf(cg, to.x, to.z) : 0;
    const path = route(cg, S, kind, start, goal, goalMask, id);
    if (!path || path.length < 2) return null;
    const pts: number[] = [from.x, from.z];
    for (let i = 1; i < path.length - 1; i++) pts.push(nodeX(cg, path[i]), nodeZ(cg, path[i]));
    let joinsEnd = -1;
    let end: { x: number; z: number };
    if (to) end = to;
    else {
      joinsEnd = cg.road[path[path.length - 1]];
      const target = roads[joinsEnd];
      const last = path[path.length - 1];
      const q = nearestOnRoad(target, nodeX(cg, last), nodeZ(cg, last));
      end = { x: q.x, z: q.z };
    }
    pts.push(end.x, end.z);
    const simple = simplify(pts, kind === 'highway' ? 70 : 50);
    const smooth = chaikin(simple, 4);
    const points = limitCurvature(resample(smooth, RESAMPLE), MIN_RADIUS[kind]);
    const m = points.length / 2;
    if (m < 3) return null;
    const arc = new Float64Array(m);
    for (let i = 1; i < m; i++) {
      arc[i] = arc[i - 1] + Math.hypot(points[2 * i] - points[2 * i - 2], points[2 * i + 1] - points[2 * i - 1]);
    }
    const heights = profile(kind, points, arc);
    const road: RoadPolyline = {
      id,
      kind,
      points,
      width: widthOf(kind),
      heights,
      arc,
      length: arc[m - 1],
      joinsStart,
      joinsEnd,
    };
    roads.push(road);
    // Mark the cost grid (reuse discount, junction targets).
    for (let i = 0; i < m; i++) {
      const k = nodeOf(cg, points[2 * i], points[2 * i + 1]);
      if (cg.road[k] < 0) cg.road[k] = id;
    }
    return road;
  }

  /** Road-bed heights along a resampled centre line (before junctions are pinned). */
  function profile(kind: RoadKind, points: Float64Array, arc: Float64Array): Float64Array {
    const m = points.length / 2;
    const raw = new Float64Array(m);
    for (let i = 0; i < m; i++) raw[i] = natural(points[2 * i], points[2 * i + 1]);
    // Running mean over ±win vertices (±105 m highway, ±75 m road, ±30 m track).
    const win = kind === 'highway' ? 7 : kind === 'road' ? 5 : 2;
    const h = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      let s = 0;
      let c = 0;
      for (let k = Math.max(0, i - win); k <= Math.min(m - 1, i + win); k++) {
        s += raw[k];
        c++;
      }
      h[i] = s / c;
    }
    const gm = maxGrade(kind) * 0.95;
    gradeLimit(h, arc, gm);
    // Causeway over the river: ≥ 5 m above the water across the channel and banks, ramps at grade.
    const B = new Float64Array(m).fill(-Infinity);
    let bridge = false;
    for (let i = 0; i < m; i++) {
      const x = points[2 * i];
      const z = points[2 * i + 1];
      const d = sampleBilinear(g, rf.dist, x, z);
      const hw = sampleBilinear(g, rf.halfW, x, z);
      if (d < hw + RANGE_WORLD.riverBank + 30) {
        B[i] = sampleBilinear(g, rf.level, x, z) + 5;
        bridge = true;
      }
    }
    if (bridge) {
      for (let i = 1; i < m; i++) B[i] = Math.max(B[i], B[i - 1] - gm * (arc[i] - arc[i - 1]));
      for (let i = m - 2; i >= 0; i--) B[i] = Math.max(B[i], B[i + 1] - gm * (arc[i + 1] - arc[i]));
      for (let i = 0; i < m; i++) if (B[i] > h[i]) h[i] = B[i];
    }
    return h;
  }

  // 1. Highway along the valley on one side of the river.
  const hwSide = site.side;
  const hwA = edgePoint(-1, 0.42 * hwSide);
  const hwB = edgePoint(1, 0.42 * hwSide);
  const highway = addRoad('highway', hwA, hwB, -1);
  // 2. Valley road on the far side.
  const vrA = edgePoint(-1, -0.5 * hwSide);
  const vrB = edgePoint(1, -0.5 * hwSide);
  const valleyRoad = addRoad('road', vrA, vrB, -1);
  // 3. Airbase access road from the apron gate to the network.
  addRoad('road', site.gate, null, -1);
  // 4. Bridges between the two valley roads.
  if (highway && valleyRoad) {
    const cut = rng.int(2, 3);
    for (let c = 0; c < cut; c++) {
      const f = (c + 0.5) / cut + rng.range(-0.08, 0.08);
      const p = highway.points;
      const i = Math.min(p.length / 2 - 1, Math.max(0, Math.floor((p.length / 2) * f)));
      const from = { x: p[2 * i], z: p[2 * i + 1] };
      if (pads.some((q) => Math.hypot(q.x - from.x, q.z - from.z) < q.radius + 1500)) continue;
      addRoad('road', from, null, highway.id);
    }
  }
  // 5. Roads over the ridges to the map edge (one each side).
  for (const s of [1, -1]) {
    const base = s === hwSide ? highway : valleyRoad;
    if (!base) continue;
    const p = base.points;
    const i = Math.floor((p.length / 2) * rng.range(0.3, 0.7));
    const from = { x: p[2 * i], z: p[2 * i + 1] };
    const u = toU(L, from.x, from.z);
    const tgtU = u + rng.range(-6000, 6000);
    let tx = from.x;
    let tz = from.z;
    for (let k = 1; k < 200; k++) {
      const v = axisV(L, tgtU) + s * k * 250;
      tx = fromUVx(L, tgtU, v);
      tz = fromUVz(L, tgtU, v);
      if (Math.abs(tx) > half - 80 || Math.abs(tz) > half - 80) break;
    }
    tx = Math.max(-half + 80, Math.min(half - 80, tx));
    tz = Math.max(-half + 80, Math.min(half - 80, tz));
    addRoad('road', from, { x: tx, z: tz }, base.id);
  }
  // 6. Tracks to the range areas.
  for (const p of pads) {
    const toAb = Math.atan2(site.airbase.z - p.z, site.airbase.x - p.x);
    const gate = { x: p.x + Math.cos(toAb) * (p.radius + 450), z: p.z + Math.sin(toAb) * (p.radius + 450) };
    const r = addRoad('track', gate, null, -1);
    if (r) trackEnds.push(gate);
  }
  // 7. Dirt tracks from the roads into the woods and the foothills.
  const count = rng.int(10, 14);
  for (let c = 0; c < count * 3 && trackEnds.length < count + pads.length; c++) {
    const base = roads[rng.int(0, roads.length - 1)];
    if (!base || base.kind === 'track') continue;
    const p = base.points;
    const i = rng.int(0, p.length / 2 - 1);
    const from = { x: p[2 * i], z: p[2 * i + 1] };
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(2500, 5500);
    const to = { x: from.x + Math.cos(ang) * dist, z: from.z + Math.sin(ang) * dist };
    if (Math.abs(to.x) > half - 1500 || Math.abs(to.z) > half - 1500) continue;
    const t = valleyT(L, to.x, to.z);
    if (t < 0.45 || t > 1.7) continue;
    if (sampleBilinear(g, rf.dist, to.x, to.z) < 400) continue;
    const k = nodeOf(cg, to.x, to.z);
    if (cg.blocked[k]) continue;
    // Tracks do not bridge the river: skip destinations on the far bank.
    if (riverSideOf(L, river, from.x, from.z) !== riverSideOf(L, river, to.x, to.z)) continue;
    const r = addRoad('track', from, to, base.id);
    if (r) trackEnds.push(to);
  }
  void toV;
  connectProfiles(roads);
  return { roads, trackEnds };
}

/**
 * Limit a profile to a grade (forward then backward pass); vertices flagged in `fixed` keep
 * their height and their neighbours give way.
 */
function gradeLimit(h: Float64Array, arc: Float64Array, g: number, fixed?: Uint8Array): void {
  const m = h.length;
  for (let i = 1; i < m; i++) {
    if (fixed && fixed[i]) continue;
    const d = g * (arc[i] - arc[i - 1]);
    if (h[i] > h[i - 1] + d) h[i] = h[i - 1] + d;
    else if (h[i] < h[i - 1] - d) h[i] = h[i - 1] - d;
  }
  for (let i = m - 2; i >= 0; i--) {
    if (fixed && fixed[i]) continue;
    const d = g * (arc[i + 1] - arc[i]);
    if (h[i] > h[i + 1] + d) h[i] = h[i + 1] + d;
    else if (h[i] < h[i + 1] - d) h[i] = h[i + 1] - d;
  }
}

/** Rank of a road: highways over roads over tracks; among equals the older (lower id) wins. */
function rank(r: RoadPolyline): number {
  return (r.kind === 'highway' ? 2 : r.kind === 'road' ? 1 : 0) * 1e6 - r.id;
}

/**
 * Make the network consistent: wherever a road's pavement meets a higher-ranked road's pavement
 * (junction, crossing), its bed takes that road's height there and ramps away at its design
 * grade; then every profile is rounded with vertical curves (binomial smoothing, pinned points
 * held), so the grade changes gently from one 15 m segment to the next.
 */
function connectProfiles(roads: RoadPolyline[]): void {
  // Spatial hash of all segments (200 m cells).
  const CELLH = 200;
  const buckets = new Map<number, number[]>();
  const key = (i: number, j: number) => (i + 1000) * 4096 + (j + 1000);
  roads.forEach((r, ri) => {
    const p = r.points;
    for (let s = 0; s < p.length / 2 - 1; s++) {
      const i0 = Math.floor(Math.min(p[2 * s], p[2 * s + 2]) / CELLH);
      const i1 = Math.floor(Math.max(p[2 * s], p[2 * s + 2]) / CELLH);
      const j0 = Math.floor(Math.min(p[2 * s + 1], p[2 * s + 3]) / CELLH);
      const j1 = Math.floor(Math.max(p[2 * s + 1], p[2 * s + 3]) / CELLH);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = key(i, j);
          let b = buckets.get(k);
          if (!b) buckets.set(k, (b = []));
          b.push(ri, s);
        }
      }
    }
  });
  const order = roads.map((_, i) => i).sort((a, b) => rank(roads[b]) - rank(roads[a]));
  for (const ri of order) {
    const r = roads[ri];
    const p = r.points;
    const h = r.heights!;
    const arc = r.arc!;
    const m = p.length / 2;
    const gm = maxGrade(r.kind) * 0.95;
    const pinned = new Uint8Array(m);
    const myRank = rank(r);
    const pins: Array<[number, number]> = [];
    for (let v = 0; v < m; v++) {
      const x = p[2 * v];
      const z = p[2 * v + 1];
      const ci = Math.floor(x / CELLH);
      const cj = Math.floor(z / CELLH);
      let bestD = Infinity;
      let bestH = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const b = buckets.get(key(ci + di, cj + dj));
          if (!b) continue;
          for (let q = 0; q < b.length; q += 2) {
            const o = roads[b[q]];
            if (rank(o) <= myRank) continue;
            const s = b[q + 1];
            const op = o.points;
            const ax = op[2 * s];
            const az = op[2 * s + 1];
            const dx = op[2 * s + 2] - ax;
            const dz = op[2 * s + 3] - az;
            const l2 = dx * dx + dz * dz || 1;
            let t = ((x - ax) * dx + (z - az) * dz) / l2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const d = Math.sqrt((x - ax - dx * t) ** 2 + (z - az - dz * t) ** 2);
            // Pavements touch: this vertex lies on the other road's bed.
            if (d < (r.width + o.width) / 2 + 2 && d < bestD) {
              bestD = d;
              bestH = o.heights![s] + (o.heights![s + 1] - o.heights![s]) * t;
            }
          }
        }
      }
      if (bestD < Infinity) {
        pins.push([v, bestH]);
        pinned[v] = 1;
      }
    }
    for (const [v, value] of pins) {
      for (let k = 0; k < m; k++) {
        const d = Math.abs(arc[k] - arc[v]);
        const lo = value - gm * d;
        const hi = value + gm * d;
        if (h[k] < lo) h[k] = lo;
        else if (h[k] > hi) h[k] = hi;
      }
    }
    // Vertical curves: 16 binomial passes (≈ ±45 m), pinned vertices held; free ends follow.
    const tmp = new Float64Array(m);
    for (let pass = 0; pass < 16; pass++) {
      tmp.set(h);
      for (let k = 1; k < m - 1; k++) {
        if (!pinned[k]) h[k] = 0.25 * tmp[k - 1] + 0.5 * tmp[k] + 0.25 * tmp[k + 1];
      }
      if (!pinned[0]) h[0] = 0.5 * (tmp[0] + tmp[1]);
      if (!pinned[m - 1]) h[m - 1] = 0.5 * (tmp[m - 1] + tmp[m - 2]);
    }
    gradeLimit(h, arc, gm, pinned);
  }
}
