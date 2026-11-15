/**
 * CPU copy of the renderer's ACES filmic tone-mapping curve (three.js `ACESFilmicToneMapping`).
 *
 * Why it exists: when the renderer itself tone-maps (post-processing off), three.js applies the
 * scene fog AFTER tone mapping, straight in display space — so the fog colour of built-in
 * materials is shown as it is, while the sky dome, the clouds and the ocean tone-map the
 * horizon colour like every other colour. To keep the fog on the ship indistinguishable from
 * the sky behind it, `World` hands the scene fog the tone-mapped horizon colour in that case.
 */
import type { Color } from 'three';

/** Rational fit of the ACES reference rendering + output transforms (Stephen Hill). */
function rrtAndOdtFit(v: number): number {
  return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
}

function saturate(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Tone-map the linear, scene-referred `color` in place exactly as the renderer's ACES filmic
 * operator does at the given exposure, and return it (linear display-referred, 0..1).
 */
export function acesFilmicToneMap(color: Color, exposure = 1): Color {
  const scale = exposure / 0.6;
  const r = color.r * scale;
  const g = color.g * scale;
  const b = color.b * scale;
  // sRGB → ACES input space, the fitted curve, and back
  const x = rrtAndOdtFit(0.59719 * r + 0.35458 * g + 0.04823 * b);
  const y = rrtAndOdtFit(0.076 * r + 0.90834 * g + 0.01566 * b);
  const z = rrtAndOdtFit(0.0284 * r + 0.13383 * g + 0.83777 * b);
  color.r = saturate(1.60475 * x - 0.53108 * y - 0.07367 * z);
  color.g = saturate(-0.10208 * x + 1.10813 * y - 0.00605 * z);
  color.b = saturate(-0.00327 * x - 0.07276 * y + 1.07602 * z);
  return color;
}
