/**
 * Keep-out volumes of the ship in the CARRIER-LOCAL frame, derived from the layout, and the
 * two queries the camera rig needs to stay outside them. The ship is approximated by a few
 * axis-aligned boxes (hull + deck, island, pylons, the swept volume of each tilting duct).
 * Pure functions on plain numbers — no `sim` — so they are unit-testable.
 */
import type { Vector3 } from 'three';
import { DECK, HULL, ISLAND, TURBINE, TURBINE_MOUNTS } from '../../config/layout';

export interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Clearance the camera keeps from every box, m (comfortably more than the near plane). */
export const SHIP_CLEARANCE = 6;

const PYLON_HALF_THICKNESS = 6;

function buildShipBoxes(): Box[] {
  const boxes: Box[] = [
    {
      minX: -DECK.halfWidth,
      maxX: DECK.halfWidth,
      minY: HULL.keelY,
      maxY: DECK.y,
      minZ: -HULL.length / 2,
      maxZ: HULL.length / 2,
    },
    {
      minX: ISLAND.centerX - ISLAND.width / 2,
      maxX: ISLAND.centerX + ISLAND.width / 2,
      minY: DECK.y,
      maxY: DECK.y + ISLAND.mastHeight,
      minZ: ISLAND.centerZ - ISLAND.length / 2,
      maxZ: ISLAND.centerZ + ISLAND.length / 2,
    },
  ];
  const r = TURBINE.ductOuterRadius;
  for (const m of TURBINE_MOUNTS) {
    // the duct tilts about its X axis, so its ring sweeps a cube of half-size r
    boxes.push({
      minX: m[0] - r,
      maxX: m[0] + r,
      minY: m[1] - r,
      maxY: m[1] + r,
      minZ: m[2] - r,
      maxZ: m[2] + r,
    });
    // outrigger pylon from the centreline to the duct
    boxes.push({
      minX: Math.min(0, m[0]),
      maxX: Math.max(0, m[0]),
      minY: m[1] - PYLON_HALF_THICKNESS,
      maxY: m[1] + PYLON_HALF_THICKNESS,
      minZ: m[2] - PYLON_HALF_THICKNESS,
      maxZ: m[2] + PYLON_HALF_THICKNESS,
    });
  }
  return boxes;
}

export const SHIP_BOXES: readonly Box[] = buildShipBoxes();

/**
 * Parameter interval [t0, t1] in which the ray `origin + dir * t` is inside `box` grown by
 * `margin`; returns false when the ray misses it. Results are written to `interval`.
 */
function rayBoxInterval(
  box: Box,
  margin: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  interval: { t0: number; t1: number },
): boolean {
  let t0 = -Infinity;
  let t1 = Infinity;
  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (ox <= box.minX - margin || ox >= box.maxX + margin) return false;
  } else {
    const a = (box.minX - margin - ox) / dx;
    const b = (box.maxX + margin - ox) / dx;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  // Y slab
  if (Math.abs(dy) < 1e-9) {
    if (oy <= box.minY - margin || oy >= box.maxY + margin) return false;
  } else {
    const a = (box.minY - margin - oy) / dy;
    const b = (box.maxY + margin - oy) / dy;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  // Z slab
  if (Math.abs(dz) < 1e-9) {
    if (oz <= box.minZ - margin || oz >= box.maxZ + margin) return false;
  } else {
    const a = (box.minZ - margin - oz) / dz;
    const b = (box.maxZ + margin - oz) / dz;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  if (t0 >= t1) return false;
  interval.t0 = t0;
  interval.t1 = t1;
  return true;
}

const _interval = { t0: 0, t1: 0 };

/**
 * Smallest distance ≥ `distance` at which a camera on the ray from `origin` along the unit
 * direction `dir` (both carrier-local) is outside every ship box (grown by `margin`).
 * Used by orbiting cameras: zooming or swinging into the ship pushes the camera outward
 * along its own line of sight instead of letting it clip inside.
 */
export function clearOrbitDistance(
  origin: Vector3,
  dir: Vector3,
  distance: number,
  margin = SHIP_CLEARANCE,
  boxes: readonly Box[] = SHIP_BOXES,
): number {
  let d = distance;
  // leaving one box can land inside the next one further out, so sweep until stable
  for (let pass = 0; pass < boxes.length; pass++) {
    let moved = false;
    for (const box of boxes) {
      if (
        rayBoxInterval(box, margin, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, _interval) &&
        d > _interval.t0 &&
        d < _interval.t1
      ) {
        d = _interval.t1;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return d;
}

/**
 * Move a carrier-local point that lies inside a ship box (grown by `margin`) to the nearest
 * face of that box. Used on blended poses so a transition slides around the ship rather
 * than through it. Returns true when the point was moved.
 */
export function pushOutOfShip(
  point: Vector3,
  margin = SHIP_CLEARANCE,
  boxes: readonly Box[] = SHIP_BOXES,
): boolean {
  let moved = false;
  for (let pass = 0; pass < 3; pass++) {
    let movedThisPass = false;
    for (const box of boxes) {
      const toMinX = point.x - (box.minX - margin);
      const toMaxX = box.maxX + margin - point.x;
      const toMinY = point.y - (box.minY - margin);
      const toMaxY = box.maxY + margin - point.y;
      const toMinZ = point.z - (box.minZ - margin);
      const toMaxZ = box.maxZ + margin - point.z;
      if (toMinX <= 0 || toMaxX <= 0 || toMinY <= 0 || toMaxY <= 0 || toMinZ <= 0 || toMaxZ <= 0) {
        continue;
      }
      const nearest = Math.min(toMinX, toMaxX, toMinY, toMaxY, toMinZ, toMaxZ);
      if (nearest === toMaxY) point.y = box.maxY + margin;
      else if (nearest === toMinX) point.x = box.minX - margin;
      else if (nearest === toMaxX) point.x = box.maxX + margin;
      else if (nearest === toMinZ) point.z = box.minZ - margin;
      else if (nearest === toMaxZ) point.z = box.maxZ + margin;
      else point.y = box.minY - margin;
      movedThisPass = true;
      moved = true;
    }
    if (!movedThisPass) break;
  }
  return moved;
}
