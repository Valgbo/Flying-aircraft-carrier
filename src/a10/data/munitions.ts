/**
 * Stores reference data (PLAN_A10.md §6.4–§6.8 and §19): what each store weighs, how much drag
 * it adds, what may hang on which of the eleven stations, and the loadout presets. SI units.
 * Owned by the WEAPONS module. Release logic comes in wave 2; this is the data it will use.
 *
 * Drag areas are CdA as carried (pylon or rack interference included), m², for the flight
 * model's stores drag. No public per-store drag figures exist for the A-10, so they are
 * estimates from the stores' frontal areas and typical subsonic store drag coefficients
 * (finned bombs and missiles ≈0.2–0.4 of the frontal area, blunt pods and racks more; Hoerner,
 * Fluid-Dynamic Drag, ch. 13). The tank-hunter load (≈3,040 kg) adds 0.43 m², a fifth of the
 * clean aircraft's zero-lift drag area, and in the flight model lowers the level top speed at
 * sea level from 381 to 354 kn.
 *
 * Wave 2 adds, at the end of the file, what a store does once it has left: its free-flight drag
 * against Mach number, how the rack pushes it away, the Mk-82 AIR ballute, the Mk 66 rocket
 * motor, warheads and fuzes, and the fragment envelope used for the safe-escape warning.
 */
import { FT, LBF } from '../core/units';
import type { StoreType } from '../core/weapons/types';
import type { SourceNote } from './sources';

export type StoreKind =
  'missile' | 'bomb' | 'guidedBomb' | 'rocketPod' | 'dispenser' | 'pod' | 'airToAir' | 'rack';

export interface StoreData {
  kind: StoreKind;
  /** Mass as loaded, kg (racks and launchers: empty; rocket pods: with their rockets). */
  mass: number;
  /** Drag area as carried, m² (CdA). */
  dragArea: number;
  /** Length, m. */
  length: number;
  /** Body diameter, m. */
  diameter: number;
  /** Selective and emergency jettison can drop it (pods and the AIM-9 rails stay). */
  jettisonable: boolean;
  /** Racks and launchers: the stores they carry, and how many at most. */
  carries?: readonly StoreType[];
  capacity?: number;
  /** Rocket pods: rockets loaded and the mass of one rocket, kg. */
  rockets?: number;
  rocketMass?: number;
}

/** Hydra 70 rocket (PLAN §6.7): Mk 66 motor and warheads, kg. */
export const HYDRA70 = {
  /** Mk 66 motor. */
  motorMass: 6.2,
  /** M151 high-explosive warhead with fuze. */
  m151Mass: 4.2,
  /** M156 white-phosphorus smoke warhead with fuze. */
  m156Mass: 4.4,
  /** Tubes in a LAU-131 or LAU-68 pod. */
  podTubes: 7,
  /** Speed at motor burn-out from a static launch (Mk 66 with an M151), m/s (PLAN §16). */
  burnoutSpeed: 739,
} as const;

export const HYDRA70_NOTES: Record<keyof typeof HYDRA70, SourceNote> = {
  motorMass: { source: 'gdotsHydra', confidence: 'confirmed', note: 'Mk 66: 6.2 kg (PLAN §19)' },
  m151Mass: {
    source: 'gdotsHydra',
    confidence: 'confirmed',
    note: '3.9–4.2 kg without or with fuze (PLAN §19)',
  },
  m156Mass: { source: 'wikiHydra', confidence: 'approximate', note: '≈9.7 lb with fuze' },
  podTubes: { source: 'gdotsHydra', confidence: 'confirmed' },
  burnoutSpeed: {
    source: 'gdotsHydra',
    confidence: 'confirmed',
    note: '739 m/s (2,425 ft/s) at burn-out, static launch (PLAN §19)',
  },
};

const M151_ROCKET = HYDRA70.motorMass + HYDRA70.m151Mass;
const M156_ROCKET = HYDRA70.motorMass + HYDRA70.m156Mass;
const LAU131_EMPTY = 29.5;
const LAU68_EMPTY = 36;
const MAVERICKS: readonly StoreType[] = ['AGM-65D', 'AGM-65H', 'AGM-65G', 'AGM-65K'];

