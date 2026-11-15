/**
 * Read-only helpers that turn `sim` + the ship layout into world-space quantities.
 * Allocation-free: pass output objects in. Safe to call from any useFrame.
 */
import { Vector3 } from 'three';
import { TURBINE, TURBINE_MOUNTS, type Vec3Tuple } from '../config/layout';
import { smoothstep } from '../utils/math';
import { sim } from './sim';
import type { TurbineSim } from './types';

/** Carrier-local point → world point. Accepts a tuple or a Vector3. */
export function carrierLocalToWorld(local: Vec3Tuple | Vector3, out: Vector3): Vector3 {
  if (local instanceof Vector3) out.copy(local);
  else out.set(local[0], local[1], local[2]);
  return out.applyQuaternion(sim.carrier.quaternion).add(sim.carrier.position);
}

/** Carrier-local direction → world direction (no translation). */
export function carrierDirToWorld(local: Vec3Tuple | Vector3, out: Vector3): Vector3 {
  if (local instanceof Vector3) out.copy(local);
  else out.set(local[0], local[1], local[2]);
  return out.applyQuaternion(sim.carrier.quaternion);
}

const _qInv = sim.carrier.quaternion.clone();

/** World point → carrier-local point. */
export function worldToCarrierLocal(world: Vector3, out: Vector3): Vector3 {
  _qInv.copy(sim.carrier.quaternion).invert();
  return out.copy(world).sub(sim.carrier.position).applyQuaternion(_qInv);
}

/**
 * Unit thrust axis of a turbine in the CARRIER-LOCAL frame for a given tilt (rad).
 * This is the direction of the force on the ship: straight up at tilt 0, leaning toward
 * the bow (-Z) for positive tilt. The exhaust leaves in the opposite direction.
 */
export function thrustAxisLocal(tilt: number, out: Vector3): Vector3 {
  return out.set(0, Math.cos(tilt), -Math.sin(tilt));
}

/**
 * World-space exhaust exit of turbine `index`: `outPos` = centre of the nozzle exit plane,
 * `outDir` = unit direction the exhaust travels (opposite to the thrust axis).
 */
export function getTurbineExhaust(index: number, outPos: Vector3, outDir: Vector3): void {
  const m = TURBINE_MOUNTS[index];
  thrustAxisLocal(sim.turbines[index].tilt, outDir).negate();
  outPos
    .set(m[0], m[1], m[2])
    .addScaledVector(outDir, TURBINE.ductHeight / 2)
    .applyQuaternion(sim.carrier.quaternion)
    .add(sim.carrier.position);
  outDir.applyQuaternion(sim.carrier.quaternion);
}

export interface Downwash {
  /** World x/z where the exhaust column meets mean sea level. */
  x: number;
  z: number;
  /** Distance from the nozzle to the water along the exhaust, m (Infinity if it never hits). */
  distance: number;
  /** 0..1 — how hard the jet is hitting the water (throttle × proximity). 0 above ≈ 90 m. */
  strength: number;
}

const _p = new Vector3();
const _d = new Vector3();

/** Where and how strongly turbine `index` blasts the sea surface. */
export function getDownwash(index: number, out: Downwash): Downwash {
  getTurbineExhaust(index, _p, _d);
  if (_d.y > -0.08 || _p.y <= 0) {
    // pointing sideways / up, or the nozzle itself is under water
    out.x = _p.x;
    out.z = _p.z;
    out.distance = _p.y <= 0 ? 0 : Infinity;
    out.strength = _p.y <= 0 ? sim.turbines[index].throttle : 0;
    return out;
  }
  const dist = -_p.y / _d.y;
  out.x = _p.x + _d.x * dist;
  out.z = _p.z + _d.z * dist;
  out.distance = dist;
  out.strength = sim.turbines[index].throttle * (1 - smoothstep(20, 90, dist));
  return out;
}

/** Fan speed as a fraction of maximum (0..1): running engines idle at 10 %. */
export function turbineRpmFraction(t: TurbineSim): number {
  return t.enabled ? 0.1 + 0.9 * t.throttle : t.throttle;
}
