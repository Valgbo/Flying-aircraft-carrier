/** Builds the UI's snapshot of `sim`. Kept free of the store so the store itself can use it. */
import { MS_TO_KTS, RAD2DEG } from '../utils/math';
import { sim } from './sim';
import type { Quad, Telemetry } from './types';

function quad<T>(f: (i: number) => T): Quad<T> {
  return [f(0), f(1), f(2), f(3)];
}

export function buildTelemetry(): Telemetry {
  const c = sim.carrier;
  const t = sim.turbines;
  return {
    time: sim.time,
    altitude: c.altitude,
    keelClearance: c.keelClearance,
    speedKts: c.speed * MS_TO_KTS,
    forwardSpeedKts: c.forwardSpeed * MS_TO_KTS,
    verticalSpeed: c.verticalSpeed,
    headingDeg: c.headingDeg,
    pitchDeg: c.pitch * RAD2DEG,
    rollDeg: c.roll * RAD2DEG,
    gLoad: c.gLoad,
    afloat: c.afloat,
    throttle: quad((i) => t[i].throttle),
    throttleCmd: quad((i) => t[i].throttleCmd),
    tiltDeg: quad((i) => t[i].tilt * RAD2DEG),
    tiltCmdDeg: quad((i) => t[i].tiltCmd * RAD2DEG),
    thrustKN: quad((i) => t[i].thrust),
    enabled: quad((i) => t[i].enabled),
    targetAltitude: sim.controls.targetAltitude,
  };
}