export const STORES: Record<StoreType, StoreData> = {
  'AGM-65D': {
    kind: 'missile',
    mass: 218.3,
    dragArea: 0.03,
    length: 2.49,
    diameter: 0.305,
    jettisonable: true,
  },
  'AGM-65H': {
    kind: 'missile',
    mass: 207.9,
    dragArea: 0.03,
    length: 2.49,
    diameter: 0.305,
    jettisonable: true,
  },
  'AGM-65G': {
    kind: 'missile',
    mass: 301.5,
    dragArea: 0.03,
    length: 2.49,
    diameter: 0.305,
    jettisonable: true,
  },
  'AGM-65K': {
    kind: 'missile',
    mass: 301.5,
    dragArea: 0.03,
    length: 2.49,
    diameter: 0.305,
    jettisonable: true,
  },
  'MK-82': {
    kind: 'bomb',
    mass: 241,
    dragArea: 0.015,
    length: 2.21,
    diameter: 0.273,
    jettisonable: true,
  },
  'MK-82AIR': {
    kind: 'bomb',
    mass: 242,
    dragArea: 0.02,
    length: 2.29,
    diameter: 0.273,
    jettisonable: true,
  },
  'GBU-12': {
    kind: 'guidedBomb',
    mass: 277,
    dragArea: 0.025,
    length: 3.27,
    diameter: 0.273,
    jettisonable: true,
  },
  'LAU-131-M151': {
    kind: 'rocketPod',
    mass: LAU131_EMPTY + HYDRA70.podTubes * M151_ROCKET,
    dragArea: 0.035,
    length: 1.7,
    diameter: 0.25,
    jettisonable: true,
    rockets: HYDRA70.podTubes,
    rocketMass: M151_ROCKET,
  },
  'LAU-131-M156': {
    kind: 'rocketPod',
    mass: LAU131_EMPTY + HYDRA70.podTubes * M156_ROCKET,
    dragArea: 0.035,
    length: 1.7,
    diameter: 0.25,
    jettisonable: true,
    rockets: HYDRA70.podTubes,
    rocketMass: M156_ROCKET,
  },
  'LAU-68-M151': {
    kind: 'rocketPod',
    mass: LAU68_EMPTY + HYDRA70.podTubes * M151_ROCKET,
    dragArea: 0.035,
    length: 1.8,
    diameter: 0.25,
    jettisonable: true,
    rockets: HYDRA70.podTubes,
    rocketMass: M151_ROCKET,
  },
  'LAU-68-M156': {
    kind: 'rocketPod',
    mass: LAU68_EMPTY + HYDRA70.podTubes * M156_ROCKET,
    dragArea: 0.035,
    length: 1.8,
    diameter: 0.25,
    jettisonable: true,
    rockets: HYDRA70.podTubes,
    rocketMass: M156_ROCKET,
  },
  'CBU-97': {
    kind: 'dispenser',
    mass: 420,
    dragArea: 0.03,
    length: 2.34,
    diameter: 0.4,
    jettisonable: true,
  },
  'AN/AAQ-28': {
    kind: 'pod',
    mass: 208,
    dragArea: 0.035,
    length: 2.2,
    diameter: 0.406,
    jettisonable: false,
  },
  'AN/ALQ-184': {
    kind: 'pod',
    mass: 209.5,
    dragArea: 0.04,
    length: 3.96,
    diameter: 0.3,
    jettisonable: false,
  },
  'AIM-9M': {
    kind: 'airToAir',
    mass: 86,
    dragArea: 0.012,
    length: 2.87,
    diameter: 0.127,
    jettisonable: false,
  },
  'TER-9A': {
    kind: 'rack',
    mass: 47.6,
    dragArea: 0.03,
    length: 1.85,
    diameter: 0.5,
    jettisonable: true,
    carries: ['MK-82', 'MK-82AIR'],
    capacity: 3,
  },
  'LAU-117': {
    kind: 'rack',
    mass: 61,
    dragArea: 0.008,
    length: 2.2,
    diameter: 0.27,
    jettisonable: true,
    carries: MAVERICKS,
    capacity: 1,
  },
  'LAU-88': {
    kind: 'rack',
    mass: 211,
    dragArea: 0.04,
    length: 1.77,
    diameter: 0.96,
    jettisonable: true,
    carries: ['AGM-65D', 'AGM-65H'],
    capacity: 3,
  },
  'LAU-114': {
    kind: 'rack',
    mass: 41,
    dragArea: 0.015,
    length: 2.31,
    diameter: 0.55,
    jettisonable: false,
    carries: ['AIM-9M'],
    capacity: 2,
  },
};

/** Sources of each store's mass, drag area and dimensions. */
export interface StoreNotes {
  mass: SourceNote;
  dragArea: SourceNote;
  size: SourceNote;
}

const DRAG_ESTIMATE: SourceNote = {
  source: 'hoernerDrag',
  confidence: 'estimate',
  note: 'frontal area × typical store drag coefficient (Hoerner, Fluid-Dynamic Drag, ch. 13)',
};
const MAVERICK_SIZE: SourceNote = {
  source: 'designationSystems',
  confidence: 'confirmed',
  note: '2.49 m × 0.305 m',
};
const MK82_SIZE: SourceNote = {
  source: 'wikiMk82',
  confidence: 'confirmed',
  note: 'Mk 82: 2.21 m × 0.273 m (Wikipedia, Mark 82 bomb)',
};
const LAU131_NOTE: SourceNote = {
  source: 'arnoldLau131',
  confidence: 'approximate',
  note: 'LAU-131/A empty 65 lb (Arnold Defense data sheet) + 7 rockets (HYDRA70)',
};
const LAU68_NOTE: SourceNote = {
  source: 'plan',
  confidence: 'estimate',
  note: 'LAU-68 empty ≈80 lb + 7 rockets (HYDRA70)',
};
const POD_SIZE: SourceNote = {
  source: 'flightgearA10',
  confidence: 'estimate',
  note: 'sized from the FlightGear model',
};

