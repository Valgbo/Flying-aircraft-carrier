/**
 * Targets contract: ground vehicles, their armour and damage. Owned by the TARGETS module
 * (core/targets). See docs/a10/ARCHITECTURE.md §4 and PLAN_A10.md §9.
 *
 * Every field that existed in the foundation contract keeps its name and meaning (the views,
 * audio and UI read them). Fields added by the targets module are documented where they are
 * declared; fields named `internal` belong to the targets module alone.
 */
import type { Vector3 } from 'three';
import type { RoadPolyline } from '../world/types';
import type { Pose } from './pose';

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

// ---- Armour and component layout (data/vehicles.ts builds one per class) ----------------------

/** Which side of the vehicle a plate faces (for the hit log and the debrief). */
export type ArmourFace = 'front' | 'side' | 'rear' | 'top' | 'bottom';

/** What kind of part a plate belongs to. */
export type ArmourPartKind =
  'hull' | 'turret' | 'tracks' | 'wheels' | 'cab' | 'cargo' | 'tank' | 'panel' | 'gun' | 'fender';

/**
 * One armour plate: a face of a convex part, the plane n·p = d in the part's frame (hull frame,
 * or turret frame for turret parts) with the OUTWARD unit normal n. A point p is inside the part
 * when n·p ≤ d for every plate of the part.
 */
export interface ArmourPlate {
  /** Index of the plate in its class's `plates` list (stable: used by the hit log). */
  index: number;
  /** Readable name ('upper glacis', 'engine deck' …). */
  name: string;
  face: ArmourFace;
  /** Nominal thickness, mm of rolled homogeneous armour (RHA) equivalent; 0 = no resistance. */
  thicknessMm: number;
  nx: number;
  ny: number;
  nz: number;
  d: number;
}

/** A convex armour part: hull, glacis block, turret, track run, fender, cab, tank, panel … */
export interface ArmourPart {
  name: string;
  part: ArmourPartKind;
  /** Turns with the turret (turret frame = hull frame turned by turretYaw about the ring axis). */
  turret: boolean;
  /**
   * An outer layer (track run, fender stowage, external fuel, gun barrel): a round that defeats
   * it carries on and may strike the main armour behind. Non-spaced parts enclose the interior.
   */
  spaced: boolean;
  /** Component carried by this part (track → runningGear, fender tank → fuel), or null. */
  component: ComponentId | null;
  plates: ArmourPlate[];
  /** Bounds of the part in its own frame, m (fast reject). */
  min: [number, number, number];
  max: [number, number, number];
}

/** What losing a component box does on its own (besides the class rules). */
export type ComponentEffect = 'mobility' | 'firepower' | 'none';

/** An internal (or external) component as a box in the hull or turret frame. */
export interface ComponentBox {
  id: ComponentId;
  /** Readable name ('autoloader carousel', 'driver' …). */
  name: string;
  turret: boolean;
  /** Outside the armour (optics, external fuel, running gear): hurt by HEI bursts, blast, fragments. */
  external: boolean;
  min: [number, number, number];
  max: [number, number, number];
  /** Penetration a residual penetrator loses crossing it, mm RHA (engine block, crates …). */
  absorbMm: number;
  /** Share of its component's health this box carries (default 1). */
  weight: number;
  /** Losing this box alone causes a mobility or firepower kill. */
  effect: ComponentEffect;
  /**
   * A track: it is not worn down by nearby strikes. It breaks (health 0) only when a penetrator or
   * fragment defeats its run (the armour part of the same name), with this chance per defeating
   * hit (a link or pin severed), or under heavy blast. Undefined for every other box.
   */
  breakChance?: number;
}

/** Everything the damage model knows about one vehicle class. */
export interface VehicleClassModel {
  kind: VehicleKind;
  parts: ArmourPart[];
  /** All plates of all parts, `plates[i].index === i`. */
  plates: ArmourPlate[];
  components: ComponentBox[];
  /** Bounds of the whole vehicle in the hull frame (turret at every yaw), m. */
  min: [number, number, number];
  max: [number, number, number];
  /** Bounding-sphere centre height above the origin and radius, m (broadphase). */
  sphereY: number;
  sphereR: number;
  /** Turret ring axis position along z, m (0 when there is no turret). */
  turretZ: number;
}

