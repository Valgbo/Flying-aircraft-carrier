/**
 * The two multifunction displays (PLAN_A10.md §7, "Display pages"): which page each shows, the
 * pages that can be the sensor of interest, and the option-select buttons (OSBs).
 *
 * OSBs are numbered as on the A-10C's displays: 1–5 along the top (left to right), 6–10 down the
 * right side, 11–15 along the bottom (right to left), 16–20 up the left side. The bottom row
 * selects pages on every page (our default assignment; the real aircraft lets the pilot set it).
 * Each page has a table of its own buttons with their labels, so the display view draws the
 * labels from the same table that handles the presses; wave 2 fills the TGP, MAV and TAD rows and
 * the full DSMS layout.
 */
import type { Sim } from '../types';
import { notify, switched } from './notify';
import { cycleProfile } from './profiles';
import type { MfdPage } from './types';

export type Display = 'L' | 'R';

/** Pages that can be the sensor of interest (sensor pages). */
export const SOI_PAGES: readonly MfdPage[] = ['TAD', 'TGP', 'MAV'];

/** Order in which a short coolie press steps through a display's pages. */
export const PAGE_CYCLE: readonly MfdPage[] = ['TAD', 'TGP', 'MAV', 'DSMS', 'STAT'];

/** Bottom-row page selection: OSB number → page. */
export const PAGE_SELECT_OSB: Readonly<Record<number, MfdPage>> = {
  15: 'TAD',
  14: 'TGP',
  13: 'MAV',
  12: 'DSMS',
  11: 'STAT',
};

export interface OsbBinding {
  /** Label shown next to the button. */
  label: string;
  press(sim: Sim, display: Display): void;
}

/**
 * Per-page buttons (wave 1: profile stepping on the DSMS page). Wave 2 adds the TGP, MAV, TAD and
 * the DSMS profile-settings rows here.
 */
export const OSB_TABLE: Record<MfdPage, Partial<Record<number, OsbBinding>>> = {
  DSMS: {
    6: { label: 'PROF+', press: (sim) => void cycleProfile(sim, 1) },
    7: { label: 'PROF-', press: (sim) => void cycleProfile(sim, -1) },
  },
  TGP: {},
  MAV: {},
  TAD: {},
  STAT: {},
  MSG: {},
};

export function pageOf(sim: Sim, display: Display): MfdPage {
  return display === 'L' ? sim.avionics.mfd.left : sim.avionics.mfd.right;
}

/** The binding of a button on a page: the page's own, else the page-select row. */
export function osbBinding(page: MfdPage, button: number): OsbBinding | null {
  const own = OSB_TABLE[page][button];
  if (own) return own;
  const target = PAGE_SELECT_OSB[button];
  if (target) {
    return {
      label: target,
      press: (sim, display) => setMfdPage(sim, display, target),
    };
  }
  return null;
}

/**
 * Show `page` on a display. When the display was the sensor of interest and the new page cannot
 * be (DSMS, STAT, MSG), the SOI returns to the HUD.
 */
export function setMfdPage(sim: Sim, display: Display, page: MfdPage): void {
  const av = sim.avionics;
  if (pageOf(sim, display) === page) return;
  if (display === 'L') av.mfd.left = page;
  else av.mfd.right = page;
  switched(sim, display === 'L' ? 'leftMfd' : 'rightMfd', page);
  const soiHere = (display === 'L' && av.soi === 'LMFD') || (display === 'R' && av.soi === 'RMFD');
  if (soiHere && !SOI_PAGES.includes(page)) {
    av.soi = 'HUD';
    switched(sim, 'soi', 'HUD');
  }
}

/** Show the next page of the cycle on a display (coolie left / right short). */
export function cyclePage(sim: Sim, display: Display): void {
  const cur = PAGE_CYCLE.indexOf(pageOf(sim, display));
  setMfdPage(sim, display, PAGE_CYCLE[(cur + 1) % PAGE_CYCLE.length]);
}

/** An OSB press: the click, then the page's handler. */
export function pressOsb(sim: Sim, display: Display, button: number): void {
  if (!Number.isInteger(button) || button < 1 || button > 20) return;
  switched(sim, 'osb', `${display}${button}`);
  osbBinding(pageOf(sim, display), button)?.press(sim, display);
}

/** Make a display the sensor of interest if its page can be (A-10C: TAD, TGP or MAV only). */
export function selectMfdSoi(sim: Sim, display: Display): boolean {
  const av = sim.avionics;
  const page = pageOf(sim, display);
  const soi = display === 'L' ? 'LMFD' : 'RMFD';
  if (!SOI_PAGES.includes(page)) {
    notify(sim, `${display === 'L' ? 'LEFT' : 'RIGHT'} MFCD ${page}: NOT SOI CAPABLE`, 'info');
    return false;
  }
  if (av.soi !== soi) {
    av.soi = soi;
    switched(sim, 'soi', soi);
  }
  return true;
}
