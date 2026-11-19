/**
 * The display pages that are text and symbols only (PLAN_A10.md §6.8, §7; ARCHITECTURE §12.7):
 * the common frame (OSB labels from the avionics' OSB table, the page-select row, the
 * sensor-of-interest box, the UFC scratchpad beside the CODE button that enters it), the stores
 * page (DSMS), the status page (STAT) and the messages page (MSG). Pure functions of a
 * PageContext onto a MfdPainter: no rendering, no allocation, so they run in unit tests. The
 * sensor pages are in sensorPages.ts, the map in tad.ts.
 */
import { OSB_TABLE, PAGE_SELECT_OSB, SOI_PAGES, type OsbBinding } from '../../core/avionics';
import type { DsmsStationView, MfdPage, ProfileMode } from '../../core/avionics/types';
import type { Sim } from '../../core/types';
import type { AmmoLoad, StoreType } from '../../core/weapons/types';
import {
  ALIGN_CENTER,
  ALIGN_LEFT,
  ALIGN_RIGHT,
  GLYPH_ADVANCE,
  GLYPH_H,
  GLYPH_W,
  textWidth,
} from '../hud/strokeFont';
import type { MfdDisplay, PageContext } from './context';
import {
  MFD_COLOR as C,
  MFD_TEXT as T,
  OSB_ANCHORS,
  SOI_BOX,
  STORE_SHORT,
  type OsbAnchor,
} from './mfdLayout';
import type { MfdPainter } from './painter';

const KG_TO_LB = 1 / 0.45359237;

/**
 * Label / value rows (STAT): `label` writes a grey label at the left,
 * then the caller fills `p.buf` and `value` writes it at the right and moves down a row.
 */
const rows = {
  p: null as MfdPainter | null,
  x0: 0,
  x1: 0,
  y: 0,
  start(p: MfdPainter, x0: number, x1: number, y: number): void {
    this.p = p;
    this.x0 = x0;
    this.x1 = x1;
    this.y = y;
  },
  label(text: string): MfdPainter {
    const p = this.p as MfdPainter;
    p.color(C.grey);
    p.str(text, this.x0, this.y, T.small, ALIGN_LEFT);
    p.color(C.white);
    return p;
  },
  value(): void {
    (this.p as MfdPainter).text(this.x1, this.y, T.body, ALIGN_RIGHT);
    this.y -= 0.085;
  },
};

// ---------------------------------------------------------------------------------------------
// Frame: OSB labels, page select, SOI
// ---------------------------------------------------------------------------------------------

/** The page's own binding of a button (the avionics' OSB table), or undefined. */
function ownBinding(page: MfdPage, button: number): OsbBinding | undefined {
  return OSB_TABLE[page]?.[button];
}

/**
 * The label of an OSB on a page: the page's own button (the avionics' OSB_TABLE), else the
 * page-select row. '' when the button does nothing on this page.
 */
export function osbLabel(_sim: Sim, page: MfdPage, button: number, _display: MfdDisplay): string {
  const own = ownBinding(page, button);
  if (own) return own.label;
  return PAGE_SELECT_OSB[button] ?? '';
}

/** The live value printed under an OSB's label ('' when none). */
export function osbValue(sim: Sim, page: MfdPage, button: number, display: MfdDisplay): string {
  return ownBinding(page, button)?.value?.(sim, display) ?? '';
}

/** The OSB's option is on (its label is boxed); on the page-select row: the page shown. */
export function osbActive(sim: Sim, page: MfdPage, button: number, display: MfdDisplay): boolean {
  const own = ownBinding(page, button);
  if (own) return own.active?.(sim, display) === true;
  return PAGE_SELECT_OSB[button] === page;
}

/**
 * The CODE button of a page (it enters the UFC scratchpad as a laser code, avionics mfd.ts): OSB
 * 3 on the DSMS (the selected profile's code) and OSB 9 on the TGP (the pod's code); 0 on the
 * other pages.
 */
export function codeOsb(page: MfdPage): number {
  return page === 'DSMS' ? 3 : page === 'TGP' ? 9 : 0;
}

/**
 * The laser-code digit the INC button changes, underlined in the CODE value: the DSMS's (OSB 3,
 * the selected profile's code) and the TGP's (OSB 9, the pod's code). −1 for other buttons.
 */
export function codeCursor(sim: Sim, page: MfdPage, button: number): number {
  if (button === 0 || button !== codeOsb(page)) return -1;
  const pages = sim.avionics.pages;
  return page === 'DSMS' ? pages.dsmsCodeDigit : pages.tgpCodeDigit;
}

/** A laser code's digits: the scratchpad entry is shown padded to this length with '_'. */
const CODE_DIGITS = 4;

