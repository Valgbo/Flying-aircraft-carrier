import { debugFlags } from '../config/debugFlags';
import type { CameraMode, QualityLevel, Screen } from './types';
import { useGameStore } from './useGameStore';

const SCREENS: readonly Screen[] = ['menu', 'hangar', 'flight', 'ops'];
const QUALITIES: readonly QualityLevel[] = ['low', 'medium', 'high'];
const CAMERAS: readonly CameraMode[] = ['orbit', 'chase', 'deck', 'bridge', 'turbine'];

/** Apply URL debug flags to the store. Called once at start-up (see debugFlags.ts for the list). */
export function applyDebugFlags(): void {
  const s = useGameStore.getState();
  if (debugFlags.quality && (QUALITIES as readonly string[]).includes(debugFlags.quality)) {
    s.updateSettings({ quality: debugFlags.quality as QualityLevel, adaptiveQuality: false });
  }
  if (debugFlags.time !== null) {
    s.updateSettings({ timeOfDay: ((debugFlags.time % 24) + 24) % 24 });
  }
  if (debugFlags.mute === '1') s.updateSettings({ muted: true });
  if (debugFlags.touch === '1') s.updateSettings({ touchControls: 'on' });
  if (debugFlags.screen && (SCREENS as readonly string[]).includes(debugFlags.screen)) {
    s.setScreen(debugFlags.screen as Screen);
  }
  if (debugFlags.cam && (CAMERAS as readonly string[]).includes(debugFlags.cam)) {
    useGameStore.getState().setCameraMode(debugFlags.cam as CameraMode);
  }
  if (debugFlags.assist === '0') useGameStore.getState().setAssistEnabled(false);
}
