/**
 * Turbine actuator dynamics: how the real throttle and nacelle tilt follow their commands.
 * Pure and allocation-free; shared by the Rapier driver and the test integrator.
 *
 *   throttle  first-order spool lag, faster up than down (PHYS.spoolUpRate / spoolDownRate)
 *   tilt      constant slew rate (PHYS.tiltRate) inside [PHYS.tiltMin, PHYS.tiltMax]
 *   disabled  the engine ignores its command and spools down to zero
 */
import { PHYS } from '../config/physicsConfig';
import type { Quad, TurbineSim } from '../state/types';
import { clamp, clamp01, moveToward } from '../utils/math';

/** Below this the fan is considered stopped (avoids an endless exponential tail). */
const THROTTLE_EPSILON = 1e-4;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Advance one turbine's throttle and tilt by `dt` seconds toward its (sanitised) commands. */
export function stepTurbineActuator(turbine: TurbineSim, dt: number): void {
  turbine.throttleCmd = turbine.enabled ? clamp01(finiteOr(turbine.throttleCmd, 0)) : 0;
  turbine.tiltCmd = clamp(finiteOr(turbine.tiltCmd, 0), PHYS.tiltMin, PHYS.tiltMax);

  const throttle = clamp01(finiteOr(turbine.throttle, 0));
  const rate = turbine.throttleCmd > throttle ? PHYS.spoolUpRate : PHYS.spoolDownRate;
  let next = throttle + (turbine.throttleCmd - throttle) * (1 - Math.exp(-rate * dt));
  if (turbine.throttleCmd === 0 && next < THROTTLE_EPSILON) next = 0;
  turbine.throttle = next;

  const tilt = clamp(finiteOr(turbine.tilt, 0), PHYS.tiltMin, PHYS.tiltMax);
  turbine.tilt = moveToward(tilt, turbine.tiltCmd, PHYS.tiltRate * dt);
}

export function stepTurbineActuators(turbines: Quad<TurbineSim>, dt: number): void {
  for (let i = 0; i < 4; i++) stepTurbineActuator(turbines[i], dt);
}
