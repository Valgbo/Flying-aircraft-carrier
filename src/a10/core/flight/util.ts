/** Small numeric helpers shared by the flight-control files. */

/** Dynamic pressure the gain schedules refer to (250 kn at sea level), Pa. */
export const REFERENCE_DYNAMIC_PRESSURE = 0.5 * 1.225 * (250 * 0.514444) ** 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Move toward `target` at no more than `rate` per second. */
export function moveToward(value: number, target: number, rate: number, dt: number): number {
  const step = rate * dt;
  const d = target - value;
  return d > step ? value + step : d < -step ? value - step : target;
}

/**
 * Gain schedule against dynamic pressure: 1 at the reference, inversely proportional (control
 * power grows with q̄, so loop gains shrink with it), bounded.
 */
export function qSchedule(dynamicPressure: number): number {
  return clamp(REFERENCE_DYNAMIC_PRESSURE / Math.max(1, dynamicPressure), 0.25, 4);
}
