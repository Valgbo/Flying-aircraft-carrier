/**
 * Carrier force model — the single source of every force that acts on the ship.
 *
 * Pure and deterministic: no React, no physics engine, no store. Given the rigid-body state,
 * the turbine states and the environment it returns the net force (kN) and torque (kN·m, about
 * the centre of mass) in the WORLD frame. The Rapier driver and the fixed-step test integrator
 * both call `computeCarrierForces`, so the game and the tests share one code path.
 *
 * Contributions:
 *   thrust     per turbine: maxThrust × throttle × air density × ground effect, applied at the
 *              tilt pivot along the tilted thrust axis
 *   gravity    weight, straight down
 *   aero       anisotropic drag in the body frame relative to the wind (least along the keel
 *              line, most through the deck), rotational damping, a leading-edge shift of the
 *              vertical drag that rights a flat fall, and injected turbulence torques
 *   water      buoyancy, heave / slamming damping and hull drag from sample columns under the
 *              hull footprint, evaluated against the shared wave field
 */
import { Quaternion, Vector3 } from 'three';
import { HULL, TURBINE, TURBINE_MOUNTS } from '../config/layout';
import { AERO, HYDRO, PHYS, WEIGHT } from '../config/physicsConfig';
import { waveHeightAt } from '../config/waves';
import { thrustAxisLocal } from '../state/simHelpers';
import type { Quad } from '../state/types';
import { clamp01 } from '../utils/math';

/** Rigid-body state the model works on. `sim.carrier` satisfies it. */
export interface RigidState {
  /** World position of the centre of mass, m. */
  position: Vector3;
  /** Carrier-local → world. */
  quaternion: Quaternion;
  /** World linear velocity, m/s. */
  velocity: Vector3;
  /** World angular velocity, rad/s. */
  angularVelocity: Vector3;
}

/** The part of a turbine's state that produces force. `TurbineSim` satisfies it. */
export interface TurbineForceState {
  throttle: number;
  tilt: number;
}

export interface CarrierEnvironment {
  /** Simulation time, s (selects the phase of the wave field). */
  time: number;
  /** World wind velocity, m/s. */
  wind: Vector3;
  /** Turbulence torque in the carrier-local frame at sea-level density, kN·m. */
  turbulence: Vector3;
}

export interface CarrierForces {
  /** Net force, world frame, kN. */
  force: Vector3;
  /** Net torque about the centre of mass, world frame, kN·m. */
  torque: Vector3;
  /** Thrust produced by each turbine, kN. */
  thrust: Quad<number>;
  /** Total buoyancy, kN. */
  buoyancy: number;
  /** World-up force from everything except thrust and gravity (drag + water), kN. */
  supportForceY: number;
}

export function createCarrierForces(): CarrierForces {
  return {
    force: new Vector3(),
    torque: new Vector3(),
    thrust: [0, 0, 0, 0],
    buoyancy: 0,
    supportForceY: 0,
  };
}

/** Air density relative to sea level at an altitude (m ASL). */
export function airDensityFactor(altitude: number): number {
  if (!Number.isFinite(altitude)) return 1;
  return Math.exp(-Math.max(0, altitude) / PHYS.densityScaleHeight);
}

/** Thrust multiplier from ground effect for a nozzle `height` metres above mean sea level. */
export function groundEffectFactor(height: number): number {
  if (!Number.isFinite(height)) return 1;
  return 1 + AERO.groundEffectGain * Math.exp(-Math.max(0, height) / AERO.groundEffectHeight);
}

/**
 * Aerodynamic yaw damping, kN·m per (rad/s), at an altitude (m ASL) and airspeed (m/s): the
 * still-air value plus bow and stern sweeping sideways through the passing air.
 */
export function yawDampingCoefficient(altitude: number, airspeed: number): number {
  const sideSlope = AERO.dragLinear[0] + AERO.dragQuadratic[0] * airspeed;
  return (
    airDensityFactor(altitude) * (AERO.angularDamping[1] + sideSlope * AERO.dampingGyration[1])
  );
}

const _mount = new Vector3();

