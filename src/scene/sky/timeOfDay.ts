/**
 * Time-of-day model — pure functions from the hour of the day (0..24) to everything the sky,
 * the lights and the clouds need: where the sun and the moon are, how much daylight there is
 * and which colours go with it. No scene objects, no global state: `World` evaluates it when
 * the time-of-day setting changes and copies the result into the lights, the sky dome and
 * `sim.env`.
 *
 * Geometry (world frame: +X east, +Y up, +Z south):
 *   - the sun rises due east at 06:00, culminates 62° above the southern horizon at noon and
 *     sets due west at 18:00;
 *   - the moon runs roughly opposite on a slightly lower arc, about 40 minutes late.
 *
 * Light hand-over. Only one directional light exists (the "dominant" body). Direct sunlight
 * dies out shortly after sunset and moonlight only starts once the sky is darker still, so
 * there is a short window in which the scene is lit by skylight alone. The dominant light
 * swaps inside that window — its direction jumps while its intensity is exactly zero, so
 * nothing pops.
 *
 * Colours are linear-sRGB and scene-referred (they may exceed 1). The palettes are keyed on
 * the sun's elevation and were tuned through the ACES tone mapper the app renders with, whose
 * toe crushes dark values: night levels are therefore higher than a physical model would give
 * ("exposure-adapted" night, so the ship stays readable).
 */
import { Color, Vector3 } from 'three';
import { DEG2RAD, RAD2DEG, TAU, clamp, lerp, smoothstep } from '../../utils/math';

/** Elevation of the sun at local noon, degrees (it culminates due south = world +Z). */
export const SUN_CULMINATION_DEG = 62;
/** Elevation of the moon when it culminates, degrees. */
export const MOON_CULMINATION_DEG = 54;
/** The moon culminates this long after midnight, hours. */
export const MOON_LAG_HOURS = 0.65;

/** Angular radius of the discs as drawn (a little larger than life, as skies in games are). */
export const SUN_ANGULAR_RADIUS = 0.8 * DEG2RAD;
export const MOON_ANGULAR_RADIUS = 1.15 * DEG2RAD;

/** sin(sun elevation) below which no direct sunlight is left (sun ≈ 2.6° under the horizon). */
const SUNLIGHT_END = -0.045;
/** sin(sun elevation) below which moonlight starts to fade in (sun ≈ 4° under the horizon). */
const MOONLIGHT_START = -0.07;
/**
 * sin(sun elevation) at which the dominant light swaps between sun and moon. It lies inside
 * the window where both are dark.
 */
export const HANDOVER_SUN_Y = (SUNLIGHT_END + MOONLIGHT_START) / 2;

/** Direct sunlight above the atmosphere; extinction (below) tints and dims it toward the horizon. */
const SUN_INTENSITY = 2.7;
/** Per-channel optical depth of one air mass: blue is scattered out first, red last. */
const EXTINCTION_R = 0.03;
const EXTINCTION_G = 0.058;
const EXTINCTION_B = 0.115;
/** Colour × intensity of full moonlight: cool and dim. */
const MOONLIGHT_R = 0.3;
const MOONLIGHT_G = 0.4;
const MOONLIGHT_B = 0.66;

/** Share of the direct sunlight a cloud sends back toward the viewer (its albedo / π). */
const CLOUD_SUN_RESPONSE = 0.29;
/** The same for moonlight — lower, or moonlit cumulus would outshine the night sky. */
const CLOUD_MOON_RESPONSE = 0.14;
/** Share of the skylight that is left on a cloud surface in full direct light. */
const CLOUD_LIT_AMBIENT = 0.55;

/** [sun elevation in degrees, r, g, b] — ascending elevation, linear RGB. */
type ColorKey = readonly [elevationDeg: number, r: number, g: number, b: number];
/** [sun elevation in degrees, value] — ascending elevation. */
type ScalarKey = readonly [elevationDeg: number, value: number];

/** Sky colour overhead. */
const ZENITH_KEYS: readonly ColorKey[] = [
  [-18, 0.01, 0.017, 0.045],
  [-12, 0.013, 0.024, 0.065],
  [-6, 0.022, 0.05, 0.14],
  [-3, 0.034, 0.08, 0.215],
  [0, 0.05, 0.125, 0.33],
  [3, 0.06, 0.165, 0.42],
  [8, 0.06, 0.195, 0.5],
  [16, 0.052, 0.205, 0.545],
  [30, 0.047, 0.208, 0.55],
  [62, 0.043, 0.2, 0.55],
];

