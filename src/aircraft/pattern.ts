/**
 * Geometry of the landing area and of the flight pattern, in the SHIP FRAME: [x, z] with
 * +x starboard and -z toward the bow, origin at the carrier origin (the same axes as the
 * carrier-local frame, seen from above). Everything is derived from src/config/layout.ts.
 *
 * The pattern is a left-hand racetrack:
 *
 *   crosswind turn  ┌──────────────┐   upwind (straight ahead off the bow)
 *                   │              │
 *     downwind leg  │            [ship]
 *     (abeam, port) │              │
 *                   ◆ decision     │   final: along the angled strip, extended astern
 *                   └──────────────┘
 *        base turn (wider when the downwind leg is extended to open the landing interval)
 */
import { DECK, LANDING_STRIP, type Vec2Tuple } from '../config/layout';
import { wrapAngle } from '../utils/math';
import { JET_DIMS, OPS } from './opsConfig';
import { buildPath, headingOf, type RailPath } from './railPath';

const stripDx = LANDING_STRIP.end[0] - LANDING_STRIP.threshold[0];
const stripDz = LANDING_STRIP.end[2] - LANDING_STRIP.threshold[2];
const stripLength = Math.hypot(stripDx, stripDz);
const dirX = stripDx / stripLength;
const dirZ = stripDz / stripLength;
const wireDistance = LANDING_STRIP.wireDistances[LANDING_STRIP.targetWire];
const touchdownX = LANDING_STRIP.threshold[0] + dirX * wireDistance;
const touchdownZ = LANDING_STRIP.threshold[2] + dirZ * wireDistance;
const sternZ = DECK.outline.reduce((max, p) => Math.max(max, p[1]), -Infinity);

/** The angled landing strip. */
export const STRIP = {
  /** Unit direction of travel along the strip (from the threshold toward the end). */
  dirX,
  dirZ,
  length: stripLength,
  /** Deck heading of the strip, rad (negative: it points to port of the bow). */
  heading: headingOf(dirX, dirZ),
  /** Distance of the target wire from the threshold. */
  wireDistance,
  /** Touchdown point: where the target wire crosses the strip centreline. */
  touchdownX,
  touchdownZ,
  /** Distance before touchdown at which an approaching jet crosses the stern (the ramp). */
  rampDistance: (sternZ - touchdownZ) / -dirZ,
} as const;

/** Point on the strip centreline `distance` metres from the threshold. */
export function stripPoint(distance: number): Vec2Tuple {
  return [
    LANDING_STRIP.threshold[0] + dirX * distance,
    LANDING_STRIP.threshold[2] + dirZ * distance,
  ];
}

/** Point on the extended approach line `distance` metres short of the touchdown point. */
export function approachLinePoint(distance: number): Vec2Tuple {
  return [touchdownX - dirX * distance, touchdownZ - dirZ * distance];
}

/**
 * True when a deck vehicle centred on (x, z) fouls the landing area: closer to the strip
 * centreline than half the strip width plus a wing, anywhere a landing jet can roll.
 */
export function inLandingArea(x: number, z: number): boolean {
  const rx = x - LANDING_STRIP.threshold[0];
  const rz = z - LANDING_STRIP.threshold[2];
  const along = rx * dirX + rz * dirZ;
  const lateral = Math.abs(rx * dirZ - rz * dirX);
  return (
    along > -10 &&
    along < wireDistance + OPS.arrestDistance + 20 &&
    lateral < LANDING_STRIP.width / 2 + JET_DIMS.halfSpan + 1
  );
}

const TAN_GLIDE = Math.tan(OPS.glideSlope);

/** Height of the pattern in the ship frame (carrier-local y). */
export const PATTERN_Y = DECK.y + OPS.patternHeight;

/** Carrier-local y of the glide path `distance` metres (along the ground) before touchdown. */
export function glidePathY(distance: number): number {
  return DECK.y + Math.max(0, distance) * TAN_GLIDE;
}

