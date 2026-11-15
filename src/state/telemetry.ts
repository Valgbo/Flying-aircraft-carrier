/** Publishes a ≈10 Hz snapshot of `sim` into the store for React UI (HUD, panels, tests). */
import { buildTelemetry } from './telemetrySnapshot';
import { useGameStore } from './useGameStore';

const INTERVAL_MS = 100;
let lastPublish = -Infinity;

export { buildTelemetry };

/**
 * Push the current sim state to the store, at most every 100 ms (pass `force` to bypass).
 * Drivers call this every frame after updateDerived().
 */
export function publishTelemetry(force = false): void {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!force && now - lastPublish < INTERVAL_MS) return;
  lastPublish = now;
  useGameStore.getState().setTelemetry(buildTelemetry());
}
