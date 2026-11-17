/**
 * The two multifunction colour displays (PLAN_A10.md §7 "Display pages"; ARCHITECTURE §12.7):
 * which page each shows, the pages that can be the sensor of interest, and the option-select
 * buttons (OSBs) with the labels the displays draw and the cockpit's hover text.
 *
 * OSBs are numbered as on the A-10C's displays: 1–5 along the top (left to right), 6–10 down the
 * right side, 11–15 along the bottom (right to left), 16–20 up the left side. The bottom row
 * selects pages on every page (our default assignment; the real aircraft lets the pilot set it):
 * 15 TAD, 14 TGP, 13 MAV, 12 DSMS, 11 STAT; MSG is reached from STAT.
 *
 * Each binding has a `label` (the function), an optional `value` (the live setting the display
 * prints under the label) and an optional `active` (an option that is on: drawn boxed). The view
 * draws from the same table that handles the presses. Values come from small string caches, so
 * reading them every frame allocates nothing after the first time.
 *
 *   DSMS  1 SEL station for selective jettison · 2 JETT drop it (Master Arm ARM) · 3 CODE / 4 INC
 *         the selected profile's laser code (GBU-12): CODE moves the cursor digit, INC steps it ·
 *         6 PROF+ / 7 PROF- profiles · 8 MODE CCIP/CCRP · 9 REL SGL/PRS/RIP SGL/RIP PRS ·
 *         10 QTY ripple quantity · 20 SPC ripple spacing (ft) · 19 FUZE NOSE/TAIL/N/T ·
 *         18 DRAG LD/HD (Mk-82 AIR) · 17 ARM arming delay (s) · 16 MIN minimum altitude (ft).
 *   TGP   1 PIC CCD/WHOT/BHOT · 2 FOV WIDE/NARO · 3 ZM+ / 4 ZM- electronic zoom · 5 SLV slave the
 *         pod to the SPI · 6 TRK point/area track (TMS forward) · 7 INR (TMS aft) · 8 LTCH laser
 *         latch · 9 CODE / 10 INC the pod's laser code.
 *   MAV   1 PWR seeker power · 2 FOV WIDE/NARO · 3 PIC polarity · 4 STEP next Maverick type ·
 *         5 SLV slave the seeker to the SPI · 6 TRK lock (TMS forward) · 7 BRK break (TMS aft).
 *   TAD   1 RNG+ / 2 RNG- map range (nm) · 3 CEN own ship / SPI · 6 STP+ / 7 STP- steerpoint.
 *   STAT  1 MSG.   MSG  1 STAT · 2 CLR.
 * Sensor actions become SensorRequests with the HOTAS meanings (hotas.ts): FOV is a China-hat
 * forward short press, track and break are TMS forward / aft short.
 */
import { TAD_RANGES_NM } from '../../data/avionics';
import { updateMassProperties } from '../flight';
import type { Sim } from '../types';
import { jettisonStores } from '../weapons';
import { isMaverick } from './delivery';
import { requestSensor } from './hotas';
import { refreshStores } from './init';
import { cycleSteerpoint } from './navigation';
import { notify, switched } from './notify';
import {
  cycleArmingTime,
  cycleFuze,
  cycleMinAltitude,
  cycleProfile,
  cycleProfileMode,
  cycleReleaseMode,
  cycleRippleQty,
  cycleRippleSpacing,
  laserGuided,
  profileAvailable,
  profileLaserCode,
  releaseLabel,
  selectedProfile,
  stationJettisonable,
  stepLaserDigit,
  toggleDrag,
} from './profiles';
import type { MfdPage, WeaponProfile } from './types';
import { FT } from '../units';

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
  /** Label shown next to the button: the function ('MODE', 'LTCH' …). */
  label: string;
  press(sim: Sim, display: Display): void;
  /** The live setting printed under the label ('CCRP', 'RIP SGL', '1688' …); '' when none. */
  value?(sim: Sim, display: Display): string;
  /** The option is on (drawn boxed): the laser latched, the seeker powered … */
  active?(sim: Sim, display: Display): boolean;
}

// ---------------------------------------------------------------------------------------------
// Allocation-free value strings
// ---------------------------------------------------------------------------------------------

const intCache = new Map<number, string>();
/** A whole number as text, cached. */
export function intText(v: number): string {
  const k = Math.round(v);
  let s = intCache.get(k);
  if (s === undefined) {
    if (intCache.size > 1024) intCache.clear();
    s = String(k);
    intCache.set(k, s);
  }
  return s;
}

const tenthCache = new Map<number, string>();
/** A number with one decimal as text, cached. */
export function tenthText(v: number): string {
  const k = Math.round(v * 10);
  let s = tenthCache.get(k);
  if (s === undefined) {
    if (tenthCache.size > 1024) tenthCache.clear();
    s = (k / 10).toFixed(1);
    tenthCache.set(k, s);
  }
  return s;
}

