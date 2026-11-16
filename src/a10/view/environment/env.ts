/**
 * The current lighting and haze, for every view module. Interface FIXED by the foundation
 * (docs/a10/ARCHITECTURE.md §6); the ENVIRONMENT module owns the values and updates them every
 * frame (useFrame priority 0, before other visuals read them — read them at priority ≥ 0 or use
 * last frame's values).
 */
import { Color, Vector3 } from 'three';

export interface A10Environment {
  /** Unit vector toward the sun (or the moon at night), world frame. */
  sunDirection: Vector3;
  /** Colour × intensity of direct sunlight (linear, may exceed 1). */
  sunColor: Color;
  /** Sky colour at the horizon (linear): the haze colour everything fades to. */
  horizonColor: Color;
  /** Sky colour overhead (linear). */
  zenithColor: Color;
  /** Ambient (sky) light colour × intensity (linear). */
  ambientColor: Color;
  /** 0 = night, 1 = full day. */
  daylight: number;
  /** Exponential haze density at the camera, 1/m (fog factor = 1 - exp(-(density·distance)²)). */
  hazeDensity: number;
  /** 0..1 how deep the camera is inside cloud. */
  cloudCover: number;
}

export const a10Env: A10Environment = {
  sunDirection: new Vector3(0.45, 0.75, 0.3).normalize(),
  sunColor: new Color(2.4, 2.25, 2.0),
  horizonColor: new Color(0.62, 0.72, 0.82),
  zenithColor: new Color(0.25, 0.45, 0.8),
  ambientColor: new Color(0.55, 0.62, 0.72),
  daylight: 1,
  hazeDensity: 4.5e-5,
  cloudCover: 0,
};
