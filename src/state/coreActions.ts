/** Wires the store-level actions of the action bus. Called once from main.tsx. */
import { onAction } from './actions';
import { CAMERA_LABELS, isFlyingScreen, useGameStore } from './useGameStore';

let bound = false;

export function bindCoreActions(): void {
  if (bound) return;
  bound = true;
  const store = useGameStore;

  onAction('toggleAssist', () => {
    const s = store.getState();
    if (!isFlyingScreen(s.screen) || s.paused) return;
    s.toggleAssist();
    const on = store.getState().assistEnabled;
    s.pushMessage(
      on ? 'FLIGHT ASSIST ON' : 'FLIGHT ASSIST OFF — MANUAL CONTROL',
      on ? 'info' : 'warn',
    );
  });

  onAction('cycleCamera', () => {
    const s = store.getState();
    if (!isFlyingScreen(s.screen)) return;
    s.cycleCamera();
    s.pushMessage(
      `CAMERA: ${CAMERA_LABELS[store.getState().cameraMode].toUpperCase()}`,
      'info',
      1500,
    );
  });

  onAction('toggleTurbinePanel', () => {
    const s = store.getState();
    if (!isFlyingScreen(s.screen)) return;
    s.toggleTurbinePanel();
  });

  onAction('togglePause', () => {
    const s = store.getState();
    if (s.settingsOpen) {
      s.setSettingsOpen(false);
      return;
    }
    if (!isFlyingScreen(s.screen)) return;
    s.togglePause();
  });

  onAction('resetFlight', () => {
    const s = store.getState();
    if (!isFlyingScreen(s.screen)) return;
    s.resetFlight();
    s.pushMessage('FLIGHT RESET', 'info', 1500);
  });
}
