/**
 * A-10C airframe and engine reference data (PLAN_A10.md §5 and §19). SI units.
 * Owned by the FLIGHT module; values here are the public figures the flight model is tuned to.
 */
import { FT, KT, LB, LBF } from '../core/units';
import type { SourceNote } from './sources';

export const A10 = {
  length: 16.26,
  span: 17.53,
  height: 4.47,
  wingArea: 47.0,
  /** Mean aerodynamic chord, m (FlightGear JSBSim metrics: 8.11 ft). */
  mac: 8.11 * FT,
  emptyMass: 24959 * LB,
  maxTakeoffMass: 50000 * LB,
  internalFuel: 11000 * LB,
  /** Static thrust per engine (TF34-GE-100A), N. */
  engineThrust: 9065 * LBF,
  engines: 2,
  /** Maximum level speed, clean, sea level, m/s. */
  maxLevelSpeed: 381 * KT,
  /** Never-exceed speed, m/s (indicated). */
  vne: 450 * KT,
  /** Stall speed, clean, at the reference mass, m/s (indicated). */
  stallSpeed: 120 * KT,
  stallReferenceMass: 13600,
  /** Initial climb rate, clean, m/s. */
  climbRate: (6000 * FT) / 60,
  gLimitPositive: 7.33,
  gLimitNegative: -3,
  stations: 11,
  storesCapacity: 16000 * LB,
  /** Flap angles, rad: UP, MVR, DN. */
  flapAngles: [0, (7 * Math.PI) / 180, (20 * Math.PI) / 180] as const,
  /** Full speed-brake split, rad. */
  speedBrakeMax: (80 * Math.PI) / 180,
} as const;

export const A10_NOTES: Record<keyof typeof A10, SourceNote> = {
  length: { source: 'aerospaceweb', confidence: 'confirmed' },
  span: { source: 'aerospaceweb', confidence: 'confirmed' },
  height: { source: 'aerospaceweb', confidence: 'confirmed' },
  wingArea: { source: 'aerospaceweb', confidence: 'confirmed' },
  mac: { source: 'flightgearA10', confidence: 'approximate', note: 'Aeromatic input' },
  emptyMass: { source: 'aerocorner', confidence: 'confirmed' },
  maxTakeoffMass: {
    source: 'aerocorner',
    confidence: 'approximate',
    note: 'sources give 50,000–51,000 lb',
  },
  internalFuel: { source: 'aerocorner', confidence: 'confirmed' },
  engineThrust: { source: 'wikiTf34', confidence: 'confirmed' },
  engines: { source: 'wikiA10', confidence: 'confirmed' },
  maxLevelSpeed: { source: 'aerospaceweb', confidence: 'confirmed' },
  vne: { source: 'wikiA10', confidence: 'approximate' },
  stallSpeed: { source: 'flightgearA10', confidence: 'approximate' },
  stallReferenceMass: { source: 'plan', confidence: 'estimate' },
  climbRate: { source: 'wikiA10', confidence: 'approximate' },
  gLimitPositive: { source: 'aerocorner', confidence: 'approximate' },
  gLimitNegative: { source: 'plan', confidence: 'approximate' },
  stations: { source: 'wikiA10', confidence: 'confirmed' },
  storesCapacity: { source: 'wikiA10', confidence: 'confirmed' },
  flapAngles: { source: 'plan', confidence: 'approximate' },
  speedBrakeMax: { source: 'plan', confidence: 'approximate' },
};
