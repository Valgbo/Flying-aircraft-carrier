/**
 * SENSORS module public API (wave 2): targeting pod, Maverick seekers, laser.
 * FOUNDATION STAND-IN: state constructor and a no-op step.
 */
import { Vector3 } from 'three';
import type { Sim } from '../types';
import type { SensorsState } from './types';

export type * from './types';

export function createSensorsState(): SensorsState {
  return {
    tgp: {
      powered: true,
      warmup: 0,
      los: new Vector3(0, -1, 0),
      point: new Vector3(),
      pointValid: false,
      mode: 'INR',
      trackedVehicle: -1,
      picture: 'WHOT',
      fov: (4 * Math.PI) / 180,
      fovSetting: 'WIDE',
      zoom: 1,
      masked: false,
      lasing: false,
      laserCode: 1688,
      laserRange: 0,
      gimbalAz: 0,
      gimbalEl: -Math.PI / 2,
      latched: false,
      spot: new Vector3(),
      spotValid: false,
    },
    mavericks: [],
    selectedMaverick: -1,
  };
}

export function stepSensors(_sim: Sim, _dt: number): void {}

/**
 * Contrast of a vehicle against its background for a sensor band, 0..1, seen from `from`
 * (ARCHITECTURE §12.5). The seekers lock on it and the sensor pictures use the same inputs.
 * FOUNDATION STAND-IN: a crude guess from the vehicle's heat (IR) or a constant (TV).
 */
export function targetContrast(
  sim: Sim,
  vehicleId: number,
  band: 'IR' | 'TV',
  _from: Vector3,
): number {
  const v = sim.targets.vehicles.find((x) => x.id === vehicleId);
  if (!v) return 0;
  if (band === 'TV') return 0.5;
  // Hottest part above ambient (K), saturating at ≈40 K; a fire is always hot.
  const h = Math.max(v.heat.engine, v.heat.exhaust, v.heat.running, v.heat.hull);
  return Math.min(1, Math.max(v.fire, h / 40));
}
