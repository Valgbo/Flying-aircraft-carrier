/** Shared types. See docs/ARCHITECTURE.md for the conventions behind them. */
import type { Color, Quaternion, Vector3 } from 'three';

export type Screen = 'menu' | 'hangar' | 'flight' | 'ops';

/**
 * orbit   — free orbit around the ship (also the menu / hangar camera)
 * chase   — behind and above, follows the ship's heading
 * deck    — standing on the flight deck looking forward
 * bridge  — from the navigation bridge in the island
 * turbine — close-up of one turbine
 */
export type CameraMode = 'orbit' | 'chase' | 'deck' | 'bridge' | 'turbine';

export type QualityLevel = 'low' | 'medium' | 'high';

export type TurbineIndex = 0 | 1 | 2 | 3;

export type Quad<T> = [T, T, T, T];

/** Live state of one turbine. Angles in radians. */
export interface TurbineSim {
  /** Engine master switch. A disabled turbine spools down to zero and produces no thrust. */
  enabled: boolean;
  /** Commanded throttle 0..1. */
  throttleCmd: number;
  /** Actual (spool-lagged) throttle 0..1 — drives thrust, fan speed, glow and sound. */
  throttle: number;
  /** Commanded tilt. 0 = thrust straight up; positive = thrust vector tilted toward the bow. */
  tiltCmd: number;
  /** Actual (slew-limited) tilt. */
  tilt: number;
  /** Thrust currently produced, kN. */
  thrust: number;
}

/** Live rigid-body state of the ship plus values derived from it once per frame. */
export interface CarrierSim {
  /** World position of the carrier origin (centre of mass), m. `y` is altitude above mean sea level. */
  position: Vector3;
  /** World orientation (carrier-local → world). */
  quaternion: Quaternion;
  /** World linear velocity, m/s. */
  velocity: Vector3;
  /** World angular velocity, rad/s. */
  angularVelocity: Vector3;

  // ---- derived by updateDerived() ----
  /** Centre of mass above mean sea level, m. */
  altitude: number;
  /** Keel above the local water surface, m (≤ 0 while the hull is in the water). */
  keelClearance: number;
  /** Horizontal ground speed, m/s. */
  speed: number;
  /** Speed along the ship's own forward axis, m/s (negative when moving astern). */
  forwardSpeed: number;
  /** Vertical speed, m/s (positive = climbing). */
  verticalSpeed: number;
  /** Compass heading of the bow, degrees 0..360 (0 = north = world -Z, 90 = east = world +X). */
  headingDeg: number;
  /** Pitch, rad (positive = bow up). */
  pitch: number;
  /** Roll, rad (positive = starboard side down). */
  roll: number;
  /** Felt acceleration along the ship's up axis in g (1 = steady hover or floating). */
  gLoad: number;
  /** True while the water is carrying at least part of the ship's weight. */
  afloat: boolean;
}

/** Pilot / flight-computer control state. Written by the active driver; the turbine panel edits the manual arrays. */
export interface FlightControls {
  /** Flight assist: altitude the flight computer holds, m ASL. */
  targetAltitude: number;
  /** Flight assist: collective tilt the pilot has dialled in for all turbines, rad. */
  tiltLever: number;
  /** Manual mode: commanded throttle per turbine 0..1. */
  manualThrottle: Quad<number>;
  /** Manual mode: commanded tilt per turbine, rad. */
  manualTilt: Quad<number>;
}

/** Environment state. Written by the world module (sun) and the active driver / ops (wind). */
export interface EnvSim {
  /** Unit vector pointing from the scene toward the sun (or the moon at night). */
  sunDirection: Vector3;
  /** 0 = deep night, 1 = full day. Use it to switch deck lights on, dim clouds, etc. */
  daylight: number;
  /** Colour × intensity of the direct sun / moon light (linear, may exceed 1). */
  sunColor: Color;
  /** Sky colour at the horizon (linear) — also the fog colour; the ocean fades into it. */
  horizonColor: Color;
  /** Sky colour overhead (linear) — what the water mostly reflects. */
  zenithColor: Color;
  /** World wind velocity, m/s (including gusts). */
  wind: Vector3;
  /** 0..1 — how deep the camera currently is inside cloud. Written by the clouds module. */
  cloudCover: number;
}

export type JetPhase =
  | 'parked'
  | 'taxi'
  | 'catapult'
  | 'launch'
  | 'climbout'
  | 'pattern'
  | 'approach'
  | 'trap'
  | 'waveoff'
  | 'rollout';

/** One aircraft of the air wing. Positions are WORLD space. Written by the flight-ops module. */
export interface JetSim {
  id: number;
  phase: JetPhase;
  position: Vector3;
  quaternion: Quaternion;
  /** Airspeed, m/s. */
  speed: number;
  /** 0..1 engine power (afterburner glow / sound). */
  power: number;
  gearDown: boolean;
}

export interface CameraSim {
  /** World position of the active camera (written by the camera rig every frame). */
  position: Vector3;
  /** Pending shake energy 0..1+. Systems add to it via addCameraShake(); the rig consumes and decays it. */
  shake: number;
}

export interface SimState {
  /** Simulation time in seconds since the current scene was (re)started. Advanced by the active driver. */
  time: number;
  /**
   * Simulated seconds advanced during the current frame (0 while paused or frozen).
   * Visuals animate with `sim.time` / `sim.dt` — never wall-clock time — so pause and
   * deterministic screenshots work everywhere.
   */
  dt: number;
  carrier: CarrierSim;
  turbines: Quad<TurbineSim>;
  controls: FlightControls;
  env: EnvSim;
  jets: JetSim[];
  camera: CameraSim;
}

/** Low-rate (≈10 Hz) snapshot of the sim for React UI. Units are display units. */
export interface Telemetry {
  time: number;
  altitude: number;
  keelClearance: number;
  speedKts: number;
  forwardSpeedKts: number;
  verticalSpeed: number;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  gLoad: number;
  afloat: boolean;
  throttle: Quad<number>;
  throttleCmd: Quad<number>;
  tiltDeg: Quad<number>;
  tiltCmdDeg: Quad<number>;
  thrustKN: Quad<number>;
  enabled: Quad<boolean>;
  targetAltitude: number;
}

export type MessageLevel = 'info' | 'warn' | 'alert';

export interface GameMessage {
  id: number;
  text: string;
  level: MessageLevel;
  /** performance.now() timestamp after which the message should disappear. */
  expiresAt: number;
}

export type TouchControlsSetting = 'auto' | 'on' | 'off';

export interface OpsJetStatus {
  id: number;
  phase: JetPhase;
}

export interface RecoveryResult {
  jetId: number;
  /** Points awarded for this recovery (0 for a wave-off). */
  points: number;
  /** Short grade label, e.g. "PERFECT", "OK", "ROUGH", "WAVE-OFF". */
  grade: string;
  /** Deck tilt at touchdown, degrees. */
  deckTiltDeg: number;
  /** Deck vertical speed at touchdown, m/s. */
  deckHeave: number;
}

export interface OpsState {
  score: number;
  launches: number;
  recoveries: number;
  waveOffs: number;
  /** One-line status for the ops HUD, e.g. "CAT 1 READY" or "JET 2 ON FINAL". */
  status: string;
  /** Live deck steadiness 0..1 (1 = rock steady). */
  deckStability: number;
  lastRecovery: RecoveryResult | null;
  jets: OpsJetStatus[];
}