export const STORE_NOTES: Record<StoreType, StoreNotes> = {
  'AGM-65D': {
    mass: { source: 'afAgm65', confidence: 'confirmed', note: 'USAF fact sheet: 485 lb' },
    dragArea: DRAG_ESTIMATE,
    size: MAVERICK_SIZE,
  },
  'AGM-65H': {
    mass: { source: 'afAgm65', confidence: 'confirmed', note: 'USAF fact sheet: 462 lb' },
    dragArea: DRAG_ESTIMATE,
    size: MAVERICK_SIZE,
  },
  'AGM-65G': {
    mass: { source: 'afAgm65', confidence: 'confirmed', note: 'USAF fact sheet: 670 lb' },
    dragArea: DRAG_ESTIMATE,
    size: MAVERICK_SIZE,
  },
  'AGM-65K': {
    mass: {
      source: 'wikiAgm65',
      confidence: 'approximate',
      note: "the G's airframe and 136 kg warhead with a TV seeker; sources give 670–793 lb",
    },
    dragArea: DRAG_ESTIMATE,
    size: MAVERICK_SIZE,
  },
  'MK-82': {
    mass: { source: 'wikiMk82', confidence: 'confirmed', note: '531 lb' },
    dragArea: DRAG_ESTIMATE,
    size: MK82_SIZE,
  },
  'MK-82AIR': {
    mass: {
      source: 'flightgearA10',
      confidence: 'approximate',
      note: '533 lb with the BSU-49 ballute tail (FlightGear payload file, citing the Weapons File 2004)',
    },
    dragArea: DRAG_ESTIMATE,
    size: MK82_SIZE,
  },
  'GBU-12': {
    mass: {
      source: 'wikiGbu12',
      confidence: 'approximate',
      note: 'Mk 82 body + guidance kit: sources give 510–611 lb; 611 lb taken',
    },
    dragArea: DRAG_ESTIMATE,
    size: { source: 'wikiGbu12', confidence: 'approximate', note: '3.27 m long' },
  },
  'LAU-131-M151': { mass: LAU131_NOTE, dragArea: DRAG_ESTIMATE, size: POD_SIZE },
  'LAU-131-M156': { mass: LAU131_NOTE, dragArea: DRAG_ESTIMATE, size: POD_SIZE },
  'LAU-68-M151': { mass: LAU68_NOTE, dragArea: DRAG_ESTIMATE, size: POD_SIZE },
  'LAU-68-M156': { mass: LAU68_NOTE, dragArea: DRAG_ESTIMATE, size: POD_SIZE },
  'CBU-97': {
    mass: { source: 'wikiCbu97', confidence: 'confirmed', note: '927 lb (≈420 kg, PLAN §19)' },
    dragArea: DRAG_ESTIMATE,
    size: { source: 'wikiCbu97', confidence: 'approximate', note: 'SUU-66/B dispenser' },
  },
  'AN/AAQ-28': {
    mass: {
      source: 'wikiLitening',
      confidence: 'approximate',
      note: '208 kg; the USAF fact sheet says 440 lb (200 kg)',
    },
    dragArea: DRAG_ESTIMATE,
    size: { source: 'wikiLitening', confidence: 'confirmed', note: '2.2 m × 0.406 m' },
  },
  'AN/ALQ-184': {
    mass: {
      source: 'alq184Forecast',
      confidence: 'approximate',
      note: 'two-band pod: 461 lb',
    },
    dragArea: DRAG_ESTIMATE,
    size: {
      source: 'flightgearA10',
      confidence: 'approximate',
      note: '3.96 m as modelled (the forecast gives 2.9 m; other public figures ≈3.9 m)',
    },
  },
  'AIM-9M': {
    mass: {
      source: 'flightgearA10',
      confidence: 'approximate',
      note: '185–191 lb (FlightGear payload file cites CNATRA P-825)',
    },
    dragArea: DRAG_ESTIMATE,
    size: {
      source: 'afAim9',
      confidence: 'confirmed',
      note: '9 ft 5 in × 5 in (2.87 m × 0.127 m)',
    },
  },
  'TER-9A': {
    mass: {
      source: 'plan',
      confidence: 'approximate',
      note: '105 lb (a USAF weapons manual as quoted on the DCS forum; 95 lb elsewhere)',
    },
    dragArea: DRAG_ESTIMATE,
    size: POD_SIZE,
  },
  'LAU-117': {
    mass: {
      source: 'plan',
      confidence: 'estimate',
      note: '≈135 lb (L3Harris release-systems catalogue)',
    },
    dragArea: DRAG_ESTIMATE,
    size: POD_SIZE,
  },
  'LAU-88': {
    mass: { source: 'plan', confidence: 'estimate', note: 'no public figure found; ≈465 lb' },
    dragArea: DRAG_ESTIMATE,
    size: POD_SIZE,
  },
  'LAU-114': {
    mass: {
      source: 'flightgearA10',
      confidence: 'estimate',
      note: 'dual-rail adapter with two LAU-114/A rails: FlightGear launcher mass 90 lb',
    },
    dragArea: DRAG_ESTIMATE,
    size: POD_SIZE,
  },
};

/**
 * What may hang on each station (index = station 1..11): the item next to the pylon, i.e. a
 * rack or launcher, or a store hung directly. Mavericks hang only on LAU-117/LAU-88 launchers on
 * stations 3 and 9, AIM-9s only on the dual-rail adapter on the outboard stations, ECM pods on
 * 1 and 11, the targeting pod on 2, 3, 9 or 10, rockets on 2–4 and 8–10, triple ejector racks
 * on 3, 4, 8 and 9.
 */
const ROCKET_PODS: readonly StoreType[] = [
  'LAU-131-M151',
  'LAU-131-M156',
  'LAU-68-M151',
  'LAU-68-M156',
];
const BOMBS: readonly StoreType[] = ['MK-82', 'MK-82AIR', 'GBU-12', 'CBU-97'];
const WING_TIP: readonly StoreType[] = ['AN/ALQ-184', 'LAU-114', 'MK-82', 'MK-82AIR', 'CBU-97'];
const OUTER: readonly StoreType[] = [...ROCKET_PODS, 'AN/AAQ-28', 'MK-82', 'MK-82AIR', 'CBU-97'];
const MAVERICK_STATION: readonly StoreType[] = [
  'LAU-117',
  'LAU-88',
  'TER-9A',
  ...BOMBS,
  ...ROCKET_PODS,
  'AN/AAQ-28',
];
const MIDDLE: readonly StoreType[] = ['TER-9A', ...BOMBS, ...ROCKET_PODS];

export const STATION_STORES: ReadonlyArray<readonly StoreType[]> = [
  [],
  WING_TIP,
  OUTER,
  MAVERICK_STATION,
  MIDDLE,
  BOMBS,
  BOMBS,
  BOMBS,
  MIDDLE,
  MAVERICK_STATION,
  OUTER,
  WING_TIP,
];

