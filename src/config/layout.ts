/**
 * Carrier geometry layout — the single source of truth for where things are on the ship.
 * Every model, effect, gameplay system and UI hotspot derives its positions from here.
 *
 * CARRIER-LOCAL FRAME (the rigid-body frame; the origin is the centre of mass):
 *   +X = starboard (right)      -X = port (left)
 *   +Y = up
 *   -Z = forward (bow)          +Z = aft (stern)
 * Units: metres. Angles in this file: degrees unless the name ends in `Rad`.
 *
 * The design is original: an angular, faceted hull with an offset command island and four
 * tilting ducted-fan turbines on outrigger pylons (two forward, two aft).
 */

export type Vec3Tuple = readonly [x: number, y: number, z: number];
export type Vec2Tuple = readonly [x: number, z: number];

export const HULL = {
  /** Overall length. Bow at z = -160, stern at z = +160. */
  length: 320,
  /** Hull width at the waterline. */
  beam: 44,
  /** Local y of the keel (lowest point of the hull). */
  keelY: -16,
  /** Local y of the top surface of the flight deck. */
  deckY: 14,
  /** Hull under water when floating at rest → the waterline sits at local y = keelY + designDraft = -6. */
  designDraft: 10,
} as const;

/** Local y of the waterline when the ship floats at rest. */
export const WATERLINE_Y = HULL.keelY + HULL.designDraft;
/** Altitude (world y of the carrier origin) when the ship floats at rest on a flat sea. */
export const FLOATING_ALTITUDE = -WATERLINE_Y;

export const DECK = {
  /** Local y of the flight-deck surface. */
  y: HULL.deckY,
  thickness: 2.5,
  /** Half-width at the widest point (deck overhangs the hull). */
  halfWidth: 36,
  /**
   * Flight-deck outline as [x, z] points, clockwise seen from above starting at the port bow.
   * Angular planform: tapered bow, port bulge for the angled landing strip.
   */
  outline: [
    [-14, -158],
    [14, -158],
    [30, -118],
    [36, -70],
    [36, 120],
    [30, 158],
    [-22, 158],
    [-36, 110],
    [-36, -30],
    [-30, -70],
    [-22, -118],
  ] as readonly Vec2Tuple[],
} as const;

/** Command island (superstructure), offset to starboard. */
export const ISLAND = {
  /** Centre of the footprint on the deck. */
  centerX: 27,
  centerZ: 25,
  /** Footprint size. */
  width: 13,
  length: 52,
  /** Height of the main block above the deck. */
  height: 30,
  /** Top of the sensor mast above the deck. */
  mastHeight: 48,
  /** Navigation-bridge eye point (carrier-local) — used by the bridge camera. */
  bridgeEye: [22, 14 + 22, 4] as Vec3Tuple,
} as const;

/** Four ducted-fan turbines. Index order is fixed everywhere in the code base. */
export const TURBINE_COUNT = 4;
export const TURBINE_NAMES = ['FL', 'FR', 'RL', 'RR'] as const;
export const TURBINE_LABELS = [
  'Forward port',
  'Forward starboard',
  'Aft port',
  'Aft starboard',
] as const;

export const TURBINE = {
  /** Outer radius of the duct (nacelle ring). */
  ductOuterRadius: 22,
  /** Radius of the fan disc. */
  fanRadius: 19,
  /** Axial length of the duct (along the thrust axis). */
  ductHeight: 13,
  hubRadius: 4.5,
  /** Tilt limits. 0° = thrust straight up (hover). Positive = thrust vector tilts toward the bow. */
  tiltMinDeg: -20,
  tiltMaxDeg: 60,
  bladeCount: 11,
} as const;

/**
 * Tilt-pivot centre of each turbine (carrier-local). The duct rotates about the local X axis
 * through this point. Pylons run along X from the hull side to the inboard edge of the duct.
 */
export const TURBINE_MOUNTS: readonly Vec3Tuple[] = [
  [-66, 4, -95], // 0 FL — forward port
  [66, 4, -95], // 1 FR — forward starboard
  [-66, 4, 95], // 2 RL — aft port
  [66, 4, 95], // 3 RR — aft starboard
];

