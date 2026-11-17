/**
 * The display pages that are text and symbols only (PLAN_A10.md §6.8, §7; ARCHITECTURE §12.7):
 * the common frame (OSB labels from the avionics' OSB table, the page-select row, the
 * sensor-of-interest box), the stores page (DSMS), the status page (STAT) and the messages page
 * (MSG). Pure functions of a PageContext onto a MfdPainter: no rendering, no allocation, so they
 * run in unit tests. The sensor pages are in sensorPages.ts, the map in tad.ts.
 */
import { OSB_TABLE, PAGE_SELECT_OSB, SOI_PAGES } from '../../core/avionics';
import type { DsmsProfileView, DsmsStationView, MfdPage } from '../../core/avionics/types';
import type { Sim } from '../../core/types';
import { mToFt } from '../../core/units';
import type { AmmoLoad, StoreType } from '../../core/weapons/types';
import { ALIGN_CENTER, ALIGN_LEFT, ALIGN_RIGHT } from '../hud/strokeFont';
import {
  pageSettings,
  createPageSettings,
  type DsmsProfileExtras,
  type DsmsStationExtras,
  type MfdDisplay,
  type PageContext,
} from './context';
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
const settings = createPageSettings();

/**
 * Label / value rows (STAT, the DSMS profile settings): `label` writes a grey label at the left,
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

/**
 * An OSB's binding as the avionics' OSB table gives it (core/avionics/mfd.ts `OsbBinding`): the
 * label (the function), optionally a live value printed under it and an "active" flag (drawn
 * boxed). Read defensively, so a label may also be a function and the extras may be missing.
 */
interface OsbView {
  label: unknown;
  value?: unknown;
  active?: unknown;
}

type OsbFn<T> = (sim: Sim, display: MfdDisplay) => T;

function ownBinding(page: MfdPage, button: number): OsbView | undefined {
  return OSB_TABLE[page]?.[button] as OsbView | undefined;
}

function textOf(v: unknown, sim: Sim, display: MfdDisplay): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'function') {
    const r = (v as OsbFn<unknown>)(sim, display);
    return typeof r === 'string' ? r : '';
  }
  return '';
}

/**
 * The label of an OSB on a page: the page's own button (the avionics' OSB_TABLE), else the
 * page-select row. '' when the button does nothing on this page.
 */
export function osbLabel(sim: Sim, page: MfdPage, button: number, display: MfdDisplay): string {
  const own = ownBinding(page, button);
  if (own) return textOf(own.label, sim, display);
  return PAGE_SELECT_OSB[button] ?? '';
}

/** The live value printed under an OSB's label ('' when none). */
export function osbValue(sim: Sim, page: MfdPage, button: number, display: MfdDisplay): string {
  const own = ownBinding(page, button);
  return own && own.value !== undefined ? textOf(own.value, sim, display) : '';
}

/** The OSB's option is on (its label is boxed); on the page-select row: the page shown. */
export function osbActive(sim: Sim, page: MfdPage, button: number, display: MfdDisplay): boolean {
  const own = ownBinding(page, button);
  if (own) {
    return typeof own.active === 'function' ? (own.active as OsbFn<unknown>)(sim, display) === true : false;
  }
  return PAGE_SELECT_OSB[button] === page;
}

/** The OSB that selects `page` from the page-select row, or 0. */
export function pageSelectButton(page: MfdPage): number {
  for (let n = 11; n <= 15; n++) if (PAGE_SELECT_OSB[n] === page) return n;
  return 0;
}

/**
 * One label at its anchor (split on a space into two lines when long), boxed when `boxed`, and
 * its live value on the next line toward the screen centre.
 */
