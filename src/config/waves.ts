/**
 * Ocean wave model shared by the water shader (visual) and buoyancy (physics).
 *
 * CONTRACT: `waveHeightAt(x, z, t)` returns the height (m, relative to mean sea level y = 0) of the
 * water surface at world position (x, z) at simulation time t (seconds, `sim.time`).
 * The ocean shader must displace its surface consistently with this function so that the hull
 * visibly sits in the water it floats on. Keep it cheap: it is called many times per physics step.
 *
 * Owned by the ocean module. The physics module only calls `waveHeightAt`.
 */

export interface WaveComponent {
  /** Unit direction of travel in the XZ plane. */
  dirX: number;
  dirZ: number;
  /** Crest-to-crest distance, m. */
  wavelength: number;
  /** Height amplitude, m. */
  amplitude: number;
  /** Gerstner steepness 0..1 (horizontal sharpening; visual only). */
  steepness: number;
}

function wave(
  angleDeg: number,
  wavelength: number,
  amplitude: number,
  steepness: number,
): WaveComponent {
  const a = (angleDeg * Math.PI) / 180;
  return { dirX: Math.cos(a), dirZ: Math.sin(a), wavelength, amplitude, steepness };
}

export const WAVES: readonly WaveComponent[] = [
  wave(18, 210, 1.15, 0.5),
  wave(-34, 120, 0.7, 0.45),
  wave(62, 64, 0.34, 0.4),
  wave(-8, 33, 0.16, 0.35),
];

const G = 9.81;

/** Angular frequency of a deep-water wave with the given wavelength (rad/s). */
export function waveOmega(wavelength: number): number {
  return Math.sqrt((G * 2 * Math.PI) / wavelength);
}

export function waveHeightAt(x: number, z: number, t: number): number {
  let h = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    const k = (2 * Math.PI) / w.wavelength;
    h += w.amplitude * Math.sin(k * (w.dirX * x + w.dirZ * z) - waveOmega(w.wavelength) * t);
  }
  return h;
}
