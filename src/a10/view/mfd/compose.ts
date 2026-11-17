/**
 * Which page to draw, and when (PLAN_A10.md §14: the displays must stay cheap). A page is drawn
 * again only when what it shows changed — a cheap signature of its inputs — and no more often
 * than its rate: the sensor pages at the sensor picture's rate, the moving map at TAD rate, the
 * text pages when their data change (with a slow keep-alive). A change of page or of the sensor
 * of interest redraws at once. Pure: the renderer (MfdRenderer.ts) holds one schedule per display.
 */
import { OSB_TABLE } from '../../core/avionics';
import type { MfdPage } from '../../core/avionics/types';
import type { Sim } from '../../core/types';
import { pageSettings, createPageSettings, type PageContext } from './context';
import { drawChrome, drawDsms, drawMsg, drawStat, osbActive, osbLabel, osbValue } from './pages';
import { MFD_RATES } from './mfdLayout';
import type { MfdPainter } from './painter';
import { createSensorPageInfo, drawMav, drawTgp, type SensorPageInfo } from './sensorPages';
import { createTadInfo, drawTad, type TadInfo } from './tad';

/** What the last page drew (tests, the sandbox). */
export interface PageInfo {
  sensor: SensorPageInfo;
  tad: TadInfo;
  /** Strokes of the last page. */
  strokes: number;
}

export function createPageInfo(): PageInfo {
  return { sensor: createSensorPageInfo(), tad: createTadInfo(), strokes: 0 };
}

/** Draw a whole page: its content, then the frame (labels, SOI) on top. */
export function drawPage(ctx: PageContext, p: MfdPainter, info: PageInfo): void {
  const start = p.count;
  switch (ctx.page) {
    case 'DSMS':
      drawDsms(ctx, p);
      break;
    case 'TGP':
      drawTgp(ctx, p, info.sensor);
      break;
    case 'MAV':
      drawMav(ctx, p, info.sensor);
      break;
    case 'TAD':
      drawTad(ctx, p, info.tad);
      break;
    case 'STAT':
      drawStat(ctx, p);
      break;
    case 'MSG':
      drawMsg(ctx, p);
      break;
  }
  drawChrome(ctx, p);
  info.strokes = p.count - start;
}

/** The pages whose picture moves all the time: drawn at their rate. */
export function continuousPage(page: MfdPage): boolean {
  return page === 'TGP' || page === 'MAV' || page === 'TAD';
}

/** Smallest time between two drawings of a page, s. */
export function pageInterval(page: MfdPage, sensorRate: number): number {
  if (page === 'TGP' || page === 'MAV') return 1 / Math.max(1, sensorRate);
  if (page === 'TAD') return 1 / MFD_RATES.tad;
  return 1 / MFD_RATES.text;
}

// ---------------------------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------------------------

const FNV_PRIME = 16777619;

function mix(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), FNV_PRIME) >>> 0;
}

function mixStr(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i));
  return mix(h, 0x2f);
}

const settings = createPageSettings();

/**
 * A hash of everything a text page shows (and of the OSB labels): equal hashes mean the page
 * would draw the same. Continuous pages (TGP, MAV, TAD) do not use it.
 */
export function pageSignature(ctx: PageContext): number {
  const sim = ctx.sim;
  const av = sim.avionics;
  let h = 2166136261;
  h = mixStr(h, ctx.page);
  h = mix(h, ctx.soi ? 1 : 0);
  for (let n = 1; n <= 20; n++) {
    h = mixStr(h, osbLabel(sim, ctx.page, n, ctx.display));
    h = mixStr(h, osbValue(sim, ctx.page, n, ctx.display));
    h = mix(h, osbActive(sim, ctx.page, n, ctx.display) ? 1 : 0);
  }
  h = mixStr(h, av.masterArm);
  switch (ctx.page) {
    case 'DSMS':
      h = dsmsSignature(sim, h);
      break;
    case 'STAT':
      h = statSignature(sim, h);
      break;
    case 'MSG': {
      const ps = pageSettings(sim, settings);
      h = mix(h, ctx.messages.version);
      h = mix(h, Math.round(ps.msgClearTime * 10));
      break;
    }
    default:
      // Continuous pages change with time.
      h = mix(h, Math.round(ctx.time * 1000));
  }
  return h;
}