/** The centreline station cannot be loaded together with stations 5 and 7 (clearance). */
export const STATION_EXCLUSIVE: ReadonlyArray<readonly [number, number]> = [
  [6, 5],
  [6, 7],
];

export const STATION_NOTES: SourceNote = {
  source: 'flightgearA10',
  confidence: 'estimate',
  note:
    'FlightGear pylon sets (Nasal/WEAPONS/pylons.nas) checked against public loading notes: ' +
    'Mavericks on 3 and 9; ECM pod and AIM-9 pair on 1/11; targeting pod on 2/10 (also 3/9)',
};

export interface LoadoutPreset {
  name: string;
  /** Station number → what hangs there (rack or launcher first). */
  stations: Record<number, StoreType[]>;
}

/**
 * Loadout presets (PLAN §6.8). The tank hunter: four Mavericks — two infrared (D) and two
 * television (H) — on LAU-88s with two missiles each (Mavericks only hang on stations 3 and 9,
 * so four need the triple launchers), two GBU-12, two Mk-82, a pod of M156 smoke rockets and the
 * targeting pod, plus the jamming pod and the AIM-9M pair A-10Cs carry on the outboard stations.
 */
export const LOADOUT_PRESETS: Record<string, LoadoutPreset> = {
  tankHunter: {
    name: 'Tank hunter',
    stations: {
      1: ['AN/ALQ-184'],
      2: ['LAU-131-M156'],
      3: ['LAU-88', 'AGM-65D', 'AGM-65D'],
      4: ['GBU-12'],
      5: ['MK-82'],
      7: ['MK-82'],
      8: ['GBU-12'],
      9: ['LAU-88', 'AGM-65H', 'AGM-65H'],
      10: ['AN/AAQ-28'],
      11: ['LAU-114', 'AIM-9M', 'AIM-9M'],
    },
  },
  gunOnly: { name: 'Gun only', stations: {} },
  rangeTraining: {
    name: 'Range training',
    stations: {
      2: ['LAU-131-M156'],
      3: ['TER-9A', 'MK-82', 'MK-82'],
      4: ['LAU-131-M151'],
      8: ['LAU-131-M151'],
      9: ['TER-9A', 'MK-82', 'MK-82'],
      10: ['AN/AAQ-28'],
    },
  },
  heavyBombs: {
    name: 'Heavy bombs',
    stations: {
      1: ['AN/ALQ-184'],
      3: ['TER-9A', 'MK-82', 'MK-82'],
      4: ['TER-9A', 'MK-82AIR', 'MK-82AIR', 'MK-82AIR'],
      5: ['MK-82'],
      7: ['MK-82'],
      8: ['TER-9A', 'MK-82AIR', 'MK-82AIR', 'MK-82AIR'],
      9: ['TER-9A', 'MK-82', 'MK-82'],
      10: ['AN/AAQ-28'],
      11: ['LAU-114', 'AIM-9M', 'AIM-9M'],
    },
  },
};

export const LOADOUT_NOTES: SourceNote = {
  source: 'plan',
  confidence: 'approximate',
  note: 'PLAN §6.8 tank hunter; outboard ECM pod + AIM-9 pair as public A-10C photographs show',
};

// =================================================================================================
// Wave 2: released stores in free flight (PLAN §6.1, §6.5–§6.7, §6.9; ARCHITECTURE §12.1, §12.2)
// =================================================================================================

/**
 * Drag coefficient against Mach number: [Mach, Cd] pairs, increasing Mach, Cd on the store's
 * reference area π·d²/4 (its body diameter). Beyond the last Mach the last value holds.
 */
export type DragCurve = ReadonlyArray<readonly [number, number]>;

/**
 * Mk 82 with the Mk 15-type conical fin assembly ("low drag"). Subsonic Cd ≈ 0.2 is the sum of
 * skin friction on a fineness-8 body (≈0.09), the four fins (≈0.02), the small base behind the
 * tail cone, the nose fuze and the lugs (Hoerner, Fluid-Dynamic Drag, ch. 3, 13); the transonic
 * rise to ≈0.6 and the supersonic fall-off have the shape of finned bodies of revolution
 * (Hoerner ch. 16). The measured Mk 82 tables (DSTO-TR-0554, AD A329921) were not reachable.
 */
export const MK82_DRAG: DragCurve = [
  [0, 0.2],
  [0.6, 0.2],
  [0.7, 0.21],
  [0.8, 0.24],
  [0.85, 0.28],
  [0.9, 0.36],
  [0.95, 0.47],
  [1.0, 0.56],
  [1.05, 0.6],
  [1.1, 0.6],
  [1.2, 0.57],
  [1.5, 0.5],
  [2.0, 0.42],
  [3.0, 0.34],
];

/**
 * GBU-12: the Mk 82 body with the Paveway II seeker head, its four canards and the large folding
 * wings of the air-foil group, which add skin friction and interference drag (about 1.65 × the
 * low-drag Mk 82). The canards' manoeuvring (induced) drag is the guided module's.
 */
export const GBU12_DRAG: DragCurve = [
  [0, 0.33],
  [0.6, 0.33],
  [0.7, 0.35],
  [0.8, 0.4],
  [0.9, 0.55],
  [1.0, 0.8],
  [1.1, 0.85],
  [1.3, 0.8],
  [2.0, 0.65],
];

/** AGM-65 airframe (glass seeker dome, long-chord cruciform wings and tail), power off. */
export const MAVERICK_DRAG: DragCurve = [
  [0, 0.34],
  [0.7, 0.36],
  [0.85, 0.42],
  [0.95, 0.6],
  [1.05, 0.8],
  [1.2, 0.76],
  [1.5, 0.66],
  [2.0, 0.56],
];

