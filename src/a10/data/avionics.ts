/**
 * Fire-control and stores-page reference data (PLAN_A10.md §6.2, §6.4–6.8, §7). SI units.
 * Every number has a SourceNote (data/sources.ts). Owned by the AVIONICS module.
 */
import type { SourceNote } from './sources';
import { DEG, FT } from '../core/units';
import type { DeliveryMode, FuzeOption, ReleaseMode } from '../core/avionics/types';

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

/**
 * The release logic (PLAN_A10.md §6.4–6.7, ARCHITECTURE §12.1): consent and CCRP solving, ripple
 * timing, the Maverick launch hold, the laser code.
 */
export const RELEASE = {
  /** Maverick: the pickle is held this long before the missile leaves the rail, s. */
  mavHoldTime: 1.0,
  /**
   * Consent release: the delay cue sits on the bomb fall line this far above the bottom edge of
   * the HUD glass (seen from the design eye), rad, so it stays visible inside the glass.
   */
  delayCueMargin: 0.5 * DEG,
  /** Longest ray the computer casts to find the ground under the delay cue, m. */
  delayCueMaxRange: 30000,
  /** Release-time solver: a solution is accepted within this along-track error, m. */
  solverTolerance: 0.02,
  /**
   * A warm-started solution within this along-track error is corrected along the known slope
   * without another prediction, m (the error left is second order: millimetres).
   */
  solverLinear: 0.5,
  /** Release-time solver: most predictions in one step. */
  solverMaxIterations: 8,
  /** Largest change of the release time in one solver iteration, s. */
  solverMaxStep: 20,
  /** Longest time to release the CCRP solver looks ahead, s. */
  maxTimeToRelease: 120,
  /** Loft used to measure how far a pull-up throws the store (the solution cue's scale), rad. */
  cueLoftStep: 2 * DEG,
  /** The solution cue's range sensitivity is measured again every this many steps. */
  cueRefreshSteps: 12,
  /**
   * Store predictor ground chords, s: a ballistic arc lies above its chord and sags at most
   * g·T²/8 ≈ 0.3 m below a 0.5 s chord, so a clear chord proves the arc clear.
   */
  storeChordTime: 0.5,
  /** Shortest interval between ripple pulses from bomb racks (ejector cycle), s. */
  minIntervalBomb: 0.05,
  /** Shortest interval between rockets of a ripple (launcher firing interval), s. */
  minIntervalRocket: 0.06,
  /** Default laser code of the pod and of a laser-guided bomb's seeker (PLAN §6.6). */
  laserCode: 1688,
} as const;

export const RELEASE_NOTES: Record<keyof typeof RELEASE, SourceNote> = {
  mavHoldTime: {
    source: 'dcsMaverick',
    confidence: 'approximate',
    note: 'PLAN §6.4: hold the weapon-release button for about a second',
  },
  delayCueMargin: {
    source: 'hoggitHud',
    confidence: 'estimate',
    note: 'CCIP consent release: the delay cue on the bomb fall line at the bottom of the HUD field of view; the margin is a design value',
  },
  delayCueMaxRange: { source: 'plan', confidence: 'estimate', note: 'design: beyond any CCIP solution' },
  solverTolerance: {
    source: 'plan',
    confidence: 'estimate',
    note: 'design: 2 cm along the track, far inside the 5–10 m of PLAN §16',
  },
  solverLinear: { source: 'plan', confidence: 'estimate', note: 'design' },
  solverMaxIterations: { source: 'plan', confidence: 'estimate', note: 'design' },
  solverMaxStep: { source: 'plan', confidence: 'estimate', note: 'design' },
  maxTimeToRelease: {
    source: 'plan',
    confidence: 'estimate',
    note: 'design: 2 minutes at 300 kn is ≈19 km to the release point',
  },
  cueLoftStep: { source: 'plan', confidence: 'estimate', note: 'design' },
  cueRefreshSteps: { source: 'plan', confidence: 'estimate', note: 'design: 10 Hz' },
  storeChordTime: { source: 'plan', confidence: 'estimate', note: 'design (see the comment)' },
  minIntervalBomb: {
    source: 'plan',
    confidence: 'estimate',
    note: 'ejector racks fire in tens of milliseconds; the real DSMS minimum is not public',
  },
  minIntervalRocket: {
    source: 'gdotsHydra',
    confidence: 'estimate',
    note: 'pod ripple fire at about 60 ms between rockets (hobbyist and helicopter descriptions)',
  },
  laserCode: {
    source: 'wikiGbu12',
    confidence: 'approximate',
    note: 'PLAN §19: 1688 by default; codes have a first digit 1–2 and further digits 1–8 (PRF codes)',
  },
};