/**
 * Thrust of turbine `index` per unit throttle as a fraction of `PHYS.maxThrust`:
 * air density × ground effect at the ship's current position and attitude.
 */
export function turbineThrustFactor(body: RigidState, index: number): number {
  const m = TURBINE_MOUNTS[index];
  _mount.set(m[0], m[1], m[2]).applyQuaternion(body.quaternion);
  return airDensityFactor(body.position.y) * groundEffectFactor(body.position.y + _mount.y);
}

// ---------------------------------------------------------------------------------------------
// Buoyancy sample columns
// ---------------------------------------------------------------------------------------------

/** A vertical prism of hull (carrier-local): the water it displaces pushes the ship up. */
export interface BuoyancyColumn {
  x: number;
  z: number;
  /** Local y of the bottom of the column. */
  bottomY: number;
  /** Length of the column along local +Y, m. */
  height: number;
  /** Cross-section, m². */
  area: number;
}

/** Half-beam of the underwater hull at station z (m): tapered bow, slightly tapered stern. */
function hullHalfBeam(z: number): number {
  const half = HULL.beam / 2;
  const bow = -HULL.length / 2;
  if (z < bow + 90) return half * (0.12 + 0.88 * ((z - bow) / 90));
  if (z > 120) return half * (1 - 0.3 * ((z - 120) / 40));
  return half;
}

function buildHullColumns(): BuoyancyColumn[] {
  const stations = 13;
  // The outer columns sit close to the hull sides: that is where a wall-sided, hard-chined
  // hull has its waterplane stiffness, and it keeps the ship from listing in a breeze.
  const across = [-0.9, 0, 0.9];
  const spacing = (HULL.length - 20) / (stations - 1);
  const raw: BuoyancyColumn[] = [];
  for (let s = 0; s < stations; s++) {
    const z = -(HULL.length - 20) / 2 + s * spacing;
    const half = hullHalfBeam(z);
    for (const a of across) {
      raw.push({
        x: a * half,
        z,
        bottomY: HULL.keelY,
        height: HULL.deckY - HULL.keelY,
        area: half,
      });
    }
  }
  // The centre of buoyancy must sit under the centre of mass or the ship would float trimmed
  // by the stern (the bow is finer than the stern). Fill the forebody out just enough — a
  // linear fullness correction along the keel — to bring the waterplane centroid to z = 0.
  let sumAz = 0;
  let sumAzz = 0;
  for (const c of raw) {
    sumAz += c.area * c.z;
    sumAzz += c.area * c.z * c.z;
  }
  const fullness = -sumAz / sumAzz;
  let total = 0;
  for (const c of raw) {
    c.area *= 1 + fullness * c.z;
    total += c.area;
  }
  // Scale so the hull displaces exactly its own mass at the design draft.
  const designArea = PHYS.mass / (PHYS.waterDensity * HULL.designDraft);
  for (const c of raw) c.area *= designArea / total;
  return raw;
}

function buildNacelleColumns(): BuoyancyColumn[] {
  return TURBINE_MOUNTS.map((m) => ({
    x: m[0],
    z: m[2],
    bottomY: m[1] - TURBINE.ductHeight / 2,
    height: TURBINE.ductHeight,
    area: HYDRO.nacelleFloatArea,
  }));
}

/** Waterplane area of the hull proper at the design draft, m². */
export const HULL_WATERPLANE_AREA = PHYS.mass / (PHYS.waterDensity * HULL.designDraft);

/** Hull columns followed by the four nacelle floats (which only get wet when the ship heels or plunges). */
export const BUOYANCY_COLUMNS: readonly BuoyancyColumn[] = [
  ...buildHullColumns(),
  ...buildNacelleColumns(),
];

/** Above this altitude the hull cannot touch the water and the column loop is skipped. */
const WATER_CHECK_ALTITUDE = 200;
/** Time offset used to estimate the vertical speed of the water surface, s. */
const WAVE_RATE_DT = 0.05;

// ---------------------------------------------------------------------------------------------
// Force accumulation
// ---------------------------------------------------------------------------------------------

