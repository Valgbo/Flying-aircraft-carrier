/**
 * The simulation state and its inputs and outputs. FOUNDATION-OWNED: modules extend only the
 * types file in their own folder. See docs/a10/ARCHITECTURE.md §3–§5.
 */
import type {
  AvionicsState,
  MasterArm,
  GunPacSwitch,
  LaserArm,
  AltSource,
  MasterMode,
  Soi,
  MfdPage,
} from './avionics/types';
import type { DebriefState } from './debrief/types';
import type { AircraftState } from './flight/types';
import type { RngStreams } from './rng';
import type { SensorsState } from './sensors/types';
import type {
  ComponentId,
  TargetsState,
  RoundOutcome,
  VehicleCondition,
  VehicleKind,
} from './targets/types';
import type {
  AmmoLoad,
  GunState,
  ProjectileState,
  RoundType,
  StoresState,
  StoreType,
} from './weapons/types';
import type { SurfaceKind, WorldState } from './world/types';

/** Continuous pilot controls, written by the input layer once per frame, read by every step. */
export interface PilotInput {
  /** Stick pitch, -1..1, + = stick back (nose up). */
  pitch: number;
  /** Stick roll, -1..1, + = stick right. */
  roll: number;
  /** Pedals, -1..1, + = right pedal (nose right). */
  rudder: number;
  /** Throttle levers, 0 = IDLE .. 1 = MAX, left and right engine. */
  throttle: [number, number];
  /** Gun trigger detent: 0 released, 1 first detent (PAC-1), 2 second detent (fire). */
  trigger: 0 | 1 | 2;
  /** Weapon release ("pickle") button held. */
  weaponRelease: boolean;
  /** Speed brake switch: -1 retract (held), 0 hold, +1 extend (held). */
  speedBrake: -1 | 0 | 1;
  /** Trim hat held: -1..1 each (pitch + nose up, roll + right, yaw + nose right). */
  trimPitch: number;
  trimRoll: number;
  trimYaw: number;
  /** Sensor / cursor slew, -1..1 (+ right, + up). Acts on the sensor of interest. */
  slewX: number;
  slewY: number;
  /** Laser fire button held (the TGP may also latch it). */
  laser: boolean;
}

export type HatDir = 'up' | 'down' | 'left' | 'right';

/** Discrete pilot commands, queued by input/UI and applied at the start of the next step. */
export type Command =
  | { type: 'masterArm'; value: MasterArm | 'cycle' }
  | { type: 'gunPac'; value: GunPacSwitch | 'cycle' }
  | { type: 'laserArm'; value: LaserArm | 'cycle' }
  | { type: 'tgpPower'; value: boolean | 'toggle' }
  | { type: 'altSource'; value: AltSource | 'cycle' }
  | { type: 'masterMode'; value: MasterMode | 'next' }
  | { type: 'profile'; dir: 1 | -1 }
  | { type: 'soi'; value: Soi }
  | { type: 'mfdPage'; display: 'L' | 'R'; page: MfdPage }
  | { type: 'osb'; display: 'L' | 'R'; button: number }
  /** Target management switch: short or long press. */
  | { type: 'tms'; dir: HatDir; long: boolean }
  /** Data management switch. */
  | { type: 'dms'; dir: HatDir; long: boolean }
  /** China hat (throttle). */
  | { type: 'chinaHat'; dir: 'fwd' | 'aft'; long: boolean }
  /** Coolie hat (stick): SOI selection etc. */
  | { type: 'coolie'; dir: HatDir; long: boolean }
  | { type: 'sensorPicture'; value: 'cycle' }
  | { type: 'sensorZoom'; dir: 1 | -1 }
  | { type: 'flaps'; value: 0 | 1 | 2 | 'up' | 'down' }
  | { type: 'gear'; value: boolean | 'toggle' }
  | { type: 'autopilot'; action: 'toggle' | 'disengage' | 'mode' }
  | { type: 'altitudeAlert'; value: number }
  | { type: 'jettison'; stations: number[] | 'all' }
  | { type: 'rearm' }
  | { type: 'steerpoint'; dir: 1 | -1 };

export type Vec3Like = { x: number; y: number; z: number };

