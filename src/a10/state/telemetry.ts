/** Telemetry snapshot in display units (≈10 Hz) for the React UI and tests. FOUNDATION-OWNED. */
import type { Sim } from '../core/types';
import { msToFpm, msToKt, mToFt, radToDeg } from '../core/units';
import { useA10Store } from './store';

export function publishTelemetry(sim: Sim): void {
  const ac = sim.aircraft;
  let alive = 0;
  for (const v of sim.targets.vehicles)
    if (v.condition === 'intact' || v.condition === 'damaged') alive++;
  useA10Store.getState().setTelemetry({
    time: sim.time,
    ias: msToKt(ac.ias),
    altitude: mToFt(ac.altitude),
    agl: mToFt(ac.agl),
    heading: radToDeg(ac.heading),
    vs: msToFpm(ac.verticalSpeed),
    g: ac.gLoad,
    mach: ac.mach,
    aoa: radToDeg(ac.alpha),
    throttle: (ac.engines[0].lever + ac.engines[1].lever) / 2,
    rounds: sim.gun.rounds,
    masterArm: sim.avionics.masterArm,
    gunPac: sim.avionics.gunPac,
    masterMode: sim.avionics.masterMode,
    crashed: ac.crashed,
    vehiclesAlive: alive,
    vehiclesKilled: sim.targets.killed,
  });
}
