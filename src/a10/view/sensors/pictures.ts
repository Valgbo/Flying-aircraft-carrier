/**
 * The sensor pictures the displays show (ARCHITECTURE §12.7). OWNED BY THE SENSOR-VIEW MODULE.
 *
 * `getSensorPicture('TGP' | 'MAV')` returns the targeting pod's or the selected Maverick's
 * latest picture, or null when there is none (no pod carried, no missile selected, no flight).
 * Read it every frame (or whenever `frame` changes): the info object is reused, and `texture`
 * is replaced when the graphics preset changes the picture size.
 *
 * The texture is an 8-bit sRGB render target texture holding the finished picture — gain,
 * level, polarity, noise and the display transfer already applied. Sample it like any colour
 * texture (three.js decodes it to linear) and show it without tone mapping: the screen then
 * shows exactly the grey levels the sensor produced. It is square; `fov` is its full field of
 * view, edge to edge, in both directions.
 *
 * `valid` is true when the sensor delivers live video: powered, warmed up (pod) or aligned
 * (Maverick), and not masked by the aircraft (pod). While it is false the texture shows what the
 * sensor shows then (validity.ts): black without video, a featureless field when masked.
 */
import type { Texture } from 'three';
import type { SensorPicture } from '../../core/sensors/types';
import type { SensorPictureStatus } from './validity';

export type { SensorPictureStatus } from './validity';

export interface SensorPictureInfo {
  /** The latest picture (a render target's texture). */
  texture: Texture;
  /** The sensor delivers a picture (powered, warmed up or aligned, not masked). */
  valid: boolean;
  /** Full field of view of the picture, rad. */
  fov: number;
  picture: SensorPicture;

  // ---- added by the sensor-view module ----
  /** Why the picture is (not) valid. */
  status: SensorPictureStatus;
  /** Pictures rendered so far: changes each time the texture gets a new picture. */
  frame: number;
  /** Sim time of the latest picture, s. */
  time: number;
  /** Picture size (pixels, square) and the detector pixels across it (≤ size: blur). */
  size: number;
  effectivePixels: number;
  /** The automatic gain control has settled since the last mode or power change. */
  agcSettled: boolean;
}

export type SensorName = 'TGP' | 'MAV';

const published: Record<SensorName, SensorPictureInfo | null> = { TGP: null, MAV: null };

/** The targeting pod's or the selected Maverick's latest picture, or null when there is none. */
export function getSensorPicture(sensor: SensorName): SensorPictureInfo | null {
  return published[sensor];
}

/** The sensor-view renderer only: publish (or withdraw) a picture. */
export function publishSensorPicture(sensor: SensorName, info: SensorPictureInfo | null): void {
  published[sensor] = info;
}
