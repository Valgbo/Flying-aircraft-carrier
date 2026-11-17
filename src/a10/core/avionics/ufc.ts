/**
 * The up-front controller's keys the avionics handles (PLAN_A10.md §7; ARCHITECTURE §12.7: "UFC
 * keys for the steerpoint and laser-code entry the avionics module supports").
 *
 * As in the A-10C, the UFC types into a scratchpad and the OSB beside a field enters it: type the
 * four digits of a laser code, then press CODE on the DSMS page (the selected laser-guided
 * bomb's profile) or on the TGP page (the pod's code). With an empty scratchpad CODE moves the
 * cursor digit that INC steps (mfd.ts). Keys (the cockpit's key ids):
 *   0–9        append a digit (up to UFC_ENTRY.scratchpadMax characters)
 *   CLR        empty the scratchpad
 *   STEER_UP / STEER_DN   next / previous steerpoint (as the `steerpoint` command)
 * The other keys (ENT, FUNC, LTR, HACK, MK, DATA, SEL, DEPR, INTEN …) have no function yet.
 */
import { PROFILE_EDIT, UFC_ENTRY } from '../../data/avionics';
import type { Sim } from '../types';
import { cycleSteerpoint } from './navigation';
import { notify, switched } from './notify';

/**
 * The scratchpad read as a laser code (four digits: the first 1–2, the others 1–8, as
 * PROFILE_EDIT allows), or 0 when it is not one.
 */
export function scratchpadLaserCode(text: string): number {
  if (text.length !== 4) return 0;
  let code = 0;
  for (let i = 0; i < 4; i++) {
    const d = text.charCodeAt(i) - 48;
    if (d < PROFILE_EDIT.laserDigitMin[i] || d > PROFILE_EDIT.laserDigitMax[i]) return 0;
    code = code * 10 + d;
  }
  return code;
}

/** A UFC key press (see the file comment). Every press clicks (`switch` event `ufc`). */
export function ufcKey(sim: Sim, key: string): void {
  const pages = sim.avionics.pages;
  switched(sim, 'ufc', key);
  if (key.length === 1 && key >= '0' && key <= '9') {
    if (pages.scratchpad.length < UFC_ENTRY.scratchpadMax) pages.scratchpad += key;
    return;
  }
  switch (key) {
    case 'CLR':
      pages.scratchpad = '';
      break;
    case 'STEER_UP':
      cycleSteerpoint(sim, 1);
      break;
    case 'STEER_DN':
      cycleSteerpoint(sim, -1);
      break;
    default:
      break;
  }
}

/**
 * Take the scratchpad as a laser code for a CODE OSB: the code (the scratchpad is emptied), 0
 * when the scratchpad is empty (the OSB does its other job), or −1 when it holds something that
 * is not a laser code (a message; the scratchpad is kept so the pilot can see and clear it).
 */
export function takeScratchpadCode(sim: Sim): number {
  const pages = sim.avionics.pages;
  if (pages.scratchpad === '') return 0;
  const code = scratchpadLaserCode(pages.scratchpad);
  if (code === 0) {
    notify(sim, `INVALID CODE ${pages.scratchpad}`, 'info');
    return -1;
  }
  pages.scratchpad = '';
  return code;
}