/** One-shot outcomes, appended during steps and handed to the view/audio/UI after each frame. */
export type SimEvent =
  | { type: 'gunStart'; t: number }
  | { type: 'gunStop'; t: number; rounds: number; duration: number }
  | {
      type: 'roundImpact';
      t: number;
      round: RoundType;
      position: Vec3Like;
      /** Velocity at impact, world m/s. */
      velocity: Vec3Like;
      normal: Vec3Like;
      /** What was hit: the ground (with its surface kind) or a vehicle. */
      target:
        | { kind: 'ground'; surface: SurfaceKind }
        | { kind: 'vehicle'; vehicleId: number; part: string };
      outcome: RoundOutcome | 'ground' | 'skip' | 'water';
    }
  | { type: 'storeReleased'; t: number; station: number; store: StoreType; bodyId: number }
  | { type: 'motorIgnition'; t: number; bodyId: number }
  | {
      type: 'detonation';
      t: number;
      position: Vec3Like;
      /** TNT-equivalent charge, kg. */
      charge: number;
      kind: 'bomb' | 'rocket' | 'missile' | 'hei' | 'secondary' | 'whitePhosphorus' | 'dud';
      /** Detonated on (or close to) a vehicle. */
      vehicleId: number;
      surface: SurfaceKind;
    }
  | {
      type: 'vehicleDamaged';
      t: number;
      vehicleId: number;
      vehicleKind: VehicleKind;
      condition: VehicleCondition;
      component: ComponentId | null;
    }
  | {
      type: 'vehicleDestroyed';
      t: number;
      vehicleId: number;
      vehicleKind: VehicleKind;
      catastrophic: boolean;
      position: Vec3Like;
    }
  | { type: 'crash'; t: number; position: Vec3Like; reason: 'terrain' | 'overstress' | 'water' }
  | { type: 'warning'; t: number; warning: string; on: boolean }
  | { type: 'switch'; t: number; name: string; value: string }
  | { type: 'laser'; t: number; on: boolean }
  | { type: 'lock'; t: number; sensor: 'TGP' | 'MAV'; on: boolean }
  | { type: 'message'; t: number; text: string; level: 'info' | 'warn' | 'alert' };

export type RealismPreset = 'authentic' | 'standard' | 'relaxed';

/** The aids each realism preset switches on (PLAN_A10.md §2). */
export interface RealismFlags {
  preset: RealismPreset;
  /** Target areas marked on the map display. */
  mapMarkers: boolean;
  /** Boxes on the HUD around vehicles. */
  hudBoxes: boolean;
  /** Sensor lock snaps to the nearest vehicle. */
  snapLock: boolean;
  /** Larger capture gate for manual locks. */
  largeGate: boolean;
  /** Two-stage trigger with PAC on the first detent (false = one stage, PAC always on). */
  twoStageTrigger: boolean;
  autoTrim: boolean;
  unlimitedAmmo: boolean;
  /** Fuze arming, duds and fragment warnings. */
  fuzeEffects: boolean;
  /** The aircraft bounces off the ground instead of crashing. */
  invulnerable: boolean;
}

export type ScenarioKind = 'freeHunt' | 'strafePit' | 'bombCircle' | 'tacticalLane' | 'empty';

export interface SimOptions {
  seed: number;
  scenario: ScenarioKind;
  realism: RealismFlags;
  /** Loadout preset id ('tankHunter' by default) or 'custom'. */
  loadoutId: string;
  /** Custom loadout: station number → store list (rack first). */
  customLoadout?: Record<number, StoreType[]>;
  /** The gun's ammunition load (default: the combat mix). */
  ammoLoad?: AmmoLoad;
}

export interface Sim {
  readonly options: SimOptions;
  /** Simulated seconds since the start. */
  time: number;
  /** Number of steps taken. */
  stepCount: number;
  rng: RngStreams;
  input: PilotInput;
  /** Commands waiting for the next step. */
  commands: Command[];
  aircraft: AircraftState;
  avionics: AvionicsState;
  gun: GunState;
  stores: StoresState;
  projectiles: ProjectileState;
  world: WorldState;
  targets: TargetsState;
  sensors: SensorsState;
  debrief: DebriefState;
  /** Events since the frame loop last drained them. */
  events: SimEvent[];
}