const _qInv = new Quaternion();
const _right = new Vector3();
const _up = new Vector3();
const _back = new Vector3();
const _axis = new Vector3();
const _arm = new Vector3();
const _f = new Vector3();
const _vBody = new Vector3();
const _wBody = new Vector3();
const _torqueBody = new Vector3();

/** Add force `f` acting at offset `arm` from the centre of mass (both world frame). */
function addForceAt(out: CarrierForces, f: Vector3, arm: Vector3): void {
  out.force.add(f);
  out.torque.x += arm.y * f.z - arm.z * f.y;
  out.torque.y += arm.z * f.x - arm.x * f.z;
  out.torque.z += arm.x * f.y - arm.y * f.x;
}

function addThrust(
  out: CarrierForces,
  body: RigidState,
  turbines: readonly TurbineForceState[],
): void {
  for (let i = 0; i < 4; i++) {
    const t = turbines[i];
    const throttle = Number.isFinite(t.throttle) ? clamp01(t.throttle) : 0;
    const tilt = Number.isFinite(t.tilt) ? t.tilt : 0;
    const thrust = PHYS.maxThrust * throttle * turbineThrustFactor(body, i);
    out.thrust[i] = thrust;
    if (thrust <= 0) continue;
    const m = TURBINE_MOUNTS[i];
    _arm.set(m[0], m[1], m[2]).applyQuaternion(body.quaternion);
    thrustAxisLocal(tilt, _axis).applyQuaternion(body.quaternion);
    addForceAt(out, _f.copy(_axis).multiplyScalar(thrust), _arm);
  }
}

function addAerodynamics(out: CarrierForces, body: RigidState, env: CarrierEnvironment): void {
  const density = airDensityFactor(body.position.y);

  // Drag in the body frame, relative to the moving air.
  _vBody.copy(body.velocity).sub(env.wind).applyQuaternion(_qInv);
  const speed = _vBody.length();
  const fx = -density * (AERO.dragLinear[0] + AERO.dragQuadratic[0] * speed) * _vBody.x;
  const fy = -density * (AERO.dragLinear[1] + AERO.dragQuadratic[1] * speed) * _vBody.y;
  const fz = -density * (AERO.dragLinear[2] + AERO.dragQuadratic[2] * speed) * _vBody.z;
  _f.set(fx, fy, fz).applyQuaternion(body.quaternion);
  out.force.add(_f);
  out.supportForceY += _f.y;

  // Rotational damping and turbulence, body frame. Pitch and roll sweep deck area through the
  // air vertically, yaw sweeps the hull sides: each adds the drag slope of that motion at the
  // current airspeed to the still-air damping.
  _wBody.copy(body.angularVelocity).applyQuaternion(_qInv);
  const deckSlope = AERO.dragLinear[1] + AERO.dragQuadratic[1] * speed;
  const dampX = AERO.angularDamping[0] + deckSlope * AERO.dampingGyration[0];
  const dampZ = AERO.angularDamping[2] + deckSlope * AERO.dampingGyration[2];
  _torqueBody.set(
    density * (env.turbulence.x - dampX * _wBody.x),
    density * env.turbulence.y - yawDampingCoefficient(body.position.y, speed) * _wBody.y,
    density * (env.turbulence.z - dampZ * _wBody.z),
  );

  // In a flat fall (or climb) the vertical drag acts ahead of the centre of the deck, toward
  // whichever edge leads into the flow, and so pushes that edge back: the ship rights itself.
  // The shift fades with the share of the flow that goes through the deck, so it plays no
  // part in forward flight.
  if (speed > 0.5) {
    const through = Math.abs(_vBody.y) / speed;
    const shiftX = AERO.pressureShift[0] * (_vBody.x / speed) * through;
    const shiftZ = AERO.pressureShift[1] * (_vBody.z / speed) * through;
    _torqueBody.x -= shiftZ * fy;
    _torqueBody.z += shiftX * fy;
  }
  out.torque.add(_torqueBody.applyQuaternion(body.quaternion));
}

