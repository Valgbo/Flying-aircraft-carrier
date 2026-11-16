/**
 * Target areas and the air start (PLAN_A10.md §5, §9, §11).
 *
 * The start lies over the low down-valley end, ~4.5 km inside the map. The first area (ALPHA) is
 * found 12 km from it, up the valley; every other non-range area is kept farther than 12.6 km
 * from the start, so ALPHA is the nearest and the start heads toward it. Areas are 12–16 places of
 * four kinds — open ground, along a tree line, on a road, dug in on the foothills — each on ground
 * whose slope stays under 6° everywhere within its radius, measured on the full height function
 * over a 30 m baseline (the scale of a vehicle group: micro-relief and road verges included, the
 * ripple of single furrows not), with no water inside it and neither water nor trees at its centre.
 * The three range areas come from the flattened range pads.
 */
import { headingOf } from '../../frames';
import { Rng } from '../../rng';
import type { RoadPolyline, TargetArea, TargetAreaKind, Terrain } from '../types';
import { axisV, downValleyAngle, fromUVx, fromUVz, toU, valleyT, type Layout } from './layout';
import type { AirbaseSite, RangePad } from './sites';

const NAMES = [
  'ALPHA',
  'BRAVO',
  'CHARLIE',
  'DELTA',
  'ECHO',
  'FOXTROT',
  'GOLF',
  'HOTEL',
  'INDIA',
  'JULIETT',
  'KILO',
  'LIMA',
  'MIKE',
  'NOVEMBER',
  'OSCAR',
  'PAPA',
];

const RADIUS: Record<Exclude<TargetAreaKind, 'range' | 'village'>, number> = {
  open: 450,
  treeline: 350,
  road: 600,
  dugIn: 300,
};

/** Largest ground slope allowed anywhere within an area, rad. */
export const AREA_MAX_SLOPE = (6 * Math.PI) / 180;
/** Baseline over which an area's ground slope is measured, m. */
export const AREA_SLOPE_BASELINE = 30;

/** Ground slope at (x, z) over AREA_SLOPE_BASELINE (central differences of heightAt), rad. */
export function areaSlopeAt(terrain: Terrain, x: number, z: number): number {
  const b = AREA_SLOPE_BASELINE / 2;
  const sx = (terrain.heightAt(x + b, z) - terrain.heightAt(x - b, z)) / AREA_SLOPE_BASELINE;
  const sz = (terrain.heightAt(x, z + b) - terrain.heightAt(x, z - b)) / AREA_SLOPE_BASELINE;
  return Math.atan(Math.sqrt(sx * sx + sz * sz));
}
/** First-area distance from the start, m. */
export const START_DISTANCE = 12000;

/** Sample points of an area: centre and five rings. */
const RINGS = [0.2, 0.4, 0.6, 0.8, 1.0];
const RING_COUNTS = [8, 12, 16, 20, 24];
function forAreaPoints(x: number, z: number, r: number, fn: (px: number, pz: number, ring: number) => boolean): boolean {
  if (!fn(x, z, 0)) return false;
  const rings = RINGS;
  const counts = RING_COUNTS;
  for (let k = 0; k < rings.length; k++) {
    for (let a = 0; a < counts[k]; a++) {
      const ang = ((a + 0.5 * k) / counts[k]) * Math.PI * 2;
      if (!fn(x + Math.cos(ang) * r * rings[k], z + Math.sin(ang) * r * rings[k], rings[k])) return false;
    }
  }
  return true;
}

/**
 * The placement rules every non-range area obeys (also used by the tests): slope < 6° at every
 * sample within the radius, no water within it, no trees or water at the centre.
 */
export function areaGroundOk(terrain: Terrain, x: number, z: number, r: number): boolean {
  const s = terrain.surfaceAt(x, z);
  if (s === 'water' || s === 'forest' || terrain.canopyAt(x, z) > 0) return false;
  // Rings first (cheap rejection), then a 25 m lattice over the whole disc, with a 10 % margin
  // for the slope between lattice points.
  const limit = AREA_MAX_SLOPE * 0.9;
  const ok = (px: number, pz: number) =>
    areaSlopeAt(terrain, px, pz) < limit &&
    !(terrain.waterLevelAt && terrain.waterLevelAt(px, pz) > -Infinity);
  if (!forAreaPoints(x, z, r, ok)) return false;
  const step = 25;
  for (let dz = -r; dz <= r; dz += step) {
    for (let dx = -r; dx <= r; dx += step) {
      if (dx * dx + dz * dz > r * r) continue;
      if (!ok(x + dx, z + dz)) return false;
    }
  }
  return true;
}

