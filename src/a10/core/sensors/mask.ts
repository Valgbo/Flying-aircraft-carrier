/**
 * The pod's view blocked by its own aircraft (PLAN §8: "masking by the aircraft's own wing and
 * fuselage"). The aircraft is a set of BODY-frame boxes (fuselage sections, main-gear pods,
 * nacelles, the wing's centre section, tailplane and fins, and an envelope around what hangs on
 * each other station) plus the two outer wing panels as planes with their dihedral; all measured
 * on the converted FlightGear model (data/sensors.ts MASK_*). A line of sight is masked when the
 * ray from the pod's head meets any of them within a few tens of metres.
 *
 * The pod hangs under the outer wing: everything above the wing aft of the leading edge is hidden,
 * and straight up its own pylon stands over the head; the belly side is shadowed by the gear pod,
 * the fuselage and the next station's stores. Because the head reaches ≈0.2 m ahead of the
 * leading edge, the sky up and to the sides just in front of the wing stays visible.
 */
import { MASK_BOXES, MASK_PYLONS, MASK_STORES, MASK_WING } from '../../data/sensors';
import type { Sim } from '../types';
import type { StationState } from '../weapons/types';
import { stationPoint } from './geometry';
import { Vector3 } from 'three';

/** Most boxes the mask holds (airframe + stores). */
export const MASK_CAPACITY = 48;

const _s = new Vector3();

function pushBox(
  boxes: Float64Array,
  n: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): number {
  if (n >= MASK_CAPACITY) return n;
  const o = n * 6;
  boxes[o] = x0;
  boxes[o + 1] = y0;
  boxes[o + 2] = z0;
  boxes[o + 3] = x1;
  boxes[o + 4] = y1;
  boxes[o + 5] = z1;
  return n + 1;
}

/** Height of the wing's lower surface at span |x|, BODY y (centre section flat, then dihedral). */
export function wingLowerY(x: number): number {
  const ax = Math.abs(x);
  const w = MASK_WING;
  return ax <= w.rootX ? w.rootY : w.rootY + w.slope * (ax - w.rootX);
}

/** What hangs on a station as one mask envelope, or null when nothing masks there. */
function stationEnvelope(st: StationState) {
  if (st.rack) return st.stores.length > 0 ? (MASK_STORES[st.rack] ?? null) : null;
  return st.stores.length > 0 ? (MASK_STORES[st.stores[0]] ?? null) : null;
}

/**
 * Rebuild the mask for the loadout: the airframe boxes and one envelope per loaded station other
 * than the pod's own (`podStation`). Called when the stores change.
 */
export function buildMask(sim: Sim, podStation: number): void {
  const internal = sim.sensors.internal;
  const boxes = internal.maskBoxes;
  let n = 0;
  for (const b of MASK_BOXES) {
    n = pushBox(boxes, n, b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2]);
    if (b.mirror) n = pushBox(boxes, n, -b.max[0], b.min[1], b.min[2], -b.min[0], b.max[1], b.max[2]);
  }
  for (let station = 1; station < MASK_PYLONS.length; station++) {
    const py = MASK_PYLONS[station];
    if (!py) continue;
    stationPoint(station, _s);
    // the bottom slopes ≈3° nose-down with the station: 4 cm lower at the front
    n = pushBox(boxes, n, _s.x - py.halfWidth, _s.y - 0.05, py.front, _s.x + py.halfWidth, wingLowerY(_s.x), py.rear);
  }
  for (const st of sim.stores.stations) {
    if (st.station === podStation) continue;
    const env = stationEnvelope(st);
    if (!env) continue;
    stationPoint(st.station, _s);
    n = pushBox(
      boxes,
      n,
      _s.x - env.halfWidth,
      _s.y - env.depth,
      _s.z + env.front,
      _s.x + env.halfWidth,
      _s.y,
      _s.z + env.rear,
    );
  }
  internal.maskCount = n;
  internal.maskStation = podStation;
  internal.maskDirty = false;
}

/** Entry distance of a ray into a box (slab test), or Infinity. Direction need not be unit. */
function rayBox(
  b: Float64Array,
  o: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  tMax: number,
): number {
  let t0 = 1e-6;
  let t1 = tMax;
  for (let a = 0; a < 3; a++) {
    const org = a === 0 ? ox : a === 1 ? oy : oz;
    const dir = a === 0 ? dx : a === 1 ? dy : dz;
    const lo = b[o + a];
    const hi = b[o + 3 + a];
    if (Math.abs(dir) < 1e-12) {
      if (org < lo || org > hi) return Infinity;
      continue;
    }
    let ta = (lo - org) / dir;
    let tb = (hi - org) / dir;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/** Does the ray meet an outer wing panel (side = +1 right, −1 left) within tMax? */
function rayWing(
  side: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  tMax: number,
): boolean {
  const w = MASK_WING;
  // lower surface: y − side·slope·x = rootY − slope·rootX
  const c0 = w.rootY - w.slope * w.rootX;
  const den = dy - side * w.slope * dx;
  if (Math.abs(den) < 1e-12) return false;
  const t = (c0 - oy + side * w.slope * ox) / den;
  if (!(t > 1e-6 && t < tMax)) return false;
  const ax = side * (ox + dx * t);
  if (ax < w.rootX || ax > w.tipX) return false;
  const z = oz + dz * t;
  const u = ax - w.rootX;
  return z >= w.leRoot + w.leSlope * u && z <= w.teRoot + w.teSlope * u;
}

/**
 * Is the ray from BODY point (ox, oy, oz) along BODY direction (dx, dy, dz) (unit) blocked by the
 * aircraft within `maxDist` metres?
 */
export function airframeMasked(
  sim: Sim,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): boolean {
  const internal = sim.sensors.internal;
  const boxes = internal.maskBoxes;
  for (let i = 0; i < internal.maskCount; i++) {
    if (rayBox(boxes, i * 6, ox, oy, oz, dx, dy, dz, maxDist) < Infinity) return true;
  }
  return (
    rayWing(1, ox, oy, oz, dx, dy, dz, maxDist) || rayWing(-1, ox, oy, oz, dx, dy, dz, maxDist)
  );
}
