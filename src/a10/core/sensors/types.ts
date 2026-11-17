/**
 * Sensors contract: targeting pod, Maverick seekers and the laser. Owned by the SENSORS module
 * (core/sensors, wave 2). See docs/a10/ARCHITECTURE.md §4 and PLAN_A10.md §8.
 */
import type { Vector3 } from 'three';

export type TrackMode = 'INR' | 'AREA' | 'POINT';
export type SensorPicture = 'CCD' | 'WHOT' | 'BHOT';

export interface TgpState {
  powered: boolean;
  /** Seconds left before the pod is ready after power-on (0 = ready). */
  warmup: number;
  /** Line of sight, unit vector in the WORLD frame. */
  los: Vector3;
  /** The ground point the pod looks at (when the line of sight meets the ground). */
  point: Vector3;
  pointValid: boolean;
  mode: TrackMode;
  /** Vehicle id in point track, -1 if none. */
  trackedVehicle: number;
  picture: SensorPicture;
  /** Full field of view, rad (current zoom). */
  fov: number;
  /** Field of view setting: wide or narrow. */
  fovSetting: 'WIDE' | 'NARROW';
  /** Electronic zoom factor, 1..n. */
  zoom: number;
  /** The line of sight is masked by the aircraft or beyond the gimbal limits. */
  masked: boolean;
  /** Laser firing. */
  lasing: boolean;
  /** Laser code (4 digits). */
  laserCode: number;
  /** Last laser range, m (0 = none). */
  laserRange: number;

  // ---- wave 2 (ARCHITECTURE §12.5) ----
  /** Line of sight in the aircraft's body frame: azimuth (+ right) and elevation (+ up), rad. */
  gimbalAz: number;
  gimbalEl: number;
  /** The laser is latched on (fires without holding the button). */
  latched: boolean;
  /** Where the laser beam meets a vehicle or the ground while it marks (LGB seekers read it). */
  spot: Vector3;
  spotValid: boolean;
}

export interface MaverickSeekerState {
  /** Station of the missile this seeker belongs to. */
  station: number;
  powered: boolean;
  /** Gyro alignment time left after power-on, s (0 = video available). */
  align: number;
  /** Seeker line of sight, unit vector in the WORLD frame. */
  los: Vector3;
  fov: 'WIDE' | 'NARROW';
  /** Locked on a contrast point. */
  locked: boolean;
  lockedVehicle: number;
  lockPoint: Vector3;
  /** Launch constraints met (in range, inside gimbal limits, locked). */
  inZone: boolean;

  // ---- wave 2 (ARCHITECTURE §12.5) ----
  /** Seeker line of sight in the aircraft's body frame, rad. */
  gimbalAz: number;
  gimbalEl: number;
  /** Contrast of the locked (or gated) object against its background, 0..1. */
  contrast: number;
}

export interface SensorsState {
  tgp: TgpState;
  /** One per Maverick still on a station (the selected one first). */
  mavericks: MaverickSeekerState[];
  /** Index into `mavericks` of the selected missile, -1 when none. */
  selectedMaverick: number;
}
