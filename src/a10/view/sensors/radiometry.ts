/**
 * The infrared picture's physics, as pure functions (sensorShaders.ts transcribes the per-pixel
 * ones; the tests and the sandbox call these).
 *
 * WHAT LOOKS HOT IS WHAT THE SEEKERS CAN LOCK (PLAN §8). The picture follows the contrast model of
 * the sensors module (core/sensors/contrast.ts, numbers in data/sensors.ts CONTRAST), which itself
 * mirrors how the thermal hooks draw:
 *
 *   raw scale  the terrain and trees draw their thermal level t as it is (`uThermalParams.z` = 1
 *              during the sensor render), the vehicles `0.3 + K / 75` (K = kelvin above the local
 *              air: `uThermalLevel` = CONTRAST.ambientLevel, `uThermalGain` = 1 / kelvinPerLevel)
 *              and the particles their heat on top of 0.3 — one scale: K = (r − 0.3) · 75;
 *   haze       f = 1 − exp(−(ρ·d)²), ρ from the visibility and the SENSOR's height above the haze
 *              floor (the environment's law), d the distance of each pixel's surface (depth
 *              buffer); the picture shows K·(1 − 0.7 f) + K_sky·0.7 f — the terrain shader's own
 *              law (both ends pulled toward the cold sky level), applied here to every surface
 *              alike, the vehicles included (their material draws no haze in thermal mode);
 *   sky        the hazed horizon's cold level K_sky = (0.12 − 0.3) · 75 at the horizon, colder
 *              toward the zenith by Bliss's slant-path law (this module's addition: no seeker
 *              looks at the sky).
 *
 * Hot things (fires, exhausts) saturate the raw scale at about +52 K, as a real imager saturates.
 */
import { CONTRAST } from '../../data/sensors';
import { hazeAmount } from '../environment/haze';
import { RADIOMETRY } from './sensorViewData';

/** Terrain thermal gain during an infrared sensor render (its level as the seekers read it). */
export const TERRAIN_THERMAL_GAIN = 1;
/** The vehicles' thermal level of the ambient air during a sensor render. */
export const VEHICLE_THERMAL_LEVEL = CONTRAST.ambientLevel;
/** The vehicles' thermal gain during a sensor render, levels per kelvin. */
export const VEHICLE_THERMAL_GAIN = 1 / CONTRAST.kelvinPerLevel;

/** Kelvin above ambient that a raw thermal level stands for. */
export function levelToKelvin(level: number): number {
  return (level - CONTRAST.ambientLevel) * CONTRAST.kelvinPerLevel;
}

/** Raw thermal level of a surface `kelvin` above ambient. */
export function kelvinToLevel(kelvin: number): number {
  return CONTRAST.ambientLevel + kelvin / CONTRAST.kelvinPerLevel;
}

/** Kelvin of the cold sky level a hazed path tends to. */
export function skyLevelKelvin(): number {
  return levelToKelvin(CONTRAST.skyLevel);
}

/**
 * Haze density of the FogExp2 law (1/m) for a visibility (km) seen from `heightAboveFloor`
 * metres above the haze floor (terrain.minHeight).
 */
export function hazeDensity(visibilityKm: number, heightAboveFloor: number): number {
  const v = Math.max(CONTRAST.minVisibilityKm, visibilityKm) * 1000;
  const depth = Math.sqrt(-Math.log(CONTRAST.visibilityContrast));
  return depth / v / (1 + Math.max(0, heightAboveFloor) / CONTRAST.hazeAltitudeScale);
}

/** Haze factor (0 clear … 1 all haze) at `distance` for a density: 1 − exp(−(ρ·d)²). */
export function hazeFactor(density: number, distance: number): number {
  const x = density * distance;
  return 1 - Math.exp(-x * x);
}

/** What the picture shows of a surface `kelvin` above ambient behind haze `haze` (0..1). */
export function apparentKelvin(kelvin: number, haze: number): number {
  const a = CONTRAST.irHazeShare * haze;
  return kelvin * (1 - a) + skyLevelKelvin() * a;
}

/** Zenith sky temperature relative to the air, K: colder in clear air, warmer in haze. */
export function skyZenithKelvin(visibilityKm: number): number {
  const h = hazeAmount(visibilityKm);
  return RADIOMETRY.skyZenithClear + (RADIOMETRY.skyZenithHazy - RADIOMETRY.skyZenithClear) * h;
}

/**
 * Weight of the zenith's coldness at elevation sine `s` (0 at the horizon, 1 at the zenith):
 * Bliss's slant path, (1 − ε_z)^(1/s − 1).
 */
export function skyZenithWeight(s: number): number {
  if (s <= 1e-3) return 0;
  return (1 - RADIOMETRY.skyZenithEmissivity) ** (1 / Math.min(1, s) - 1);
}

/** Apparent sky temperature at elevation sine `s`, K above ambient. */
export function skyKelvin(s: number, visibilityKm: number): number {
  const horizon = skyLevelKelvin();
  return horizon + skyZenithWeight(s) * (skyZenithKelvin(visibilityKm) - horizon);
}

/** Temperature of the airframe skin above the air at the aircraft (recovery), K. */
export function skinRecoveryK(airspeed: number): number {
  return (RADIOMETRY.recoveryFactor * airspeed * airspeed) / (2 * RADIOMETRY.airCp);
}

/**
 * Sine of the sun's elevation at local time `hours`: the sky's daily arc through due east and
 * west, culminating at CONTRAST.sunCulmination at noon (as the seekers compute it; the
 * environment's light direction follows the moon at night, so it cannot serve here).
 */
export function sunElevationSine(hours: number): number {
  const h = ((hours % 24) + 24) % 24;
  return Math.cos(((h - 12) / 24) * Math.PI * 2) * Math.sin(CONTRAST.sunCulmination);
}

/**
 * Light for a television sensor, 0 (night) … 1 (sun well up), from the sine of the sun's
 * elevation: the seekers' factor (CONTRAST.tvLightLow/High). The picture's photon count scales
 * with it, so a CCD picture is drowned in noise exactly when a TV seeker cannot lock.
 */
export function tvLight(sinSunElevation: number): number {
  const t = Math.min(
    1,
    Math.max(
      0,
      (sinSunElevation - CONTRAST.tvLightLow) / (CONTRAST.tvLightHigh - CONTRAST.tvLightLow),
    ),
  );
  return t * t * (3 - 2 * t);
}
