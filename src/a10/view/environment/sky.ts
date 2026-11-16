/**
 * The A-10 sky: the carrier's time-of-day model (shared through src/engine), adapted to a land
 * range in haze. Pure and allocation-free: `computeA10Sky(hours, visibilityKm, out)`.
 *
 *   - aerosol haze over land is whiter and greyer than the clean sea-air horizon, so the horizon
 *     (the haze colour everything fades to) moves toward a bright grey as visibility drops;
 *   - haze takes some of the direct sunlight and gives it back as skylight;
 *   - the zenith goes paler and the sun disc softer;
 *   - the light bouncing up from the ground is green-brown farmland, not the sea's blue-grey.
 */
import { Color } from 'three';
import { computeSkyState, luminance, type SkyState } from '../../../engine';
import { hazeAmount } from './haze';

/** Hue of the light reflected by farmland and forest (luminance is kept from the sky model). */
const LAND_BOUNCE = new Color(0.92, 1.0, 0.68);
/** Share of the sea model's hemisphere sky light kept over land. */
const LAND_SKY_FILL = 0.82;
/** How far the horizon goes toward grey in the thickest haze. */
const HAZE_GREY = 0.55;
/** Brightness of the haze grey relative to the horizon's luminance. */
const HAZE_GREY_GAIN = 1.12;

const _grey = new Color();
const _bounce = new Color();

/** Evaluate the A-10 sky for `hours` and a visibility (km) into `out`, and return it. */
export function computeA10Sky(hours: number, visibilityKm: number, out: SkyState): SkyState {
  computeSkyState(hours, out);
  const haze = hazeAmount(visibilityKm);

  // whiter, greyer horizon (the haze colour)
  const l = luminance(out.horizonColor) * HAZE_GREY_GAIN;
  _grey.setRGB(l * 1.0, l * 1.0, l * 1.02);
  out.horizonColor.lerp(_grey, HAZE_GREY * haze);
  // paler zenith
  out.zenithColor.lerp(out.horizonColor, 0.3 * haze);

  // over land, a little less sky fill than the sea model (relief reads in the sun), and in
  // haze the direct light scattered into skylight
  out.lightColor.multiplyScalar(1 - 0.22 * haze);
  out.hemisphereSkyColor.multiplyScalar(LAND_SKY_FILL * (1 + 0.3 * haze));
  out.ambientColor.multiplyScalar(1 + 0.1 * haze);
  out.sunDiscColor.multiplyScalar(1 - 0.45 * haze);
  out.sunHaloColor.multiplyScalar(1 + 0.6 * haze);

  // green-brown bounce from the land, same level as the model's
  const g = luminance(out.hemisphereGroundColor);
  _bounce.copy(LAND_BOUNCE).multiplyScalar(g / luminance(LAND_BOUNCE));
  out.hemisphereGroundColor.copy(_bounce);
  return out;
}
