/**
 * GAU-8/A Avenger reference data (PLAN_A10.md §6.2, §6.3 and §19). SI units.
 * Owned by the WEAPONS module. Every number has a *_NOTES entry (source id + confidence).
 */
import { DEG, LBF } from '../core/units';
import type { SourceNote } from './sources';

export const GAU8 = {
  /** Rounds per second at full rate (3,900 per minute; fixed rate in the A-10). */
  rate: 3900 / 60,
  /**
   * Seconds from trigger to full rate. The barrels speed up linearly (hydraulic drive at full
   * torque), so the rounds in the first second are rate × (1 − spinUpTime / 2) = 50.
   */
  spinUpTime: 2 * (1 - 50 / 65),
  /** Seconds for the barrels to stop after release (no firing during spin-down). */
  spinDownTime: 0.6,
  drumCapacity: 1174,
  typicalLoad: 1150,
  /** Combat mix: API rounds per HEI round. */
  combatMixApiPerHei: 5,
  /** Muzzle velocity of the PGU-14/B API (and the ballistically matched PGU-15/B TP), m/s. */
  muzzleVelocity: 1013,
  /** Muzzle velocity of the lighter PGU-13/B HEI, m/s. */
  muzzleVelocityHei: 1036,
  /** Projectile masses, kg. */
  massApi: 0.395,
  massHei: 0.378,
  /** The PGU-15/B target-practice projectile matches the API's mass and shape. */
  massTp: 0.395,
  calibre: 0.03,
  /**
   * Drag of each projectile as a multiple of the G7 standard projectile's (GUN_DRAG_G7): the
   * boat-tailed API flies like the G7 shape, so a round from a static gun at sea level reaches
   * 1,220 m (4,000 ft) in 1.44 s; the HEI's blunter fuze nose drags 10 % more.
   */
  formFactorApi: 1.0,
  formFactorHei: 1.1,
  formFactorTp: 1.0,
  /** Dispersion: diameter of the circle holding 80 % of rounds, rad (5 mil). */
  dispersion80Diameter: 0.005,
  /** Average recoil force at full rate, N (10,000 lbf). */
  recoilForce: 10000 * LBF,
  /** Gun line below the fuselage reference line, rad (≈2°). */
  gunLineDepression: 2 * DEG,
  /** API penetration of steel armour at two published ranges, mm (see penetration fit note). */
  penetration500m: 69,
  penetration1000m: 38,
  /**
   * Steel the inert TP and the HEI (before its fuze functions) defeat at the API's reference
   * impact speed, mm: thin skin only (truck bodies, sheet metal), not armour.
   */
  penetrationTp: 10,
  penetrationHei: 6,
  barrels: 7,
  /** PGU-13/B high-explosive fill, TNT equivalent, kg. */
  heiCharge: 0.055,
  /** PGU-13/B steel body that breaks into fragments, kg. */
  heiFragmentMass: 0.28,
} as const;