const STATION_TEXT: readonly string[] = Array.from({ length: 12 }, (_, i) =>
  i === 0 ? '---' : `STA ${i}`,
);

/** "STA n" for a station, '---' for none. */
export function stationText(station: number): string {
  return STATION_TEXT[station] ?? '---';
}

// ---------------------------------------------------------------------------------------------
// Page handlers
// ---------------------------------------------------------------------------------------------

/** The selected profile, or a message and null. */
function profileOrNote(sim: Sim): WeaponProfile | null {
  const p = selectedProfile(sim);
  if (!p) notify(sim, 'NO PROFILE', 'info');
  return p;
}

/** Apply an edit to the selected profile and click it. */
function editProfile(sim: Sim, edit: (p: WeaponProfile) => void): void {
  const p = profileOrNote(sim);
  if (!p) return;
  edit(p);
  switched(sim, 'profile', p.name ?? p.id);
}

/** Step the selective-jettison station to the next station that can be jettisoned (or none). */
export function cycleJettisonStation(sim: Sim): void {
  const pages = sim.avionics.pages;
  for (let k = 1; k <= 12; k++) {
    const s = (pages.jettisonStation + k) % 12;
    if (s === 0 || stationJettisonable(sim, s)) {
      pages.jettisonStation = s;
      return;
    }
  }
}

/** Selective jettison of the chosen station (Master Arm ARM), through the weapons module. */
export function jettisonSelected(sim: Sim): void {
  const av = sim.avionics;
  const s = av.pages.jettisonStation;
  if (s === 0 || !stationJettisonable(sim, s)) {
    notify(sim, 'JETT: SELECT A STATION', 'info');
    return;
  }
  if (av.masterArm !== 'ARM') {
    notify(sim, 'JETT: MASTER ARM NOT ARM', 'info');
    return;
  }
  jettisonStores(sim, [s]);
  updateMassProperties(sim);
  switched(sim, 'jettison', intText(s));
  av.pages.jettisonStation = 0;
  refreshStores(sim);
}

/** Step to the next Maverick profile whose missiles are loaded (MAV page STEP). */
function stepMaverick(sim: Sim): void {
  const av = sim.avionics;
  const list = av.profiles;
  const n = list.length;
  let cur = -1;
  for (let i = 0; i < n; i++) if (list[i].id === av.selectedProfile) cur = i;
  for (let k = 1; k <= n; k++) {
    const p = list[(((cur + k) % n) + n) % n];
    if (!isMaverick(p.store) || !profileAvailable(sim, p)) continue;
    if (p.id !== av.selectedProfile) {
      av.selectedProfile = p.id;
      switched(sim, 'profile', p.name ?? p.id);
    }
    return;
  }
  notify(sim, 'NO MAV', 'info');
}

function tadRange(sim: Sim, dir: 1 | -1): void {
  const pages = sim.avionics.pages;
  let i = TAD_RANGES_NM.indexOf(pages.tadRange);
  if (i < 0) i = 2;
  const j = Math.min(TAD_RANGES_NM.length - 1, Math.max(0, i + dir));
  pages.tadRange = TAD_RANGES_NM[j];
}

