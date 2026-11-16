/**
 * Targets contract: ground vehicles, their armour and damage. Owned by the TARGETS module
 * (core/targets). See docs/a10/ARCHITECTURE.md §4 and PLAN_A10.md §9.
 */
import type { Vector3 } from 'three';

export type VehicleKind =
  | 'mbt' // main battle tank, T-72 class
  | 'ifv' // infantry fighting vehicle, BMP class
  | 'apc' // wheeled personnel carrier, BTR class
  | 'truckCargo'
  | 'truckFuel'
  | 'truckAmmo'
  | 'hulk' // range hulk (an old tank body, no engine)
  | 'panel'; // strafe scoring panel

export type VehicleCondition = 'intact' | 'damaged' | 'destroyed' | 'catastrophic';

export type ComponentId =
  'engine' | 'fuel' | 'ammo' | 'gun' | 'runningGear' | 'optics' | 'crew' | 'cargo';

/**
 * Overall shape of a vehicle class, shared by the damage model and the 3D model so the two
 * match. Vehicle-local frame: +X right, +Y up, -Z forward (same handedness as the aircraft
 * body frame), origin on the ground under the hull centre.
 */
export interface VehicleShape {
  /** Hull box: length (z), width (x), height (y), m; bottom at `hullClearance` above ground. */
  hullLength: number;
  hullWidth: number;
  hullHeight: number;
  hullClearance: number;
  /** Turret (null for none): centre offset along z (+ aft) from hull centre, radius, height. */
  turret: { offsetZ: number; radius: number; height: number } | null;
  /** Main gun barrel length from the turret front, m (0 for none). */
  gunLength: number;
  /** Tracks or wheels. */
  running: { type: 'tracks'; width: number } | { type: 'wheels'; axles: number; radius: number };
  /** Cab length for trucks (front part), m. */
  cabLength?: number;
}

export interface Vehicle {
  id: number;
  kind: VehicleKind;
  /** Ground contact point under the hull centre, world. */
  position: Vector3;
  /** Hull heading, rad (0 = north, clockwise). */
  heading: number;
  /** Ground speed, m/s (+ forward). */
  speed: number;
  /** Turret direction relative to the hull, rad (+ clockwise from the bow). */
  turretYaw: number;
  /** Hull pitch and roll from the ground slope, rad. */
  pitch: number;
  roll: number;
  condition: VehicleCondition;
  mobilityKill: boolean;
  firepowerKill: boolean;
  /** Fire intensity 0..1 (0 = none). */
  fire: number;
  /** Engine running (heat, exhaust, dust when moving). */
  engineOn: boolean;
  /** Temperatures above ambient, K, for the thermal picture: engine deck, exhaust, running gear, hull. */
  heat: { engine: number; exhaust: number; running: number; hull: number };
  /** Component health, 0 (destroyed) .. 1. */
  components: Record<ComponentId, number>;
  groupId: number;
  /** Sim time of the last change of condition. */
  conditionTime: number;
  /** Turret thrown off in a catastrophic kill: its world position and orientation, else null. */
  thrownTurret: { position: Vector3; velocity: Vector3; spin: Vector3; angle: Vector3 } | null;
}

export type GroupBehaviour = 'parked' | 'column' | 'dugIn' | 'scatter' | 'static';

export interface VehicleGroup {
  id: number;
  name: string;
  behaviour: GroupBehaviour;
  vehicleIds: number[];
  /** Target area id it belongs to, -1 if none. */
  areaId: number;
  /** For columns: the road id and progress along it, m. */
  roadId: number;
  roadDistance: number;
  /** Time the group was first attacked (-1 = not yet). */
  alertTime: number;
}

export interface TargetsState {
  vehicles: Vehicle[];
  groups: VehicleGroup[];
  nextVehicleId: number;
  nextGroupId: number;
  /** Totals for the scoreboard. */
  killed: number;
  damaged: number;
}

/** Result of a segment test against vehicle armour (filled by the targets module). */
export interface VehicleHit {
  vehicleId: number;
  /** 0..1 along the tested segment. */
  t: number;
  point: Vector3;
  /** Outward unit normal of the plate that was hit, world. */
  normal: Vector3;
  /** Nominal plate thickness, mm of rolled homogeneous steel equivalent (0 = soft skin). */
  thicknessMm: number;
  part: 'hull' | 'turret' | 'tracks' | 'wheels' | 'cab' | 'cargo' | 'tank' | 'panel';
  face: 'front' | 'side' | 'rear' | 'top' | 'bottom';
  /** Index of the plate in the vehicle class's armour list (for the hit log). */
  plate: number;
}

export type RoundOutcome = 'penetrated' | 'stopped' | 'ricochet' | 'burst' | 'passedThrough';

export interface RoundHitResult {
  outcome: RoundOutcome;
  /** Angle between the round's path and the plate normal, rad. */
  obliquity: number;
  /** Plate thickness along the line of flight, mm. */
  effectiveThicknessMm: number;
  /** What the round could penetrate at its impact speed, mm. */
  penetrationMm: number;
  /** Components damaged by this hit. */
  damaged: ComponentId[];
  /** World velocity after a ricochet (else zero). */
  ricochetVelocity: Vector3;
}
