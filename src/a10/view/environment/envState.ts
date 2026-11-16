/**
 * Environment state shared inside the environment + terrain-view module (and readable by
 * others): what `a10Env` (env.ts, the fixed interface) does not carry. Written once per frame
 * by the environment driver (useFrame priority 0, mounted before every other visual).
 */
import { Color } from 'three';
import type { CloudLayout } from '../../../engine';
import { DEFAULT_VISIBILITY_KM } from './haze';

/**
 * Per-visit overrides for development (the terrain sandbox's sliders): used instead of the
 * flight's world state while not null.
 */
export const environmentOverrides: { timeOfDay: number | null; visibilityKm: number | null } = {
  timeOfDay: null,
  visibilityKm: null,
};

/** What the environment resolved this frame. */
export const envFrame = {
  /** Local time of day, hours. */
  hours: 10.5,
  /** Meteorological visibility, km. */
  visibilityKm: DEFAULT_VISIBILITY_KM,
  /** Clear-air haze density at the camera (before cloud white-out), 1/m. */
  clearDensity: 0,
  /** Height of the haze floor (the valley floor), m above sea level. */
  hazeFloor: 0,
  /** Wind at cloud height, world m/s (x east, z south). */
  cloudWindX: 0,
  cloudWindZ: 0,
};

/** The clock the sky and the clouds run on: sim time, and 0 s steps while paused. */
export const envClock = { time: 0, dt: 0 };

/**
 * The fill lights as three.js applies them (HemisphereLight + AmbientLight), for custom shaders
 * that light like the built-in materials: irradiance = mix(hemiGround, hemiSky, 0.5·n.y + 0.5)
 * + ambient + sunColor·max(n·l, 0), reflected = irradiance · albedo / π.
 */
export const a10Lights = {
  hemiSky: new Color(0.6, 0.66, 0.75),
  hemiGround: new Color(0.15, 0.16, 0.1),
  ambient: new Color(0.1, 0.1, 0.11),
};

/** Whether the post-processing pass draws this frame (the world then renders linear HDR). */
export const postState = { active: false };

/** The cloud layer as drawn, for cloud shadows on the ground (null until the layer exists). */
export const cloudShadowSource: { layout: CloudLayout | null; driftX: number; driftZ: number } = {
  layout: null,
  driftX: 0,
  driftZ: 0,
};