function kindOk(terrain: Terrain, kind: TargetAreaKind, x: number, z: number, r: number): boolean {
  if (kind === 'open') {
    return forAreaPoints(x, z, r, (px, pz, ring) => ring > 0.7 || terrain.canopyAt(px, pz) === 0);
  }
  if (kind === 'treeline') {
    let trees = false;
    const clearInner = forAreaPoints(x, z, r, (px, pz, ring) => {
      const c = terrain.canopyAt(px, pz) > 0;
      if (c && ring <= 0.4) return false;
      if (c) trees = true;
      return true;
    });
    return clearInner && trees;
  }
  return forAreaPoints(x, z, r, (px, pz, ring) => ring > 0.4 || terrain.canopyAt(px, pz) === 0);
}

export interface AreaPlan {
  areas: TargetArea[];
  start: { x: number; z: number; heading: number };
}

export function placeAreas(
  L: Layout,
  terrain: Terrain,
  roads: readonly RoadPolyline[],
  trackEnds: ReadonlyArray<{ x: number; z: number }>,
  site: AirbaseSite,
  pads: RangePad[],
  rng: Rng,
): AreaPlan {
  const half = L.half;
  // --- Start: over the down-valley end of the valley, 4.5 km inside the map.
  let sx = 0;
  let sz = 0;
  for (let k = 0; k < 400; k++) {
    const u = -L.upstream * (half * 1.5 - k * 250);
    const v = axisV(L, u);
    const x = fromUVx(L, u, v);
    const z = fromUVz(L, u, v);
    if (Math.abs(x) < half - 4500 && Math.abs(z) < half - 4500) {
      sx = x;
      sz = z;
      break;
    }
  }
  const upAngle = downValleyAngle(L, toU(L, sx, sz)) + Math.PI;

  const placed: Array<{ x: number; z: number; r: number; kind: TargetAreaKind; heading: number; roadId?: number; roadDistance?: number }> = [];
  const ab = site.airfield;
  const aex = Math.sin(ab.heading);
  const aez = -Math.cos(ab.heading);
  function clearOfSites(x: number, z: number, r: number): boolean {
    const px = x - ab.x;
    const pz = z - ab.z;
    const al = Math.max(0, Math.abs(px * aex + pz * aez) - ab.halfLength);
    const ac = Math.max(0, Math.abs(-px * aez + pz * aex) - ab.halfWidth);
    if (Math.hypot(al, ac) < r + 3000) return false;
    for (const p of pads) if (Math.hypot(x - p.x, z - p.z) < p.radius + r + 2200) return false;
    return Math.abs(x) < half - r - 2000 && Math.abs(z) < half - r - 2000;
  }
  function separated(x: number, z: number): boolean {
    return placed.every((p) => Math.hypot(p.x - x, p.z - z) > 3200);
  }
  function valid(kind: TargetAreaKind, x: number, z: number, r: number): boolean {
    return clearOfSites(x, z, r) && separated(x, z) && areaGroundOk(terrain, x, z, r) && kindOk(terrain, kind, x, z, r);
  }
  function headingFor(kind: TargetAreaKind, x: number, z: number): number {
    if (kind === 'treeline') {
      // Along the tree line: perpendicular to the direction of the nearest trees.
      for (let rr = 60; rr <= 400; rr += 40) {
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          if (terrain.canopyAt(x + Math.cos(ang) * rr, z + Math.sin(ang) * rr) > 0) {
            return headingOf(-Math.sin(ang), Math.cos(ang));
          }
        }
      }
    }
    const a = downValleyAngle(L, toU(L, x, z));
    return headingOf(Math.cos(a), Math.sin(a));
  }

  // --- ALPHA: 12 km from the start, up the valley.
  let alpha: (typeof placed)[number] | null = null;
  outer: for (const tol of [0, 1]) {
    for (let k = 0; k <= 30; k++) {
      for (const sgn of [1, -1]) {
        const ang = upAngle + sgn * k * ((tol ? 2.5 : 1.5) * Math.PI) / 180;
        for (const d of tol ? [START_DISTANCE - 450, START_DISTANCE + 450] : [START_DISTANCE, START_DISTANCE - 200, START_DISTANCE + 200]) {
          const x = sx + Math.cos(ang) * d;
          const z = sz + Math.sin(ang) * d;
          for (const kind of ['open', 'treeline', 'dugIn'] as const) {
            const r = RADIUS[kind];
            if (valid(kind, x, z, r)) {
              alpha = { x, z, r, kind, heading: headingFor(kind, x, z) };
              break outer;
            }
          }
        }
        if (k === 0) break;
      }
    }
  }
  if (alpha) placed.push(alpha);

  // --- The others.
  const total = rng.int(12, 16);
  const plan: TargetAreaKind[] = [];
  const kinds: TargetAreaKind[] = ['road', 'treeline', 'open', 'dugIn'];
  for (let k = 0; plan.length < total - placed.length; k++) plan.push(kinds[k % 4]);
  // Every other area farther from the start than ALPHA, so ALPHA is the nearest.
  const farFromStart = (x: number, z: number) => Math.hypot(x - sx, z - sz) > START_DISTANCE + 600;
  const valleyRoads = roads;
  for (const kind of plan) {
    const r = RADIUS[kind as keyof typeof RADIUS];
    let done = false;
    for (let attempt = 0; attempt < 400 && !done; attempt++) {
      let x: number;
      let z: number;
      let roadId: number | undefined;
      let roadDistance: number | undefined;
      let heading: number | undefined;
      if (kind === 'road') {
        const road = valleyRoads[rng.int(0, valleyRoads.length - 1)];
        if (!road || !road.arc) continue;
        const m = road.points.length / 2;
        const i = rng.int(Math.min(m - 1, 20), Math.max(0, m - 21));
        x = road.points[2 * i];
        z = road.points[2 * i + 1];
        roadId = roads.indexOf(road);
        roadDistance = road.arc[i];
        const j = Math.min(m - 1, i + 1);
        const i0 = j === i ? i - 1 : i;
        heading = headingOf(road.points[2 * j] - road.points[2 * i0], road.points[2 * j + 1] - road.points[2 * i0 + 1]);
      } else if (kind === 'dugIn' && attempt < trackEnds.length * 2 && trackEnds.length > 0) {
        const e = trackEnds[rng.int(0, trackEnds.length - 1)];
        x = e.x + rng.range(-300, 300);
        z = e.z + rng.range(-300, 300);
      } else {
        // Anywhere on the valley floor and lower foothills.
        const u = rng.range(-half * 1.2, half * 1.2);
        const tMax = kind === 'dugIn' ? 1.05 : 0.9;
        const tMin = kind === 'dugIn' ? 0.5 : 0;
        const tt = rng.range(tMin, tMax) * (rng.chance(0.5) ? 1 : -1);
        const v = axisV(L, u) + tt * 8000;
        x = fromUVx(L, u, v);
        z = fromUVz(L, u, v);
        if (kind === 'dugIn') {
          const t = valleyT(L, x, z);
          if (t < 0.45) continue;
        }
      }
      if (!farFromStart(x, z)) continue;
      if (!valid(kind, x, z, r)) continue;
      placed.push({ x, z, r, kind, heading: heading ?? headingFor(kind, x, z), roadId, roadDistance });
      done = true;
    }
  }

  // Names in order of distance from the start (ALPHA first).
  const ordered = placed
    .map((p) => ({ p, d: Math.hypot(p.x - sx, p.z - sz) }))
    .sort((a, b) => a.d - b.d)
    .map((e) => e.p);
  const areas: TargetArea[] = ordered.map((p, i) => {
    const a: TargetArea = {
      id: i,
      name: NAMES[i] ?? `AREA ${i + 1}`,
      kind: p.kind,
      x: p.x,
      z: p.z,
      radius: p.r,
      heading: p.heading,
      elevation: terrain.heightAt(p.x, p.z),
    };
    if (p.kind === 'road') {
      a.roadId = p.roadId;
      a.roadDistance = p.roadDistance;
    }
    return a;
  });
  for (const p of pads) {
    areas.push({
      id: areas.length,
      name: p.name,
      kind: 'range',
      x: p.x,
      z: p.z,
      radius: p.radius,
      heading: p.heading,
      elevation: terrain.heightAt(p.x, p.z),
    });
  }
  const first = areas.find((a) => a.kind !== 'range');
  const heading = first ? headingOf(first.x - sx, first.z - sz) : headingOf(Math.cos(upAngle), Math.sin(upAngle));
  return { areas, start: { x: sx, z: sz, heading } };
}
