/**
 * GAU-8/A Avenger reference data (PLAN_A10.md §6.2 and §19). SI units.
 * Owned by the WEAPONS module.
 */
import { LBF } from '../core/units';
import type { SourceNote } from './sources';

export const GAU8 = {
  /** Rounds per second at full rate (3,900 per minute; fixed rate in the A-10). */
  rate: 3900 / 60,
  /** Seconds from trigger to full rate (≈50 rounds leave in the first second). */
  spinUpTime: 0.46,
  /** Seconds for the barrels to stop after release (no firing during spin-down). */
  spinDownTime: 0.6,
  drumCapacity: 1174,
  typicalLoad: 1150,
  /** Combat mix: API rounds per HEI round. */
  combatMixApiPerHei: 5,
  muzzleVelocity: 1010,
  /** Projectile masses, kg. */
  massApi: 0.395,
  massHei: 0.378,
  massTp: 0.378,
  calibre: 0.03,
  /** Dispersion: diameter of the circle holding 80 % of rounds, rad (5 mil). */
  dispersion80Diameter: 0.005,
  /** Average recoil force at full rate, N (10,000 lbf). */
  recoilForce: 10000 * LBF,
  /** Gun line below the fuselage reference line, rad (≈2°). */
  gunLineDepression: (2 * Math.PI) / 180,
  /** API penetration of steel armour at two published ranges, mm (see penetration fit note). */
  penetration500m: 69,
  penetration1000m: 38,
  barrels: 7,
} as const;

export const GAU8_NOTES: Record<keyof typeof GAU8, SourceNote> = {
  rate: { source: 'wikiGau8', confidence: 'confirmed' },
  spinUpTime: {
    source: 'plan',
    confidence: 'approximate',
    note: 'chosen so ≈50 rounds leave in the first second',
  },
  spinDownTime: { source: 'plan', confidence: 'estimate' },
  drumCapacity: { source: 'wikiGau8', confidence: 'confirmed' },
  typicalLoad: { source: 'wikiGau8', confidence: 'confirmed' },
  combatMixApiPerHei: { source: 'wikiGau8', confidence: 'confirmed' },
  muzzleVelocity: {
    source: 'wikiGau8',
    confidence: 'approximate',
    note: 'sources give 1,010–1,036 m/s',
  },
  massApi: { source: 'wikiGau8', confidence: 'approximate' },
  massHei: { source: 'wikiGau8', confidence: 'approximate' },
  massTp: { source: 'plan', confidence: 'estimate' },
  calibre: { source: 'wikiGau8', confidence: 'confirmed' },
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
    note: 'fitted as P(impact speed) for a round fired from an aircraft at 300 kn (docs/a10/ARCHITECTURE.md §6)',
  },
  penetration1000m: { source: 'fasGau8', confidence: 'approximate' },
  barrels: { source: 'wikiGau8', confidence: 'confirmed' },
};
