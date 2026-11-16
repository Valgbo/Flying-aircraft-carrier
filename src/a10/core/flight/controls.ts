/**
 * stepFlightControls (docs/a10/ARCHITECTURE.md §3, step 2): stick, pedals, trim, SAS, PAC and
 * autopilot → surface commands → hydraulic actuators; flaps, gear, speed brakes and slats.
 *
 * The A-10 has mechanical, hydraulically powered controls with a series stability augmentation
 * system (data: A10_FCS):
 *  - pitch SAS: pitch-rate damper through a washout (steady turns are not opposed), limited
 *    authority, gain ∝ 1/V so the added damping is the same at every speed;
 *  - yaw SAS: yaw damper (washed out), sideslip feedback (turn coordination, the role of the
 *    lateral accelerometer) and an aileron–rudder interconnect, limited authority;
 *  - trim: the hat moves the trim at fixed rates; with the realism flag `autoTrim` the trim runs
 *    itself while the stick is neutral: pitch toward the load factor that holds the present
 *    flight path (n = cos γ / cos φ), roll toward zero roll rate, rudder toward zero sideslip;
 *  - PAC and the low-altitude autopilot add limited-authority series commands (pac.ts,
 *    autopilot.ts).
 */
import { A10, A10_FCS as F } from '../../data/aircraft';
import { pitchRate, rollRate, yawRate } from '../frames';
import type { Sim } from '../types';
import { stepAutopilot } from './autopilot';
import { stepPac } from './pac';
import { startTrim } from './trim';
import { clamp, moveToward, qSchedule } from './util';

const DEG = Math.PI / 180;

/** Hydraulic actuator: first-order lag plus a rate limit. */
function actuate(pos: number, cmd: number, rate: number, dt: number): number {
  const lagged = pos + (cmd - pos) * Math.min(1, dt / F.actuatorLag);
  return moveToward(pos, lagged, rate, dt);
}

function stepTrim(sim: Sim, dt: number): void {
  const ac = sim.aircraft;
  const input = sim.input;
  const t = ac.trim;
  t.pitch = clamp(t.pitch + clamp(input.trimPitch, -1, 1) * F.pitchTrimRate * dt, -1, 1);
  t.roll = clamp(t.roll + clamp(input.trimRoll, -1, 1) * F.rollTrimRate * dt, -1, 1);
  t.yaw = clamp(t.yaw + clamp(input.trimYaw, -1, 1) * F.yawTrimRate * dt, -1, 1);
  if (!sim.options.realism.autoTrim || ac.autopilot.engaged || ac.tas < 30) return;
  // Automatic trim (Standard and Relaxed presets) while the controls are neutral.
  const db = F.autoTrimDeadband;
  const sched = qSchedule(ac.dynamicPressure);
  if (Math.abs(input.pitch) < db && input.trimPitch === 0 && ac.pac.stage === 0) {
    const cosBank = Math.max(0.5, Math.cos(ac.bank));
    const nTarget = Math.cos(ac.flightPathAngle) / cosBank;
    const err = clamp(nTarget - ac.gLoad, -1, 1);
    t.pitch = clamp(t.pitch + F.autoTrimPitchGain * sched * err * dt, -1, 1);
  }
  if (Math.abs(input.roll) < db && input.trimRoll === 0) {
    const p = clamp(rollRate(ac.angularVelocity), -0.5, 0.5);
    t.roll = clamp(t.roll - F.autoTrimRollGain * sched * p * dt, -1, 1);
  }
  if (Math.abs(input.rudder) < db && input.trimYaw === 0) {
    const b = clamp(ac.beta, -0.2, 0.2);
    t.yaw = clamp(t.yaw + F.autoTrimYawGain * sched * b * dt, -1, 1);
  }
}

/** Flaps follow the handle at their travel rate; DN and MVR blow back at high speed. */
function stepFlaps(sim: Sim, dt: number): void {
  const ac = sim.aircraft;
  const f = ac.fcs;
  let handle: number = ac.flapHandle;
  const h = F.flapBlowupHysteresis;
  if (handle === 2) {
    if (ac.ias > F.flapLimitDn) f.flapDnBlown = true;
    else if (ac.ias < F.flapLimitDn - h) f.flapDnBlown = false;
    if (f.flapDnBlown) handle = 1;
  } else f.flapDnBlown = false;
  if (handle >= 1) {
    if (ac.ias > F.flapLimitMvr) f.flapMvrBlown = true;
    else if (ac.ias < F.flapLimitMvr - h) f.flapMvrBlown = false;
    if (f.flapMvrBlown) handle = 0;
  } else f.flapMvrBlown = false;
  const target = A10.flapAngles[handle];
  const rate = A10.flapAngles[2] / F.flapTravelTime;
  ac.surfaces.flaps = moveToward(ac.surfaces.flaps, target, rate, dt);
}