const DSMS_TABLE: Partial<Record<number, OsbBinding>> = {
  1: {
    label: 'SEL',
    press: (sim) => cycleJettisonStation(sim),
    value: (sim) => stationText(sim.avionics.pages.jettisonStation),
  },
  2: { label: 'JETT', press: (sim) => jettisonSelected(sim) },
  3: {
    label: 'CODE',
    press(sim) {
      const p = profileOrNote(sim);
      if (!p) return;
      if (!laserGuided(p.store)) {
        notify(sim, `${p.name ?? p.id}: NO LASER CODE`, 'info');
        return;
      }
      const pages = sim.avionics.pages;
      pages.dsmsCodeDigit = (pages.dsmsCodeDigit + 1) % 4;
    },
    value(sim) {
      const p = selectedProfile(sim);
      return p && laserGuided(p.store) ? intText(profileLaserCode(p)) : '';
    },
  },
  4: {
    label: 'INC',
    press(sim) {
      const p = profileOrNote(sim);
      if (!p) return;
      if (!laserGuided(p.store)) {
        notify(sim, `${p.name ?? p.id}: NO LASER CODE`, 'info');
        return;
      }
      p.laserCode = stepLaserDigit(profileLaserCode(p), sim.avionics.pages.dsmsCodeDigit);
      switched(sim, 'profile', p.name ?? p.id);
    },
  },
  6: {
    label: 'PROF+',
    press: (sim) => void cycleProfile(sim, 1),
    value: (sim) => {
      const p = selectedProfile(sim);
      return p ? (p.name ?? p.id) : '';
    },
  },
  7: { label: 'PROF-', press: (sim) => void cycleProfile(sim, -1) },
  8: {
    label: 'MODE',
    press(sim) {
      const p = profileOrNote(sim);
      if (!p) return;
      if (cycleProfileMode(sim, p)) switched(sim, 'profile', p.name ?? p.id);
      else notify(sim, `${p.name ?? p.id}: ${p.mode === 'NONE' ? 'NO MODE' : p.mode + ' ONLY'}`);
    },
    value: (sim) => {
      const p = selectedProfile(sim);
      return p ? (p.mode === 'NONE' ? '' : p.mode) : '';
    },
  },
  9: {
    label: 'REL',
    press: (sim) => editProfile(sim, cycleReleaseMode),
    value: (sim) => {
      const p = selectedProfile(sim);
      return p ? releaseLabel(p.release) : '';
    },
  },
  10: {
    label: 'QTY',
    press: (sim) => editProfile(sim, cycleRippleQty),
    value: (sim) => {
      const p = selectedProfile(sim);
      return p ? intText(p.rippleQty) : '';
    },
  },
  16: {
    label: 'MIN',
    press: (sim) => editProfile(sim, cycleMinAltitude),
    value: (sim) => {
      const p = selectedProfile(sim);
      return p ? intText(p.minAltitude / FT) : '';
    },
  },
  17: {
    label: 'ARM',
    press: (sim) => editProfile(sim, cycleArmingTime),
    value: (sim) => {
      const p = selectedProfile(sim);
      return p ? tenthText(p.armingTime) : '';
    },
  },
  18: {
    label: 'DRAG',
    press(sim) {
      const p = profileOrNote(sim);
      if (p && toggleDrag(sim, p)) switched(sim, 'profile', p.name ?? p.id);
    },
    value: (sim) => {
      const p = selectedProfile(sim);
      return p ? (p.drag ?? 'LD') : '';
    },
  },
  19: {
    label: 'FUZE',
    press: (sim) => editProfile(sim, cycleFuze),
    value: (sim) => selectedProfile(sim)?.fuze ?? '',
  },
  20: {
    label: 'SPC',
    press: (sim) => editProfile(sim, cycleRippleSpacing),
    value: (sim) => {
      const p = selectedProfile(sim);
      return p ? intText(p.rippleSpacing / FT) : '';
    },
  },
};

const FOV_TEXT: Readonly<Record<string, string>> = { WIDE: 'WIDE', NARROW: 'NARO' };

const TGP_TABLE: Partial<Record<number, OsbBinding>> = {
  1: {
    label: 'PIC',
    press: (sim) => requestSensor(sim, 'TGP', 'picture', '', false),
    value: (sim) => sim.sensors.tgp.picture,
  },
  2: {
    label: 'FOV',
    press: (sim) => requestSensor(sim, 'TGP', 'chinaHat', 'fwd', false),
    value: (sim) => FOV_TEXT[sim.sensors.tgp.fovSetting] ?? '',
  },
  3: {
    label: 'ZM+',
    press: (sim) => requestSensor(sim, 'TGP', 'zoom', '', false, 1),
    value: (sim) => tenthText(sim.sensors.tgp.zoom),
  },
  4: { label: 'ZM-', press: (sim) => requestSensor(sim, 'TGP', 'zoom', '', false, -1) },
  5: { label: 'SLV', press: (sim) => requestSensor(sim, 'TGP', 'slaveSpi', 'aft', true) },
  6: {
    label: 'TRK',
    press: (sim) => requestSensor(sim, 'TGP', 'tms', 'up', false),
    value: (sim) => sim.sensors.tgp.mode,
  },
  7: { label: 'INR', press: (sim) => requestSensor(sim, 'TGP', 'tms', 'down', false) },
  8: {
    label: 'LTCH',
    press(sim) {
      const av = sim.avionics;
      av.laserLatch = !av.laserLatch;
      switched(sim, 'laserLatch', av.laserLatch ? 'ON' : 'OFF');
    },
    value: (sim) => (sim.avionics.laserLatch ? 'ON' : 'OFF'),
    active: (sim) => sim.avionics.laserLatch,
  },
  9: {
    label: 'CODE',
    press(sim) {
      const pages = sim.avionics.pages;
      pages.tgpCodeDigit = (pages.tgpCodeDigit + 1) % 4;
    },
    value: (sim) => intText(sim.avionics.laserCode),
  },
  10: {
    label: 'INC',
    press(sim) {
      const av = sim.avionics;
      av.laserCode = stepLaserDigit(av.laserCode, av.pages.tgpCodeDigit);
      switched(sim, 'laserCode', intText(av.laserCode));
    },
  },
};

