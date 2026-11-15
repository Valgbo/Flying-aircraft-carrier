import { QUALITY_PRESETS, type QualityPreset } from '../config/quality';
import { useGameStore } from './useGameStore';

/** The quality preset currently in effect (re-renders when it changes). */
export function useQuality(): QualityPreset {
  return QUALITY_PRESETS[useGameStore((s) => s.effectiveQuality)];
}

/** Non-reactive read for use inside useFrame / plain modules. */
export function getQuality(): QualityPreset {
  return QUALITY_PRESETS[useGameStore.getState().effectiveQuality];
}