/**
 * What the UFC has typed for an OSB to enter: the avionics' scratchpad beside the page's CODE
 * button ('' for any other button, or when nothing is typed). The A-10C shows the scratchpad
 * on the CDU; this cockpit has none, so the display shows it at the field it goes into.
 */
export function scratchpadEntry(sim: Sim, page: MfdPage, button: number): string {
  return button !== 0 && button === codeOsb(page) ? sim.avionics.pages.scratchpad : '';
}

/** The OSB that selects `page` from the page-select row, or 0. */
export function pageSelectButton(page: MfdPage): number {
  for (let n = 11; n <= 15; n++) if (PAGE_SELECT_OSB[n] === page) return n;
  return 0;
}

/**
 * One label at its anchor (split on a space into two lines when long), boxed when `boxed`, and
 * its live value on the next line toward the screen centre; below that, in cyan, the UFC
 * scratchpad `entry` the button would enter (padded with '_' to a laser code's four digits), so
 * the pilot sees the digits typed before pressing it.
 */
function drawLabel(
  p: MfdPainter,
  label: string,
  value: string,
  a: OsbAnchor,
  boxed: boolean,
  cursor: number,
  entry: string,
): void {
  const size = T.label;
  const gap = size * 1.35;
  const split = label.length > 5 ? label.indexOf(' ') : -1;
  const lines = (split < 0 ? 1 : 2) + (value ? 1 : 0);
  // Lines run downward from the first; bottom-row labels grow upward from the button, the
  // side labels stay centred on theirs.
  let y = a.side ? a.y + ((lines - 1) * gap) / 2 : a.y > 0 ? a.y : a.y + (lines - 1) * gap;
  if (split < 0) p.str(label, a.x, y, size, a.align);
  else p.strRange(label, 0, split, a.x, y, size, a.align);
  if (boxed) p.boxText(a.x, y, size, a.align);
  if (split >= 0) {
    y -= gap;
    p.strRange(label, split + 1, label.length, a.x, y, size, a.align);
  }
  if (value) {
    y -= gap;
    const c = p.currentColor;
    p.color(C.green);
    p.str(value, a.x, y, T.small, a.align);
    if (cursor >= 0 && cursor < value.length) {
      // Underline the character `cursor` of the value.
      const k = T.small / GLYPH_H;
      const x0 = a.x - a.align * textWidth(value.length, T.small) + cursor * GLYPH_ADVANCE * k;
      const yu = y - T.small * 0.75;
      p.seg(x0, yu, x0 + GLYPH_W * k, yu, 1.4);
    }
    p.color(c);
  }
  if (entry) {
    // One line further, outside the label block's centring, so the label and value stay put.
    y -= gap;
    const c = p.currentColor;
    p.color(C.cyan);
    const b = p.buf.clear().str(entry);
    for (let k = entry.length; k < CODE_DIGITS; k++) b.ch(95 /* _ */);
    p.text(a.x, y, T.small, a.align);
    p.color(c);
  }
}

/** The frame of every page: OSB labels (and values), active options boxed, the SOI box or NOT SOI. */
export function drawChrome(ctx: PageContext, p: MfdPainter): void {
  for (let n = 1; n <= 20; n++) {
    const label = osbLabel(ctx.sim, ctx.page, n, ctx.display);
    if (!label) continue;
    const active = osbActive(ctx.sim, ctx.page, n, ctx.display);
    p.color(active ? C.green : C.white);
    const value = osbValue(ctx.sim, ctx.page, n, ctx.display);
    const entry = scratchpadEntry(ctx.sim, ctx.page, n);
    drawLabel(p, label, value, OSB_ANCHORS[n], active, codeCursor(ctx.sim, ctx.page, n), entry);
  }
  if (ctx.soi) {
    p.color(C.green);
    p.box(-SOI_BOX, -SOI_BOX, SOI_BOX, SOI_BOX, 2.2);
  } else if (SOI_PAGES.includes(ctx.page)) {
    p.color(C.white);
    p.str('NOT SOI', 0, 0.74, T.body);
  }
}

// ---------------------------------------------------------------------------------------------
// DSMS
// ---------------------------------------------------------------------------------------------

const AMMO: Record<AmmoLoad, string> = {
  combatMix: 'CM',
  allHEI: 'HEI',
  allAPI: 'API',
  targetPractice: 'TP',
};

const MODE_TEXT: Record<ProfileMode, string> = { CCIP: 'CCIP', CCRP: 'CCRP', NONE: '' };

/** Page x of station `i` (0-based) on the station row. */
export function stationX(i: number, count: number): number {
  const span = 1.2;
  return count <= 1 ? 0 : -span / 2 + (i * span) / (count - 1);
}

