/**
 * Wind and turbulence as smooth, deterministic functions of simulation time: a mean wind
 * whose direction veers slowly, gusts made of a few incommensurate sines, and small
 * turbulence torques that nudge the deck. No random numbers, so pause, reset and the tests
 * always see the same air.
 */
import type { Vector3 } from 'three';
import { WIND } from '../config/physicsConfig';

/** Sum of three sines with unrelated frequencies, roughly in [-1, 1]. */
function noise(t: number, f1: number, f2: number, f3: number, phase: number): number {
  return (
    0.5 * Math.sin(f1 * t + phase) +
    0.3 * Math.sin(f2 * t + phase * 2.3 + 1.1) +
    0.2 * Math.sin(f3 * t + phase * 0.7 + 4.2)
  );
}

/**
 * Sample the air at simulation time `time` for a wind `level` (0 = dead calm, 1 = the light
 * air of free flight, WIND.opsLevel on the flight-ops screen).
 * Writes the world wind velocity (m/s) and the turbulence torque in the carrier-local frame
 * (kN·m at sea-level density; it grows with level² like dynamic pressure).
 */
export function sampleWind(
  time: number,
  level: number,
  outWind: Vector3,
  outTurbulence: Vector3,
): void {
  if (!(level > 0) || !Number.isFinite(time)) {
    outWind.set(0, 0, 0);
    outTurbulence.set(0, 0, 0);
    return;
  }
  const direction = 0.9 + 0.6 * Math.sin(0.011 * time + 0.4);
  const along = WIND.meanSpeed + WIND.gustSpeed * noise(time, 0.23, 0.61, 1.37, 0.0);
  const across = WIND.gustSpeed * 0.7 * noise(time, 0.19, 0.53, 1.13, 2.0);
  const cos = Math.cos(direction);
  const sin = Math.sin(direction);
  outWind.set(
    level * (along * cos - across * sin),
    level * WIND.gustSpeed * 0.3 * noise(time, 0.31, 0.83, 1.71, 5.0),
    level * (along * sin + across * cos),
  );
  const gain = level * level;
  outTurbulence.set(
    gain * WIND.turbulenceTorque[0] * noise(time, 0.37, 0.97, 1.93, 1.0),
    gain * WIND.turbulenceTorque[1] * noise(time, 0.29, 0.71, 1.51, 3.0),
    gain * WIND.turbulenceTorque[2] * noise(time, 0.43, 1.09, 2.17, 4.0),
  );
}