/** Aircraft elevator on the starboard deck edge, forward of the island. */
export const ELEVATOR = {
  minX: 19,
  maxX: 36,
  minZ: -62,
  maxZ: -34,
  /** Local y of the platform surface when raised (flush with the deck) and lowered (hangar deck). */
  topY: DECK.y,
  bottomY: 3,
} as const;

/** Two bow catapults. Aircraft accelerate from `start` to `end` (toward the bow, -Z). */
export const CATAPULTS = [
  { id: 1, start: [-9, DECK.y, -48] as Vec3Tuple, end: [-9, DECK.y, -150] as Vec3Tuple },
  { id: 2, start: [9, DECK.y, -48] as Vec3Tuple, end: [9, DECK.y, -150] as Vec3Tuple },
] as const;

/**
 * Angled landing strip. Aircraft touch down near `threshold` heading toward `end`
 * (≈ 8.8° to port of the ship's centreline). Arrestor wires cross the strip at the given
 * distances (metres) from the threshold; aircraft aim for wire 3.
 */
export const LANDING_STRIP = {
  threshold: [6, DECK.y, 152] as Vec3Tuple,
  end: [-25, DECK.y, -48] as Vec3Tuple,
  width: 26,
  wireDistances: [30, 42, 54, 66] as readonly number[],
  targetWire: 2,
} as const;

/** Deck parking spots (carrier-local position + heading in degrees; 0° = facing the bow, +90° = facing starboard). */
export const PARKING_SPOTS = [
  { position: [27, DECK.y, 68] as Vec3Tuple, headingDeg: -70 },
  { position: [27, DECK.y, 88] as Vec3Tuple, headingDeg: -70 },
  { position: [27, DECK.y, 108] as Vec3Tuple, headingDeg: -70 },
  { position: [27, DECK.y, 128] as Vec3Tuple, headingDeg: -70 },
] as const;

/** Nominal aircraft dimensions (for spacing, cameras and the jet model). */
export const JET = {
  length: 17,
  wingspan: 11,
  height: 4.6,
} as const;

/** Points of interest for the hangar / inspect mode (carrier-local anchor positions). */
export type HotspotId =
  | 'turbine-0'
  | 'turbine-1'
  | 'turbine-2'
  | 'turbine-3'
  | 'island'
  | 'catapults'
  | 'arrestor'
  | 'elevator';

export const HOTSPOTS: readonly { id: HotspotId; anchor: Vec3Tuple }[] = [
  {
    id: 'turbine-0',
    anchor: [TURBINE_MOUNTS[0][0], TURBINE_MOUNTS[0][1] + 10, TURBINE_MOUNTS[0][2]],
  },
  {
    id: 'turbine-1',
    anchor: [TURBINE_MOUNTS[1][0], TURBINE_MOUNTS[1][1] + 10, TURBINE_MOUNTS[1][2]],
  },
  {
    id: 'turbine-2',
    anchor: [TURBINE_MOUNTS[2][0], TURBINE_MOUNTS[2][1] + 10, TURBINE_MOUNTS[2][2]],
  },
  {
    id: 'turbine-3',
    anchor: [TURBINE_MOUNTS[3][0], TURBINE_MOUNTS[3][1] + 10, TURBINE_MOUNTS[3][2]],
  },
  { id: 'island', anchor: [ISLAND.centerX, DECK.y + ISLAND.height + 4, ISLAND.centerZ] },
  { id: 'catapults', anchor: [0, DECK.y + 4, -100] },
  { id: 'arrestor', anchor: [-2, DECK.y + 4, 100] },
  {
    id: 'elevator',
    anchor: [(ELEVATOR.minX + ELEVATOR.maxX) / 2, DECK.y + 4, (ELEVATOR.minZ + ELEVATOR.maxZ) / 2],
  },
];

/** Radius of a sphere that comfortably contains the whole ship (for camera framing / shadow frusta). */
export const CARRIER_BOUNDING_RADIUS = 185;