/** Sky colour at the horizon, averaged over all azimuths (it is also the fog colour). */
const HORIZON_KEYS: readonly ColorKey[] = [
  [-18, 0.026, 0.042, 0.09],
  [-12, 0.04, 0.055, 0.11],
  [-6, 0.15, 0.125, 0.18],
  [-3, 0.33, 0.235, 0.235],
  [0, 0.52, 0.36, 0.28],
  [3, 0.62, 0.48, 0.38],
  [8, 0.63, 0.59, 0.55],
  [16, 0.52, 0.62, 0.72],
  [30, 0.42, 0.585, 0.755],
  [62, 0.4, 0.58, 0.77],
];

/** Extra colour of the band along the horizon toward the sun (sunrise / sunset / afterglow). */
const HORIZON_GLOW_KEYS: readonly ColorKey[] = [
  [-14, 0, 0, 0],
  [-9, 0.16, 0.05, 0.03],
  [-4, 0.58, 0.2, 0.06],
  [0, 0.78, 0.31, 0.07],
  [4, 0.66, 0.33, 0.11],
  [10, 0.36, 0.24, 0.14],
  [24, 0, 0, 0],
];

/** Luminance of the hemisphere light's sky colour (what an upward-facing surface receives). */
const HEMISPHERE_SKY_LEVEL: readonly ScalarKey[] = [
  [-18, 0.22],
  [-8, 0.24],
  [-3, 0.33],
  [0, 0.42],
  [6, 0.55],
  [15, 0.62],
  [62, 0.66],
];

/** Luminance of the hemisphere light's ground colour (light coming back up from the sea). */
const HEMISPHERE_GROUND_LEVEL: readonly ScalarKey[] = [
  [-18, 0.06],
  [-8, 0.065],
  [-3, 0.08],
  [0, 0.1],
  [6, 0.13],
  [15, 0.15],
  [62, 0.16],
];

/**
 * Luminance of the flat ambient fill. It is HIGHER at night than by day: with no bounce light
 * to speak of, this is what keeps the shaded side and the underside of the hull navy grey
 * instead of black.
 */
const AMBIENT_LEVEL: readonly ScalarKey[] = [
  [-18, 0.2],
  [-8, 0.19],
  [-3, 0.16],
  [0, 0.13],
  [6, 0.11],
  [15, 0.1],
  [62, 0.1],
];

/** Luminance of the skylight that fills the shaded parts of the clouds. */
const CLOUD_AMBIENT_LEVEL: readonly ScalarKey[] = [
  [-18, 0.05],
  [-8, 0.07],
  [-3, 0.16],
  [0, 0.26],
  [6, 0.36],
  [15, 0.42],
  [62, 0.44],
];

/** Everything the renderer needs to know about one moment of the day. */
export interface SkyState {
  /** Hour of the day this state describes, wrapped to [0, 24). */
  hours: number;
  /** Unit vector from the scene toward the sun. */
  sunDirection: Vector3;
  /** Unit vector from the scene toward the moon. */
  moonDirection: Vector3;
  /** Elevation of the sun above the horizon, degrees (negative while it is below). */
  sunElevationDeg: number;
  /** 0 = deep night … 1 = full day, with smooth twilight in between. */
  daylight: number;
  /** True while the sun is the dominant (shadow-casting) light, false while the moon is. */
  sunIsDominant: boolean;
  /** Unit vector from the scene toward the dominant light. */
  lightDirection: Vector3;
  /** Colour × intensity of the dominant light. */
  lightColor: Color;
  /** Sky colour at the horizon (also the clear-air fog colour). */
  horizonColor: Color;
  /** Sky colour overhead. */
  zenithColor: Color;
  /** Hemisphere light: colour × intensity arriving from above. */
  hemisphereSkyColor: Color;
  /** Hemisphere light: colour × intensity arriving from below (the sea). */
  hemisphereGroundColor: Color;
  /** Flat ambient fill, colour × intensity. */
  ambientColor: Color;
  /** HDR radiance of the sun disc (well above 1, so it blooms). */
  sunDiscColor: Color;
  /** Colour × strength of the forward-scatter halo around the sun. */
  sunHaloColor: Color;
  /** Colour × strength of the warm band along the horizon toward the sun. */
  horizonGlowColor: Color;
  /** Radiance of the moon disc. */
  moonDiscColor: Color;
  /** 0..1 — how visible the stars are. */
  starVisibility: number;
  /** Cloud colour where the dominant light hits it. */
  cloudLitColor: Color;
  /** Cloud colour in its own shade and at its base (skylight only). */
  cloudShadeColor: Color;
}

