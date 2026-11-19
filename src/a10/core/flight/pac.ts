/**
 * Precision Attitude Control (PLAN §6.2), part of the A-10's LASTE: while the gun trigger is
 * squeezed the flight controls steady the gun pipper.
 *
 * Active with GUN/PAC at ARM, Master Arm at ARM and the trigger at the first detent (PAC-1) or
 * the second (PAC-2, firing); GUN/PAC at GUNARM arms the gun without PAC. With a one-stage
 * trigger (realism flag `twoStageTrigger` off, the Relaxed preset: "One stage, PAC always on",
 * PLAN §2) PAC is on whenever the gun is armed, GUNARM included, and any press counts as PAC-2.
 *
 * PAC-1 HOLDS: at the squeeze it records the ground point under the pipper (the avionics gun
 * solution) and the positions of the stick and pedals. Every step it computes where that point now
 * appears in the HUD (from the pilot's eye) and drives the pipper back onto it with a
 * proportional–integral–derivative law on the pipper error plus pitch- and yaw-rate damping,
 * through LIMITED series authority on elevator and rudder (data: A10_FCS.pac*): it steadies, it
 * does not aim. The command goes to the surfaces without a slew limit: the elevator and rudder
 * actuators already limit the rate, and a slew limit inside this loop turned any pitch transient
 * into a sustained ≈1 Hz limit cycle (review GFC-1 / FC-1). The integrator stops while the command
 * is saturated (anti-windup), so a large transient settles without a slow overshoot.
 *
 * WALKING THE PIPPER: the pilot's stick and pedals always add to PAC's series command (they move
 * the surfaces mechanically). While they are moved away from where they were when the point was
 * captured (beyond a small band, A10_FCS.pacWalkStick / pacWalkPedal), PAC holds no point: the
 * held point follows the pipper and PAC only damps the body rates lightly, so a small correction
 * moves the pipper smoothly. When the controls come back, PAC captures the point the pilot left
 * the pipper on and holds it. A large input (A10_FCS.pacOverride*) overrides PAC completely. So a
 * pilot who squeezes the first detent a few metres off the target nudges the pipper on and lets
 * go; turbulence and recoil are still opposed in full whenever the controls are still.
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

/**
 * Take the pipper's present ground point as the point to hold, and the present stick and pedal
 * positions as the controls' rest positions. A new engagement also clears the integrators; a
 * re-capture after the pilot walked the pipper keeps them (they hold the out-of-trim force).
 */
function capture(sim: Sim, newEngagement: boolean): void {
  const pac = sim.aircraft.pac;
  const f = sim.aircraft.fcs;
  const gun = sim.avionics.gun;
  const input = sim.input;
  pac.aimValid = gun.valid;
  if (gun.valid) pac.aimPoint.copy(gun.impact);
  f.pacRefPitch = input.pitch;
  f.pacRefRoll = input.roll;
  f.pacRefRudder = input.rudder;
  if (newEngagement) {
    f.pacPrevValid = false;
    f.pacIntAz = 0;
    f.pacIntEl = 0;
  } else {
    // The pipper sits on the new point: the error is zero, its rate carries on.
    f.pacPrevAz = 0;
    f.pacPrevEl = 0;
  }
}

/**
 * Integrate small errors only, and not while the command is saturated in the direction the error
 * pushes it: the integrator trims out the steady drift of a dive and an out-of-trim aircraft, it
 * must not charge up during a transient (it would then overshoot and settle slowly).
 */
function integrate(i: number, gainDt: number, err: number, cmd: number): number {
  if (Math.abs(err) > F.pacIntegralZone) return i;
  if ((cmd >= 1 && err > 0) || (cmd <= -1 && err < 0)) return i;
  return clamp(i + gainDt * err, -F.pacIntegralLimit, F.pacIntegralLimit);
}

