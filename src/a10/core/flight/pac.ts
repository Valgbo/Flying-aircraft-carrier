/**
 * Precision Attitude Control (PLAN §6.2), part of the A-10's LASTE: while the gun trigger is
 * squeezed the flight controls steady the gun pipper.
 *
 * Active with GUN/PAC at ARM, Master Arm at ARM and the trigger at the first detent (PAC-1) or
 * the second (PAC-2, firing). With a one-stage trigger (realism flag `twoStageTrigger` off) any
 * press counts as PAC-2.
 *
 * PAC-1: on engagement it records the ground point under the pipper (the avionics gun
 * solution). Every step it computes where that point now appears in the HUD (from the pilot's
 * eye) and drives the pipper back onto it with a proportional–derivative law on the pipper error
 * plus pitch- and yaw-rate damping, through LIMITED series authority on elevator and rudder
 * (data: A10_FCS.pac*): it steadies, it does not aim. The pilot's inputs add on top; a large
 * stick or pedal input overrides PAC, which re-captures the pipper point once the controls are
 * neutral again (so the pilot can walk the pipper).
 *
 * PAC-2: while the gun fires it also feeds forward against the recoil pitching and yawing
 * moment (the external moment the gun writes for this step), at the present elevator and
 * rudder power.
 */
import { Vector3 } from 'three';
import { A10, A10_AERO, A10_FCS as F } from '../../data/aircraft';
import { A10_GEOMETRY } from '../../data/geometry';
import { hudAnglesFromBodyDir, pitchRate, worldToBody, yawRate } from '../frames';
import type { Sim } from '../types';
import { clamp, moveToward, qSchedule } from './util';

const _eye = new Vector3();
const _dir = new Vector3();
const _angles = { az: 0, el: 0 };

/** Record the pipper's present ground point as the point to hold. */
function capture(sim: Sim): void {
  const pac = sim.aircraft.pac;
  const gun = sim.avionics.gun;
  pac.aimValid = gun.valid;
  if (gun.valid) pac.aimPoint.copy(gun.impact);
  sim.aircraft.fcs.pacPrevValid = false;
  sim.aircraft.fcs.pacIntAz = 0;
  sim.aircraft.fcs.pacIntEl = 0;
}

export function stepPac(sim: Sim, dt: number): void {
  const ac = sim.aircraft;
  const pac = ac.pac;
  const f = ac.fcs;
  const av = sim.avionics;
  const input = sim.input;

  const armed = av.gunPac === 'ARM' && av.masterArm === 'ARM';
  let stage: 0 | 1 | 2 = 0;
  if (armed && input.trigger >= 1) stage = sim.options.realism.twoStageTrigger ? input.trigger : 2;
  const wasActive = pac.active;
  pac.stage = stage;
  pac.active = stage > 0 && !ac.crashed;
  if (!pac.active) {
    pac.pitchCmd = moveToward(pac.pitchCmd, 0, F.pacRate, dt);
    pac.yawCmd = moveToward(pac.yawCmd, 0, F.pacRate, dt);
    pac.aimValid = false;
    pac.overridden = false;
    f.pacPrevValid = false;
    return;
  }

  const overridden =
    Math.abs(input.pitch) > F.pacOverrideStick ||
    Math.abs(input.roll) > F.pacOverrideStick ||
    Math.abs(input.rudder) > F.pacOverridePedal;
  if (!wasActive || (pac.overridden && !overridden) || (!pac.aimValid && av.gun.valid)) {
    capture(sim);
  }
  pac.overridden = overridden;

  let el = 0;
  let az = 0;
  if (!overridden) {
    const sched = qSchedule(ac.dynamicPressure);
    if (pac.aimValid && av.gun.valid) {
      // Where the held point appears from the eye, against where the pipper is now.
      const e = A10_GEOMETRY.eye;
      _eye.set(e.x, e.y, e.z).applyQuaternion(ac.orientation).add(ac.position);
      worldToBody(ac.orientation, _dir.subVectors(pac.aimPoint, _eye), _dir);
      hudAnglesFromBodyDir(_dir, _angles);
      const errAz = _angles.az - av.gun.pipperAz;
      const errEl = _angles.el - av.gun.pipperEl;
      if (f.pacPrevValid) {
        const k = Math.min(1, dt / 0.05);
        f.pacRateAz += ((errAz - f.pacPrevAz) / dt - f.pacRateAz) * k;
        f.pacRateEl += ((errEl - f.pacPrevEl) / dt - f.pacRateEl) * k;
      } else {
        f.pacRateAz = 0;
        f.pacRateEl = 0;
      }
      f.pacPrevAz = errAz;
      f.pacPrevEl = errEl;
      f.pacPrevValid = true;
      pac.errorAz = errAz;
      pac.errorEl = errEl;
      // Pipper below the point → nose up; pipper left of it → nose right.
      f.pacIntEl = clamp(f.pacIntEl + F.pacElevIntegral * sched * errEl * dt, -0.6, 0.6);
      f.pacIntAz = clamp(f.pacIntAz + F.pacAzIntegral * sched * errAz * dt, -0.6, 0.6);
      el = F.pacElevGain * errEl + F.pacElevRateGain * f.pacRateEl;
      az = F.pacAzGain * errAz + F.pacAzRateGain * f.pacRateAz;
    }
    el -= F.pacPitchDamping * pitchRate(ac.angularVelocity);
    az -= F.pacYawDamping * yawRate(ac.angularVelocity);
    el = el * sched + f.pacIntEl;
    az = az * sched + f.pacIntAz;

    // PAC-2: cancel the recoil moment the gun applies in this step.
    if (stage === 2 && sim.gun.firing && ac.dynamicPressure > 500) {
      const qS = ac.dynamicPressure * A10.wingArea;
      const pitchPower = qS * A10.mac * A10_AERO.cmElevator * A10_AERO.elevatorMax;
      const yawPower = qS * A10.span * A10_AERO.cnRudder * A10_AERO.rudderMax;
      el += -ac.externalMomentBody.x / pitchPower / F.pacPitchAuthority;
      // Contract +Y moment yaws the nose left; the rudder's yaw (nose right +) cancels it.
      az += ac.externalMomentBody.y / yawPower / F.pacYawAuthority;
    }
  }
  pac.pitchCmd = moveToward(pac.pitchCmd, clamp(el, -1, 1), F.pacRate, dt);
  pac.yawCmd = moveToward(pac.yawCmd, clamp(az, -1, 1), F.pacRate, dt);
}