function selectedSeekerFov(sim: Sim): string {
  const s = sim.sensors;
  const m = s.selectedMaverick >= 0 ? s.mavericks[s.selectedMaverick] : undefined;
  return m ? (FOV_TEXT[m.fov] ?? '') : '';
}

const MAV_TABLE: Partial<Record<number, OsbBinding>> = {
  1: {
    label: 'PWR',
    press(sim) {
      const av = sim.avionics;
      av.mavPower = !av.mavPower;
      switched(sim, 'mavPower', av.mavPower ? 'ON' : 'OFF');
    },
    value: (sim) => (sim.avionics.mavPower ? 'ON' : 'OFF'),
    active: (sim) => sim.avionics.mavPower,
  },
  2: {
    label: 'FOV',
    press: (sim) => requestSensor(sim, 'MAV', 'chinaHat', 'fwd', false),
    value: (sim) => selectedSeekerFov(sim),
  },
  3: { label: 'PIC', press: (sim) => requestSensor(sim, 'MAV', 'picture', '', false) },
  4: {
    label: 'STEP',
    press: (sim) => stepMaverick(sim),
    value: (sim) => {
      const p = selectedProfile(sim);
      return p && isMaverick(p.store) ? stationText(sim.avionics.selectedStation) : '';
    },
  },
  5: { label: 'SLV', press: (sim) => requestSensor(sim, 'MAV', 'slaveSpi', '', true) },
  6: { label: 'TRK', press: (sim) => requestSensor(sim, 'MAV', 'tms', 'up', false) },
  7: { label: 'BRK', press: (sim) => requestSensor(sim, 'MAV', 'tms', 'down', false) },
};

const TAD_TABLE: Partial<Record<number, OsbBinding>> = {
  1: {
    label: 'RNG+',
    press: (sim) => tadRange(sim, 1),
    value: (sim) => intText(sim.avionics.pages.tadRange),
  },
  2: { label: 'RNG-', press: (sim) => tadRange(sim, -1) },
  3: {
    label: 'CEN',
    press(sim) {
      const pages = sim.avionics.pages;
      pages.tadCenter = pages.tadCenter === 'OWN' ? 'SPI' : 'OWN';
    },
    value: (sim) => sim.avionics.pages.tadCenter,
  },
  6: {
    label: 'STP+',
    press: (sim) => cycleSteerpoint(sim, 1),
    value: (sim) => sim.avionics.steerpoints[sim.avionics.activeSteerpoint]?.name ?? '',
  },
  7: { label: 'STP-', press: (sim) => cycleSteerpoint(sim, -1) },
};

/** Per-page buttons (the bottom row is the page selection, PAGE_SELECT_OSB). */
export const OSB_TABLE: Record<MfdPage, Partial<Record<number, OsbBinding>>> = {
  DSMS: DSMS_TABLE,
  TGP: TGP_TABLE,
  MAV: MAV_TABLE,
  TAD: TAD_TABLE,
  STAT: {
    1: { label: 'MSG', press: (sim, display) => setMfdPage(sim, display, 'MSG') },
  },
  MSG: {
    1: { label: 'STAT', press: (sim, display) => setMfdPage(sim, display, 'STAT') },
    2: {
      label: 'CLR',
      press(sim) {
        sim.avionics.pages.msgClearTime = sim.time;
      },
    },
  },
};

export function pageOf(sim: Sim, display: Display): MfdPage {
  return display === 'L' ? sim.avionics.mfd.left : sim.avionics.mfd.right;
}

const pageSelectBindings: Partial<Record<number, OsbBinding>> = {};
for (const [osb, page] of Object.entries(PAGE_SELECT_OSB)) {
  pageSelectBindings[Number(osb)] = {
    label: page,
    press: (sim, display) => setMfdPage(sim, display, page),
    active: (sim, display) => pageOf(sim, display) === page,
  };
}

/** The binding of a button on a page: the page's own, else the page-select row. */
export function osbBinding(page: MfdPage, button: number): OsbBinding | null {
  return OSB_TABLE[page][button] ?? pageSelectBindings[button] ?? null;
}

/** The label a display shows next to a button now ('' when the button has no function). */
export function osbLabel(sim: Sim, display: Display, button: number): string {
  return osbBinding(pageOf(sim, display), button)?.label ?? '';
}

/** The live value a display prints under a button's label now ('' when none). */
export function osbValue(sim: Sim, display: Display, button: number): string {
  return osbBinding(pageOf(sim, display), button)?.value?.(sim, display) ?? '';
}

/** The button's option is on now (drawn boxed). */
export function osbActive(sim: Sim, display: Display, button: number): boolean {
  return osbBinding(pageOf(sim, display), button)?.active?.(sim, display) ?? false;
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