function drawLabel(p: MfdPainter, label: string, value: string, a: OsbAnchor, boxed: boolean): void {
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
    drawLabel(p, label, osbValue(ctx.sim, ctx.page, n, ctx.display), OSB_ANCHORS[n], active);
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

const RELEASE: Record<DsmsProfileView['release'], string> = {
  SGL: 'SGL',
  PRS: 'PRS',
  RIP_SGL: 'RIP SGL',
  RIP_PRS: 'RIP PRS',
};

/** Page x of station `i` (0-based) on the station row. */
export function stationX(i: number, count: number): number {
  const span = 1.2;
  return count <= 1 ? 0 : -span / 2 + (i * span) / (count - 1);
}

const ROW_Y = 0.5;

/**
 * The stores page (DSMS): Master Arm; the eleven stations with what hangs there and how many
 * (the selected profile's stores highlighted, the next to go marked, a station chosen for
 * selective jettison dashed); the gun; the weapon profiles with the stores left; the selected
 * profile's settings.
 */
export function drawDsms(ctx: PageContext, p: MfdPainter): void {
  const v = ctx.dsms;
  const pages = pageSettings(ctx.sim, settings);
  // Master Arm.
  p.color(v.masterArm === 'ARM' ? C.green : v.masterArm === 'TRAIN' ? C.cyan : C.yellow);
  p.str(v.masterArm === 'TRAIN' ? 'TRAINING' : v.masterArm, 0, 0.74, T.body);

  // Stations.
  const n = v.stations.length;
  p.color(C.grey);
  p.seg(stationX(0, n) - 0.04, ROW_Y, stationX(n - 1, n) + 0.04, ROW_Y);
  for (let i = 0; i < n; i++) drawStation(p, v.stations[i], stationX(i, n), pages.jettisonStation);

  // Gun.
  p.color(C.white);
  p.buf.clear().str('GUN ').int(v.gunRounds).ch(47 /* / */).int(v.gunLoaded).ch(32);
  p.buf.str(AMMO[v.gunLoad] ?? '');
  p.text(-0.62, 0.3, T.body, ALIGN_LEFT);

  // Profiles.
  p.color(C.grey);
  p.str('PROFILE', -0.62, 0.18, T.small, ALIGN_LEFT);
  p.str('QTY', -0.1, 0.18, T.small, ALIGN_RIGHT);
  let selected: DsmsProfileView | null = null;
  const shown = Math.min(v.profiles.length, 7);
  for (let k = 0; k < shown; k++) {
    const pr = v.profiles[k];
    const y = 0.09 - k * 0.085;
    if (pr.selected) selected = pr;
    p.color(pr.selected ? C.green : pr.remaining > 0 ? C.white : C.grey);
    p.str(pr.name, -0.62, y, T.body, ALIGN_LEFT);
    p.buf.clear().int(pr.remaining);
    p.text(-0.1, y, T.body, ALIGN_RIGHT);
    if (pr.selected) p.box(-0.65, y - 0.04, -0.06, y + 0.04);
  }
  for (let k = 0; !selected && k < v.profiles.length; k++)
    if (v.profiles[k].selected) selected = v.profiles[k];

  // The selected profile's settings.
  if (selected) drawProfile(p, selected, pages.dsmsCodeDigit);
}

function drawStation(p: MfdPainter, s: DsmsStationView, x: number, jettison: number): void {
  const ext = s as DsmsStationView & DsmsStationExtras;
  p.color(C.white);
  p.buf.clear().int(s.station);
  p.text(x, ROW_Y - 0.07, T.small);
  p.color(C.grey);
  p.seg(x, ROW_Y, x, ROW_Y + 0.03);
  const store = s.store ?? s.rack;
  if (store) {
    const name = STORE_SHORT[store as StoreType] ?? '?';
    p.color(s.store ? (s.selected ? C.green : C.white) : C.grey);
    p.str(name, x, ROW_Y + 0.09, T.small);
    if (s.selected) p.boxText(x, ROW_Y + 0.09, T.small, 0.5);
    if (s.store) {
      const count = typeof ext.rockets === 'number' && ext.rockets >= 0 ? ext.rockets : s.count;
      p.buf.clear().int(count);
      p.text(x, ROW_Y + 0.17, T.small);
    }
  }
  if (ext.next) {
    // The next release leaves from here: a caret under the station number.
    p.color(C.green);
    p.seg(x - 0.025, ROW_Y - 0.15, x, ROW_Y - 0.12, 1.4);
    p.seg(x, ROW_Y - 0.12, x + 0.025, ROW_Y - 0.15, 1.4);
  }
  if (ext.jettisonSelected || (jettison > 0 && jettison === s.station)) {
    p.color(C.yellow);
    p.box(x - 0.055, ROW_Y - 0.11, x + 0.055, ROW_Y + 0.22, 1, 3);
  }
}

function drawProfile(p: MfdPainter, pr: DsmsProfileView, codeDigit: number): void {
  const ext = pr as DsmsProfileView & DsmsProfileExtras;
  const b = p.buf;
  rows.start(p, 0.06, 0.62, 0.09);
  rows.label('MODE');
  b.clear().str(pr.mode === 'NONE' ? 'MAV' : pr.mode);
  rows.value();
  rows.label('REL');
  b.clear().str(RELEASE[pr.release] ?? pr.release);
  rows.value();
  if (pr.release === 'RIP_SGL' || pr.release === 'RIP_PRS') {
    rows.label('QTY');
    b.clear().int(pr.rippleQty);
    rows.value();
    rows.label('SPC');
    b.clear()
      .int(Math.round(mToFt(pr.rippleSpacing)))
      .str('FT');
    rows.value();
  }
  rows.label('FUZE');
  b.clear().str(pr.fuze);
  rows.value();
  rows.label('ARM');
  b.clear().fixed(pr.armingTime, 1).str('S');
  rows.value();
  rows.label('MIN ALT');
  b.clear()
    .int(Math.round(mToFt(pr.minAltitude) / 10) * 10)
    .str('FT');
  rows.value();
  if (ext.drag) {
    rows.label('DRAG');
    b.clear().str(ext.drag);
    rows.value();
  }
  if (typeof ext.laserCode === 'number' && ext.laserCode > 0) {
    rows.label('CODE');
    b.clear().int(ext.laserCode, 4);
    const yCode = rows.y;
    const w = p.width(T.body);
    rows.value();
    if (codeDigit >= 0 && codeDigit < 4) {
      // The digit the INC button changes: underlined.
      const cw = w / 4;
      const xd = rows.x1 - w + codeDigit * cw;
      p.color(C.green);
      p.seg(xd, yCode - T.body * 0.75, xd + cw * 0.75, yCode - T.body * 0.75, 1.4);
    }
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
  const clear = pageSettings(ctx.sim, settings).msgClearTime;
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
