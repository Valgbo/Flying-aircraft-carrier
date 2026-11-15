/**
 * The hull form and deck planform as pure numbers (no three.js objects, no DOM), derived from
 * src/config/layout.ts. Geometry builders, the deck texture painter, the light layout and the
 * unit tests all read the same functions, so the mesh, the paint and the gameplay coordinates
 * cannot drift apart.
 *
 * Hull cross-section (one side, keel to deck), carrier-local metres:
 *
 *        deck slab ───────────────┐ top    (deck edge − inset, deck underside)
 *                                 │ shelf  (gallery band under the deck edge)
 *                             ╱
 *                         ╱        flare
 *              knuckle ●
 *                 sill ●           (hangar-deck level; the elevator bay floor)
 *               stripe ●           boot stripe
 *            waterline ●           HULL.beam / 2 at WATERLINE_Y
 *              bilge ╱
 *     keel ─────────●
 *
 * Toward the bow and stern the keel rises; levels below it collapse onto the cut, which gives
 * the raked forefoot and the cut-away stern without changing the ring topology.
 */
import {
  DECK,
  ELEVATOR,
  HULL,
  LANDING_STRIP,
  TURBINE,
  TURBINE_MOUNTS,
  WATERLINE_Y,
  type Vec2Tuple,
} from '../../config/layout';
import type { V3 } from './geo';

export type Side = 1 | -1;

export const BOW_Z = -HULL.length / 2;
export const STERN_Z = HULL.length / 2;
/** Underside of the flight-deck slab = top of the hull. */
export const HULL_TOP_Y = DECK.y - DECK.thickness;
export const BOOT_STRIPE_HEIGHT = 0.8;
export const BILGE_Y = HULL.keelY + 3;
export const KNUCKLE_Y = 3;
export const SHELF_Y = 9;
/** Floor of the elevator bay: just under the lowered platform. */
export const BAY_FLOOR_Y = ELEVATOR.bottomY - 1.4;
/** Top of the hangar opening in the inboard wall of the elevator bay. */
export const BAY_LINTEL_Y = 9.4;

/** Ring levels of one side of a hull station, keel upward. */
export const LEVEL = {
  keel: 0,
  bilge: 1,
  waterline: 2,
  stripe: 3,
  sill: 4,
  knuckle: 5,
  shelf: 6,
  top: 7,
} as const;
export const LEVEL_COUNT = 8;

const HALF_BEAM = HULL.beam / 2;
/** The hull top sits this far inboard of the deck edge, so the deck visibly overhangs. */
const DECK_INSET = 1;
/** Extra inset of the short hull lips that project beyond the deck at the bow. */
const BOW_LIP_INSET = 1.5;

const STRIPE_Y = WATERLINE_Y + BOOT_STRIPE_HEIGHT;
/** Half-widths of the levels as fractions of the waterline half-beam. */
const KEEL_F = 0.55;
const BILGE_F = 0.78;
const STRIPE_F = 1.01;
const KNUCKLE_F = 1.09;
/** The sill lies on the straight line stripe → knuckle, so the side stays one flat facet. */
const SILL_F =
  STRIPE_F + ((KNUCKLE_F - STRIPE_F) * (BAY_FLOOR_Y - STRIPE_Y)) / (KNUCKLE_Y - STRIPE_Y);

const LEVEL_Y: readonly number[] = [
  HULL.keelY,
  BILGE_Y,
  WATERLINE_Y,
  STRIPE_Y,
  BAY_FLOOR_Y,
  KNUCKLE_Y,
  SHELF_Y,
  HULL_TOP_Y,
];

type Table = readonly (readonly [z: number, value: number])[];

/** Waterline half-beam along the ship as a fraction of HULL.beam / 2. */
const BEAM_TABLE: Table = [
  [BOW_Z, 0.065],
  [-140, 0.34],
  [-118, 0.66],
  [-70, 1],
  [120, 1],
  [STERN_Z, 0.8],
];

/** Keel line: raked forefoot rising to the knuckle at the stem, cut-away stern. */
const KEEL_TABLE: Table = [
  [BOW_Z, KNUCKLE_Y],
  [-112, HULL.keelY],
  [118, HULL.keelY],
  [STERN_Z, -9.5],
];

function sampleTable(table: Table, z: number): number {
  if (z <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (z <= table[i][0]) {
      const [z0, v0] = table[i - 1];
      const [z1, v1] = table[i];
      return v0 + ((v1 - v0) * (z - z0)) / (z1 - z0);
    }
  }
  return table[table.length - 1][1];
}

export function waterlineHalfBeam(z: number): number {
  return HALF_BEAM * sampleTable(BEAM_TABLE, z);
}

export function keelYAt(z: number): number {
  return sampleTable(KEEL_TABLE, z);
}

export const DECK_MIN_Z = Math.min(...DECK.outline.map((p) => p[1]));
export const DECK_MAX_Z = Math.max(...DECK.outline.map((p) => p[1]));

