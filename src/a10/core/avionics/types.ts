/**
 * Avionics contract: armament switches, master modes, sensor of interest, and the fire-control
 * solutions the HUD draws. Owned by the AVIONICS module (core/avionics).
 * See docs/a10/ARCHITECTURE.md §4 and PLAN_A10.md §7.
 */
import type { Vector3 } from 'three';

export type MasterArm = 'SAFE' | 'TRAIN' | 'ARM';
/** GUN/PAC switch: SAFE, GUNARM (gun armed, PAC off), ARM (gun armed, PAC on). */
export type GunPacSwitch = 'SAFE' | 'GUNARM' | 'ARM';
export type LaserArm = 'SAFE' | 'TRAIN' | 'ARM';
/** Altitude source for fire control: barometric, DELTA (terrain database), radar altimeter. */
export type AltSource = 'BARO' | 'DELTA' | 'RADAR';
export type MasterMode = 'NAV' | 'GUNS' | 'CCIP' | 'CCRP';
export type Soi = 'HUD' | 'LMFD' | 'RMFD';

/** The gun sight solution, recomputed every step (PLAN_A10.md §6.2, "The sight"). */
export interface GunSolution {
  /** A solution exists (the predicted round reaches the ground within the computed time). */
  valid: boolean;
  /** Predicted impact point of a round fired now, world. */
  impact: Vector3;
  /** Pipper direction relative to the boresight, rad (HUD az + right, el + up). */
  pipperAz: number;
  pipperEl: number;
  /** Straight-line range to the impact point, m. */
  slantRange: number;
  /** Round time of flight to the impact, s. */
  timeOfFlight: number;
  /** Closing inside the minimum range (fragment/ricochet and ground-clearance limit). */
  tooClose: boolean;
  /** Beyond the maximum range the range bar shows. */
  tooFar: boolean;
}

/** A computed bomb / rocket release solution (CCIP or CCRP). */
export interface ReleaseSolution {
  valid: boolean;
  /** CCIP: predicted impact point of a release now. CCRP: the designated target point. */
  impact: Vector3;
  /** Pipper (CCIP) or target (CCRP) direction relative to the boresight, rad. */
  az: number;
  el: number;
  /** Seconds until the computed release (CCRP), or 0 when releasing now (CCIP). */
  timeToRelease: number;
  /** Seconds from release to impact. */
  timeOfFall: number;
  /** Release would be below the minimum (fuze arming / fragment) altitude. */
  belowMinimum: boolean;
  /** The impact point is below the bottom of the HUD glass (CCIP delayed / consent release). */
  belowGlass: boolean;
  /** The release cue: release happens this step (consent held and solution reached). */
  releaseNow: boolean;
}

/** A weapon delivery profile on the stores page (PLAN_A10.md §6.5). */
export interface WeaponProfile {
  id: string;
  /** Store type this profile applies to. */
  store: string;
  mode: 'CCIP' | 'CCRP';
  /** 'SGL' single, 'PRS' pairs, 'RIP SGL', 'RIP PRS'. */
  release: 'SGL' | 'PRS' | 'RIP_SGL' | 'RIP_PRS';
  rippleQty: number;
  /** Ripple spacing on the ground, m. */
  rippleSpacing: number;
  fuze: 'NOSE' | 'TAIL' | 'N/T';
  /** Minimum release altitude, m above target. */
  minAltitude: number;
  /** Fuze arming time, s. */
  armingTime: number;
}

/** Sensor point of interest: the one ground point every sensor and weapon can slave to. */
export interface SpiState {
  valid: boolean;
  position: Vector3;
  source: 'STPT' | 'HUD' | 'TGP' | 'MAV' | 'TAD';
}

export interface SteerPoint {
  id: number;
  name: string;
  position: Vector3;
}

export type MfdPage = 'STAT' | 'DSMS' | 'TGP' | 'MAV' | 'TAD' | 'MSG';

export interface AvionicsState {
  masterArm: MasterArm;
  gunPac: GunPacSwitch;
  laserArm: LaserArm;
  tgpPower: boolean;
  altSource: AltSource;
  masterMode: MasterMode;
  soi: Soi;
  /** Id of the selected weapon profile in the current master mode ('' when none). */
  selectedProfile: string;
  profiles: WeaponProfile[];
  gun: GunSolution;
  release: ReleaseSolution;
  spi: SpiState;
  steerpoints: SteerPoint[];
  activeSteerpoint: number;
  mfd: { left: MfdPage; right: MfdPage };
  /** Last time each switch changed (for click sounds and the checklist strip). */
  lastSwitch: { name: string; time: number };
  /** The HUD's validity flags. */
  ccipInvalid: boolean;
}
