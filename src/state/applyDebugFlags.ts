import { debugFlags } from '../config/debugFlags';
import type { CameraMode, QualityLevel, Screen } from './types';
import { overrideSettings, useGameStore, type Settings } from './useGameStore';

const SCREENS: readonly Screen[] = ['menu', 'hangar', 'flight', 'ops'];
const QUALITIES: readonly QualityLevel[] = ['low', 'medium', 'high'];
const CAMERAS: readonly CameraMode[] = ['orbit', 'chase', 'deck', 'bridge', 'turbine'];

/**
 * Apply URL debug flags to the store. Called once at start-up (see debugFlags.ts for the list).
 * Flags that touch a setting override it for this session without changing what is saved.
 */
export function applyDebugFlags(): void {
  const s = useGameStore.getState();
  const settings: Partial<Settings> = {};
  if (debugFlags.quality && (QUALITIES as readonly string[]).includes(debugFlags.quality)) {
    settings.quality = debugFlags.quality as QualityLevel;
    settings.adaptiveQuality = false;
  }
  if (debugFlags.time !== null) settings.timeOfDay = ((debugFlags.time % 24) + 24) % 24;
  if (debugFlags.mute === '1') settings.muted = true;
  if (debugFlags.touch === '1') settings.touchControls = 'on';
  if (Object.keys(settings).length > 0) overrideSettings(settings);
  if (debugFlags.screen && (SCREENS as readonly string[]).includes(debugFlags.screen)) {
    s.setScreen(debugFlags.screen as Screen);
  }
  if (debugFlags.cam && (CAMERAS as readonly string[]).includes(debugFlags.cam)) {
    useGameStore.getState().setCameraMode(debugFlags.cam as CameraMode);
  }
  if (debugFlags.assist === '0') useGameStore.getState().setAssistEnabled(false);
}