/** x of the flight-deck edge on one side at station z (z is clamped to the deck's extent). */
export function deckEdgeX(side: Side, z: number): number {
  const zc = Math.min(DECK_MAX_Z, Math.max(DECK_MIN_Z, z));
  const pts = DECK.outline;
  let best = side > 0 ? -Infinity : Infinity;
  const take = (x: number): void => {
    best = side > 0 ? Math.max(best, x) : Math.min(best, x);
  };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (zc < Math.min(a[1], b[1]) || zc > Math.max(a[1], b[1])) continue;
    if (a[1] === b[1]) {
      take(a[0]);
      take(b[0]);
    } else {
      take(a[0] + ((b[0] - a[0]) * (zc - a[1])) / (b[1] - a[1]));
    }
  }
  return best;
}

/** |x| of the hull's top edge (where it meets the underside of the deck) at station z. */
export function hullTopHalfWidth(side: Side, z: number): number {
  const lip = z < DECK_MIN_Z ? BOW_LIP_INSET : 0;
  return Math.abs(deckEdgeX(side, z)) - DECK_INSET - lip;
}

/**
 * The eight ring points of one side of the hull at station z, keel upward, in carrier-local
 * coordinates. `bay` gives the starboard profile inside the elevator bay, where the flare is
 * replaced by the bay floor and the hangar wall at x = ELEVATOR.minX.
 */
export function hullProfile(side: Side, z: number, bay = false): V3[] {
  const w = waterlineHalfBeam(z);
  const keelY = keelYAt(z);
  const knuckleX = w * KNUCKLE_F;
  const topX = Math.max(hullTopHalfWidth(side, z), knuckleX + 0.4);
  const pts: [number, number][] = [
    [w * KEEL_F, LEVEL_Y[LEVEL.keel]],
    [w * BILGE_F, LEVEL_Y[LEVEL.bilge]],
    [w, LEVEL_Y[LEVEL.waterline]],
    [w * STRIPE_F, LEVEL_Y[LEVEL.stripe]],
    [w * SILL_F, LEVEL_Y[LEVEL.sill]],
    [knuckleX, LEVEL_Y[LEVEL.knuckle]],
    [topX, LEVEL_Y[LEVEL.shelf]],
    [topX, LEVEL_Y[LEVEL.top]],
  ];
  if (bay && side > 0) {
    pts[LEVEL.knuckle] = [ELEVATOR.minX, BAY_FLOOR_Y];
    pts[LEVEL.shelf] = [ELEVATOR.minX, BAY_LINTEL_Y];
    pts[LEVEL.top] = [ELEVATOR.minX, HULL_TOP_Y];
  }
  // cut the section off at the (possibly raised) keel: lower levels collapse onto the cut
  let first = 0;
  while (first < pts.length - 1 && pts[first][1] < keelY - 1e-6) first++;
  if (first > 0) {
    const lo = pts[first - 1];
    const hi = pts[first];
    const span = hi[1] - lo[1];
    const t = span > 1e-9 ? (keelY - lo[1]) / span : 1;
    const cut: [number, number] = [lo[0] + (hi[0] - lo[0]) * t, keelY];
    for (let i = 0; i < first; i++) pts[i] = cut;
  }
  return pts.map(([x, y]) => [side * x, y, z] as const);
}

/** Point on the outer hull surface of one side at station z and height y. */
export function hullSidePoint(side: Side, z: number, y: number): V3 {
  const profile = hullProfile(side, z);
  for (let i = 1; i < profile.length; i++) {
    const lo = profile[i - 1];
    const hi = profile[i];
    if (y <= hi[1] || i === profile.length - 1) {
      const span = hi[1] - lo[1];
      const t = span > 1e-9 ? Math.min(1, Math.max(0, (y - lo[1]) / span)) : 0;
      return [lo[0] + (hi[0] - lo[0]) * t, lo[1] + span * t, z];
    }
  }
  return profile[profile.length - 1];
}

/**
 * Stations (z) at which the hull is sampled: every corner of the deck planform, the knots of
 * the form tables, the elevator bay and the places where the rising keel crosses a ring level
 * (so paint boundaries stay exactly horizontal).
 */
export function hullStations(): number[] {
  const zs: number[] = [BOW_Z, STERN_Z, ELEVATOR.minZ, ELEVATOR.maxZ, -150, 140];
  for (const p of DECK.outline) zs.push(p[1]);
  for (const row of BEAM_TABLE) zs.push(row[0]);
  for (const row of KEEL_TABLE) zs.push(row[0]);
  for (let i = 1; i < KEEL_TABLE.length; i++) {
    const [z0, y0] = KEEL_TABLE[i - 1];
    const [z1, y1] = KEEL_TABLE[i];
    if (y0 === y1) continue;
    for (const y of LEVEL_Y) {
      const t = (y - y0) / (y1 - y0);
      if (t > 1e-6 && t < 1 - 1e-6) zs.push(z0 + (z1 - z0) * t);
    }
  }
  zs.sort((a, b) => a - b);
  return zs.filter((z, i) => i === 0 || z - zs[i - 1] > 1e-6);
}