/**
 * The station row's line (names and counts above it, station numbers below): between the side
 * buttons' labels at ±0.64 and ±0.32, its ends clear of their values (up to eight characters).
 */
const ROW_Y = 0.42;
const GUN_Y = 0.2;
/**
 * Master Arm, at the top centre: below the CODE button's label, value and scratchpad lines
 * (OSB 3 above it), above the station row's counts.
 */
const ARM_Y = 0.665;
/** Profile list: header, first row, row step; columns: name, stores left (right-aligned), mode. */
const LIST_Y = 0.1;
const LIST_STEP = 0.085;
const COL_NAME = -0.62;
const COL_QTY = 0.1;
const COL_MODE = 0.2;
const MAX_PROFILES = 7;

/**
 * The stores page (DSMS): Master Arm; the eleven stations with what hangs there and how many
 * (the selected profile's stores highlighted, the next to go marked, a station chosen for
 * selective jettison dashed); the gun; the weapon profiles with the stores left and their
 * delivery mode, the selected one boxed. The selected profile's settings (mode, release,
 * quantity, spacing, fuze, arming, minimum altitude, drag, laser code) are the values printed
 * beside their buttons (the avionics' OSB table).
 */
export function drawDsms(ctx: PageContext, p: MfdPainter): void {
  const v = ctx.dsms;
  const jettison = ctx.sim.avionics.pages.jettisonStation;
  // Master Arm.
  p.color(v.masterArm === 'ARM' ? C.green : v.masterArm === 'TRAIN' ? C.cyan : C.yellow);
  p.str(v.masterArm === 'TRAIN' ? 'TRAINING' : v.masterArm, 0, ARM_Y, T.body);

  // Stations.
  const n = v.stations.length;
  p.color(C.grey);
  p.seg(stationX(0, n) - 0.04, ROW_Y, stationX(n - 1, n) + 0.04, ROW_Y);
  for (let i = 0; i < n; i++) drawStation(p, v.stations[i], stationX(i, n), jettison);

  // Gun.
  p.color(C.white);
  p.buf.clear().str('GUN ').int(v.gunRounds).ch(47 /* / */).int(v.gunLoaded).ch(32);
  p.buf.str(AMMO[v.gunLoad] ?? '');
  p.text(COL_NAME, GUN_Y, T.body, ALIGN_LEFT);

  // Profiles.
  p.color(C.grey);
  p.str('PROFILE', COL_NAME, LIST_Y, T.small, ALIGN_LEFT);
  p.str('QTY', COL_QTY, LIST_Y, T.small, ALIGN_RIGHT);
  p.str('MODE', COL_MODE, LIST_Y, T.small, ALIGN_LEFT);
  const shown = Math.min(v.profiles.length, MAX_PROFILES);
  for (let k = 0; k < shown; k++) {
    const pr = v.profiles[k];
    const y = LIST_Y - (k + 1) * LIST_STEP;
    p.color(pr.selected ? C.green : pr.remaining > 0 ? C.white : C.grey);
    p.str(pr.name, COL_NAME, y, T.body, ALIGN_LEFT);
    p.buf.clear().int(pr.remaining);
    p.text(COL_QTY, y, T.body, ALIGN_RIGHT);
    p.str(MODE_TEXT[pr.mode] ?? '', COL_MODE, y, T.body, ALIGN_LEFT);
    if (pr.selected) p.box(COL_NAME - 0.03, y - 0.04, COL_MODE + 0.25, y + 0.04);
  }
}

function drawStation(p: MfdPainter, s: DsmsStationView, x: number, jettison: number): void {
  p.color(C.white);
  p.buf.clear().int(s.station);
  p.text(x, ROW_Y - 0.07, T.small);
  p.color(C.grey);
  p.seg(x, ROW_Y, x, ROW_Y + 0.03);
  const store = s.store ?? s.rack;
  if (store) {
    // The selected profile's stores in green (no box: eleven names leave no room for one).
    const name = STORE_SHORT[store as StoreType] ?? '?';
    p.color(s.store ? (s.selected ? C.green : C.white) : C.grey);
    p.str(name, x, ROW_Y + 0.075, T.tiny);
    if (s.store) {
      p.buf.clear().int(s.rockets >= 0 ? s.rockets : s.count);
      p.text(x, ROW_Y + 0.145, T.tiny);
    }
  }
  if (s.next) {
    // The next release leaves from here: a caret under the station number.
    p.color(C.green);
    p.seg(x - 0.025, ROW_Y - 0.15, x, ROW_Y - 0.12, 1.4);
    p.seg(x, ROW_Y - 0.12, x + 0.025, ROW_Y - 0.15, 1.4);
  }
  if (s.jettisonSelected || (jettison > 0 && jettison === s.station)) {
    p.color(C.yellow);
    p.box(x - 0.058, ROW_Y - 0.11, x + 0.058, ROW_Y + 0.19, 1, 3);
  }
}

