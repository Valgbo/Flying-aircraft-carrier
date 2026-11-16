/**
 * The small slice of state the shared sky components read and write, without any app behind
 * it: the carrier passes its `sim.env` / `sim` (which already have these shapes), the A-10
 * passes its own objects. Carrier-free: no store, no sim (src/engine re-exports it).
 */
import { Color, Vector3 } from 'three';

/** The lighting and haze the sky writes every frame and every other visual reads. */
export interface SkyEnv {
  /** Unit vector from the scene toward the dominant light (the sun, or the moon at night). */
  sunDirection: Vector3;
  /** 0 = deep night … 1 = full day. */
  daylight: number;
  /** Colour × intensity of the dominant light (linear, may exceed 1). */
  sunColor: Color;
  /** The haze colour right now (linear): clear-air horizon colour, whiter inside a cloud. */
  horizonColor: Color;
  /** Sky colour overhead (linear). */
  zenithColor: Color;
  /** 0..1: how deep the camera is inside cloud (written by the cloud layer). */
  cloudCover: number;
}

/** A clock for the sky: simulated seconds since the start and this frame's step (0 = time stands still). */
export interface SkyClock {
  time: number;
  dt: number;
}

/** A fresh environment with the carrier's start-up values (a sunny afternoon). */
export function createSkyEnv(): SkyEnv {
  return {
    sunDirection: new Vector3(0.45, 0.62, 0.64).normalize(),
    daylight: 1,
    sunColor: new Color(1.0, 0.95, 0.86).multiplyScalar(2.2),
    horizonColor: new Color('#a9c8e2'),
    zenithColor: new Color('#3d7fc4'),
    cloudCover: 0,
  };
}
