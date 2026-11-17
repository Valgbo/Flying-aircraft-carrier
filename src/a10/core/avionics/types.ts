/**
 * Avionics contract: armament switches, master modes, sensor of interest, and the fire-control
 * solutions the HUD draws. Owned by the AVIONICS module (core/avionics).
 * See docs/a10/ARCHITECTURE.md §4 and PLAN_A10.md §7.
 */
import type { Vector3 } from 'three';
import type { HatDir } from '../types';
import type { AmmoLoad, ReleaseDelivery, RoundType } from '../weapons/types';

export type MasterArm = 'SAFE' | 'TRAIN' | 'ARM';
/** GUN/PAC switch: SAFE, GUNARM (gun armed, PAC off), ARM (gun armed, PAC on). */
export type GunPacSwitch = 'SAFE' | 'GUNARM' | 'ARM';
export type LaserArm = 'SAFE' | 'TRAIN' | 'ARM';
/** Altitude source for fire control: barometric, DELTA (terrain database), radar altimeter. */
export type AltSource = 'BARO' | 'DELTA' | 'RADAR';
export type MasterMode = 'NAV' | 'GUNS' | 'CCIP' | 'CCRP';
export type Soi = 'HUD' | 'LMFD' | 'RMFD';

/**
 * What the HUD's weapon sight shows now (decided by the master mode and the selected profile):
 * 'GUN' the CCIP gun reticle (GUNS, or CCIP when the gun is the CCIP weapon), 'CCIP' the selected
 * store's CCIP pipper, 'CCRP' the CCRP steering of the selected store, 'NONE' no weapon sight.
 */
export type SightMode = 'NONE' | 'GUN' | 'CCIP' | 'CCRP';

/**
 * The gun sights (DMS left/right in GUNS with the HUD as SOI). Wave 1 computes 'CCIP'; the
 * fixed-range reticles, the lead-computing cross and the manually depressed pipper are wave 3.
 */
export type GunSightMode = 'CCIP' | 'FIXED' | 'LEAD' | 'MANUAL';

/** The gun sight solution, recomputed every step (PLAN_A10.md §6.2, "The sight"). */
export interface GunSolution {
  /** A solution exists (the predicted round reaches the ground within the computed time). */
  valid: boolean;
  /** Predicted impact point of a round fired now, world. */
  impact: Vector3;
  /** Pipper direction relative to the boresight, rad (HUD az + right, el + up), from the eye. */
  pipperAz: number;
  pipperEl: number;
  /** Straight-line range from the aircraft to the impact point, m. */
  slantRange: number;
  /** Round time of flight to the impact, s. */
  timeOfFlight: number;
  /** Closing inside the minimum range (fragment/ricochet and ground-clearance limit). */
  tooClose: boolean;
  /** Beyond the maximum range the range bar shows. */
  tooFar: boolean;
  /** Minimum range of the gun sight (the HUD's minimum-range cue; `tooClose` below it), m. */
  minRange: number;
  /** Full scale of the range bar (`tooFar` beyond it), m. */
  maxRange: number;
  /** Gun line direction from the eye (the gun cross), HUD angles, rad. */
  gunLineAz: number;
  gunLineEl: number;
  /** The ground model the solution was computed against (altitude-source switch). */
  groundSource: AltSource;
  /**
   * Height of the ground plane the computer assumed, m (RADAR: under the aircraft; BARO: the
   * active steerpoint's elevation); NaN with DELTA (the terrain database) or no ground data.
   */
  groundPlane: number;
  /** The ground model has data (radar altimeter in range, a steerpoint for BARO). */
  groundValid: boolean;
  /** Round type whose ballistics the computer used (from the loaded ammunition). */
  roundType: RoundType;
  /** Predicted impact speed, m/s (0 when invalid). */
  impactSpeed: number;
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

  // ---- wave 2 (ARCHITECTURE §12.7: what the HUD draws) ----
  /**
   * The designated point: the target of a consent (delayed CCIP) release after the pickle press,
   * or the CCRP target (the SPI). Valid while there is one.
   */
  designated: Vector3;
  designatedValid: boolean;
  /** CCRP: azimuth steering error, rad (+ = steer right to fly over the release point). */
  azimuthError: number;
  /** CCRP: the solution cue's angle above (+) the velocity vector along the steering line, rad; 0 = release. */
  cueEl: number;