/**
 * Values the stores page (DSMS) steps through when a profile setting's button is pressed. The
 * cockpit has no keypad entry yet (ARCHITECTURE §12.7: the UFC keys the avionics supports), so
 * each setting cycles through the values pilots use.
 */
export const PROFILE_EDIT = {
  /** Ripple quantity (release pulses). */
  rippleQty: [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14],
  /** Ripple spacing on the ground, m (25 … 500 ft). */
  rippleSpacing: [25 * FT, 50 * FT, 75 * FT, 100 * FT, 150 * FT, 200 * FT, 300 * FT, 500 * FT],
  /** Fuze arming delay, s (FMU-139-class settings). */
  armingTime: [1.1, 2.6, 4, 5.5, 7, 10, 14, 20],
  /** Minimum release height above the target, m (300 … 5,000 ft). */
  minAltitude: [
    300 * FT,
    500 * FT,
    1000 * FT,
    1500 * FT,
    2000 * FT,
    3000 * FT,
    4000 * FT,
    5000 * FT,
  ],
  /** Laser code digits: the first 1–2, the others 1–8 (four digits). */
  laserDigitMin: [1, 1, 1, 1],
  laserDigitMax: [2, 8, 8, 8],
} as const;

export const PROFILE_EDIT_NOTES: Record<keyof typeof PROFILE_EDIT, SourceNote> = {
  rippleQty: { source: 'dcsA10Manual', confidence: 'estimate', note: 'DSMS ripple quantity' },
  rippleSpacing: {
    source: 'dcsA10Manual',
    confidence: 'estimate',
    note: 'DSMS ripple spacing in feet; the FlightGear package defaults to 150 ft',
  },
  armingTime: {
    source: 'dcsA10Manual',
    confidence: 'estimate',
    note: 'FMU-139-class arming delays (2.6–20 s); 1.1 s is the rocket motor burn',
  },
  minAltitude: { source: 'dcsA10Manual', confidence: 'estimate', note: 'DSMS minimum altitude' },
  laserDigitMin: {
    source: 'wikiGbu12',
    confidence: 'approximate',
    note: 'PRF laser codes: first digit 1–2, then 1–8',
  },
  laserDigitMax: {
    source: 'wikiGbu12',
    confidence: 'approximate',
    note: 'PRF laser codes: first digit 1–2, then 1–8',
  },
};

/**
 * Stores that can be released high drag (the Mk-82 AIR's BSU-49 ballute); their high-drag
 * ballistic model is registered as `${store}/HD` (ARCHITECTURE §12.2).
 */
export const HIGH_DRAG_STORES: readonly string[] = ['MK-82AIR'];

/** TAD map ranges the scale buttons step through, nautical miles. */
export const TAD_RANGES_NM: readonly number[] = [5, 10, 20, 40, 80, 160];

export const TAD_RANGES_NOTES: SourceNote = {
  source: 'dcsA10Manual',
  confidence: 'approximate',
  note: 'A-10C TAD display ranges 5–160 nm',
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
  /** Low or high drag at release (Mk-82 AIR: the ballute); default 'LD'. */
  drag?: 'LD' | 'HD';
  /** Laser-guided bombs: the seeker's laser code. */
  laserCode?: number;
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
    drag: 'HD',
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
    laserCode: RELEASE.laserCode,
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
    note: 'retarded (ballute, high-drag) delivery by default: 2.6 s arming, low minimum altitude',
  },
  'GBU-12': {
    source: 'dcsA10Manual',
    confidence: 'estimate',
    note: 'CCRP default (laser-guided, released onto the SPI); laser code 1688',
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