/** Leading-edge slats: out at high angle of attack, in again below a lower angle. */
function stepSlats(sim: Sim, dt: number): void {
  const ac = sim.aircraft;
  const s = ac.surfaces;
  const out = s.slats > 0.5;
  const want = out ? ac.alpha > F.slatRetractAlpha : ac.alpha > F.slatExtendAlpha;
  s.slats = moveToward(s.slats, want ? 1 : 0, 1 / F.slatTravelTime, dt);
}

/** Flight controls → surface positions (see the file comment). */
export function stepFlightControls(sim: Sim, dt: number): void {
  const ac = sim.aircraft;
  const input = sim.input;
  const f = ac.fcs;
  if (f.trimPending) startTrim(sim);
  if (ac.crashed) return;

  ac.engines[0].lever = clamp(input.throttle[0], 0, 1);
  ac.engines[1].lever = clamp(input.throttle[1], 0, 1);

  stepTrim(sim, dt);

  // Speed-brake switch moves the command while held; the decelerons follow.
  if (input.speedBrake !== 0) {
    ac.speedBrakeCmd = clamp(
      ac.speedBrakeCmd + (input.speedBrake * dt) / F.speedBrakeTravelTime,
      0,
      1,
    );
  }
  const s = ac.surfaces;
  s.speedBrake = moveToward(s.speedBrake, ac.speedBrakeCmd, 1 / F.speedBrakeTravelTime, dt);
  stepFlaps(sim, dt);
  ac.gearPosition = moveToward(ac.gearPosition, ac.gearDown ? 1 : 0, 1 / F.gearTravelTime, dt);
  stepSlats(sim, dt);

  stepAutopilot(sim, dt);
  stepPac(sim, dt);
  const pac = ac.pac;
  const ap = ac.autopilot;

  // ---- lateral command first: the yaw SAS interconnect reads it ----
  f.aileronCmd = clamp(input.roll + ac.trim.roll * F.rollTrimAuthority + ap.rollCmd, -1, 1);

  // ---- SAS ----
  const v = Math.max(40, ac.tas);
  const speedSched = clamp(F.gainReferenceSpeed / v, 0.4, 3);
  const q = pitchRate(ac.angularVelocity);
  const r = yawRate(ac.angularVelocity);
  // Washouts: the low-passed rate is the filter state; the damper acts on the rest.
  f.pitchWashout += (q - f.pitchWashout) * Math.min(1, dt / F.pitchSasWashout);
  f.yawWashout += (r - f.yawWashout) * Math.min(1, dt / F.yawSasWashout);
  const pitchSas = clamp(
    -F.pitchSasGain * speedSched * (q - f.pitchWashout),
    -F.pitchSasAuthority,
    F.pitchSasAuthority,
  );
  const coordination = ac.tas > 40 ? F.yawSasBetaGain * clamp(ac.beta, -10 * DEG, 10 * DEG) : 0;
  const yawSas = clamp(
    -F.yawSasGain * speedSched * (r - f.yawWashout) +
      coordination +
      F.yawSasAileronGain * f.aileronCmd,
    -F.yawSasAuthority,
    F.yawSasAuthority,
  );

  // ---- surface commands ----
  f.elevatorCmd = clamp(
    input.pitch +
      ac.trim.pitch * F.pitchTrimAuthority +
      pitchSas +
      pac.pitchCmd * F.pacPitchAuthority +
      ap.pitchCmd,
    -1,
    1,
  );
  f.rudderCmd = clamp(
    input.rudder + ac.trim.yaw * F.yawTrimAuthority + yawSas + pac.yawCmd * F.pacYawAuthority,
    -1,
    1,
  );
  s.elevator = actuate(s.elevator, f.elevatorCmd, F.elevatorRate, dt);
  s.aileron = actuate(s.aileron, f.aileronCmd, F.aileronRate, dt);
  s.rudder = actuate(s.rudder, f.rudderCmd, F.rudderRate, dt);
}
