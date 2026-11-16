/**
 * The analytic micro-relief of the ground (shared by the terrain and the generator, which lays
 * road beds on the same natural ground the terrain will show): three octaves of gradient noise
 * at 170, 61 and 23 m, peak ±1.63 m on smooth fields, scaled by (1 + 2.2·roughness) up to ±5.2 m
 * on broken rock. A few metres at 20–200 m wavelengths, so the ground is not flat close up.
 */
import { NOISE2_GRAD_BOUND, hash2, noise2 } from './noise';

/** Lattice spacing (m) and peak amplitude at roughness 0 (m) of each octave. */
export const MICRO_L0 = 170;
export const MICRO_L1 = 61;
export const MICRO_L2 = 23;
export const MICRO_A0 = 1.1;
export const MICRO_A1 = 0.4;
export const MICRO_A2 = 0.13;
const C1 = Math.cos(0.6);
const S1 = Math.sin(0.6);
const C2 = Math.cos(1.3);
const S2 = Math.sin(1.3);
/** Amplitude gain per unit roughness: amplitude × (1 + gain · r), r ∈ [0, 1]. */
export const MICRO_ROUGH_GAIN = 2.2;
/** Peak |micro| at roughness 0 (noise peaks are ≤ 1). */
export const MICRO_PEAK = MICRO_A0 + MICRO_A1 + MICRO_A2;
/** Bound of |∇micro| at roughness 0. */
export const MICRO_GRAD =
  (MICRO_A0 / MICRO_L0 + MICRO_A1 / MICRO_L1 + MICRO_A2 / MICRO_L2) * NOISE2_GRAD_BOUND;

/** The three octave seeds derived from the world's noise seed. */
export interface MicroSeeds {
  s0: number;
  s1: number;
  s2: number;
}

export function microSeeds(noiseSeed: number): MicroSeeds {
  return { s0: hash2(1, 0, noiseSeed) | 0, s1: hash2(2, 0, noiseSeed) | 0, s2: hash2(3, 0, noiseSeed) | 0 };
}

/** Micro-relief at (x, z) before the roughness gain, m (≈ ±MICRO_PEAK). */
export function microRelief(x: number, z: number, s0: number, s1: number, s2: number): number {
  const a = noise2(x / MICRO_L0, z / MICRO_L0, s0);
  const b = noise2((C1 * x - S1 * z) / MICRO_L1, (S1 * x + C1 * z) / MICRO_L1, s1);
  const c = noise2((C2 * x - S2 * z) / MICRO_L2, (S2 * x + C2 * z) / MICRO_L2, s2);
  return MICRO_A0 * a + MICRO_A1 * b + MICRO_A2 * c;
}
