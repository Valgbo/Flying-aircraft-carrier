/**
 * Vehicle model library: one BufferGeometry per kind and level of detail, built once from
 * VEHICLE_SHAPES (so the 3D model follows the damage model's numbers) and cached.
 */
import type { BufferGeometry } from 'three';
import type { VehicleKind } from '../../../core/targets/types';
import { VEHICLE_SHAPES } from '../../../data/vehicles';
import type { ModelBuilder } from './builder';
import { buildPanel } from './panel';
import { buildTracked } from './tracked';
import { buildApc, buildTruck } from './wheeled';

export const VEHICLE_KINDS: readonly VehicleKind[] = ['mbt', 'ifv', 'apc', 'truckCargo', 'truckFuel', 'truckAmmo', 'hulk', 'panel'];

/** Builds the model of a kind at a level of detail (0 near, 1 far); `detail` 0..2 (quality). */
export function buildVehicleModel(kind: VehicleKind, lod: 0 | 1, detail: number): ModelBuilder {
  const s = VEHICLE_SHAPES[kind];
  const d = detail >= 2 ? 1.25 : detail >= 1 ? 1 : 0.7;
  switch (kind) {
    case 'mbt':
      return buildTracked(s, { style: 'mbt', drums: true, lod }, d);
    case 'hulk':
      return buildTracked(s, { style: 'mbt', drums: false, lod }, d);
    case 'ifv':
      return buildTracked(s, { style: 'ifv', drums: false, lod }, d);
    case 'apc':
      return buildApc(s, lod, d);
    case 'truckCargo':
      return buildTruck(s, 'cargo', lod, d);
    case 'truckFuel':
      return buildTruck(s, 'fuel', lod, d);
    case 'truckAmmo':
      return buildTruck(s, 'ammo', lod, d);
    case 'panel':
      return buildPanel(s, lod, d);
  }
}

export function buildVehicleGeometry(kind: VehicleKind, lod: 0 | 1, detail: number): BufferGeometry {
  return buildVehicleModel(kind, lod, detail).build();
}

/**
 * Developer check: every triangle's winding should agree with its vertex normals (outward faces
 * survive back-face culling). Returns the share of triangles that disagree.
 */
export function windingErrors(g: BufferGeometry): number {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  let bad = 0;
  const tris = p.count / 3;
  for (let t = 0; t < tris; t++) {
    const i = t * 3;
    const ax = p.getX(i);
    const ay = p.getY(i);
    const az = p.getZ(i);
    const e1x = p.getX(i + 1) - ax;
    const e1y = p.getY(i + 1) - ay;
    const e1z = p.getZ(i + 1) - az;
    const e2x = p.getX(i + 2) - ax;
    const e2y = p.getY(i + 2) - ay;
    const e2z = p.getZ(i + 2) - az;
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const nx = n.getX(i) + n.getX(i + 1) + n.getX(i + 2);
    const ny = n.getY(i) + n.getY(i + 1) + n.getY(i + 2);
    const nz = n.getZ(i) + n.getZ(i + 1) + n.getZ(i + 2);
    if (cx * nx + cy * ny + cz * nz < 0) bad++;
  }
  return tris > 0 ? bad / tris : 0;
}