  // ---- wave 2, added by the avionics module (all filled every step) ----
  /** The store the solution is for and the station it would leave from (0 = none). */
  store: string;
  station: number;
  /**
   * Consent release (PLAN §6.5): the delay cue, where the bomb fall line (from the velocity
   * vector to the pipper, drawn straight on the HUD's flat plane) crosses
   * RELEASE.delayCueMargin above the bottom edge of the glass, seen from the design eye. Valid in
   * CCIP while the pipper is below the glass and the velocity vector above it. `delayCue` is the
   * ground point seen through the cue (the computer's ground model): the point a pickle press
   * designates.
   */
  delayCue: Vector3;
  delayCueValid: boolean;
  /** Delay cue direction from the eye, HUD angles, rad. */
  delayCueAz: number;
  delayCueEl: number;
  /**
   * The pickle is held and the computer will release by itself when the solution is reached
   * (consent after designation, or CCRP): the HUD's "release armed" state.
   */
  armed: boolean;
  /**
   * CCRP / consent: the computed release point is behind the aircraft (`timeToRelease` < 0), so
   * this run cannot release; turn round or designate again.
   */
  passed: boolean;
  /**
   * Seconds until the last store released hits, from the computer's prediction at its release
   * (the TOF countdown pilots time the laser by); −1 when nothing is falling.
   */
  timeToImpact: number;
  /** The fuze would not arm before impact (time of fall < the profile's arming time): a dud. */
  fuzeNoArm: boolean;
  /** Height of the (computed) release point above the impact or target point, m. */
  releaseHeight: number;
  /** Release pulses of the ripple in progress still to come (0 = none). */
  pulsesLeft: number;
}

/** A bomb / rocket delivery: continuously computed impact or release point. */
export type DeliveryMode = 'CCIP' | 'CCRP';
/**
 * The delivery a weapon profile is set to on the stores page; 'NONE' for weapons launched from
 * their own page in any master mode (Maverick).
 */
export type ProfileMode = DeliveryMode | 'NONE';
export type ReleaseMode = 'SGL' | 'PRS' | 'RIP_SGL' | 'RIP_PRS';
export type FuzeOption = 'NOSE' | 'TAIL' | 'N/T';

/** A weapon delivery profile on the stores page (PLAN_A10.md §6.5). */
export interface WeaponProfile {
  id: string;
  /** Store type this profile applies to (a weapons `StoreType`). */
  store: string;
  mode: ProfileMode;
  /** 'SGL' single, 'PRS' pairs, 'RIP SGL', 'RIP PRS'. */
  release: ReleaseMode;
  rippleQty: number;
  /** Ripple spacing on the ground, m. */
  rippleSpacing: number;
  fuze: FuzeOption;
  /** Minimum release altitude, m above target. */
  minAltitude: number;
  /** Fuze arming time, s. */
  armingTime: number;
  /** Name shown on the DSMS and HUD (≤ 8 characters), e.g. 'MK82LD'. Defaults to the store. */
  name?: string;
  /** Low or high drag (Mk-82 AIR: the ballute opens); default 'LD'. Wave 2. */
  drag?: 'LD' | 'HD';
  /** GBU-12: the laser code the bomb's seeker looks for (default 1688). Wave 2. */
  laserCode?: number;
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

/** A sensor of interest by what it shows: the HUD, or the page on the selected display. */
export type SoiTarget = 'HUD' | MfdPage;

/**
 * A HOTAS action for a sensor (targeting pod or Maverick seeker), recorded by `applyCommands` for
 * the sensors module (wave 2). The list lives for one step: avionics clears it at the start of
 * every `applyCommands`, and `stepSensors` (step 8) reads the requests of the same step.
 */
export interface SensorRequest {
  sensor: 'TGP' | 'MAV' | 'ALL';
  action: 'tms' | 'dms' | 'chinaHat' | 'picture' | 'zoom' | 'slaveSpi' | 'slew';
  /** Hat direction ('fwd'/'aft' for the China hat), '' when none. */
  dir: HatDir | 'fwd' | 'aft' | '';
  long: boolean;
  /** Zoom steps (+ in) for 'zoom'; 0 otherwise. */
  value: number;
  /** Sim time of the request, s. */
  t: number;
}

/** One station on the stores page (DSMS), stations 1 (left tip) … 11 (right tip). */
export interface DsmsStationView {
  station: number;
  /** Rack or launcher, or null. */
  rack: string | null;
  /** The store hanging there (first in release order), or null when empty. */
  store: string | null;
  /** Number of stores still on the station. */
  count: number;
  /** The station holds the selected profile's store. */
  selected: boolean;