export function createSkyState(): SkyState {
  return {
    hours: 0,
    sunDirection: new Vector3(0, 1, 0),
    moonDirection: new Vector3(0, -1, 0),
    sunElevationDeg: 90,
    daylight: 1,
    sunIsDominant: true,
    lightDirection: new Vector3(0, 1, 0),
    lightColor: new Color(1, 1, 1),
    horizonColor: new Color(1, 1, 1),
    zenithColor: new Color(1, 1, 1),
    hemisphereSkyColor: new Color(1, 1, 1),
    hemisphereGroundColor: new Color(0, 0, 0),
    ambientColor: new Color(0, 0, 0),
    sunDiscColor: new Color(1, 1, 1),
    sunHaloColor: new Color(0, 0, 0),
    horizonGlowColor: new Color(0, 0, 0),
    moonDiscColor: new Color(0, 0, 0),
    starVisibility: 0,
    cloudLitColor: new Color(1, 1, 1),
    cloudShadeColor: new Color(1, 1, 1),
  };
}

/** Wrap any hour value into [0, 24). */
export function wrapHours(hours: number): number {
  const h = hours % 24;
  return h < 0 ? h + 24 : h;
}

/**
 * Point on a daily arc: a great circle through due east and due west that reaches
 * `culminationDeg` above the southern horizon when `hourAngle` (radians) is zero.
 */
function arcDirection(hourAngle: number, culminationDeg: number, out: Vector3): Vector3 {
  const c = culminationDeg * DEG2RAD;
  const ch = Math.cos(hourAngle);
  return out.set(-Math.sin(hourAngle), ch * Math.sin(c), ch * Math.cos(c));
}

/** Unit vector toward the sun at the given hour. */
export function sunDirectionAt(hours: number, out: Vector3): Vector3 {
  return arcDirection(((hours - 12) / 24) * TAU, SUN_CULMINATION_DEG, out);
}

/** Unit vector toward the moon at the given hour. */
export function moonDirectionAt(hours: number, out: Vector3): Vector3 {
  return arcDirection(((hours - 24 - MOON_LAG_HOURS) / 24) * TAU, MOON_CULMINATION_DEG, out);
}

/** Daylight factor from sin(sun elevation): 0 below ≈ -9°, 1 above ≈ +9°. */
export function daylightFromSunY(sunY: number): number {
  return smoothstep(-0.16, 0.16, sunY);
}

/** Daylight factor (0..1) at the given hour. */
export function daylightAt(hours: number): number {
  return daylightFromSunY(
    Math.cos(((hours - 12) / 24) * TAU) * Math.sin(SUN_CULMINATION_DEG * DEG2RAD),
  );
}

/** Relative luminance of a linear-sRGB colour. */
export function luminance(color: Color): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

function sampleColor(keys: readonly ColorKey[], x: number, out: Color): Color {
  const last = keys.length - 1;
  if (x <= keys[0][0]) return out.setRGB(keys[0][1], keys[0][2], keys[0][3]);
  if (x >= keys[last][0]) return out.setRGB(keys[last][1], keys[last][2], keys[last][3]);
  let i = 1;
  while (keys[i][0] < x) i++;
  const a = keys[i - 1];
  const b = keys[i];
  const t = (x - a[0]) / (b[0] - a[0]);
  return out.setRGB(lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t));
}

function sampleScalar(keys: readonly ScalarKey[], x: number): number {
  const last = keys.length - 1;
  if (x <= keys[0][0]) return keys[0][1];
  if (x >= keys[last][0]) return keys[last][1];
  let i = 1;
  while (keys[i][0] < x) i++;
  const a = keys[i - 1];
  const b = keys[i];
  return lerp(a[1], b[1], (x - a[0]) / (b[0] - a[0]));
}

/** Pull a colour toward its own grey by `amount` (0 = unchanged, 1 = grey). */
function desaturate(color: Color, amount: number): Color {
  const l = luminance(color);
  color.r = lerp(color.r, l, amount);
  color.g = lerp(color.g, l, amount);
  color.b = lerp(color.b, l, amount);
  return color;
}

/** Rescale a colour to the given luminance, keeping its hue. */
function setLuminance(color: Color, target: number): Color {
  const l = luminance(color);
  return l > 1e-6 ? color.multiplyScalar(target / l) : color.setRGB(target, target, target);
}

/**
 * Fraction of sunlight that survives the atmosphere, per channel, for a sun at
 * sin(elevation) = `sunY`. Uses Rozenberg's optical air mass (≈1 overhead, 40 at the
 * horizon); below the horizon the horizon value is kept.
 */
