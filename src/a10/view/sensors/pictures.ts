/**
 * The sensor pictures the displays show (ARCHITECTURE §12.7). OWNED BY THE SENSOR-VIEW MODULE.
 * FOUNDATION STAND-IN (wave 2): no picture yet.
 */
import type { Texture } from 'three';
import type { SensorPicture } from '../../core/sensors/types';

export interface SensorPictureInfo {
  /** The latest picture (a render target's texture). */
  texture: Texture;
  /** The sensor delivers a picture (powered, warmed up or aligned, not masked). */
  valid: boolean;
  /** Full field of view of the picture, rad. */
  fov: number;
  picture: SensorPicture;
}

/** The targeting pod's or the selected Maverick's latest picture, or null when there is none. */
export function getSensorPicture(_sensor: 'TGP' | 'MAV'): SensorPictureInfo | null {
  return null;
}
