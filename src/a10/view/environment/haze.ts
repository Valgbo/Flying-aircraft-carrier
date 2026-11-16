/**
 * The haze law of the A-10 view. ONE law for everything that fades with distance (terrain,
 * roads, trees, vehicles through scene.fog, clouds, effects):
 *
 *   fog factor = 1 − exp(−(density · distance)²)        (three.js FogExp2)
 *
 * `density` follows the meteorological visibility (sim.world.visibilityKm: 2 % contrast left at
 * that distance) and THINS with the camera's height above the valley floor: haze sits in the
 * boundary layer, so from 3,000 m the ground stays readable much farther out than from a
 * strafing pass, and the range fades into the sky at 40–60 km. Pure functions (unit-tested).
 */
import { fogDensityForVisibility } from '../../../engine';

/** Height over which the haze density halves above the valley floor, m. */
export const HAZE_ALTITUDE_SCALE = 4000;
/** Visibility clamp, km (below this the sky model is not meant to work). */
export const MIN_VISIBILITY_KM = 2;
/** Default visibility before a flight exists (menu, sandbox), km. */
export const DEFAULT_VISIBILITY_KM = 30;

/**
 * Clear-air haze density (FogExp2 law, 1/m) for a visibility and the camera's height above the
 * haze floor (the valley floor).
 */
export function hazeDensityFor(visibilityKm: number, heightAboveFloor: number): number {
  const base = fogDensityForVisibility(Math.max(MIN_VISIBILITY_KM, visibilityKm) * 1000);
  return base / (1 + Math.max(0, heightAboveFloor) / HAZE_ALTITUDE_SCALE);
}

/** Fog factor (0 clear … 1 fully haze) at a distance for a density, the law above. */
export function hazeFactor(density: number, distance: number): number {
  const x = density * distance;
  return 1 - Math.exp(-x * x);
}

/**
 * Distance at which only `contrast` of an object's contrast is left (inverse of the law):
 * e.g. where a target fades to 10 % — useful for sensors and tests.
 */
export function hazeDistanceFor(density: number, contrast: number): number {
  return Math.sqrt(-Math.log(Math.max(1e-6, contrast))) / Math.max(1e-12, density);
}

/**
 * How hazy the day is, 0 (≥ 60 km, crystal clear) … 1 (≤ 6 km, thick haze): drives the whiter
 * horizon, the softer sun and the paler zenith of the A-10 sky.
 */
export function hazeAmount(visibilityKm: number): number {
  const t = (60 - Math.min(60, Math.max(6, visibilityKm))) / 54;
  return t * t * (3 - 2 * t);
}
