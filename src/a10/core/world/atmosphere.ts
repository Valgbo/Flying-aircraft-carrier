/**
 * International Standard Atmosphere (troposphere and lower stratosphere), SI units.
 * Owned by the WORLD module. Altitudes are geometric metres above sea level.
 */

const T0 = 288.15; // K
const P0 = 101325; // Pa
const RHO0 = 1.225; // kg/m³
const LAPSE = 0.0065; // K/m
const R = 287.05287; // J/(kg·K)
const GAMMA = 1.4;
const G = 9.80665;
const TROPOPAUSE = 11000;

/** Sea-level standard density, kg/m³. */
export const SEA_LEVEL_DENSITY = RHO0;

/** Air temperature, K. `isaDeviation` shifts the whole profile. */
export function temperatureAt(altitude: number, isaDeviation = 0): number {
  const h = Math.min(altitude, TROPOPAUSE);
  return T0 - LAPSE * h + isaDeviation;
}

/** Static pressure, Pa. */
export function pressureAt(altitude: number): number {
  if (altitude <= TROPOPAUSE) {
    return P0 * Math.pow(1 - (LAPSE * altitude) / T0, G / (R * LAPSE));
  }
  const pT = P0 * Math.pow(1 - (LAPSE * TROPOPAUSE) / T0, G / (R * LAPSE));
  const tT = T0 - LAPSE * TROPOPAUSE;
  return pT * Math.exp((-G * (altitude - TROPOPAUSE)) / (R * tT));
}

/** Air density, kg/m³. */
export function densityAt(altitude: number, isaDeviation = 0): number {
  return pressureAt(altitude) / (R * temperatureAt(altitude, isaDeviation));
}

/** Speed of sound, m/s. */
export function speedOfSoundAt(altitude: number, isaDeviation = 0): number {
  return Math.sqrt(GAMMA * R * temperatureAt(altitude, isaDeviation));
}

/** Calibrated (indicated) airspeed from true airspeed at an altitude, m/s (compressible). */
export function casFromTas(tas: number, altitude: number, isaDeviation = 0): number {
  const a = speedOfSoundAt(altitude, isaDeviation);
  const p = pressureAt(altitude);
  const mach = tas / a;
  const qc = p * (Math.pow(1 + 0.2 * mach * mach, 3.5) - 1);
  const a0 = Math.sqrt(GAMMA * R * T0);
  return a0 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
}

/** True airspeed from calibrated airspeed at an altitude, m/s. */
export function tasFromCas(cas: number, altitude: number, isaDeviation = 0): number {
  const a0 = Math.sqrt(GAMMA * R * T0);
  const qc = P0 * (Math.pow(1 + 0.2 * (cas / a0) * (cas / a0), 3.5) - 1);
  const p = pressureAt(altitude);
  const mach = Math.sqrt(5 * (Math.pow(qc / p + 1, 2 / 7) - 1));
  return mach * speedOfSoundAt(altitude, isaDeviation);
}