function addWater(out: CarrierForces, body: RigidState, env: CarrierEnvironment): void {
  if (body.position.y > WATER_CHECK_ALTITUDE) return;
  const pos = body.position;
  const vel = body.velocity;
  const w = body.angularVelocity;
  const unitWeight = PHYS.waterDensity * PHYS.gravity;

  for (let i = 0; i < BUOYANCY_COLUMNS.length; i++) {
    const c = BUOYANCY_COLUMNS[i];
    _arm.set(c.x, c.bottomY, c.z).applyQuaternion(body.quaternion);
    const bottomY = pos.y + _arm.y;
    const rise = c.height * _up.y;
    const lowY = rise >= 0 ? bottomY : bottomY + rise;
    const extent = Math.abs(rise);
    const worldX = pos.x + _arm.x;
    const worldZ = pos.z + _arm.z;
    const surface = waveHeightAt(worldX, worldZ, env.time);
    const immersion = surface - lowY;
    if (immersion <= 0) continue;

    const fraction = extent > 0.5 ? Math.min(1, immersion / extent) : 1;
    const wetLength = fraction * c.height;
    // centre of the wet part of the column, as an offset from the centre of mass
    const along = rise >= 0 ? wetLength / 2 : c.height - wetLength / 2;
    _arm.addScaledVector(_up, along);

    const buoyancy = unitWeight * c.area * wetLength;
    const share = (c.area / HULL_WATERPLANE_AREA) * Math.min(1, wetLength / HULL.designDraft);

    // velocity of that point through the water (the surface itself moves up and down)
    const px = vel.x + w.y * _arm.z - w.z * _arm.y;
    const py = vel.y + w.z * _arm.x - w.x * _arm.z;
    const pz = vel.z + w.x * _arm.y - w.y * _arm.x;
    const surfaceRate =
      (surface - waveHeightAt(worldX, worldZ, env.time - WAVE_RATE_DT)) / WAVE_RATE_DT;
    const vHeave = py - surfaceRate;
    const vSide = px * _right.x + py * _right.y + pz * _right.z;
    const vLong = px * _back.x + py * _back.y + pz * _back.z;

    const heave = -share * (HYDRO.heaveDamping + HYDRO.slamDrag * Math.abs(vHeave)) * vHeave;
    const side = -share * (HYDRO.lateralLinear + HYDRO.lateralQuadratic * Math.abs(vSide)) * vSide;
    const long =
      -share * (HYDRO.longitudinalLinear + HYDRO.longitudinalQuadratic * Math.abs(vLong)) * vLong;

    _f.set(0, buoyancy + heave, 0)
      .addScaledVector(_right, side)
      .addScaledVector(_back, long);
    addForceAt(out, _f, _arm);
    out.buoyancy += buoyancy;
    out.supportForceY += _f.y;
  }
}

function isFiniteVector(v: Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/**
 * Net force and torque on the ship (world frame, kN and kN·m about the centre of mass).
 * `turbines` are indexed FL, FR, RL, RR. Writes into `out` and returns it. Allocation-free.
 */
export function computeCarrierForces(
  body: RigidState,
  turbines: readonly TurbineForceState[],
  env: CarrierEnvironment,
  out: CarrierForces,
): CarrierForces {
  out.force.set(0, -WEIGHT, 0);
  out.torque.set(0, 0, 0);
  out.buoyancy = 0;
  out.supportForceY = 0;

  _qInv.copy(body.quaternion).invert();
  _right.set(1, 0, 0).applyQuaternion(body.quaternion);
  _up.set(0, 1, 0).applyQuaternion(body.quaternion);
  _back.set(0, 0, 1).applyQuaternion(body.quaternion);

  addThrust(out, body, turbines);
  addAerodynamics(out, body, env);
  addWater(out, body, env);

  // A corrupt input must never reach the integrator: fall back to plain weight.
  if (!isFiniteVector(out.force) || !isFiniteVector(out.torque)) {
    out.force.set(0, -WEIGHT, 0);
    out.torque.set(0, 0, 0);
    out.buoyancy = 0;
    out.supportForceY = 0;
  }
  return out;
}
