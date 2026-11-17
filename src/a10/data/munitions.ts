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
 */
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
    length: 2.9,
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
  source: 'plan',
  confidence: 'estimate',
  note: 'frontal area × typical store drag coefficient (Hoerner, Fluid-Dynamic Drag, ch. 13)',
};
const MAVERICK_SIZE: SourceNote = {
  source: 'designationSystems',
  confidence: 'confirmed',
  note: '2.49 m × 0.305 m',
};
const MK82_SIZE: SourceNote = {
  source: 'plan',
  confidence: 'confirmed',
  note: 'Mk 82: 2.21 m × 0.273 m (Wikipedia, Mark 82 bomb)',
};
const LAU131_NOTE: SourceNote = {
  source: 'gdotsHydra',
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
    mass: { source: 'plan', confidence: 'confirmed', note: '531 lb (Wikipedia, Mark 82 bomb)' },
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
      source: 'plan',
      confidence: 'approximate',
      note: 'Mk 82 body + guidance kit: sources give 510–611 lb; 611 lb taken',
    },
    dragArea: DRAG_ESTIMATE,
    size: { source: 'plan', confidence: 'approximate', note: '3.27 m long (Wikipedia, GBU-12)' },
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
      source: 'plan',
      confidence: 'approximate',
      note: 'two-band pod: 461 lb, 2.9 m (AN Equipment Forecast, 2002)',
    },
    dragArea: DRAG_ESTIMATE,
    size: POD_SIZE,
  },
  'AIM-9M': {
    mass: {
      source: 'flightgearA10',
      confidence: 'approximate',
      note: '185–191 lb (FlightGear payload file cites CNATRA P-825)',
    },
    dragArea: DRAG_ESTIMATE,
    size: { source: 'plan', confidence: 'confirmed', note: '2.87 m × 0.127 m (Wikipedia, AIM-9)' },
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
