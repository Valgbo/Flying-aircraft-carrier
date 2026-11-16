/**
 * The A-10C low-altitude autopilot (LAAP), for heads-down sensor work (PLAN §5):
 *
 *   PATH     hold the flight-path angle (the velocity vector) and the heading
 *   ALT/HDG  hold barometric altitude and heading
 *   ALT      hold barometric altitude and the bank angle (a steady turn if engaged banked)
 *
 * PATH and ALT/HDG do not engage above 10° of bank. Engaging captures the references. A firm
 * stick input (≈10 lb, here a third of the stick travel), a stall or a crash disengages it.
 *
 * Control laws (outputs are series commands added to elevator and aileron, limited authority):
 *  - vertical: altitude error → climb rate → flight-path command γc; γ error → load-factor
 *    command n_c = cos γ / cos φ + (V/g)·k·(γc − γ); an inner PI loop on the measured normal load
 *    factor with pitch-rate damping, its gains scheduled with 1/q̄;
 *  - lateral: heading error → bank command (limited), or the held bank; a PI loop on bank with
 *    roll-rate damping.
 */
import { A10_FCS as F } from '../../data/aircraft';
import { G0 } from '../constants';
import { pitchRate, rollRate, wrapPi } from '../frames';
import type { Sim } from '../types';
import type { AutopilotMode } from './types';
import { clamp, moveToward, qSchedule } from './util';

const MODES: readonly AutopilotMode[] = ['PATH', 'ALT_HDG', 'ALT'];
const MODE_NAMES: Record<AutopilotMode, string> = { PATH: 'PATH', ALT_HDG: 'ALT/HDG', ALT: 'ALT' };

function message(sim: Sim, text: string, level: 'info' | 'warn' | 'alert'): void {
  sim.events.push({ type: 'message', t: sim.time, text, level });
}

/** Capture the references of the present mode from the present flight state. */
function captureReferences(sim: Sim): void {
  const ac = sim.aircraft;
  const ap = ac.autopilot;
  ap.refAltitude = ac.altitude;
  ap.refHeading = ac.heading;
  ap.refPitch = ac.flightPathAngle;
  ap.refBank = ap.mode === 'ALT' ? ac.bank : 0;
  ac.fcs.apGIntegral = 0;
  ac.fcs.apBankIntegral = 0;
}

/** Engage in the present mode if the bank allows it. Returns whether it engaged. */
export function engageAutopilot(sim: Sim): boolean {
  const ac = sim.aircraft;
  const ap = ac.autopilot;
  const limit = ap.mode === 'ALT' ? F.apAltEngageBankLimit : F.apEngageBankLimit;
  if (ac.crashed || Math.abs(ac.bank) > limit) {
    message(sim, `AUTOPILOT ${MODE_NAMES[ap.mode]}: BANK LIMIT`, 'warn');
    return false;
  }
  captureReferences(sim);
  ap.engaged = true;
  return true;
}

/** Disengage (pilot action or automatic) with the disengage cue. */
export function disengageAutopilot(sim: Sim, automatic: boolean): void {
  const ap = sim.aircraft.autopilot;
  if (!ap.engaged) return;
  ap.engaged = false;
  if (automatic) message(sim, 'AUTOPILOT DISENGAGED', 'warn');
}

/**
 * Autopilot command from the avionics (engage button, paddle, mode selector):
 * 'toggle' engages or disengages, 'disengage' disengages, 'mode' selects the next mode (and
 * re-captures the references when engaged).
 */
export function autopilotCommand(sim: Sim, action: 'toggle' | 'disengage' | 'mode'): void {
  const ap = sim.aircraft.autopilot;
  if (action === 'toggle') {
    if (ap.engaged) disengageAutopilot(sim, false);
    else engageAutopilot(sim);
  } else if (action === 'disengage') {
    disengageAutopilot(sim, false);
  } else {
    ap.mode = MODES[(MODES.indexOf(ap.mode) + 1) % MODES.length];
    if (ap.engaged) {
      ap.engaged = false;
      if (!engageAutopilot(sim)) disengageAutopilot(sim, true);
    }
  }
}

/** Autopilot step: disengage checks, then pitch and roll commands. */
export function stepAutopilot(sim: Sim, dt: number): void {
  const ac = sim.aircraft;
  const ap = ac.autopilot;
  const f = ac.fcs;
  const input = sim.input;
  if (
    ap.engaged &&
    (Math.abs(input.pitch) > F.apDisengageStick ||
      Math.abs(input.roll) > F.apDisengageStick ||
      ac.warnings.stallChopped ||
      ac.crashed)
  ) {
    disengageAutopilot(sim, true);
  }
  if (!ap.engaged) {
    ap.pitchCmd = moveToward(ap.pitchCmd, 0, 2, dt);
    ap.rollCmd = moveToward(ap.rollCmd, 0, 2, dt);
    return;
  }
  const sched = qSchedule(ac.dynamicPressure);
  const v = Math.max(50, ac.tas);

  // ---- vertical ----
  let gammaCmd: number;
  if (ap.mode === 'PATH') {
    gammaCmd = ap.refPitch;
  } else {
    const climb = clamp(
      F.apAltitudeGain * (ap.refAltitude - ac.altitude),
      -F.apClimbRateLimit,
      F.apClimbRateLimit,
    );
    gammaCmd = Math.asin(clamp(climb / v, -0.5, 0.5));
  }
  const cosBank = Math.max(0.3, Math.cos(ac.bank));
  const nCmd = clamp(
    Math.cos(ac.flightPathAngle) / cosBank +
      (v / G0) * F.apGammaGain * (gammaCmd - ac.flightPathAngle),
    -0.5,
    3,
  );
  const nErr = nCmd - ac.gLoad;
  f.apGIntegral = clamp(
    f.apGIntegral + F.apGIntegral * sched * nErr * dt,
    -F.apAuthority,
    F.apAuthority,
  );
  ap.pitchCmd = clamp(
    f.apGIntegral + sched * (F.apGGain * nErr - F.apPitchDamping * pitchRate(ac.angularVelocity)),
    -F.apAuthority,
    F.apAuthority,
  );

  // ---- lateral ----
  const bankCmd =
    ap.mode === 'ALT'
      ? ap.refBank
      : clamp(
          F.apHeadingGain * wrapPi(ap.refHeading - ac.heading),
          -F.apHeadingBankLimit,
          F.apHeadingBankLimit,
        );
  const bankErr = wrapPi(bankCmd - ac.bank);
  f.apBankIntegral = clamp(
    f.apBankIntegral + F.apBankIntegral * sched * bankErr * dt,
    -F.apAuthority / 2,
    F.apAuthority / 2,
  );
  ap.rollCmd = clamp(
    f.apBankIntegral +
      sched * (F.apBankGain * bankErr - F.apRollDamping * rollRate(ac.angularVelocity)),
    -F.apAuthority,
    F.apAuthority,
  );
}
