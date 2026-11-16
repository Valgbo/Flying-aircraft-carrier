/**
 * Camera shake and vibration requests. FOUNDATION-OWNED interface (docs/a10/ARCHITECTURE.md §6):
 * effects, the gun, explosions and buffet ADD requests; the camera rig (cockpit module) SAMPLES
 * them each frame and applies them as small head/camera rotations and offsets.
 */

export interface ShakeState {
  /** Broadband shake amplitude (0..1), decays exponentially. */
  impulse: number;
  /** Continuous vibration set per frame by its source (0..1), with a frequency in Hz. */
  vibration: number;
  vibrationHz: number;
}

export const shakeState: ShakeState = { impulse: 0, vibration: 0, vibrationHz: 0 };

/** A one-off jolt (explosion nearby, store release). 0.1 small … 1 violent. */
export function addShake(amount: number): void {
  shakeState.impulse = Math.min(1.5, shakeState.impulse + amount);
}

/**
 * A continuous vibration for this frame (the gun at 65 Hz, buffet near the stall). The largest
 * request of the frame wins; the camera rig clears it after sampling.
 */
export function setVibration(amount: number, hz: number): void {
  if (amount > shakeState.vibration) {
    shakeState.vibration = amount;
    shakeState.vibrationHz = hz;
  }
}
