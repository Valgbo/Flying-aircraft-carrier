/**
 * Fire-control and stores-page reference data (PLAN_A10.md §6.2, §6.5, §7). SI units.
 * Every number has a SourceNote (data/sources.ts). Owned by the AVIONICS module; it lives in
 * core/avionics because the avionics module owns no file under data/ (see the module report).
 */
import type { SourceNote } from '../../data/sources';
import { FT } from '../units';
import type { DeliveryMode, FuzeOption, ReleaseMode } from './types';

export const FIRE_CONTROL = {
  /**
   * Gun minimum-range cue, m (2,000 ft slant range): inside it the reticle flashes. It stands for
   * the clearance a 30 mm strafing pass needs from its own ricochets and fragments, and from the
   * ground, during the pull-off (the usual A-10 training cease-fire range).
   */
  gunMinRange: 2000 * FT,
  /** Full scale of the CCIP gun reticle's analog range bar, m (12,000 ft); `tooFar` beyond it. */
  gunMaxRange: 12000 * FT,
  /** Longest time of flight the gun solution searches, s: live rounds are removed after 8 s. */
  gunMaxTimeOfFlight: 8,
  /** Radar altimeter operating limit, m above the ground (5,000 ft): no RADAR source above it. */
  radarAltimeterMax: 5000 * FT,
  /**
   * The predictor may integrate with a coarser step than the live rounds only while it stays
   * within this angle of them at 1,220 m (half of the 0.2 mrad the brief allows), rad.
   */
  predictorTolerance: 0.1e-3,
  /** Candidate predictor steps, coarsest first, s (the calibration picks the first that passes). */
  predictorSteps: [1 / 15, 1 / 20, 1 / 24, 1 / 30, 1 / 40, 1 / 60, 1 / 120],
  /** Length in time of the chords tested against the ground before refining, s. */
  groundChordTime: 0.125,
  /** Longest time of fall a store solution searches, s. */
  storeMaxTimeOfFall: 60,
} as const;

export const FIRE_CONTROL_NOTES: Record<keyof typeof FIRE_CONTROL, SourceNote> = {
  gunMinRange: {
    source: 'plan',
    confidence: 'estimate',
    note: 'A-10 30 mm cease-fire range in training (ricochet/fragment and pull-out clearance); the real cue logic is not public',
  },
  gunMaxRange: {
    source: 'hoggitHud',
    confidence: 'approximate',
    note: 'the gun reticle range bar reads to 12,000 ft (also the HUD module GUN_SIGHT.rangeBarFull)',
  },
  gunMaxTimeOfFlight: {
    source: 'plan',
    confidence: 'estimate',
    note: 'PLAN §14: live rounds are capped at 8 s, so no pipper is shown for a longer flight',
  },
  radarAltimeterMax: {
    source: 'hoggitHud',
    confidence: 'approximate',
    note: 'the HUD shows radar altitude below 5,000 ft AGL (radar altimeter range)',
  },
  predictorTolerance: {
    source: 'plan',
    confidence: 'estimate',
    note: 'design: half the 0.2 mrad allowed between the predictor and the live-round integrator',
  },
  predictorSteps: { source: 'plan', confidence: 'estimate', note: 'design' },
  groundChordTime: {
    source: 'plan',
    confidence: 'estimate',
    note: 'design: a 1/8 s chord sags 2 cm below a 30 mm trajectory',
  },
  storeMaxTimeOfFall: { source: 'plan', confidence: 'estimate', note: 'design' },
};

/** Which deliveries a store supports, and the defaults of its weapon profile on the DSMS. */
export interface ProfileDefaults {
  /** Name on the DSMS and HUD (≤ 8 characters). */
  name: string;
  /** Delivery modes the store supports; empty for weapons fired from their own page (Maverick). */
  modes: readonly DeliveryMode[];
  release: ReleaseMode;
  rippleQty: number;
  /** Ripple spacing on the ground, m. */
  rippleSpacing: number;
  fuze: FuzeOption;
  /** Minimum release height above the target, m (fuze arming and fragment clearance). */
  minAltitude: number;
  /** Fuze arming time after release, s. */
  armingTime: number;
}

const RIPPLE_75FT = 75 * FT;

/**
 * Default weapon profiles per store type (PLAN_A10.md §6.5). Stores without an entry (pods,
 * racks, the AIM-9M) get no profile. Rocket profiles fire one rocket per press by default.
 */