/** Target height of a jet on the approach path: level at pattern height, then down the glide path. */
export function approachTargetY(distanceToTouchdown: number): number {
  return Math.min(PATTERN_Y, glidePathY(distanceToTouchdown));
}

const ABEAM_X = -OPS.abeamDistance;
/** z of the crosswind leg (the corner line of the turn from upwind to downwind). */
const CROSSWIND_Z = -(OPS.upwindDistance + OPS.abeamDistance / 2);

// Base turn: from the downwind leg (heading aft) through a base leg heading to starboard
// onto the approach line. Both fillets share one radius so the two arcs meet without a
// straight between them. `finalCornerDistance` is where the base leg meets the approach
// line, chosen so that the straight final has the configured length.
const HALF_PI = Math.PI / 2;
const finalTurnTan = Math.tan((HALF_PI + Math.abs(STRIP.heading)) / 2);
const backX = -dirX;
const backZ = -dirZ;
const finalCornerDistance =
  (OPS.finalLength + (finalTurnTan * (OPS.abeamDistance + touchdownX)) / (1 + finalTurnTan)) /
  (1 - (finalTurnTan * backX) / (1 + finalTurnTan));

function baseTurnRadius(cornerDistance: number): number {
  return (OPS.abeamDistance + touchdownX + backX * cornerDistance) / (1 + finalTurnTan);
}

/**
 * Decision point at the end of the downwind leg: here a jet either turns base (possibly
 * after extending downwind) or goes round the pattern again.
 */
export const DECISION_POINT: Vec2Tuple = [
  ABEAM_X,
  touchdownZ + backZ * finalCornerDistance - baseTurnRadius(finalCornerDistance),
];

/**
 * Path from a point where the jet flies `heading` (roughly toward the bow) onto the downwind
 * leg, ending at the decision point. Used after a catapult launch and after a wave-off.
 */
export function joinPatternPath(x: number, z: number, heading: number): RailPath {
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  // run straight ahead to the crosswind line, but at least a little way
  const run = Math.max(200, (z - CROSSWIND_Z) / Math.max(cos, 0.2));
  const cornerX = x + sin * run;
  const cornerZ = z - cos * run;
  const firstTurn = Math.abs(wrapAngle(-HALF_PI - heading));
  const radius = (cornerX - ABEAM_X) / (Math.tan(firstTurn / 2) + 1);
  return buildPath(
    [[x, z], [cornerX, cornerZ], [ABEAM_X, cornerZ], DECISION_POINT],
    [radius, radius],
  );
}

/** One full circuit of the racetrack from the decision point back to it (overhead the ship). */
export function holdPatternPath(): RailPath {
  const radius = OPS.abeamDistance / 2;
  const aftZ = DECISION_POINT[1] + radius;
  return buildPath(
    [
      DECISION_POINT,
      [ABEAM_X, aftZ],
      [0, aftZ],
      [0, CROSSWIND_Z],
      [ABEAM_X, CROSSWIND_Z],
      DECISION_POINT,
    ],
    radius,
  );
}

/**
 * Approach path from the decision point to the touchdown point: `extension` metres further
 * downwind, the base turn, then the straight final along the extended strip centreline.
 */
export function approachPath(extension = 0): RailPath {
  const cornerDistance = finalCornerDistance + extension / backZ;
  const corner = approachLinePoint(cornerDistance);
  const radius = baseTurnRadius(cornerDistance);
  return buildPath(
    [DECISION_POINT, [ABEAM_X, corner[1]], corner, [touchdownX, touchdownZ]],
    [radius, radius],
  );
}

/** Time a jet needs from the decision point to touchdown along an approach path of this length. */
export function approachDuration(pathLength: number): number {
  const decelTime = (OPS.patternSpeed - OPS.approachSpeed) / OPS.decel;
  const decelDistance = ((OPS.patternSpeed + OPS.approachSpeed) / 2) * decelTime;
  return decelTime + Math.max(0, pathLength - decelDistance) / OPS.approachSpeed;
}