  // ---- wave 2 ----
  /** Rocket pods: rockets left in the pod; −1 for other stations. */
  rockets: number;
  /** The next release of the selected profile comes from this station. */
  next: boolean;
  /** Selective jettison can drop what hangs here (pods and the AIM-9 rails stay). */
  jettisonable: boolean;
  /** Chosen for selective jettison on the DSMS. */
  jettisonSelected: boolean;
}

/** One weapon profile as the DSMS lists it. */
export interface DsmsProfileView {
  id: string;
  name: string;
  store: string;
  mode: ProfileMode;
  release: ReleaseMode;
  rippleQty: number;
  rippleSpacing: number;
  fuze: FuzeOption;
  minAltitude: number;
  armingTime: number;
  /** Stores of this type still loaded (rocket pods: rockets left). */
  remaining: number;
  selected: boolean;

  // ---- wave 2 ----
  /** Low or high drag at release. */
  drag: 'LD' | 'HD';
  /** Laser code of a laser-guided bomb's seeker; 0 for other stores. */
  laserCode: number;
  /** Deliveries the store supports (empty: launched from its own page, the Maverick). */
  modes: readonly DeliveryMode[];
}

/** Everything the stores page (DSMS) shows. Filled by `buildDsmsView`. */
export interface DsmsView {
  stations: DsmsStationView[];
  profiles: DsmsProfileView[];
  /** Gun: rounds left, rounds loaded and the ammunition mix. */
  gunRounds: number;
  gunLoaded: number;
  gunLoad: AmmoLoad;
  masterArm: MasterArm;
  /** Name of the selected profile, '' when none. */
  selectedProfile: string;

  // ---- wave 2 ----
  /** Station of the next release of the selected profile (0 none). */
  selectedStation: number;
  /** Station chosen for selective jettison (0 none). */
  jettisonStation: number;
  /** Laser-code entry: the digit (0–3) the INC button changes. */
  codeDigit: number;
}

/**
 * The display pages' own settings (PLAN §7 "Display pages"): what the OSBs of the TAD, DSMS, TGP
 * and MSG pages change besides the switches.
 */
export interface PageState {
  /** TAD map range, nm (TAD_RANGES_NM). */
  tadRange: number;
  /** TAD centred on the own aircraft or on the SPI. */
  tadCenter: 'OWN' | 'SPI';
  /** DSMS: the station chosen for selective jettison (0 none). */
  jettisonStation: number;
  /** Laser-code entry cursor (digit 0–3, left to right) on the DSMS (profile) and TGP (pod). */
  dsmsCodeDigit: number;
  tgpCodeDigit: number;
  /** MSG page: messages older than this sim time are cleared (CLR), s; −1 none. */
  msgClearTime: number;
}

/**
 * What the pickle (weapon-release) button is doing (ARCHITECTURE §12.1: avionics decides every
 * release). IDLE: nothing; CONSENT: a delayed CCIP release is designated and waits for the impact
 * to reach the designated point; CCRP: waits for the computed release point; SERIES: a release
 * is under way (single, pairs, ripple pulses); MAV: the button is held for the Maverick launch;
 * DONE: this press has released (or was refused): nothing more until the button is pressed again.
 */
export type DeliveryPhase = 'IDLE' | 'CONSENT' | 'CCRP' | 'SERIES' | 'MAV' | 'DONE';

/** The release in progress (read-only for other modules). */
export interface DeliveryState {
  /** The pickle button as seen at the last step. */
  pickle: boolean;
  phase: DeliveryPhase;
  /** Fire-control time of the press, s (−1 none). */
  pressTime: number;
  /** Profile id and store of the run in progress. */
  profile: string;
  store: string;
  delivery: ReleaseDelivery;
  /** Master Arm was TRAIN at the press: simulated releases only. */
  simulated: boolean;
  /** Stores per pulse (1 single, 2 pairs), pulses in the series, pulses done. */
  perPulse: number;
  pulses: number;
  pulseIndex: number;
  /** Time of the next pulse, s, and the interval between pulses (spacing / ground speed), s. */
  nextTime: number;
  interval: number;
  /** Ripple spacing on the ground, m. */
  spacing: number;
  /**
   * Aim of the series: the target of a computed release (CCRP: the SPI; consent: the designated
   * point) — pulse k aims (k − (n − 1)/2) spacings along the track from it — or, for an
   * immediate CCIP release (`aimPerPulse`), each pulse aims at the pipper of its own release.
   */
  aim: Vector3;
  aimValid: boolean;
  aimPerPulse: boolean;
  /** Ground track at the start of the series (unit, horizontal). */
  trackX: number;
  trackZ: number;
  /**
   * Stores already taken from each station in this run that have not left the stations (Master
   * Arm TRAIN: nothing leaves), index = station number.
   */
  used: number[];
  /** Wing of the last release (−1 left, +1 right, 0 none): pairs and ties alternate wings. */
  lastSide: number;
  /**
   * After a Maverick launch: at the first command step after this time (the launch has left the
   * rail) the next missile's seeker is slaved to the SPI; −1 none.
   */
  mavSlaveAfter: number;
  /** The last release: its time and the predicted impact time, s (−1 none). */
  lastReleaseTime: number;
  lastImpactTime: number;
}

/** Internal state of the fire-control computer (read-only for other modules). */
export interface FireControlInternals {
  /** Time of flight of the previous valid gun solution, s (0 when none). */
  prevTimeOfFlight: number;
  /** Predictor integration steps used by the last gun solution (cost diagnostics). */
  steps: number;
  /** Ground tests (chord/segment queries) used by the last gun solution. */
  groundTests: number;

