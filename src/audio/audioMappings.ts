/**
 * Pure parameter mappings of the procedural audio: simulation quantities in, gains (linear),
 * frequencies (Hz) and pan positions (-1 left .. +1 right) out. No Web Audio in here, so the
 * whole file is unit-testable in Node. Every function is bounded, monotonic in its main
 * argument and returns a finite number for any input (NaN / Infinity are treated as 0).
 */
import { clamp, clamp01, smoothstep } from '../utils/math';

/** Widest pan used for a source straight off the listener's side (a little short of hard L/R). */
export const PAN_WIDTH = 0.85;
/** Speed of sound used for the Doppler factor, m/s. */
export const SPEED_OF_SOUND = 340;
/** Per-turbine pitch factor of the fan whine: four engines never sit exactly in tune, so they beat. */
export const TURBINE_DETUNE: readonly number[] = [0.987, 1, 1.011, 0.995];
/** Frequency ratios of the three whine partials (slightly inharmonic, so each engine shimmers). */
export const WHINE_PARTIALS: readonly number[] = [1, 2.003, 2.994];

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/** Volume slider 0..1 -> linear gain (square law: the slider feels even to the ear). */
export function volumeToGain(volume: number): number {
  const v = clamp01(finite(volume));
  return v * v;
}

// ---- turbines ---------------------------------------------------------------------------

/** Gain of the broadband jet roar from fan speed 0..1. A running engine idles at rpm 0.1. */
export function turbineRoarGain(rpm: number): number {
  return 0.8 * Math.pow(clamp01(finite(rpm)), 1.1);
}

/** Low-pass cut-off of the jet roar, Hz: dull at idle, a full-bodied roar at full power. */
export function turbineRoarCutoff(rpm: number): number {
  return 300 + 2400 * Math.pow(clamp01(finite(rpm)), 1.5);
}

/** Fundamental of the fan whine, Hz (before the per-turbine detune). */
export function turbineWhineHz(rpm: number): number {
  return 60 + 840 * clamp01(finite(rpm));
}

/** Gain of the fan whine from fan speed 0..1. */
export function turbineWhineGain(rpm: number): number {
  return 0.07 * Math.pow(clamp01(finite(rpm)), 0.7);
}

/** Gain of the low rumble: only the upper half of the throttle range shakes the air. */
export function turbineRumbleGain(throttle: number): number {
  return 0.55 * smoothstep(0.45, 1, clamp01(finite(throttle)));
}

// ---- placement --------------------------------------------------------------------------

/**
 * Distance attenuation 1 -> 0. Softer than inverse-distance so the ship is still present from
 * a 900 m orbit (0.18) without being deafening on the bridge at 60 m (0.85).
 */
export function distanceGain(distance: number): number {
  const d = Math.max(0, finite(distance));
  return 1 / (1 + Math.pow(d / 250, 1.2));
}

/** Low-pass cut-off for air absorption with distance, Hz (18 kHz close by, 1.2 kHz far away). */
export function distanceCutoff(distance: number): number {
  const d = Math.max(0, finite(distance));
  return clamp(18000 / Math.pow(1 + d / 300, 1.3), 1200, 18000);
}

/** Pan from a bearing in the listener's frame, rad: 0 = dead ahead, +π/2 = off the right ear. */
export function bearingToPan(bearing: number): number {
  return PAN_WIDTH * Math.sin(finite(bearing));
}

/**
 * Pan from a source offset in CAMERA space (+x right, +y up, -z ahead), metres. Uses the full
 * 3D distance, so a source straight above or below the listener sits in the centre.
 */
export function offsetToPan(x: number, y: number, z: number): number {
  const fx = finite(x);
  const len = Math.hypot(fx, finite(y), finite(z));
  return len < 1e-6 ? 0 : (PAN_WIDTH * fx) / len;
}

/**
 * Doppler pitch factor from the radial velocity of a source (m/s, positive = moving away).
 * Clamped so camera cuts cannot produce absurd pitches.
 */
export function dopplerFactor(radialVelocity: number): number {
  const vr = clamp(finite(radialVelocity), -250, 250);
  return clamp(SPEED_OF_SOUND / (SPEED_OF_SOUND + vr), 0.6, 1.6);
}

// ---- wind and sea -----------------------------------------------------------------------

/** Airflow gain from airspeed (m/s); a little louder while the ship pulls or sheds g. */
export function windGain(airspeed: number, gLoad = 1): number {
  const v = clamp01(Math.abs(finite(airspeed)) / 110);
  const buffet = clamp01(Math.abs(finite(gLoad) - 1));
  return 0.5 * Math.pow(v, 1.5) * (1 + 0.35 * buffet);
}

/** Low-pass cut-off of the airflow noise, Hz: the wind gets brighter as it gets faster. */
export function windCutoff(airspeed: number): number {
  return 250 + 2600 * clamp01(Math.abs(finite(airspeed)) / 110);
}

/** Depth 0..1 of the slow buffeting modulation of the airflow, from the g-load. */
export function windBuffetDepth(gLoad: number): number {
  return 0.15 + 0.45 * clamp01(Math.abs(finite(gLoad) - 1) / 1.5);
}

/** Gain of the surf / swell bed from the listener's height above mean sea level, m. */
export function seaBedGain(height: number): number {
  return 0.22 * (1 - smoothstep(25, 200, finite(height)));
}

/** Gain of the spray hiss from the strongest turbine downwash 0..1. */
export function sprayGain(downwash: number): number {
  return 0.3 * Math.pow(clamp01(finite(downwash)), 1.2);
}

// ---- jets -------------------------------------------------------------------------------

/** Overall gain of one jet voice from its engine power 0..1 (an idling jet is still audible). */
export function jetGain(power: number, active: boolean): number {
  if (!active) return 0;
  return 0.4 * (0.12 + 0.88 * Math.pow(clamp01(finite(power)), 1.3));
}

/** Pitch of the jet's engine tone, Hz. */
export function jetToneHz(power: number): number {
  return 140 + 260 * clamp01(finite(power));
}

/** Centre frequency of the jet's exhaust noise, Hz. */
export function jetNoiseHz(power: number): number {
  return 500 + 1700 * clamp01(finite(power));
}

// ---- one-shots --------------------------------------------------------------------------

/** Loudness 0.25..1 of the splashdown from the sink rate at contact, m/s. */
export function splashIntensity(sinkRate: number): number {
  return clamp(0.25 + 0.075 * Math.max(0, finite(sinkRate)), 0.25, 1);
}
