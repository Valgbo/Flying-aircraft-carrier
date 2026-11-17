/**
 * Column routes: a list of legs, each a road (or a range-lane loop) driven one way. Vehicles keep a
 * route distance `s`; the lead vehicle extends the route at junctions (onto the joining road, the
 * way with more road ahead) or turns back at a dead end. Pure geometry plus the targets RNG.
 */
import { headingOf } from '../frames';
import type { Sim } from '../types';
import {
  createRoadPoint,
  nearestRoadPoint,
  pointAlongRoad,
  roadLength,
  type RoadPoint,
} from '../world/roads';
import type { RoadPolyline } from '../world/types';
import type { RouteLeg, VehicleGroup } from './types';

/** Legs kept at most (a column that has driven this many legs halts). */
const MAX_LEGS = 64;
/** A junction leg shorter than this is not taken (turn back instead), m. */
const MIN_LEG = 40;

export function legLength(leg: RouteLeg): number {
  return leg.loop ? Infinity : Math.abs(leg.to - leg.from);
}

/** Route distance where the last leg ends (Infinity for a loop). */
export function routeEnd(g: VehicleGroup): number {
  const n = g.route.length;
  if (n === 0) return 0;
  const last = g.route[n - 1];
  return last.start + legLength(last);
}

/** Index of the leg that holds route distance s (the last leg beyond the end). */
export function legAt(g: VehicleGroup, s: number): number {
  const r = g.route;
  for (let i = r.length - 1; i > 0; i--) if (s >= r[i].start) return i;
  return 0;
}

/**
 * The point at route distance `s`, moved `offset` m to the right of the direction of travel;
 * `out.heading` is the direction of travel and `out.distance` the road distance.
 */
export function routePoint(g: VehicleGroup, s: number, offset: number, out: RoadPoint): RoadPoint {
  const leg = g.route[legAt(g, s)];
  let d = leg.from + leg.dir * (s - leg.start);
  if (leg.loop) {
    const L = roadLength(leg.road);
    d = ((d % L) + L) % L;
  } else {
    const lo = Math.min(leg.from, leg.to);
    const hi = Math.max(leg.from, leg.to);
    d = d < lo ? lo : d > hi ? hi : d;
  }
  pointAlongRoad(leg.road, d, out);
  if (leg.dir < 0) {
    out.heading += Math.PI;
    if (out.heading >= Math.PI * 2) out.heading -= Math.PI * 2;
  }
  if (offset !== 0) {
    // right of the direction of travel: (cos h, sin h) in world x/z
    out.x += Math.cos(out.heading) * offset;
    out.z += Math.sin(out.heading) * offset;
  }
  return out;
}

const _rp = createRoadPoint();
const _one: RoadPolyline[] = [];

/**
 * Append the next leg to a route whose end is near: onto the road joining at the end (the way
 * with more road ahead; a coin decides near-ties), or back along the same road at a dead end.
 */
export function extendRoute(sim: Sim, g: VehicleGroup): boolean {
  const n = g.route.length;
  if (n === 0 || n >= MAX_LEGS) return false;
  const last = g.route[n - 1];
  if (last.loop) return false;
  const roads = sim.world.terrain.roads;
  const road = last.road;
  const L = roadLength(road);
  const start = last.start + legLength(last);
  const j = last.dir > 0 ? road.joinsEnd : road.joinsStart;
  if (j !== undefined && j >= 0 && j < roads.length && roads[j] !== road) {
    const other = roads[j];
    pointAlongRoad(road, last.to, _rp);
    _one.length = 0;
    _one.push(other);
    if (nearestRoadPoint(_one, _rp.x, _rp.z, _rp)) {
      const d = _rp.distance;
      const Lo = roadLength(other);
      const ahead = Lo - d;
      const back = d;
      const r = sim.rng.targets;
      let dir: 1 | -1 = ahead >= back ? 1 : -1;
      if (Math.abs(ahead - back) < 0.25 * Lo && r.chance(0.5)) dir = dir > 0 ? -1 : 1;
      const to = dir > 0 ? Lo : 0;
      if (Math.abs(to - d) >= MIN_LEG) {
        g.route.push({ road: other, dir, loop: false, roadIndex: j, from: d, to, start });
        return true;
      }
    }
  }
  // dead end: turn back along the same road
  const dir: 1 | -1 = last.dir > 0 ? -1 : 1;
  g.route.push({
    road,
    dir,
    loop: false,
    roadIndex: last.roadIndex,
    from: last.to,
    to: dir > 0 ? L : 0,
    start,
  });
  return true;
}

/**
 * A closed loop path (an ellipse) for the range lane's column: semi-axes `across` (perpendicular
 * to `heading`) and `along`, centred on (cx, cz).
 */
export function loopPath(
  id: number,
  cx: number,
  cz: number,
  across: number,
  along: number,
  heading: number,
  segments = 36,
): RoadPolyline {
  const pts = new Float64Array((segments + 1) * 2);
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  const rx = Math.cos(heading);
  const rz = Math.sin(heading);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const u = Math.cos(a) * across;
    const w = Math.sin(a) * along;
    pts[2 * i] = cx + rx * u + fx * w;
    pts[2 * i + 1] = cz + rz * u + fz * w;
  }
  return { id, kind: 'track', points: pts, width: 4 };
}

/** Compass heading of travel along a road at distance d in direction dir. */
export function roadHeading(road: RoadPolyline, d: number, dir: 1 | -1): number {
  pointAlongRoad(road, d, _rp);
  return dir > 0 ? _rp.heading : headingOf(-Math.sin(_rp.heading), Math.cos(_rp.heading));
}