  // ---- store fire control (wave 2) ----
  /** Store predictions flown in the last step (cost diagnostics). */
  storePredictions: number;
  /**
   * Release-time solver warm start: the last solution (s from its state), the along-track
   * error's slope dE/dτ (m/s, negative: the impact advances), valid, and the target it was for.
   */
  solveTau: number;
  solveSlope: number;
  solveValid: boolean;
  solveTarget: Vector3;
  /**
   * How far a pull-up throws the store, m of impact range per rad of flight-path angle (the
   * solution cue's scale), and the steps since it was measured.
   */
  loftGain: number;
  loftAge: number;
}

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
  /**
   * The HUD's validity flag for CCIP: in CCIP mode, the CCIP weapon's solution (the selected
   * store's, or the gun's when the gun is the CCIP weapon) does not exist ("CCIP INVALID").
   */
  ccipInvalid: boolean;

  // ---- added by the avionics module ----
  /** The weapon sight the HUD should draw now (see SightMode). */
  sight: SightMode;
  /** Selected gun sight (wave 1: always 'CCIP'). */
  gunSight: GunSightMode;
  /** Value of the last switch change (pairs with lastSwitch.name). */
  lastSwitchValue: string;
  /** HOTAS actions for the sensors module this step (see SensorRequest). */
  sensorRequests: SensorRequest[];
  /**
   * The last "slave to SPI" request (China hat forward long: all sensors; aft long: the pod), so
   * the sensors module can act on it even if it reads it a step late. -1 = never.
   */
  slaveRequest: { sensors: 'ALL' | 'TGP'; time: number };
  /** Steerpoints, SPI and profiles have been built for this flight (see initAvionics). */
  initialized: boolean;
  fc: FireControlInternals;

  // ---- wave 2 (avionics) ----
  /**
   * Station the next release of the selected profile leaves from (the DSMS's selected station),
   * 0 when none. For a Maverick profile it is the missile to launch next: the sensors module
   * makes the seeker on this station the selected one (`sensors.selectedMaverick`).
   */
  selectedStation: number;
  /**
   * Laser latch (TGP page LTCH): the laser fires without the button held while it is armed and
   * the pod tracks. The sensors module copies it into `tgp.latched`.
   */
  laserLatch: boolean;
  /**
   * The pod's laser code as set in the cockpit (TGP page CODE / INC; default 1688). The sensors
   * module fires the laser with it (`tgp.laserCode`); a GBU-12 guides only on its profile's code.
   */
  laserCode: number;
  /**
   * Maverick power (MAV page PWR): the sensors module powers the seekers from it (alignment
   * after power-on; aligned at an air start).
   */
  mavPower: boolean;
  /** Page settings changed by the OSBs. */
  pages: PageState;
  /** The pickle and the release in progress. */
  delivery: DeliveryState;
}
