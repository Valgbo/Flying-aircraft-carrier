/**
 * Detects the moments the hull leaves and meets the water. Pure, so the same logic is tested
 * without a scene; the driver turns the results into game events, toasts and camera shake.
 */

/** Keel this far above the water before the ship counts as airborne again, m (hysteresis against wave chatter). */
const LIFT_OFF_CLEARANCE = 1.5;

export interface WaterContactState {
  /** True while the keel is in the water (with hysteresis). */
  inWater: boolean;
}

export type WaterContactEvent = 'liftOff' | 'splashdown' | null;

export function createWaterContactState(keelClearance: number): WaterContactState {
  return { inWater: keelClearance < 0 };
}

/** Feed the current keel clearance (m); returns the transition that just happened, if any. */
export function updateWaterContact(
  state: WaterContactState,
  keelClearance: number,
): WaterContactEvent {
  if (state.inWater && keelClearance > LIFT_OFF_CLEARANCE) {
    state.inWater = false;
    return 'liftOff';
  }
  if (!state.inWater && keelClearance < 0) {
    state.inWater = true;
    return 'splashdown';
  }
  return null;
}
