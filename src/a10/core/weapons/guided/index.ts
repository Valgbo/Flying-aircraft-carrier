/**
 * GUIDED WEAPONS module public API (ARCHITECTURE §12.3, PLAN_A10.md §6.4, §6.6): the AGM-65
 * Maverick and the GBU-12 in flight. The stores module's body integration calls these three
 * functions for bodies of kind 'missile' and 'laserBomb'.
 * FOUNDATION STAND-IN (wave 2): no guidance, no motor — the bodies fly ballistic.
 */
import type { Vector3 } from 'three';
import type { Sim } from '../../types';
import type { ReleaseRequest, StoreBody } from '../types';

/** Commanded acceleration (world, m/s²) within the weapon's limits; zero without a target. */
export function guidanceAccel(_sim: Sim, _body: StoreBody, _dt: number, out: Vector3): void {
  out.set(0, 0, 0);
}

/** Motor thrust along the body axis, N, `t` seconds after launch (0 for bombs). */
export function motorThrust(_body: StoreBody, _t: number): number {
  return 0;
}

/** Hand the launch's lock (Maverick) or laser code (GBU-12) to the new body. */
export function onLaunch(_sim: Sim, body: StoreBody, request: ReleaseRequest): void {
  body.laserCode = request.laserCode;
  body.guidance.vehicleId = request.lockVehicle;
}
