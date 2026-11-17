/**
 * Sensors contract: targeting pod, Maverick seekers and the laser. Owned by the SENSORS module
 * (core/sensors, wave 2). See docs/a10/ARCHITECTURE.md §4, §12.5 and PLAN_A10.md §6.4, §6.6, §8.
 *
 * Every field the foundation contract declared keeps its name and meaning (the avionics, the
 * HUD, the displays, the guided weapons and the UI read them). Fields added by the sensors module
 * are documented where they are declared; `internal` objects belong to the sensors module alone.
 */
import type { Vector3 } from 'three';
import type { StoreType } from '../weapons/types';

export type TrackMode = 'INR' | 'AREA' | 'POINT';
export type SensorPicture = 'CCD' | 'WHOT' | 'BHOT';
/** The waveband a seeker or picture works in: imaging infrared or television (visible). */
export type SensorBand = 'IR' | 'TV';

/** Why the pod cannot see along its line of sight. */
export type MaskReason = 'NONE' | 'GIMBAL' | 'AIRFRAME';

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

  // ---- added by the sensors module ----
  /** Station the pod hangs on (0 = no pod loaded: nothing works). */
  station: number;
  /** Powered and warmed up: picture, tracking and laser available. */
  ready: boolean;
  /** World position of the pod's optical head (the sensor picture's camera), m. */
  head: Vector3;
  /** Why the pod is masked ('NONE' when it is not). */
  maskReason: MaskReason;
  /** Slant range from the head to `point` (0 when invalid), m. */
  pointRange: number;
  /** Point track lost its target and is coasting on the target's last motion. */
  coasting: boolean;
  /** The slew control moves the line of sight this step (the TGP page is the SOI). */
  slewing: boolean;
  /** Sim time of the last laser range measurement, s (-1 = never): `laserRange` is that old. */
  laserRangeTime: number;
  /** Vehicle the beam met at the last pulse (-1: the ground, trees, or no lasing). */
  spotVehicle: number;
  /** State owned by the sensors module. Other modules must not read it. */
  internal: TgpInternal;
}

/** Per-pod state of the sensors module. */
export interface TgpInternal {
  /** The commanded aim: a ground point (aimValid) or a world direction (aimDir) when none. */
  aim: Vector3;
  aimValid: boolean;
  aimDir: Vector3;
  /** Point track: the target's last seen centre and velocity (for the coast), and coast time left. */
  lastSeen: Vector3;
  lastVelocity: Vector3;
  coastLeft: number;
  /** Coast ends in INR (masked) rather than AREA (lost behind terrain, trees or smoke). */
  coastToInr: boolean;
  /** Seconds the slew has been held at full deflection (acceleration). */
  slewHeld: number;
  /** Steps until the next laser pulse. */
  pulseCountdown: number;
  /** Steps until the next track check. */
  checkCountdown: number;
  /** The pod was ready last step (power-up slaving). */
  wasReady: boolean;
}

export type SeekerMode =
  /** Caged on the missile's axis. */
  | 'BORESIGHT'
  /** Held on a ground point (slewed there, or where a lock or a slave left it). */
  | 'STAB'
  /** Following the SPI. */
  | 'SLAVE'
  /** Locked: tracking `lockedVehicle`. */
  | 'TRACK';

/** Why the last lock attempt failed ('' = none or it succeeded). */
export type LockFailure =
  | ''
  | 'NOT READY'
  | 'NO TARGET'
  | 'TOO SMALL'
  | 'LOW CONTRAST'
  | 'NO LINE OF SIGHT'
  | 'GIMBAL LIMIT';

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

  // ---- added by the sensors module ----
  /** Unique id of this missile's seeker (stable while the missile is on its station). */
  id: number;
  /** The missile: 'AGM-65D', 'AGM-65H', … */
  type: StoreType;
  /** Imaging infrared (D, G) or television (H, K). */
  band: SensorBand;
  /** Place on its station: 0 = the next to leave (only rail 0 can be selected). */
  rail: number;
  /** This is the selected missile (its seeker is the uncaged one). */
  selected: boolean;
  mode: SeekerMode;
  /** Full field of view now, rad. */
  fovAngle: number;
  /** Picture polarity (IR: WHOT / BHOT; TV: CCD). */
  picture: SensorPicture;
  /** Angle between the line of sight and the missile's axis, rad (gimbal limit: MAVERICK.gimbalLimit). */
  offAxis: number;
  /** The line of sight is held at the gimbal limit. */
  atLimit: boolean;
  /** Slant range to the lock point (locked) or the ground along the line of sight, m (0 = none). */
  range: number;
  /** Why the last lock attempt failed. */
  lockFailure: LockFailure;
  /** World position of the seeker window (the picture's camera), m. */
  head: Vector3;
  /** State owned by the sensors module. Other modules must not read it. */
  internal: SeekerInternal;
}

/** Per-seeker state of the sensors module. */
export interface SeekerInternal {
  aim: Vector3;
  aimValid: boolean;
  aimDir: Vector3;
  /** Steps until the next lock check. */
  checkCountdown: number;
}

export interface SensorsState {
  tgp: TgpState;
  /** One per Maverick still on a station (the selected one first). */
  mavericks: MaverickSeekerState[];
  /** Index into `mavericks` of the selected missile, -1 when none. */
  selectedMaverick: number;

  // ---- added by the sensors module ----
  /** Maverick power (EO power, all stations): seekers align for MAVERICK.alignTime after power-on. */
  mavPower: boolean;
  /** Set up from the loadout and the SPI at the first step. */
  initialized: boolean;
  /** State owned by the sensors module. Other modules must not read it. */
  internal: SensorsInternal;
}

/** Module bookkeeping. */
export interface SensorsInternal {
  /** Next seeker id. */
  nextSeekerId: number;
  /** Per station (index = station number): Maverick count · 16 + type code, as last synced. */
  stationKeys: Int32Array;
  /** The pod's station as last synced, and whether the airframe mask must be rebuilt. */
  maskStation: number;
  maskDirty: boolean;
  /** Airframe mask boxes (BODY frame, 6 numbers each: min xyz, max xyz) and how many there are. */
  maskBoxes: Float64Array;
  maskCount: number;
  /** Station the selected missile was on (re-selection after a launch prefers another one). */
  lastSelectedStation: number;
  /** Type of the last selected missile (the next one of the same type is preferred). */
  lastSelectedType: StoreType | null;
  /** slaveRequest.time last acted on (avionics), s. */
  slaveHandled: number;
  /** Seekers by station, rail order (canonical order; `mavericks` is a view with the selected first). */
  byStation: MaverickSeekerState[][];
}