export function stepPac(sim: Sim, dt: number): void {
  const ac = sim.aircraft;
  const pac = ac.pac;
  const f = ac.fcs;
  const av = sim.avionics;
  const input = sim.input;

  const twoStage = sim.options.realism.twoStageTrigger;
  const armed =
    av.masterArm === 'ARM' && (twoStage ? av.gunPac === 'ARM' : av.gunPac !== 'SAFE');
  let stage: 0 | 1 | 2 = 0;
  if (armed && input.trigger >= 1) stage = twoStage ? input.trigger : 2;
  const wasActive = pac.active;
  pac.stage = stage;
  pac.active = stage > 0 && !ac.crashed;
  if (!pac.active) {
    // Released: the series command fades out (outside any loop, so a plain ramp is harmless).
    pac.pitchCmd = moveToward(pac.pitchCmd, 0, F.pacReleaseRate, dt);
    pac.yawCmd = moveToward(pac.yawCmd, 0, F.pacReleaseRate, dt);
    pac.aimValid = false;
    pac.overridden = false;
    pac.walking = false;
    f.pacPrevValid = false;
    return;
  }

  const overridden =
    Math.abs(input.pitch) > F.pacOverrideStick ||
    Math.abs(input.roll) > F.pacOverrideStick ||
    Math.abs(input.rudder) > F.pacOverridePedal;
  if (!wasActive) {
    capture(sim, true);
    pac.walking = false;
    f.pacSettleTime = -1;
  }
  const displaced =
    overridden ||
    Math.abs(input.pitch - f.pacRefPitch) > F.pacWalkStick ||
    Math.abs(input.roll - f.pacRefRoll) > F.pacWalkStick ||
    Math.abs(input.rudder - f.pacRefRudder) > F.pacWalkPedal;
  // After a walk the controls are back: damp the pipper to a stop (it still swings with the nose),
  // then hold the point where it stopped. Taking the point at once would pull the pipper back
  // against the pilot's correction.
  let settling = false;
  if (displaced) {
    f.pacSettleTime = -1;
  } else if (pac.walking) {
    if (f.pacSettleTime < 0) {
      f.pacSettleTime = 0;
      f.pacSettleDwell = 0;
    } else {
      f.pacSettleTime += dt;
    }
    const slow =
      f.pacRateAz * f.pacRateAz + f.pacRateEl * f.pacRateEl < F.pacSettleRate * F.pacSettleRate;
    f.pacSettleDwell = slow ? f.pacSettleDwell + dt : 0;
    if (f.pacSettleTime >= F.pacSettleMaxTime || f.pacSettleDwell >= F.pacSettleDwellTime) {
      capture(sim, false);
      f.pacSettleTime = -1;
    } else {
      settling = true;
    }
  }
  if (!pac.aimValid && av.gun.valid) capture(sim, true);
  pac.overridden = overridden;
  pac.walking = displaced || settling;

  // The pipper error to the held point and its rate, also while the pilot walks the pipper or
  // overrides PAC (the held point then follows the pipper), so the rate is right the moment PAC
  // takes over again.
  const sched = qSchedule(ac.dynamicPressure);
  const q = pitchRate(ac.angularVelocity);
  const r = yawRate(ac.angularVelocity);
  let errAz = 0;
  let errEl = 0;
  const tracking = pac.aimValid && av.gun.valid;
  if (tracking) {
    // Where the held point appears from the eye, against where the pipper is now.
    const e = A10_GEOMETRY.eye;
    _eye.set(e.x, e.y, e.z).applyQuaternion(ac.orientation).add(ac.position);
    worldToBody(ac.orientation, _dir.subVectors(pac.aimPoint, _eye), _dir);
    hudAnglesFromBodyDir(_dir, _angles);
    errAz = _angles.az - av.gun.pipperAz;
    errEl = _angles.el - av.gun.pipperEl;
    if (f.pacPrevValid) {
      const k = Math.min(1, dt / F.pacRateFilter);
      f.pacRateAz += ((errAz - f.pacPrevAz) / dt - f.pacRateAz) * k;
      f.pacRateEl += ((errEl - f.pacPrevEl) / dt - f.pacRateEl) * k;
    } else {
      f.pacRateAz = 0;
      f.pacRateEl = 0;
    }
    f.pacPrevAz = errAz;
    f.pacPrevEl = errEl;
    f.pacPrevValid = true;
    if (pac.walking) {
      pac.aimPoint.copy(av.gun.impact);
      f.pacPrevAz = 0;
      f.pacPrevEl = 0;
    }
  } else {
    f.pacPrevValid = false;
  }

  let el = 0;
  let az = 0;
  if (overridden) {
    pac.errorAz = 0;
    pac.errorEl = 0;
  } else {
    let pEl = -F.pacPitchDamping * q;
    let pAz = -F.pacYawDamping * r;
    if (pac.walking) {
      // While the pilot moves the controls PAC damps the body rates lightly (the correction goes
      // through); once they are back it also damps the pipper's motion over the ground.
      pac.errorAz = 0;
      pac.errorEl = 0;
      if (settling && tracking) {
        pEl += F.pacElevRateGain * f.pacRateEl;
        pAz += F.pacAzRateGain * f.pacRateAz;
      }
      el = pEl * sched + f.pacIntEl;
      az = pAz * sched + f.pacIntAz;
    } else {
      pac.errorAz = errAz;
      pac.errorEl = errEl;
      if (tracking) {
        // Pipper below the point → nose up; pipper left of it → nose right. The error is clipped
        // in the proportional term so a large error is closed at a bounded rate and the damping
        // keeps its authority (no saturated swing past the point).
        const lim = F.pacErrorLimit;
        pEl += F.pacElevGain * clamp(errEl, -lim, lim) + F.pacElevRateGain * f.pacRateEl;
        pAz += F.pacAzGain * clamp(errAz, -lim, lim) + F.pacAzRateGain * f.pacRateAz;
      }
      el = pEl * sched + f.pacIntEl;
      az = pAz * sched + f.pacIntAz;
      if (tracking) {
        f.pacIntEl = integrate(f.pacIntEl, F.pacElevIntegral * sched * dt, errEl, el);
        f.pacIntAz = integrate(f.pacIntAz, F.pacAzIntegral * sched * dt, errAz, az);
      }
    }

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
  pac.pitchCmd = clamp(el, -1, 1);
  pac.yawCmd = clamp(az, -1, 1);
}