/**
 * Hydra 70 (Mk 66 motor, wrap-around fins, M151 / M156 head), power off. The transonic peak and
 * the slow supersonic fall-off are those of a finned 2.75-inch rocket; while the motor burns the
 * plume fills the base (MK66.plumeDrag).
 */
export const HYDRA70_DRAG: DragCurve = [
  [0, 0.38],
  [0.6, 0.38],
  [0.8, 0.42],
  [0.9, 0.5],
  [1.0, 0.7],
  [1.1, 0.76],
  [1.2, 0.74],
  [1.5, 0.64],
  [2.0, 0.53],
  [2.5, 0.46],
  [3.0, 0.41],
  [4.0, 0.35],
];

/** SUU-66/B dispenser of the CBU-97 (blunt nose, folding tail fins), before it opens. */
export const CBU97_DRAG: DragCurve = [
  [0, 0.28],
  [0.7, 0.3],
  [0.85, 0.38],
  [0.95, 0.55],
  [1.05, 0.75],
  [1.2, 0.72],
  [2.0, 0.55],
];

export const DRAG_CURVE_NOTES: Record<
  'MK82_DRAG' | 'GBU12_DRAG' | 'MAVERICK_DRAG' | 'HYDRA70_DRAG' | 'CBU97_DRAG',
  SourceNote
> = {
  MK82_DRAG: {
    source: 'hoernerDrag',
    confidence: 'estimate',
    note: 'component build-up (Hoerner ch. 3, 13, 16); DSTO-TR-0554 Mk 82 tables not reachable',
  },
  GBU12_DRAG: {
    source: 'hoernerDrag',
    confidence: 'estimate',
    note: 'Mk 82 body + seeker head, canards and wings: ≈1.65 × the low-drag bomb',
  },
  MAVERICK_DRAG: {
    source: 'hoernerDrag',
    confidence: 'estimate',
    note: 'missile body with cruciform wings; the guided module may supply its own',
  },
  HYDRA70_DRAG: {
    source: 'hoernerDrag',
    confidence: 'estimate',
    note: 'finned 2.75-inch rocket; the motor fit (MK66.propellantMass) absorbs the power-on drag',
  },
  CBU97_DRAG: { source: 'hoernerDrag', confidence: 'estimate', note: 'blunt finned dispenser' },
};

/** How a store leaves its station. */
export type LaunchKind =
  /** A cartridge ejector (MAU-40/A pylon rack, TER-9/A) pushes it down, away from the aircraft. */
  | 'ejector'
  /** A launcher rail (LAU-117, LAU-88): the motor carries it off; no ejection. */
  | 'rail'
  /** A rocket-pod tube (LAU-131, LAU-68): the motor accelerates it along the tube. */
  | 'tube';

/** A weapon's free flight. */
export interface StoreFlightData {
  /** Drag curve and the diameter its Cd refers to, m. */
  drag: DragCurve;
  referenceDiameter: number;
  /** Multiplier on the curve (a configuration of the same airframe). */
  dragFactor: number;
  launch: LaunchKind;
  /**
   * Time constant with which the body's axis turns into the relative wind, s (first-order lag;
   * the drawn attitude only: the point-mass motion does not depend on it).
   */
  weathercockTime: number;
  /** Name in the hit, kill and weapon records (the store, or the rocket's warhead). */
  name: string;
}

/** Free flight of every store that can be released (racks and pods only fall when jettisoned). */
export const STORE_FLIGHT: Partial<Record<StoreType, StoreFlightData>> = {
  'MK-82': {
    drag: MK82_DRAG,
    referenceDiameter: 0.273,
    dragFactor: 1,
    launch: 'ejector',
    weathercockTime: 0.35,
    name: 'MK-82',
  },
  'MK-82AIR': {
    drag: MK82_DRAG,
    referenceDiameter: 0.273,
    dragFactor: 1.15,
    launch: 'ejector',
    weathercockTime: 0.35,
    name: 'MK-82AIR',
  },
  'GBU-12': {
    drag: GBU12_DRAG,
    referenceDiameter: 0.273,
    dragFactor: 1,
    launch: 'ejector',
    weathercockTime: 0.3,
    name: 'GBU-12',
  },
  'CBU-97': {
    drag: CBU97_DRAG,
    referenceDiameter: 0.4,
    dragFactor: 1,
    launch: 'ejector',
    weathercockTime: 0.35,
    name: 'CBU-97',
  },
  'AGM-65D': {
    drag: MAVERICK_DRAG,
    referenceDiameter: 0.305,
    dragFactor: 1,
    launch: 'rail',
    weathercockTime: 0.1,
    name: 'AGM-65D',
  },
  'AGM-65H': {
    drag: MAVERICK_DRAG,
    referenceDiameter: 0.305,
    dragFactor: 1,
    launch: 'rail',
    weathercockTime: 0.1,
    name: 'AGM-65H',
  },
  'AGM-65G': {
    drag: MAVERICK_DRAG,
    referenceDiameter: 0.305,
    dragFactor: 1,
    launch: 'rail',
    weathercockTime: 0.1,
    name: 'AGM-65G',
  },
  'AGM-65K': {
    drag: MAVERICK_DRAG,
    referenceDiameter: 0.305,
    dragFactor: 1,
    launch: 'rail',
    weathercockTime: 0.1,
    name: 'AGM-65K',
  },
  'LAU-131-M151': {
    drag: HYDRA70_DRAG,
    referenceDiameter: 0.07,
    dragFactor: 1,
    launch: 'tube',
    weathercockTime: 0.05,
    name: 'M151',
  },
  'LAU-131-M156': {
    drag: HYDRA70_DRAG,
    referenceDiameter: 0.07,
    dragFactor: 1,
    launch: 'tube',
    weathercockTime: 0.05,
    name: 'M156',
  },
  'LAU-68-M151': {
    drag: HYDRA70_DRAG,
    referenceDiameter: 0.07,
    dragFactor: 1,
    launch: 'tube',
    weathercockTime: 0.05,
    name: 'M151',
  },
  'LAU-68-M156': {
    drag: HYDRA70_DRAG,
    referenceDiameter: 0.07,
    dragFactor: 1,
    launch: 'tube',
    weathercockTime: 0.05,
    name: 'M156',
  },
};

