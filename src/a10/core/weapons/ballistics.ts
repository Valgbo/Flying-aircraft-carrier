/**
 * 30 mm round ballistics: point mass with drag, gravity and wind. The fire-control computer
 * predicts with THESE functions, so the pipper and the rounds always agree (PLAN_A10.md §6.1).
 *
 * FOUNDATION STAND-IN with a constant drag coefficient; the weapons module owner replaces the
 * drag law (Mach-dependent) and keeps the exported signatures.
 */
import { Vector3 } from 'three';
import { GAU8 } from '../../data/gun';
import { G0 } from '../constants';
import { densityAt } from '../world/atmosphere';
import type { Terrain, TerrainHit } from '../world/types';
import { RoundType } from './types';

/** Projectile mass, kg. */
export function roundMass(type: RoundType): number {
  return type === RoundType.API
    ? GAU8.massApi
    : type === RoundType.HEI
      ? GAU8.massHei
      : GAU8.massTp;
}

const AREA = Math.PI * (GAU8.calibre / 2) ** 2;

/** Drag deceleration factor k so that a = -k · ρ · |v_air| · v_air. */
export function dragFactor(type: RoundType, _mach: number): number {
  const cd = 0.3;
  return (0.5 * cd * AREA) / roundMass(type);
}

/**
 * Advance one round by dt (semi-implicit Euler with a midpoint drag estimate).
 * `wind` is the world air velocity at the round. Position and velocity are updated in place.
 */
export function integrateRound(
  type: RoundType,
  pos: Vector3,
  vel: Vector3,
  wind: Vector3,
  dt: number,
): void {
  const rho = densityAt(pos.y);
  const ax = vel.x - wind.x;
  const ay = vel.y - wind.y;
  const az = vel.z - wind.z;
  const speed = Math.hypot(ax, ay, az);
  const k = dragFactor(type, speed / 340) * rho * speed;
  vel.x -= k * ax * dt;
  vel.y -= (k * ay + G0) * dt;
  vel.z -= k * az * dt;
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;
  pos.z += vel.z * dt;
}

export interface RoundPrediction {
  point: Vector3;
  velocity: Vector3;
  time: number;
}

const _p = new Vector3();
const _v = new Vector3();
const _prev = new Vector3();
const _hit: TerrainHit = {
  point: new Vector3(),
  normal: new Vector3(),
  distance: 0,
  t: 0,
  surface: 'grass',
};

/**
 * Fly a round from `origin` with world velocity `velocity` (muzzle velocity + aircraft velocity)
 * until it meets the terrain or `maxTime` passes. Wind is held constant (the fire-control
 * computer only knows the wind at the aircraft). Returns false if no impact within maxTime.
 */
export function predictRoundImpact(
  type: RoundType,
  origin: Vector3,
  velocity: Vector3,
  terrain: Terrain,
  wind: Vector3,
  maxTime: number,
  out: RoundPrediction,
  dt = 1 / 120,
): boolean {
  _p.copy(origin);
  _v.copy(velocity);
  for (let t = 0; t < maxTime; t += dt) {
    _prev.copy(_p);
    integrateRound(type, _p, _v, wind, dt);
    if (terrain.segmentHit(_prev, _p, _hit)) {
      out.point.copy(_hit.point);
      out.velocity.copy(_v);
      out.time = t + dt * _hit.t;
      return true;
    }
  }
  return false;
}
