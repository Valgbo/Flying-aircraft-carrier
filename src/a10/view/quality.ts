/**
 * Graphics presets for the A-10 view. FOUNDATION-OWNED (docs/a10/ARCHITECTURE.md §6).
 * Everything expensive scales with these; read them with `getA10Quality()` (per frame) or
 * `useA10Quality()` (React).
 */
import { useA10Store, type QualityLevel } from '../state/store';

export interface A10Quality {
  level: QualityLevel;
  /** Terrain mesh detail: 0 coarse … 2 fine (tile resolution / LOD distances). */
  terrainDetail: 0 | 1 | 2;
  /** Instanced trees drawn near the aircraft. */
  treeCount: number;
  /** Distance to which individual trees are drawn, m. */
  treeDistance: number;
  /** Live particles across all effects. */
  particles: number;
  /** Shadow maps (cockpit and nearby objects). */
  shadows: boolean;
  shadowMapSize: number;
  /** Sensor picture size (pixels, square) and update rate (Hz). */
  sensorResolution: number;
  sensorRate: number;
  /** Post-processing chain (bloom, tone mapping pass). */
  postprocessing: boolean;
  /** Cloud puffs. */
  clouds: number;
  /** Fine detail on models (0..2). */
  detail: 0 | 1 | 2;
}

export const A10_QUALITY: Record<QualityLevel, A10Quality> = {
  low: {
    level: 'low',
    terrainDetail: 0,
    treeCount: 6000,
    treeDistance: 1500,
    particles: 4000,
    shadows: false,
    shadowMapSize: 1024,
    sensorResolution: 256,
    sensorRate: 15,
    postprocessing: false,
    clouds: 16,
    detail: 0,
  },
  medium: {
    level: 'medium',
    terrainDetail: 1,
    treeCount: 20000,
    treeDistance: 3000,
    particles: 10000,
    shadows: true,
    shadowMapSize: 2048,
    sensorResolution: 384,
    sensorRate: 20,
    postprocessing: false,
    clouds: 32,
    detail: 1,
  },
  high: {
    level: 'high',
    terrainDetail: 2,
    treeCount: 45000,
    treeDistance: 5000,
    particles: 20000,
    shadows: true,
    shadowMapSize: 4096,
    sensorResolution: 512,
    sensorRate: 30,
    postprocessing: true,
    clouds: 56,
    detail: 2,
  },
};

export function getA10Quality(): A10Quality {
  return A10_QUALITY[useA10Store.getState().settings.quality];
}

export function useA10Quality(): A10Quality {
  return A10_QUALITY[useA10Store((s) => s.settings.quality)];
}