export const STORE_FLIGHT_NOTES: SourceNote = {
  source: 'hoernerDrag',
  confidence: 'estimate',
  note:
    'curves above; Mk 82 AIR in low drag: the BSU-49 canister tail drags ≈15 % more than the ' +
    'conical fins; weathercock lags from the stores’ static margins (≈1–3 Hz at release speeds)',
};

/**
 * Cartridge ejectors (MAU-40/A in the pylons, TER-9/A): the cartridges' gas does roughly the same
 * work on any store, so the ejection speed falls as 1/√mass. The reference is 20 ft/s for a
 * 500-lb bomb; a TER with three Mk 82s jettisoned from the pylon leaves at ≈3.4 m/s.
 */
export const EJECTOR = {
  /** Work done on the store, J: 20 ft/s for a 241 kg Mk 82 (½·241·6.10²). */
  energy: 0.5 * 241 * (20 * FT) ** 2,
  /** Fastest ejection, m/s (the piston stroke limits a light store). */
  maxVelocity: 25 * FT,
} as const;

export const EJECTOR_NOTES: Record<keyof typeof EJECTOR, SourceNote> = {
  energy: {
    source: 'l3harrisRelease',
    confidence: 'approximate',
    note:
      'L3Harris quotes 20 ft/s for 500-lb stores (BRU-55 class), as the FlightGear payload file ' +
      'gives for the Mk 82; constant ejector work is our model',
  },
  maxVelocity: { source: 'plan', confidence: 'estimate' },
};

/**
 * The Mk 82 AIR's BSU-49/B tail: a high-drag release pulls the ballute (a nylon balloon-
 * parachute) out of its canister; it fills and slows the bomb hard (≈8 g at 450 kn), so it
 * falls steeply far behind the aircraft — the low-level delivery the A-10 escapes from.
 */
export const BSU49 = {
  /** Drag area of the inflated ballute, m² (≈1.2 m across, Cd ≈ 0.55), on top of the bomb's. */
  dragArea: 0.6,
  /** Time from release to the start of inflation, s. */
  openStart: 0.2,
  /** Time from release to full inflation, s. */
  openFull: 0.5,
  /**
   * Time constant of the drawn axis turning into the relative wind once the ballute is out, s:
   * its drag acts far behind the centre of gravity, so it holds the tail downwind much harder
   * than the fins (the bomb swings nose-down with the steepening path).
   */
  weathercockTime: 0.1,
} as const;

export const BSU49_NOTES: Record<keyof typeof BSU49, SourceNote> = {
  dragArea: {
    source: 'flightgearA10',
    confidence: 'estimate',
    note:
      'inflated diameter ≈1.2 m from photographs, ballute Cd ≈0.5–0.9; FlightGear guesses +0.31 m² ' +
      '(delta Cd 5.25 on 0.63 ft²); no public drag figure found',
  },
  openStart: {
    source: 'plan',
    confidence: 'estimate',
    note:
      'brief: opens ≈0.2–0.5 s after release (the Eglin deployment test, ADTC 1559W055, was not ' +
      'reachable; FlightGear uses 0.65 s)',
  },
  openFull: { source: 'plan', confidence: 'estimate' },
  weathercockTime: {
    source: 'plan',
    confidence: 'estimate',
    note: 'drawn attitude only; ≈3× stiffer than the fins (drag area ×5 at ≈1.5 bomb lengths aft)',
  },
};

/**
 * Mk 66 Mod 4 rocket motor (Hydra 70). The thrust curve has the published total impulse and
 * burn time; its shape (a fast rise, a slightly regressive plateau, a short tail-off) is that of
 * a cast double-base grain. The propellant burnt is fitted so a static launch with an M151
 * burns out at 739 m/s (≈3.0 kg, specific impulse ≈229 s, typical of double-base propellant):
 * the static-launch test checks it. The mass falls in proportion to the impulse delivered.
 */
export const MK66 = {
  /** Total impulse, N·s (1,515 lbf·s, Mod 4 at 77 °F). */
  totalImpulse: 1515 * LBF,
  /** Burn time, s. */
  burnTime: 1.07,
  /** Average thrust, N (1,415 lbf): totalImpulse / burnTime. */
  averageThrust: 1415 * LBF,
  /** Shape of the thrust curve: [time s, thrust / average] knots, scaled to totalImpulse. */
  thrustShape: [
    [0, 0],
    [0.015, 1.1],
    [0.5, 1.03],
    [1.0, 0.96],
    [1.07, 0],
  ] as ReadonlyArray<readonly [number, number]>,
  /** Propellant burnt, kg (fitted, see above). */
  propellantMass: 3.0,
  /** Distance the rocket moves in the launch tube before it flies free, m. */
  tubeTravel: 1.5,
  /** Drag while the motor burns, as a share of the power-off drag (the plume fills the base). */
  plumeDrag: 0.8,
  /**
   * Launch dispersion, rad per axis (σ of the direction the rocket takes as it leaves the tube:
   * tip-off and thrust misalignment, most of it in the first 0.1 s).
   */
  dispersion: 0.0035,
} as const;

