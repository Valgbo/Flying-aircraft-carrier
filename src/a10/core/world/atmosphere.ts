/**
 * International Standard Atmosphere (troposphere and lower stratosphere), SI units.
 * Owned by the WORLD module. Altitudes are GEOMETRIC metres above sea level; they are converted
 * to geopotential height H = r0·z / (r0 + z) as the standard defines (≈ 1.4 m less at 3 km).
 *
 * An ISA deviation ΔT shifts the whole temperature profile; pressure then follows the
 * hydrostatic equation for that warmer or colder column with the standard sea-level pressure,
 *   p(H) = p0 · (1 − L·H / (T0 + ΔT))^(g0 / (R·L)),
 * so a hot day has lower density at the same height (higher density altitude).
 */
import { ISA } from './params';

const T0 = ISA.seaLevelTemperature;
const P0 = ISA.seaLevelPressure;
const LAPSE = ISA.lapseRate;
const R = ISA.gasConstant;
const GAMMA = ISA.gamma;
const G = ISA.gravity;
const TROPOPAUSE = ISA.tropopause;
const R0 = ISA.earthRadius;
const EXPONENT = G / (R * LAPSE);

/** Sea-level standard density, kg/m³. */
export const SEA_LEVEL_DENSITY = ISA.seaLevelDensity;

/** Geopotential height (m') of a geometric altitude (m). */
export function geopotentialHeight(altitude: number): number {
  return (R0 * altitude) / (R0 + altitude);
}

/** Air temperature, K. `isaDeviation` shifts the whole profile. */
export function temperatureAt(altitude: number, isaDeviation = 0): number {
  const h = Math.min(geopotentialHeight(altitude), TROPOPAUSE);
  return T0 - LAPSE * h + isaDeviation;
}

/** Static pressure, Pa (standard sea-level pressure; see the file comment for ΔT). */
export function pressureAt(altitude: number, isaDeviation = 0): number {
  const h = geopotentialHeight(altitude);
  const t0 = T0 + isaDeviation;
  if (h <= TROPOPAUSE) return P0 * Math.pow(1 - (LAPSE * h) / t0, EXPONENT);
  const pT = P0 * Math.pow(1 - (LAPSE * TROPOPAUSE) / t0, EXPONENT);
  const tT = t0 - LAPSE * TROPOPAUSE;
  return pT * Math.exp((-G * (h - TROPOPAUSE)) / (R * tT));
}

/** Air density, kg/m³. */
export function densityAt(altitude: number, isaDeviation = 0): number {
  return pressureAt(altitude, isaDeviation) / (R * temperatureAt(altitude, isaDeviation));
}

/** Speed of sound, m/s. */
export function speedOfSoundAt(altitude: number, isaDeviation = 0): number {
  return Math.sqrt(GAMMA * R * temperatureAt(altitude, isaDeviation));
}

const A0 = Math.sqrt(GAMMA * R * T0);

/**
 * Calibrated (indicated) airspeed from true airspeed at an altitude, m/s (compressible,
 * subsonic: the impact pressure qc of the flight Mach number gives the CAS that would produce
 * the same qc at sea level).
 */
export function casFromTas(tas: number, altitude: number, isaDeviation = 0): number {
  const a = speedOfSoundAt(altitude, isaDeviation);
  const p = pressureAt(altitude, isaDeviation);
  const mach = tas / a;
  const qc = p * (Math.pow(1 + 0.2 * mach * mach, 3.5) - 1);
  return A0 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
}

/** True airspeed from calibrated airspeed at an altitude, m/s. */
export function tasFromCas(cas: number, altitude: number, isaDeviation = 0): number {
  const qc = P0 * (Math.pow(1 + 0.2 * (cas / A0) * (cas / A0), 3.5) - 1);
  const p = pressureAt(altitude, isaDeviation);
  const mach = Math.sqrt(5 * (Math.pow(qc / p + 1, 2 / 7) - 1));
  return mach * speedOfSoundAt(altitude, isaDeviation);
}
