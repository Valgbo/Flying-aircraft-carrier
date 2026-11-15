/**
 * Ocean wave model shared by the water shader (visual) and buoyancy (physics).
 *
 * CONTRACT: `waveHeightAt(x, z, t)` returns the height (m, relative to mean sea level y = 0) of the
 * water surface at world position (x, z) at simulation time t (seconds, `sim.time`).
 * The ocean shader displaces its surface with the same table (src/scene/ocean/waveExpr.ts turns
 * `WAVES` into GLSL), so the hull visibly sits in the water it floats on. Keep it cheap: it is
 * called many times per physics step.
 *
 * Owned by the ocean module. The physics module only calls `waveHeightAt`.
 *
 * The sea state is a moderate open-ocean one: a long swell plus a wind sea of progressively
 * shorter components, significant wave height ≈ 2.4 m (4·√(Σa²/2)), worst-case crest 1.9 m.
 * Against a 320 m hull with 20 m of freeboard that reads as a big ship in a lively sea, never
 * as a toy in a bathtub. Wavelengths and headings are deliberately non-commensurate so the
 * pattern never visibly repeats, and every component obeys the deep-water dispersion relation,
 * so long waves overtake short ones the way real ones do.
 */

export interface WaveComponent {
  /** Unit direction of travel in the XZ plane. */
  dirX: number;
  dirZ: number;
  /** Crest-to-crest distance, m. */
  wavelength: number;
  /** Height amplitude, m. */
  amplitude: number;
  /**
   * Gerstner steepness 0..1: horizontal sway of the surface as a fraction of the amplitude
   * (1 = the circular orbit of a true trochoid). Sharpens the crests; visual only.
   */
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
  // swell
  wave(14, 203, 0.62, 0.6),
  wave(-24, 131, 0.44, 0.65),
  // wind sea
  wave(41, 86, 0.3, 0.7),
  wave(-7, 57, 0.21, 0.75),
  wave(58, 37, 0.14, 0.8),
  wave(-41, 23.5, 0.09, 0.8),
  wave(22, 15, 0.055, 0.8),
];

const G = 9.81;

/** Angular frequency of a deep-water wave with the given wavelength (rad/s). */
export function waveOmega(wavelength: number): number {
  return Math.sqrt((G * 2 * Math.PI) / wavelength);
}

// Per-component constants, flattened once so the hot loop below is nothing but multiply-adds
// and one sine per component.
const COUNT = WAVES.length;
const KX = new Float64Array(COUNT);
const KZ = new Float64Array(COUNT);
const OMEGA = new Float64Array(COUNT);
const AMPLITUDE = new Float64Array(COUNT);
for (let i = 0; i < COUNT; i++) {
  const w = WAVES[i];
  const k = (2 * Math.PI) / w.wavelength;
  KX[i] = k * w.dirX;
  KZ[i] = k * w.dirZ;
  OMEGA[i] = waveOmega(w.wavelength);
  AMPLITUDE[i] = w.amplitude;
}

export function waveHeightAt(x: number, z: number, t: number): number {
  let h = 0;
  for (let i = 0; i < COUNT; i++) {
    h += AMPLITUDE[i] * Math.sin(KX[i] * x + KZ[i] * z - OMEGA[i] * t);
  }
  return h;
}