export const MK66_NOTES: Record<keyof typeof MK66, SourceNote> = {
  totalImpulse: {
    source: 'gdotsHydra',
    confidence: 'confirmed',
    note: 'Mod 4: 1,515 lbf·s (674 daN·s) at 77 °F',
  },
  burnTime: { source: 'gdotsHydra', confidence: 'confirmed', note: '1.07 s (PLAN: 1.05–1.10 s)' },
  averageThrust: {
    source: 'gdotsHydra',
    confidence: 'confirmed',
    note: '1,415 lbf (6.29 kN) Mod 4; Mod 2/3: 1,335 lbf',
  },
  thrustShape: { source: 'plan', confidence: 'estimate', note: 'cast double-base grain' },
  propellantMass: {
    source: 'plan',
    confidence: 'estimate',
    note: 'fitted to the 739 m/s static burn-out (no public propellant weight found)',
  },
  tubeTravel: { source: 'plan', confidence: 'estimate', note: 'LAU-131/A tube ≈1.7 m long' },
  plumeDrag: {
    source: 'hoernerDrag',
    confidence: 'estimate',
    note: 'base drag removed while burning',
  },
  dispersion: {
    source: 'ndiaHydra2003',
    confidence: 'estimate',
    note:
      'fixed-wing launch at 300 kn; the Army’s 2003 NDIA Hydra briefing gives 29 mil CEP for ' +
      'helicopter launches, where low launch speed and pylon motion dominate',
  },
};

/** What a store's warhead does when its fuze functions. */
export interface WarheadData {
  /** Explosive fill as TNT equivalent, kg (0: none). */
  charge: number;
  /** Mass of the case that breaks into fragments, kg. */
  caseMass: number;
  /** Detonation event kind. */
  kind: 'bomb' | 'rocket' | 'missile' | 'whitePhosphorus' | 'dud';
  /**
   * Distance from the fuze in the nose back to the centre of the charge, m: an instantaneous
   * burst on the ground happens this far back along the path, above the surface.
   */
  chargeOffset: number;
  /** Shaped-charge jet penetration, mm RHA (Maverick D/H); 0 = blast and fragments only. */
  penetrationMm: number;
  /**
   * Fuzing: 'profile' (bombs: nose instantaneous or tail delay from the weapon profile),
   * 'instant' (rocket and shaped-charge nose fuzes), 'delay' (a penetrating warhead).
   */
  fuze: 'profile' | 'instant' | 'delay';
}

/** Mk 82: 87 kg of Tritonal (≈96 kg TNT by blast) in a 125 kg fragmenting steel case. */
const MK82_WARHEAD: WarheadData = {
  charge: 96,
  caseMass: 125,
  kind: 'bomb',
  chargeOffset: 1.0,
  penetrationMm: 0,
  fuze: 'profile',
};

/** Warheads of the stores that can be released (CBU-97 submunitions are a later milestone). */
export const WARHEADS: Partial<Record<StoreType, WarheadData>> = {
  'MK-82': MK82_WARHEAD,
  'MK-82AIR': MK82_WARHEAD,
  'GBU-12': MK82_WARHEAD,
  'CBU-97': {
    charge: 0,
    caseMass: 0,
    kind: 'dud',
    chargeOffset: 0,
    penetrationMm: 0,
    fuze: 'instant',
  },
  'LAU-131-M151': {
    charge: 1.15,
    caseMass: 2.7,
    kind: 'rocket',
    chargeOffset: 0.25,
    penetrationMm: 0,
    fuze: 'instant',
  },
  'LAU-68-M151': {
    charge: 1.15,
    caseMass: 2.7,
    kind: 'rocket',
    chargeOffset: 0.25,
    penetrationMm: 0,
    fuze: 'instant',
  },
  'LAU-131-M156': {
    charge: 0.12,
    caseMass: 1.0,
    kind: 'whitePhosphorus',
    chargeOffset: 0.25,
    penetrationMm: 0,
    fuze: 'instant',
  },
  'LAU-68-M156': {
    charge: 0.12,
    caseMass: 1.0,
    kind: 'whitePhosphorus',
    chargeOffset: 0.25,
    penetrationMm: 0,
    fuze: 'instant',
  },
  'AGM-65D': {
    charge: 39,
    caseMass: 15,
    kind: 'missile',
    chargeOffset: 0.6,
    penetrationMm: 1000,
    fuze: 'instant',
  },
  'AGM-65H': {
    charge: 39,
    caseMass: 15,
    kind: 'missile',
    chargeOffset: 0.6,
    penetrationMm: 1000,
    fuze: 'instant',
  },
  'AGM-65G': {
    charge: 45,
    caseMass: 90,
    kind: 'missile',
    chargeOffset: 0.9,
    penetrationMm: 0,
    fuze: 'delay',
  },
  'AGM-65K': {
    charge: 45,
    caseMass: 90,
    kind: 'missile',
    chargeOffset: 0.9,
    penetrationMm: 0,
    fuze: 'delay',
  },
};

export const WARHEAD_NOTES: Record<string, SourceNote> = {
  'MK-82': {
    source: 'wikiMk82',
    confidence: 'approximate',
    note:
      '87 kg Tritonal × ≈1.1 (TNT equivalence by blast, UFC 3-340-02) = 96 kg; case 125 kg; the ' +
      'targets blast table (BLAST.mk82*) is calibrated to these',
  },
  'CBU-97': {
    source: 'wikiCbu97',
    confidence: 'estimate',
    note: 'PLAN §6.9 later weapon: the dispenser is flown, its BLU-108s are not (lands inert)',
  },
  M151: {
    source: 'wikiHydra',
    confidence: 'approximate',
    note:
      '2.3 lb (1.04 kg) Comp B-4 × ≈1.1 = 1.15 kg TNT; 4.2 kg warhead with fuze, ≈2.7 kg of ' +
      'fragmenting case',
  },
  M156: {
    source: 'wikiHydra',
    confidence: 'estimate',
    note: '≈1 kg of white phosphorus with a small burster (≈0.1 kg Comp B); thin case',
  },
  'AGM-65D/H': {
    source: 'wikiAgm65',
    confidence: 'estimate',
    note:
      'WDU-20/B 57 kg shaped charge (PLAN §19): ≈35 kg fill; the jet defeats any tank ' +
      '(≈1,000 mm RHA assumed). The guided module may own these numbers (data/guided.ts)',
  },
  'AGM-65G/K': {
    source: 'wikiAgm65',
    confidence: 'estimate',
    note: 'WDU-24/B 136 kg penetrating blast warhead (PLAN §19): ≈40 kg fill, delayed fuze',
  },
};