function dsmsSignature(sim: Sim, h: number): number {
  const av = sim.avionics;
  const ps = pageSettings(sim, settings);
  h = mixStr(h, av.selectedProfile);
  h = mix(h, ps.jettisonStation);
  h = mix(h, ps.dsmsCodeDigit);
  h = mix(h, (av as unknown as { selectedStation?: number }).selectedStation ?? 0);
  h = mix(h, sim.gun.rounds);
  h = mixStr(h, sim.gun.load);
  const st = sim.stores.stations;
  for (let i = 0; i < st.length; i++) {
    h = mix(h, st[i].stores.length);
    h = mix(h, st[i].rockets ?? -1);
    if (st[i].stores.length > 0) h = mixStr(h, st[i].stores[0]);
  }
  const pr = av.profiles;
  for (let i = 0; i < pr.length; i++) {
    const p = pr[i];
    h = mixStr(h, p.id);
    h = mixStr(h, p.mode);
    h = mixStr(h, p.release);
    h = mix(h, p.rippleQty);
    h = mix(h, Math.round(p.rippleSpacing * 10));
    h = mixStr(h, p.fuze);
    h = mix(h, Math.round(p.minAltitude));
    h = mix(h, Math.round(p.armingTime * 100));
    h = mixStr(h, p.drag ?? '');
    h = mix(h, p.laserCode ?? 0);
  }
  return h;
}

function statSignature(sim: Sim, h: number): number {
  const ac = sim.aircraft;
  const av = sim.avionics;
  const tgp = sim.sensors.tgp;
  h = mix(h, Math.round(ac.fuel / 4.5));
  h = mix(h, Math.round(ac.mass / 4.5));
  h = mix(h, Math.round(ac.gLimitPositive * 10));
  h = mix(h, Math.round(ac.engines[0].n2 * 100));
  h = mix(h, Math.round(ac.engines[1].n2 * 100));
  h = mix(h, sim.gun.rounds);
  h = mixStr(h, av.laserArm);
  h = mix(h, tgp.laserCode);
  h = mix(h, av.tgpPower && tgp.powered ? 1 : 0);
  h = mix(h, Math.ceil(tgp.warmup));
  h = mix(h, tgp.masked ? 1 : 0);
  const i = sim.sensors.selectedMaverick;
  const mav = i >= 0 ? sim.sensors.mavericks[i] : undefined;
  h = mix(h, mav ? (mav.powered ? 2 : 1) + (mav.locked ? 4 : 0) : 0);
  h = mix(h, mav ? Math.ceil(mav.align) : 0);
  h = mixStr(h, av.altSource);
  h = mix(h, ac.flapHandle);
  h = mix(h, Math.round(ac.gearPosition * 100));
  h = mix(h, Math.round(ac.speedBrakeCmd * 100));
  h = mixStr(h, ac.autopilot.engaged ? ac.autopilot.mode : 'OFF');
  return h;
}

// ---------------------------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------------------------

/** When one display draws its page again. */
export class RedrawSchedule {
  /** Clock of the last drawing, s. */
  last = -Infinity;
  private page: MfdPage | '' = '';
  private soi = false;
  private signature = -1;

  /**
   * Is a drawing due at `now` (s)? A new page or SOI change: yes. Otherwise not before
   * `interval` since the last one, then when the signature changed or `keepAlive` passed.
   */
  due(
    now: number,
    page: MfdPage,
    soi: boolean,
    signature: number,
    interval: number,
    keepAlive: number,
  ): boolean {
    if (page !== this.page || soi !== this.soi) return true;
    const dt = now - this.last;
    if (dt < interval - 1e-9) return false;
    return signature !== this.signature || dt >= keepAlive;
  }

  done(now: number, page: MfdPage, soi: boolean, signature: number): void {
    this.last = now;
    this.page = page;
    this.soi = soi;
    this.signature = signature;
  }

  /** Force the next `due` (a new flight, new display surfaces). */
  invalidate(): void {
    this.page = '';
  }
}

/** Whether the OSB table has a page (a page the avionics knows). */
export function knownPage(page: string): page is MfdPage {
  return Object.prototype.hasOwnProperty.call(OSB_TABLE, page);
}