// ---- Vehicles, groups, state -------------------------------------------------------------------

export interface Vehicle {
  id: number;
  kind: VehicleKind;
  /** Ground contact point under the hull centre, world (a dug-in vehicle: the floor of its pit). */
  position: Vector3;
  /** Hull heading, rad (0 = north, clockwise). */
  heading: number;
  /** Ground speed, m/s (+ forward). */
  speed: number;
  /** Turret direction relative to the hull, rad (+ clockwise from the bow). */
  turretYaw: number;
  /** Hull pitch and roll from the ground slope, rad (pitch + nose up, roll + right side down). */
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
  /**
   * Turret thrown off in a catastrophic kill, else null. `position`: world position of the turret
   * centre (hull-frame point (0, top + 0.45·turret height, offsetZ) when it left); `velocity` m/s;
   * `angle`: its world orientation as Euler angles (order XYZ, rad); `spin`: rate of change of
   * `angle`, rad/s. Velocity and spin are zero once it has landed.
   */
  thrownTurret: { position: Vector3; velocity: Vector3; spin: Vector3; angle: Vector3 } | null;
  // ---- added by the targets module ----
  /** Dug into a firing pit: only the turret and the hull top stand above the ground. */
  dugIn: boolean;
  /** Rounds, fragments and blasts that have struck the vehicle (range scoring, hulks). */
  hits: number;
  /** Sim time of the last hit, s (-1 = never). */
  lastHitTime: number;
  /** State owned by the targets module (damage, fire, driving). Other modules must not read it. */
  internal: VehicleInternal;
}

/** Per-vehicle state of the targets module. */
export interface VehicleInternal {
  /** Health of each component box of the class model, 0..1 (same order as `components`). */
  boxHealth: Float32Array;
  /** Fire inside the hull / crew or cargo space, 0..1, and its fuel left (s at full intensity). */
  fireIn: number;
  fireInTarget: number;
  fireInLoad: number;
  /** Fire outside (fender tanks, drums, a truck's own tank), 0..1, and its fuel left. */
  fireOut: number;
  fireOutTarget: number;
  fireOutLoad: number;
  /** Sim time of a pending ammunition (or fuel-tank) explosion, -1 = none. */
  explodeTime: number;
  /** A cook-off was already decided for the current fire. */
  cookOffDecided: boolean;
  /** Sim time of the next small cook-off detonation of an ammunition truck, -1 = none. */
  popTime: number;
  /** Small cook-off detonations left (ammunition trucks). */
  popsLeft: number;
  /**
   * TNT-equivalent charge of the vehicle's own explosion whose blast and fragments still have to
   * reach its neighbours (set by explode(), applied by stepTargets in the same step), kg; 0 = none.
   */
  secondaryCharge: number;
  /** Weapon that last damaged the vehicle (kill attribution). */
  lastWeapon: string;
  /**
   * A burst already resolved on this vehicle in this step (an HEI round by resolveRoundHit, a
   * warhead by applyWarheadHit): its applyBlast at the same point skips the vehicle, so the burst
   * counts once (contract §4).
   */
  burstTime: number;
  burstX: number;
  burstY: number;
  burstZ: number;
  /** Driving: route leg index, distance along the leg, desired cruise speed (m/s). */
  leg: number;
  s: number;
  cruise: number;
  /** Where the vehicle is driving to off the road (scatter, cover), and whether it has one. */
  goalX: number;
  goalZ: number;
  hasGoal: boolean;
  /** Sim time before which the vehicle does not start to move (reaction time). */
  waitUntil: number;
  /** Depth of the firing pit (dug in), m. */
  digDepth: number;
  /** Turret scan phase, rad, and the yaw the turret is turning toward. */
  scanPhase: number;
  /** Smoothed pitch/roll targets from the ground under the hull. */
  groundPitch: number;
  groundRoll: number;
  /** Steps until the next ground-slope sample. */
  slopeTimer: number;
  /** Cached pose for the hit tests and what it was computed from (pose.ts, vehiclePose). */
  pose: Pose;
  poseKey: Float64Array;
}

