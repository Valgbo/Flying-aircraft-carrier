/**
 * RailPath — a 2D path made of straight lines joined by circular fillets, parameterised by
 * arc length. Deck taxi routes and the flight pattern are both built from it, so a jet's
 * position, heading and turn curvature are always analytic functions of the distance travelled.
 *
 * Coordinates are [x, z] in a ship-shaped frame: +x starboard, -z toward the bow.
 * Headings are radians in the deck convention: 0 = toward the bow, +π/2 = toward starboard.
 * Curvature is signed: positive = turning to starboard.
 */
import type { Vec2Tuple } from '../config/layout';
import { clamp, wrapAngle } from '../utils/math';

export interface PathSample {
  x: number;
  z: number;
  heading: number;
  curvature: number;
}

export function makePathSample(): PathSample {
  return { x: 0, z: 0, heading: 0, curvature: 0 };
}

export interface PathElement {
  /** Arc length at which the element starts. */
  s0: number;
  length: number;
  /** Start point and heading. */
  x: number;
  z: number;
  heading: number;
  /** 0 for a straight line. */
  radius: number;
  /** +1 = turning to starboard, -1 = to port (arcs only). */
  turn: number;
  /** Arc centre (arcs only). */
  cx: number;
  cz: number;
}

/** Deck heading of the direction (dx, dz). */
export function headingOf(dx: number, dz: number): number {
  return Math.atan2(dx, -dz);
}

export class RailPath {
  readonly length: number;

  constructor(readonly elements: readonly PathElement[]) {
    const last = elements[elements.length - 1];
    this.length = last.s0 + last.length;
  }

  /**
   * Point at arc length `s`. Outside [0, length] the path continues straight along its end
   * tangent, so a follower that overshoots by a step stays well defined.
   */
  sample(s: number, out: PathSample): PathSample {
    const els = this.elements;
    const lastIndex = els.length - 1;
    let i = 0;
    while (i < lastIndex && s >= els[i].s0 + els[i].length) i++;
    const e = els[i];
    const u = s - e.s0;
    const along = clamp(u, 0, e.length);
    let heading = e.heading;
    let x: number;
    let z: number;
    let curvature = 0;
    if (e.radius === 0) {
      x = e.x + Math.sin(heading) * along;
      z = e.z - Math.cos(heading) * along;
    } else {
      heading += (e.turn * along) / e.radius;
      x = e.cx - e.turn * e.radius * Math.cos(heading);
      z = e.cz - e.turn * e.radius * Math.sin(heading);
      curvature = e.turn / e.radius;
    }
    const beyond = u - along;
    if (beyond !== 0) {
      x += Math.sin(heading) * beyond;
      z -= Math.cos(heading) * beyond;
      curvature = 0;
    }
    out.x = x;
    out.z = z;
    out.heading = wrapAngle(heading);
    out.curvature = curvature;
    return out;
  }
}

const EPS = 1e-6;

/**
 * Build a path through `points`, rounding every interior corner with a fillet of the given
 * radius (one number for all corners, or one per interior corner). A radius that does not
 * fit between its neighbours is reduced until it does.
 */
export function buildPath(
  points: readonly Vec2Tuple[],
  radii: number | readonly number[],
): RailPath {
  const elements: PathElement[] = [];
  let s = 0;
  const pushLine = (x: number, z: number, heading: number, length: number): void => {
    if (length <= EPS) return;
    elements.push({ s0: s, length, x, z, heading, radius: 0, turn: 0, cx: 0, cz: 0 });
    s += length;
  };

  const n = points.length;
  let curX = points[0][0];
  let curZ = points[0][1];
  let usedIn = 0;
  for (let i = 1; i < n - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const headingIn = headingOf(b[0] - a[0], b[1] - a[1]);
    const headingOut = headingOf(c[0] - b[0], c[1] - b[1]);
    const lengthIn = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const lengthOut = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const turnAngle = wrapAngle(headingOut - headingIn);
    const half = Math.tan(Math.abs(turnAngle) / 2);
    let radius = typeof radii === 'number' ? radii : radii[i - 1];
    let tangent = radius * half;
    const room = Math.max(0, Math.min(lengthIn - usedIn, i === n - 2 ? lengthOut : lengthOut / 2));
    if (tangent > room) {
      tangent = room;
      radius = half > EPS ? tangent / half : 0;
    }
    const inX = b[0] - Math.sin(headingIn) * tangent;
    const inZ = b[1] + Math.cos(headingIn) * tangent;
    pushLine(curX, curZ, headingIn, Math.hypot(inX - curX, inZ - curZ));
    if (radius > EPS && Math.abs(turnAngle) > EPS) {
      const turn = Math.sign(turnAngle);
      const length = radius * Math.abs(turnAngle);
      elements.push({
        s0: s,
        length,
        x: inX,
        z: inZ,
        heading: headingIn,
        radius,
        turn,
        cx: inX + turn * radius * Math.cos(headingIn),
        cz: inZ + turn * radius * Math.sin(headingIn),
      });
      s += length;
    }
    curX = b[0] + Math.sin(headingOut) * tangent;
    curZ = b[1] - Math.cos(headingOut) * tangent;
    usedIn = tangent;
  }
  const end = points[n - 1];
  const before = points[n - 2];
  const finalHeading = headingOf(end[0] - before[0], end[1] - before[1]);
  const finalLength = Math.hypot(end[0] - curX, end[1] - curZ);
  // the path always ends with a straight element, however short, so its end tangent is defined
  elements.push({
    s0: s,
    length: Math.max(finalLength, EPS),
    x: curX,
    z: curZ,
    heading: finalHeading,
    radius: 0,
    turn: 0,
    cx: 0,
    cz: 0,
  });
  return new RailPath(elements);
}

/**
 * Highest speed a vehicle may have at arc length `s` so that it can still slow down (at
 * `brake` m/s²) to `turnRate × radius` for every fillet ahead and to a stop at the end.
 */
export function pathSpeedLimit(
  path: RailPath,
  s: number,
  cruise: number,
  turnRate: number,
  brake: number,
): number {
  let limit = Math.min(cruise, Math.sqrt(2 * brake * Math.max(0, path.length - s)));
  for (const e of path.elements) {
    if (e.radius === 0 || e.s0 + e.length <= s) continue;
    const arcSpeed = turnRate * e.radius;
    const distance = Math.max(0, e.s0 - s);
    limit = Math.min(limit, Math.sqrt(arcSpeed * arcSpeed + 2 * brake * distance));
  }
  return limit;
}