function sunTransmittance(sunY: number, out: Color): Color {
  const s = Math.max(sunY, 0);
  const airMass = 1 / (s + 0.025 * Math.exp(-11 * s));
  return out.setRGB(
    Math.exp(-EXTINCTION_R * airMass),
    Math.exp(-EXTINCTION_G * airMass),
    Math.exp(-EXTINCTION_B * airMass),
  );
}

const _transmittance = new Color();
const _tint = new Color();

/**
 * Evaluate the model for `hours` (any real number; it wraps) into `out` and return it.
 * Allocation-free.
 */
export function computeSkyState(hours: number, out: SkyState): SkyState {
  const h = wrapHours(hours);
  out.hours = h;
  sunDirectionAt(h, out.sunDirection);
  moonDirectionAt(h, out.moonDirection);
  const sunY = out.sunDirection.y;
  const moonY = out.moonDirection.y;
  const elevation = Math.asin(clamp(sunY, -1, 1)) * RAD2DEG;
  out.sunElevationDeg = elevation;
  out.daylight = daylightFromSunY(sunY);

  sampleColor(ZENITH_KEYS, elevation, out.zenithColor);
  sampleColor(HORIZON_KEYS, elevation, out.horizonColor);
  sampleColor(HORIZON_GLOW_KEYS, elevation, out.horizonGlowColor);

  // ---- direct light: sun and moon cross-fade through darkness ----
  sunTransmittance(sunY, _transmittance);
  const sunlight = SUN_INTENSITY * smoothstep(SUNLIGHT_END, 0.02, sunY);
  const darkness = smoothstep(MOONLIGHT_START, -0.16, sunY);
  const moonlight = darkness * smoothstep(-0.02, 0.14, moonY);
  out.sunIsDominant = sunY > HANDOVER_SUN_Y;
  if (out.sunIsDominant) {
    out.lightDirection.copy(out.sunDirection);
    out.lightColor.copy(_transmittance).multiplyScalar(sunlight);
  } else {
    out.lightDirection.copy(out.moonDirection);
    out.lightColor.setRGB(MOONLIGHT_R, MOONLIGHT_G, MOONLIGHT_B).multiplyScalar(moonlight);
  }

  // ---- skylight: hue from the sky itself, level from the keyed curves ----
  _tint.copy(out.zenithColor).lerp(out.horizonColor, 0.45);
  desaturate(_tint, 0.45);
  setLuminance(out.hemisphereSkyColor.copy(_tint), sampleScalar(HEMISPHERE_SKY_LEVEL, elevation));
  setLuminance(out.ambientColor.copy(_tint), sampleScalar(AMBIENT_LEVEL, elevation));
  out.hemisphereGroundColor.copy(out.zenithColor).lerp(out.horizonColor, 0.25);
  desaturate(out.hemisphereGroundColor, 0.3);
  setLuminance(out.hemisphereGroundColor, sampleScalar(HEMISPHERE_GROUND_LEVEL, elevation));

  // ---- sun and moon as drawn in the sky ----
  const peak = Math.max(_transmittance.r, _transmittance.g, _transmittance.b);
  out.sunDiscColor
    .copy(_transmittance)
    .multiplyScalar(lerp(9, 24, smoothstep(0, 0.45, sunY)) / peak);
  out.sunHaloColor
    .copy(_transmittance)
    .multiplyScalar(
      (lerp(0.75, 0.3, smoothstep(0, 0.5, sunY)) * smoothstep(-0.14, 0.02, sunY)) / peak,
    );
  out.moonDiscColor.setRGB(0.86, 0.9, 1).multiplyScalar(lerp(0.35, 1.7, darkness));
  out.starVisibility = smoothstep(MOONLIGHT_START, -0.21, sunY);

  // ---- clouds: shade = skylight, lit = shade + what the dominant light adds ----
  _tint.copy(out.zenithColor).lerp(out.horizonColor, 0.5);
  desaturate(_tint, 0.55);
  setLuminance(out.cloudShadeColor.copy(_tint), sampleScalar(CLOUD_AMBIENT_LEVEL, elevation));
  // (in full light the skylight share drops, so sunlit cloud is warm white rather than blue-white
  // and stays just under the bloom threshold; with no direct light, lit and shade coincide)
  const skyShare = lerp(1, CLOUD_LIT_AMBIENT, smoothstep(0, 1.2, luminance(out.lightColor)));
  out.cloudLitColor.copy(out.cloudShadeColor).multiplyScalar(skyShare);
  const response = out.sunIsDominant ? CLOUD_SUN_RESPONSE : CLOUD_MOON_RESPONSE;
  out.cloudLitColor.r += out.lightColor.r * response;
  out.cloudLitColor.g += out.lightColor.g * response;
  out.cloudLitColor.b += out.lightColor.b * response;
  return out;
}