export type GroupBehaviour = 'parked' | 'column' | 'dugIn' | 'scatter' | 'static';

/** One leg of a column's route: a road (or a range lane path) driven in one direction. */
export interface RouteLeg {
  road: RoadPolyline;
  /** +1 along increasing distance, -1 against it. */
  dir: 1 | -1;
  /** Closed loop (range lane): distance wraps around and the leg never ends. */
  loop: boolean;
  /** Index into Terrain.roads, -1 for a path that is not a terrain road. */
  roadIndex: number;
  /** Road distance where the leg starts and ends, m (along the road's own arc). */
  from: number;
  to: number;
  /** Route distance at the start of the leg, m (sum of the legs before it). */
  start: number;
}

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
  // ---- added by the targets module ----
  /** Template it was built from ('tankPlatoon', 'supplyColumn' …). */
  template: string;
  /** Range targets do not react to attacks (remote-controlled); field groups do. */
  reacts: boolean;
  /** Columns: the legs driven so far and to come (the lead vehicle extends it at junctions). */
  route: RouteLeg[];
  /** Columns: cruise speed, m/s, and the spacing between vehicles, m. */
  speed: number;
  spacing: number;
  /** Centre and radius of the group's vehicles (alert tests), updated each step. */
  cx: number;
  cz: number;
  radius: number;
  /** All its vehicles are destroyed (free hunt replaces it). */
  wipedOut: boolean;
  /** The group has reacted to its alert (scattered, started engines, headed for cover). */
  reacted: boolean;
}

export interface TargetsState {
  vehicles: Vehicle[];
  groups: VehicleGroup[];
  nextVehicleId: number;
  nextGroupId: number;
  /** Totals for the scoreboard: vehicles destroyed (or catastrophic), and vehicles now damaged. */
  killed: number;
  damaged: number;
  // ---- added by the targets module ----
  /** Free hunt: how many groups to keep alive (0 in other scenarios). */
  huntGroups: number;
  /** Free hunt: sim time the next replacement group appears (-1 = none pending). */
  respawnTime: number;
  /** Spatial index and event scan state owned by the targets module. */
  internal: TargetsInternal;
}

/** Spatial hash of the vehicles (broadphase) and bookkeeping of the targets module. */
export interface TargetsInternal {
  /** The grid must be rebuilt before the next query (vehicles were added or moved). */
  dirty: boolean;
  /** Open-addressing hash: cell key per slot (or -1), first entry per slot. */
  keys: Int32Array;
  heads: Int32Array;
  /** Entry list: vehicle index and next entry in the same cell. */
  entryVehicle: Int32Array;
  entryNext: Int32Array;
  entryCount: number;
  /** Per-vehicle query stamp (no vehicle tested twice in one query). */
  stamps: Int32Array;
  stamp: number;
  /** sim.events scan: index reached and the last event seen (detects the frame loop's drain). */
  eventIndex: number;
  lastEvent: unknown;
  /** Paths that are not terrain roads (range lanes). */
  paths: RoadPolyline[];
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
  part: ArmourPartKind;
  face: ArmourFace;
  /** Index of the plate in the vehicle class's armour list (for the hit log). */
  plate: number;
  /** Index of the armour part in the class model (targets module; optional for callers). */
  partIndex?: number;
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
  // ---- optional, filled by the targets module when present ----
  /**
   * The plate that decided the outcome (after a spaced layer such as a track run this is the
   * main armour behind it), else the plate that was struck.
   */
  plate?: number;
  /** Vehicle condition after the hit. */
  condition?: VehicleCondition;
}
