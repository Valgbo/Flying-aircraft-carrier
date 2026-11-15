/**
 * Taxi routes on the flight deck, in carrier-local [x, z]. All of them use one taxi lane
 * (x = OPS.laneX) that runs parallel to the centreline inboard of the island:
 *
 *   taxi out : parking spot → lane → forward → onto the catapult centreline → shuttle
 *   taxi in  : where the arrestment ended → on along the strip → turn off to starboard →
 *              aft along the lane → stop just past the own parking spot
 *   park     : back into the spot (driven in reverse, tail first)
 */
import { CATAPULTS, PARKING_SPOTS, type Vec2Tuple } from '../config/layout';
import { DEG2RAD } from '../utils/math';
import { OPS } from './opsConfig';
import { STRIP, stripPoint } from './pattern';
import { buildPath, type RailPath } from './railPath';

export interface DeckPose {
  x: number;
  z: number;
  /** Deck heading, rad (0 = facing the bow, +π/2 = facing starboard). */
  heading: number;
}

/** Pose of a jet standing on parking spot `spot`. */
export function parkingPose(spot: number): DeckPose {
  const p = PARKING_SPOTS[spot];
  return { x: p.position[0], z: p.position[2], heading: p.headingDeg * DEG2RAD };
}

/** Where the nose-to-tail line of a parked jet crosses the taxi lane. */
export function laneMergePoint(spot: number): Vec2Tuple {
  const pose = parkingPose(spot);
  const sin = Math.sin(pose.heading);
  const cos = Math.cos(pose.heading);
  const run = (OPS.laneX - pose.x) / sin;
  return [OPS.laneX, pose.z - cos * run];
}

/** Distance from the touchdown wire's threshold distance to where an arrested jet stops. */
export const ARREST_STOP_DISTANCE = STRIP.wireDistance + OPS.arrestDistance;

export function taxiOutPath(spot: number, catapult: number): RailPath {
  const pose = parkingPose(spot);
  const cat = CATAPULTS[catapult];
  const startX = cat.start[0];
  const startZ = cat.start[2];
  const alignZ = startZ + OPS.catapultAlignRun;
  // leave the lane early enough for a shallow diagonal onto the catapult centreline
  const leaveZ = alignZ + Math.abs(OPS.laneX - startX) * 1.2 + 8;
  return buildPath(
    [
      [pose.x, pose.z],
      laneMergePoint(spot),
      [OPS.laneX, leaveZ],
      [startX, alignZ],
      [startX, startZ],
    ],
    [OPS.pullOutRadius, OPS.catapultJoinRadius, OPS.catapultJoinRadius],
  );
}

/** Lane point from which a jet backs into spot `spot` (it stands there facing aft). */
export function parkEntryPoint(spot: number): Vec2Tuple {
  const pose = parkingPose(spot);
  const merge = laneMergePoint(spot);
  // the reverse path turns from "toward the bow" to the tail direction of the parked jet
  const turn = Math.PI - Math.abs(pose.heading);
  return [OPS.laneX, merge[1] + OPS.parkRadius * Math.tan(turn / 2) + 2];
}

export function taxiInPath(spot: number): RailPath {
  const turnTan = Math.tan((Math.PI / 2 + Math.abs(STRIP.heading)) / 2);
  const corner = stripPoint(ARREST_STOP_DISTANCE + OPS.exitRun + OPS.exitRadius * turnTan);
  return buildPath(
    [stripPoint(ARREST_STOP_DISTANCE), corner, [OPS.laneX, corner[1]], parkEntryPoint(spot)],
    OPS.exitRadius,
  );
}

/** Reverse path into the spot: travel direction is tail first, so heading = tangent + π. */
export function parkPath(spot: number): RailPath {
  const pose = parkingPose(spot);
  return buildPath([parkEntryPoint(spot), laneMergePoint(spot), [pose.x, pose.z]], OPS.parkRadius);
}