export const GAU8_NOTES: Record<keyof typeof GAU8, SourceNote> = {
  rate: { source: 'wikiGau8', confidence: 'confirmed' },
  spinUpTime: {
    source: 'plan',
    confidence: 'approximate',
    note: '≈0.5 s to full rate and ≈50 rounds in the first second (PLAN §6.2); linear ramp',
  },
  spinDownTime: { source: 'plan', confidence: 'estimate' },
  drumCapacity: { source: 'wikiGau8', confidence: 'confirmed' },
  typicalLoad: { source: 'wikiGau8', confidence: 'confirmed' },
  combatMixApiPerHei: { source: 'wikiGau8', confidence: 'confirmed' },
  muzzleVelocity: {
    source: 'wikiGau8',
    confidence: 'approximate',
    note: '3,324 ft/s; sources give 990–1,067 m/s for the API (General Dynamics, NDIA 2008: 990)',
  },
  muzzleVelocityHei: {
    source: 'wikiGau8',
    confidence: 'approximate',
    note: '3,400 ft/s; sources give 1,021 (General Dynamics, NDIA 2008) to 1,052 m/s',
  },
  massApi: {
    source: 'wikiGau8',
    confidence: 'approximate',
    note: 'sources differ: 378–426 g (General Dynamics, NDIA 2008: 426 g; FlightGear 0.937 lb)',
  },
  massHei: {
    source: 'wikiGau8',
    confidence: 'approximate',
    note: 'General Dynamics, NDIA 2008: 367 g',
  },
  massTp: {
    source: 'plan',
    confidence: 'estimate',
    note: 'practice rounds are ballistically matched to the service round',
  },
  calibre: { source: 'wikiGau8', confidence: 'confirmed' },
  formFactorApi: {
    source: 'plan',
    confidence: 'estimate',
    note:
      'boat-tailed projectile ≈ the G7 shape; gives 1.44 s to 1,220 m from a static gun (plan: ' +
      '1.3–1.5 s; AFTC history: 30 % less than an M61 round to 4,000 ft)',
  },
  formFactorHei: {
    source: 'plan',
    confidence: 'estimate',
    note: 'M505 point-detonating fuze nose: 10 % more drag than the API',
  },
  formFactorTp: { source: 'plan', confidence: 'estimate', note: 'matched to the API' },
  dispersion80Diameter: {
    source: 'gdotsGau8',
    confidence: 'approximate',
    note: 'maker states 5 mil diameter, 80 % circle',
  },
  recoilForce: { source: 'gdotsGau8', confidence: 'confirmed' },
  gunLineDepression: { source: 'dcsForumGunLine', confidence: 'approximate' },
  penetration500m: {
    source: 'fasGau8',
    confidence: 'approximate',
    note: 'fitted as P(impact speed) for a round fired from an aircraft at 300 kn (docs/a10/ARCHITECTURE.md §5)',
  },
  penetration1000m: { source: 'fasGau8', confidence: 'approximate' },
  penetrationTp: {
    source: 'plan',
    confidence: 'estimate',
    note: 'aluminium-bodied inert projectile: about a third of a calibre of mild steel',
  },
  penetrationHei: {
    source: 'plan',
    confidence: 'estimate',
    note: 'the fuze functions on contact; the steel body holes only sheet metal',
  },
  barrels: { source: 'wikiGau8', confidence: 'confirmed' },
  heiCharge: {
    source: 'plan',
    confidence: 'estimate',
    note: 'no public fill weight; ≈50 g of RDX-based fill as in other 30×173 mm HEI rounds',
  },
  heiFragmentMass: {
    source: 'plan',
    confidence: 'estimate',
    note: 'projectile mass less fill, fuze and driving bands',
  },
};

/**
 * Drag coefficient of the G7 standard projectile (long boat-tail, 7.5-calibre tangent ogive)
 * against Mach number: pairs [Mach, Cd], increasing Mach. Each 30 mm projectile drags as
 * GAU8.formFactor* times this curve. Beyond the last Mach the last value holds.
 */
export const GUN_DRAG_G7: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.1198],
  [0.05, 0.1197],
  [0.1, 0.1196],
  [0.15, 0.1194],
  [0.2, 0.1193],
  [0.25, 0.1194],
  [0.3, 0.1194],
  [0.35, 0.1194],
  [0.4, 0.1193],
  [0.45, 0.1193],
  [0.5, 0.1194],
  [0.55, 0.1193],
  [0.6, 0.1194],
  [0.65, 0.1197],
  [0.7, 0.1202],
  [0.725, 0.1207],
  [0.75, 0.1215],
  [0.775, 0.1226],
  [0.8, 0.1242],
  [0.825, 0.1266],
  [0.85, 0.1306],
  [0.875, 0.1368],
  [0.9, 0.1464],
  [0.925, 0.166],
  [0.95, 0.2054],
  [0.975, 0.2993],
  [1.0, 0.3803],
  [1.025, 0.4015],
  [1.05, 0.4043],
  [1.075, 0.4034],
  [1.1, 0.4014],
  [1.125, 0.3987],
  [1.15, 0.3955],
  [1.2, 0.3884],
  [1.25, 0.381],
  [1.3, 0.3732],
  [1.35, 0.3657],
  [1.4, 0.358],
  [1.5, 0.344],
  [1.55, 0.3376],
  [1.6, 0.3315],
  [1.65, 0.326],
  [1.7, 0.3209],
  [1.75, 0.316],
  [1.8, 0.3117],
  [1.85, 0.3078],
  [1.9, 0.3042],
  [1.95, 0.301],
  [2.0, 0.298],
  [2.05, 0.2951],
  [2.1, 0.2922],
  [2.15, 0.2892],
  [2.2, 0.2864],
  [2.25, 0.2835],
  [2.3, 0.2807],
  [2.35, 0.2779],
  [2.4, 0.2752],
  [2.45, 0.2725],
  [2.5, 0.2697],
  [2.55, 0.267],
  [2.6, 0.2643],
  [2.65, 0.2615],
  [2.7, 0.2588],
  [2.75, 0.2561],
  [2.8, 0.2533],
  [2.85, 0.2506],
  [2.9, 0.2479],
  [2.95, 0.2451],
  [3.0, 0.2424],
  [3.1, 0.2368],
  [3.2, 0.2313],
  [3.3, 0.2258],
  [3.4, 0.2205],
  [3.5, 0.2154],
  [3.6, 0.2106],
  [3.7, 0.206],
  [3.8, 0.2017],
  [3.9, 0.1975],
  [4.0, 0.1935],
];