/**
 * Bomb fuzes (PLAN §6.5): the profile sets NOSE (instantaneous), TAIL (a short delay) or N/T
 * (both armed: the nose functions first). A delayed burst on the ground happens after the bomb
 * has buried itself (a metre or two in soil), which sends part of the energy into the crater and
 * stops most fragments; in water it bursts under the surface.
 */
export const FUZE = {
  /** Delay of the tail fuze, s. */
  tailDelay: 0.025,
  /** A delayed burst in the ground: share of the air blast (TNT equivalent) that acts above it. */
  buriedBlast: 0.6,
  /** …and share of the fragmenting case whose fragments get out of the ground. */
  buriedFragments: 0.25,
  /** A delayed burst under water: share of the air blast; no fragments get out. */
  underwaterBlast: 0.3,
} as const;

export const FUZE_NOTES: Record<keyof typeof FUZE, SourceNote> = {
  tailDelay: {
    source: 'fmu139',
    confidence: 'approximate',
    note: 'FMU-139 / M905 short-delay settings (10–60 ms)',
  },
  buriedBlast: {
    source: 'ufc334002',
    confidence: 'estimate',
    note: 'shallow-buried burst: a large part of the energy goes into cratering',
  },
  buriedFragments: { source: 'plan', confidence: 'estimate' },
  underwaterBlast: { source: 'plan', confidence: 'estimate' },
};

/**
 * Safe escape (PLAN §6.5): a release is flagged when the aircraft is inside the fragment
 * envelope of its own weapon when it detonates. The envelope is the distance at which the
 * expected number of HAZARDOUS fragments (those still carrying hazardousEnergy) striking the
 * aircraft's presented area falls to hitProbability. Fragments follow the targets module's model
 * (Mott masses, Gurney speed, drag; half of them go into the ground). For the Mk 82 this gives
 * ≈350 m (see the test).
 */
export const SAFE_ESCAPE = {
  /** Kinetic energy of a hazardous fragment, J (58 ft·lbf). */
  hazardousEnergy: 58 * FT * LBF,
  /** The A-10's mean presented area to fragments from below and the side, m². */
  presentedArea: 30,
  /** Expected hazardous hits accepted at the envelope edge (1 in 100, a combat risk level). */
  hitProbability: 0.01,
} as const;

export const SAFE_ESCAPE_NOTES: Record<keyof typeof SAFE_ESCAPE, SourceNote> = {
  hazardousEnergy: {
    source: 'dod605509',
    confidence: 'confirmed',
    note: 'DoD 6055.09-M: a hazardous fragment has 58 ft-lb (79 J) of kinetic energy',
  },
  presentedArea: { source: 'plan', confidence: 'estimate', note: 'A-10 planform 47 m² wing' },
  hitProbability: {
    source: 'plan',
    confidence: 'estimate',
    note: 'combat risk 1 %; peacetime safe-escape criteria use 0.1 % (envelope ≈540 m for a Mk 82)',
  },
};

/**
 * A jettisoned rack, pod or launcher tumbles: its drag area is half the broadside drag of a
 * cylinder of its length and diameter (Cd ≈ 1.2 broadside, small end-on), averaged over attitudes.
 */
export const TUMBLE = {
  /** Broadside drag coefficient of a cylinder, on length × diameter. */
  broadsideCd: 1.2,
  /** Average share of the broadside drag while tumbling. */
  meanShare: 0.5,
} as const;

export const TUMBLE_NOTES: Record<keyof typeof TUMBLE, SourceNote> = {
  broadsideCd: { source: 'hoernerDrag', confidence: 'approximate', note: 'Hoerner ch. 3' },
  meanShare: { source: 'plan', confidence: 'estimate' },
};

/** Store bodies in flight (PLAN §14). */
export const STORE_BODY = {
  /** A body still flying this long after release is removed, s. */
  maxLifetime: 180,
  /** Bodies kept ready for reuse (more are made only if more fly at once). */
  poolSize: 32,
  /**
   * Step of the fire-control predictor for bombs and dispensers, s: within 0.05 m (low drag) and
   * 0.15 m (high drag) of the live 1/120 s integration over CCIP dives of 10–60° and level
   * releases from 500 to 20,000 ft (stores test).
   */
  predictorStepBomb: 1 / 8,
  /** …for rockets, s: within 0.15 m (the burn is integrated in 1/60 s pieces at any step). */
  predictorStepRocket: 1 / 15,
} as const;

export const STORE_BODY_NOTES: Record<keyof typeof STORE_BODY, SourceNote> = {
  maxLifetime: { source: 'plan', confidence: 'estimate', note: 'design' },
  poolSize: { source: 'plan', confidence: 'estimate', note: 'design (PLAN §14: no allocation)' },
  predictorStepBomb: {
    source: 'plan',
    confidence: 'estimate',
    note: 'design: within 0.5 m of the live SIM_DT integration (measured ≤ 0.15 m)',
  },
  predictorStepRocket: {
    source: 'plan',
    confidence: 'estimate',
    note: 'design: within 0.5 m of the live SIM_DT integration (measured ≤ 0.15 m)',
  },
};