/**
 * Flight-deck outline with the rectangular elevator notch cut into the starboard edge
 * ([x, z] points, clockwise seen from above like DECK.outline).
 */
export function deckOutlineWithNotch(): Vec2Tuple[] {
  const out: Vec2Tuple[] = [];
  const pts = DECK.outline;
  let cut = false;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push(a);
    const onEdge =
      a[0] === ELEVATOR.maxX &&
      b[0] === ELEVATOR.maxX &&
      Math.min(a[1], b[1]) < ELEVATOR.minZ &&
      Math.max(a[1], b[1]) > ELEVATOR.maxZ;
    if (!onEdge) continue;
    const forward = b[1] > a[1];
    const zIn = forward ? ELEVATOR.minZ : ELEVATOR.maxZ;
    const zOut = forward ? ELEVATOR.maxZ : ELEVATOR.minZ;
    out.push(
      [ELEVATOR.maxX, zIn],
      [ELEVATOR.minX, zIn],
      [ELEVATOR.minX, zOut],
      [ELEVATOR.maxX, zOut],
    );
    cut = true;
  }
  if (!cut) throw new Error('ELEVATOR does not lie on a straight starboard deck edge');
  return out;
}

function distanceToSegment(x: number, z: number, a: Vec2Tuple, b: Vec2Tuple): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (z - a[1]) * dz) / len2)) : 0;
  return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
}

/** True when (x, z) lies on the flight deck, at least `margin` metres inside its edge. */
export function pointOnDeck(x: number, z: number, margin = 0): boolean {
  const pts = DECK.outline;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a[1] > z !== b[1] > z && x < a[0] + ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1])) {
      inside = !inside;
    }
  }
  if (!inside) return false;
  if (margin <= 0) return true;
  for (let i = 0; i < pts.length; i++) {
    if (distanceToSegment(x, z, pts[i], pts[(i + 1) % pts.length]) < margin) return false;
  }
  return true;
}

/** True when (x, z) lies on the elevator platform (grown by `pad` metres). */
export function pointOnElevator(x: number, z: number, pad = 0): boolean {
  return (
    x >= ELEVATOR.minX - pad &&
    x <= ELEVATOR.maxX + pad &&
    z >= ELEVATOR.minZ - pad &&
    z <= ELEVATOR.maxZ + pad
  );
}

const stripDx = LANDING_STRIP.end[0] - LANDING_STRIP.threshold[0];
const stripDz = LANDING_STRIP.end[2] - LANDING_STRIP.threshold[2];
const stripLength = Math.hypot(stripDx, stripDz);

/** Landing-strip frame: `dir` runs from the threshold toward the far end, `stbd` across it. */
export const STRIP = {
  length: stripLength,
  halfWidth: LANDING_STRIP.width / 2,
  dirX: stripDx / stripLength,
  dirZ: stripDz / stripLength,
  stbdX: -stripDz / stripLength,
  stbdZ: stripDx / stripLength,
} as const;

/** Deck [x, z] of a point `along` metres past the threshold and `across` metres to starboard of the centreline. */
export function stripPoint(along: number, across: number): Vec2Tuple {
  return [
    LANDING_STRIP.threshold[0] + STRIP.dirX * along + STRIP.stbdX * across,
    LANDING_STRIP.threshold[2] + STRIP.dirZ * along + STRIP.stbdZ * across,
  ];
}

/** |x| of the bearing cap that ends pylon `index`: the inboard edge of the duct ring on its tilt axis. */
export function pylonTipX(index: number): number {
  return Math.abs(TURBINE_MOUNTS[index][0]) - TURBINE.ductOuterRadius;
}

/** Sponsons under the deck edge (galleries that carry the defensive mounts). */
export interface Sponson {
  side: Side;
  z0: number;
  z1: number;
  /** A defensive mount stands on it at this detail level and above (3 = never). */
  mountDetail: 1 | 2 | 3;
}

export const SPONSONS: readonly Sponson[] = [
  { side: -1, z0: -64, z1: -40, mountDetail: 1 },
  { side: -1, z0: -22, z1: 6, mountDetail: 3 },
  { side: -1, z0: 120, z1: 144, mountDetail: 2 },
  { side: 1, z0: -28, z1: -4, mountDetail: 2 },
  { side: 1, z0: 62, z1: 92, mountDetail: 3 },
  { side: 1, z0: 124, z1: 148, mountDetail: 1 },
];
/** How far a sponson platform stands out beyond the deck edge. */
export const SPONSON_OVERHANG = 2.6;