// ---------------------------------------------------------------------------------------------
// STAT
// ---------------------------------------------------------------------------------------------

const FLAPS = ['UP', 'MVR', 'DN'] as const;

/** The status page: fuel, weight, limits, engines, armament and sensors, configuration. */
export function drawStat(ctx: PageContext, p: MfdPainter): void {
  const sim = ctx.sim;
  const ac = sim.aircraft;
  const av = sim.avionics;
  const b = p.buf;
  p.color(C.green);
  p.str('STATUS', 0, 0.74, T.body);
  rows.start(p, -0.62, 0.62, 0.6);
  rows.label('FUEL');
  b.clear()
    .int(Math.round((ac.fuel * KG_TO_LB) / 10) * 10)
    .str(' LB');
  rows.value();
  rows.label('WEIGHT');
  b.clear()
    .int(Math.round((ac.mass * KG_TO_LB) / 10) * 10)
    .str(' LB');
  rows.value();
  rows.label('G LIMIT');
  b.clear().ch(43).fixed(ac.gLimitPositive, 1).ch(32).fixed(ac.gLimitNegative, 1);
  rows.value();
  rows.label('ENG CORE');
  b.clear()
    .int(ac.engines[0].n2 * 100)
    .ch(32)
    .int(ac.engines[1].n2 * 100)
    .str(' %');
  rows.value();
  rows.label('GUN');
  b.clear()
    .int(sim.gun.rounds)
    .ch(32)
    .str(AMMO[sim.gun.load] ?? '');
  rows.value();
  rows.label('MASTER ARM');
  b.clear().str(av.masterArm);
  rows.value();
  rows.label('LASER');
  b.clear().str(av.laserArm).ch(32).int(sim.sensors.tgp.laserCode, 4);
  rows.value();
  rows.label('TGP');
  const tgp = sim.sensors.tgp;
  if (!av.tgpPower || !tgp.powered) b.clear().str('OFF');
  else if (tgp.warmup > 0) b.clear().str('WARM ').time(tgp.warmup);
  else if (tgp.masked) b.clear().str('MASK');
  else b.clear().str('READY');
  rows.value();
  rows.label('MAV');
  const i = sim.sensors.selectedMaverick;
  const mav = i >= 0 ? sim.sensors.mavericks[i] : undefined;
  if (!mav) b.clear().str('NONE');
  else if (!mav.powered) b.clear().str('OFF');
  else if (mav.align > 0) b.clear().str('ALIGN ').time(mav.align);
  else b.clear().str(mav.locked ? 'LOCKED' : 'READY');
  rows.value();
  rows.label('ALT SRC');
  b.clear().str(av.altSource);
  rows.value();
  rows.label('FLAPS GEAR');
  b.clear()
    .str(FLAPS[ac.flapHandle] ?? '')
    .ch(32)
    .str(ac.gearPosition > 0.99 ? 'DN' : ac.gearPosition < 0.01 ? 'UP' : 'TRANS');
  rows.value();
  rows.label('SPD BRK');
  b.clear()
    .int(ac.speedBrakeCmd * 100)
    .str(' %');
  rows.value();
  rows.label('AUTOPILOT');
  b.clear().str(ac.autopilot.engaged ? ac.autopilot.mode : 'OFF');
  rows.value();
}

// ---------------------------------------------------------------------------------------------
// MSG
// ---------------------------------------------------------------------------------------------

/** Rows of the messages page and the characters that fit on one. */
export const MSG_ROWS = 14;
const MSG_CHARS = 30;

/** The messages page: the flight's cockpit messages, newest first, with their times. */
export function drawMsg(ctx: PageContext, p: MfdPainter): void {
  const log = ctx.messages;
  const clear = ctx.sim.avionics.pages.msgClearTime;
  p.color(C.green);
  p.str('MESSAGES', 0, 0.74, T.body);
  let shown = 0;
  for (let k = 0; k < log.size && shown < MSG_ROWS; k++) {
    const m = log.newest(k);
    if (!m || (clear >= 0 && m.t <= clear)) continue;
    const y = 0.6 - shown * 0.085;
    p.color(m.level === 'alert' ? C.red : m.level === 'warn' ? C.yellow : C.white);
    p.buf.clear().time(m.t).ch(32).str(m.text, MSG_CHARS);
    p.text(-0.62, y, T.small, ALIGN_LEFT);
    shown++;
  }
  if (shown === 0) {
    p.color(C.grey);
    p.str('NO MESSAGES', 0, 0, T.body, ALIGN_CENTER);
  }
}
