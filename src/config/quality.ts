import type { QualityLevel } from '../state/types';

/** Everything that scales with the graphics preset. Read it via `useQuality()` (src/state/useQuality.ts). */
export interface QualityPreset {
  /** Device-pixel-ratio range handed to the R3F <Canvas dpr>. */
  dpr: [min: number, max: number];
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  /** Segments per side of the ocean grid. */
  oceanSegments: number;
  /** Exhaust particles per turbine. */
  exhaustParticles: number;
  /** Number of cloud puffs / sprites. */
  cloudCount: number;
  /** Master switch for the post-processing chain. */
  postprocessing: boolean;
  bloom: boolean;
  heatDistortion: boolean;
  /** Number of instanced deck-edge / runway lights. */
  deckLights: number;
  /** Fine geometric detail on the ship (greebles, railings, antennas). */
  detail: 0 | 1 | 2;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: {
    dpr: [0.75, 1],
    antialias: false,
    shadows: false,
    shadowMapSize: 1024,
    oceanSegments: 96,
    exhaustParticles: 500,
    cloudCount: 24,
    postprocessing: false,
    bloom: false,
    heatDistortion: false,
    deckLights: 60,
    detail: 0,
  },
  medium: {
    dpr: [1, 1.5],
    antialias: true,
    shadows: true,
    shadowMapSize: 2048,
    oceanSegments: 160,
    exhaustParticles: 1400,
    cloudCount: 48,
    postprocessing: true,
    bloom: true,
    heatDistortion: false,
    deckLights: 140,
    detail: 1,
  },
  high: {
    dpr: [1, 2],
    antialias: true,
    shadows: true,
    shadowMapSize: 4096,
    oceanSegments: 256,
    exhaustParticles: 2500,
    cloudCount: 80,
    postprocessing: true,
    bloom: true,
    heatDistortion: true,
    deckLights: 220,
    detail: 2,
  },
};

export const QUALITY_ORDER: readonly QualityLevel[] = ['low', 'medium', 'high'];

export function lowerQuality(q: QualityLevel): QualityLevel {
  const i = QUALITY_ORDER.indexOf(q);
  return QUALITY_ORDER[Math.max(0, i - 1)];
}
