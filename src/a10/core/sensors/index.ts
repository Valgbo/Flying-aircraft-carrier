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
    },
    mavericks: [],
    selectedMaverick: -1,
  };
}

export function stepSensors(_sim: Sim, _dt: number): void {}
