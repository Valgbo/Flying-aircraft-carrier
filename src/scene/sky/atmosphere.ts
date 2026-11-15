/**
 * Visibility model shared by the world (scene fog, sky white-out) and the cloud layer.
 *
 * The scene uses exponential-squared fog (`FogExp2`): transmittance over a distance x is
 * exp(-(density · x)²). "Visibility" below is the meteorological one — the distance at which
 * contrast has dropped to 2 %.
 *
 *   clear air      → about 28 km (the ocean's distance fade is matched to this)
 *   inside a cloud → about 200 m (white-out)
 *
 * `sim.env.cloudCover` (0..1, written by the cloud layer) moves between the two. Density is
 * interpolated geometrically, which reads as a steady thickening rather than a sudden wall.
 */
import { clamp01 } from '../../utils/math';

/** Visibility on a clear day, m. */
export const CLEAR_VISIBILITY = 28_000;
/** Visibility in the middle of a cloud, m. */
export const CLOUD_VISIBILITY = 200;

/** density · distance at which FogExp2 leaves 2 % contrast. */
const VISIBILITY_OPTICAL_DEPTH = Math.sqrt(-Math.log(0.02));

/** FogExp2 density that gives the requested visibility (m). */
export function fogDensityForVisibility(visibility: number): number {
  return VISIBILITY_OPTICAL_DEPTH / visibility;
}

/** Visibility (m) that a FogExp2 density gives. */
export function visibilityForFogDensity(density: number): number {
  return VISIBILITY_OPTICAL_DEPTH / density;
}

export const CLEAR_FOG_DENSITY = fogDensityForVisibility(CLEAR_VISIBILITY);
export const CLOUD_FOG_DENSITY = fogDensityForVisibility(CLOUD_VISIBILITY);

/** Scene fog density for a cloud cover of 0 (clear air) … 1 (deep inside a cloud). */
export function fogDensityFor(cloudCover: number): number {
  return CLEAR_FOG_DENSITY * Math.pow(CLOUD_FOG_DENSITY / CLEAR_FOG_DENSITY, clamp01(cloudCover));
}

/**
 * Typical length of the path from the camera out of the cloud it is in, m. The fog is local
 * to the cloud, so this — not infinity — is the depth of murk that hides the sky.
 */
const CLOUD_PATH_LENGTH = 1500;

/**
 * 0..1 — how much of the sky (dome, sun, far clouds) is hidden by the cloud the camera is in:
 * the opacity of the cloud's extra fog along a typical path out of it. Exactly 0 in clear air.
 */
export function skyWhiteout(cloudCover: number): number {
  const depth = (fogDensityFor(cloudCover) - CLEAR_FOG_DENSITY) * CLOUD_PATH_LENGTH;
  return 1 - Math.exp(-depth * depth);
}