export const GUN_DRAG_G7_NOTE: SourceNote = {
  source: 'plan',
  confidence: 'confirmed',
  note: 'G7 standard drag function (US Army BRL; McCoy, Modern Exterior Ballistics, 1999)',
};

/**
 * What a 30 mm round does on the ground and how long it is followed (PLAN §6.3, §14 and
 * docs/a10/ARCHITECTURE.md §5: the weapons module sets the exact skip rule).
 */
export const ROUND_BEHAVIOUR = {
  /** Impact angle below which a round always skips off hard ground, rad. */
  skipAlwaysAngle: 6 * DEG,
  /** Impact angle above which it never skips (linear chance in between: 50 % at ≈8°), rad. */
  skipNeverAngle: 10 * DEG,
  /** Speed kept by a skipping round: uniform between these fractions. */
  skipSpeedMin: 0.5,
  skipSpeedMax: 0.7,
  /** Departure angle above the ground as a fraction of the impact angle: uniform range. */
  skipDepartureMin: 0.3,
  skipDepartureMax: 0.8,
  /** Sideways scatter of a skip, rad (standard deviation). */
  skipScatter: 4 * DEG,
  /** Skips a round can make before it digs in. */
  maxSkips: 2,
  /** Armour ricochets a round is followed through. */
  maxRicochets: 3,
  /** A 'field' or 'dirt'-like surface counts as dry (hard) below this ground moisture (0..1). */
  dryMoisture: 0.45,
  /** Rounds are removed this long after leaving the muzzle, s. */
  maxLifetime: 8,
  /** Live-round pool size. */
  poolCapacity: 1024,
} as const;

export const ROUND_BEHAVIOUR_NOTES: Record<keyof typeof ROUND_BEHAVIOUR, SourceNote> = {
  skipAlwaysAngle: {
    source: 'plan',
    confidence: 'estimate',
    note: 'rounds skip off hard ground below ≈8° (PLAN §6.3, ARCHITECTURE §5)',
  },
  skipNeverAngle: { source: 'plan', confidence: 'estimate' },
  skipSpeedMin: { source: 'plan', confidence: 'estimate', note: 'keeps ≈50–70 % of its speed' },
  skipSpeedMax: { source: 'plan', confidence: 'estimate' },
  skipDepartureMin: {
    source: 'plan',
    confidence: 'estimate',
    note: 'ricochets leave flatter than they arrive',
  },
  skipDepartureMax: { source: 'plan', confidence: 'estimate' },
  skipScatter: { source: 'plan', confidence: 'estimate' },
  maxSkips: { source: 'plan', confidence: 'estimate' },
  maxRicochets: { source: 'plan', confidence: 'estimate' },
  dryMoisture: { source: 'plan', confidence: 'estimate' },
  maxLifetime: { source: 'plan', confidence: 'confirmed', note: 'PLAN §14 (lifetime cap 8 s)' },
  poolCapacity: { source: 'plan', confidence: 'confirmed', note: 'PLAN §14 (pool of 1,024)' },
};

/**
 * Time of flight and remaining speed of each round type, from THIS simulator's ballistic model,
 * frozen as the reference the tests hold the model to (PLAN §16, within 2 %). Conditions: a
 * static gun at sea level (ISA, still air), fired horizontally; `range` is the straight-line
 * distance from the muzzle, m; `tof` s; `speed` m/s. tests/unit/a10/ballistics.test.ts prints
 * the model's values when they drift: regenerate the table only for a deliberate data change.
 */
export const GAU8_TRAJECTORY_TABLE = {
  conditions: { altitude: 0, elevation: 0, aircraftSpeed: 0 },
  api: [
    { range: 500, tof: 0.529, speed: 881 },
    { range: 1000, tof: 1.141, speed: 758 },
    { range: 1500, tof: 1.856, speed: 645 },
  ],
  hei: [
    { range: 500, tof: 0.522, speed: 884 },
    { range: 1000, tof: 1.14, speed: 743 },
    { range: 1500, tof: 1.88, speed: 615 },
  ],
} as const;

export const GAU8_TRAJECTORY_TABLE_NOTE: SourceNote = {
  source: 'plan',
  confidence: 'estimate',
  note: 'model output (G7 × form factor drag, ISA); the plan freezes it for the regression tests',
};