export const PROFILE_DEFAULTS: Readonly<Record<string, ProfileDefaults>> = {
  'MK-82': {
    name: 'MK82LD',
    modes: ['CCIP', 'CCRP'],
    release: 'SGL',
    rippleQty: 1,
    rippleSpacing: RIPPLE_75FT,
    fuze: 'NOSE',
    minAltitude: 1500 * FT,
    armingTime: 4,
  },
  'MK-82AIR': {
    name: 'MK82AIR',
    modes: ['CCIP', 'CCRP'],
    release: 'SGL',
    rippleQty: 1,
    rippleSpacing: RIPPLE_75FT,
    fuze: 'TAIL',
    minAltitude: 300 * FT,
    armingTime: 2.6,
  },
  'GBU-12': {
    name: 'GBU12',
    modes: ['CCRP', 'CCIP'],
    release: 'SGL',
    rippleQty: 1,
    rippleSpacing: RIPPLE_75FT,
    fuze: 'TAIL',
    minAltitude: 1500 * FT,
    armingTime: 4,
  },
  'CBU-97': {
    name: 'CBU97',
    modes: ['CCRP', 'CCIP'],
    release: 'SGL',
    rippleQty: 1,
    rippleSpacing: RIPPLE_75FT,
    fuze: 'NOSE',
    minAltitude: 1000 * FT,
    armingTime: 1.2,
  },
  'LAU-131-M151': rocket('M151-131'),
  'LAU-131-M156': rocket('M156-131'),
  'LAU-68-M151': rocket('M151-68'),
  'LAU-68-M156': rocket('M156-68'),
  'AGM-65D': maverick('AGM65D'),
  'AGM-65H': maverick('AGM65H'),
  'AGM-65G': maverick('AGM65G'),
  'AGM-65K': maverick('AGM65K'),
};

function rocket(name: string): ProfileDefaults {
  return {
    name,
    modes: ['CCIP'],
    release: 'SGL',
    rippleQty: 1,
    rippleSpacing: 0,
    fuze: 'NOSE',
    minAltitude: 500 * FT,
    armingTime: 1.1,
  };
}

function maverick(name: string): ProfileDefaults {
  return {
    name,
    modes: [],
    release: 'SGL',
    rippleQty: 1,
    rippleSpacing: 0,
    fuze: 'NOSE',
    minAltitude: 0,
    armingTime: 0,
  };
}

export const PROFILE_DEFAULTS_NOTES: Record<string, SourceNote> = {
  'MK-82': {
    source: 'dcsA10Manual',
    confidence: 'estimate',
    note: 'CCIP default; 4.0 s arming (FMU-139 settings run 2.6–20 s); 1,500 ft minimum covers the arming fall in a 30° dive; 75 ft ripple spacing',
  },
  'MK-82AIR': {
    source: 'dcsA10Manual',
    confidence: 'estimate',
    note: 'retarded (ballute) delivery: 2.6 s arming, low minimum altitude',
  },
  'GBU-12': {
    source: 'dcsA10Manual',
    confidence: 'estimate',
    note: 'CCRP default (laser-guided, released onto the SPI)',
  },
  'CBU-97': { source: 'wikiCbu97', confidence: 'estimate', note: 'CCRP default' },
  'LAU-131-M151': {
    source: 'gdotsHydra',
    confidence: 'estimate',
    note: 'rockets: CCIP only; the fuze arms after the ~1.1 s motor burn',
  },
  'LAU-131-M156': { source: 'gdotsHydra', confidence: 'estimate', note: 'as M151' },
  'LAU-68-M151': { source: 'gdotsHydra', confidence: 'estimate', note: 'as LAU-131' },
  'LAU-68-M156': { source: 'gdotsHydra', confidence: 'estimate', note: 'as LAU-131' },
  'AGM-65D': {
    source: 'dcsMaverick',
    confidence: 'approximate',
    note: 'launched from the MAV page in any master mode: no CCIP/CCRP delivery',
  },
  'AGM-65H': { source: 'dcsMaverick', confidence: 'approximate', note: 'as AGM-65D' },
  'AGM-65G': { source: 'dcsMaverick', confidence: 'approximate', note: 'as AGM-65D' },
  'AGM-65K': { source: 'dcsMaverick', confidence: 'approximate', note: 'as AGM-65D' },
};
