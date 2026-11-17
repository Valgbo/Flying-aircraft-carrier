/**
 * The sensor pages (PLAN_A10.md §6.4, §8; ARCHITECTURE §12.5, §12.7): the targeting pod (TGP) and
 * the selected Maverick's seeker (MAV). The picture itself is the sensor-view module's render
 * target, drawn underneath by the display renderer; these functions draw the symbology over it
 * from the sensors' state. Pure: no rendering, no allocation.
 *
 * TGP: crosshair, the track gate of the track mode (POINT box, AREA brackets), track mode, field
 * of view and electronic zoom, picture mode, laser arming, "T"/"L" and the range at the lower
 * left ("L" while the laser fires), laser code and latch, SPI when the pod is the SPI generator,
 * a line-of-sight cue (pod azimuth and elevation), MASK, NOT TIMED OUT while the pod warms up.
 *
 * MAV: the variant and station, the pointing cross (where the seeker looks relative to the
 * aircraft; it flashes while the seeker tracks), the track gate (dashed searching, solid locked),
 * TRK and IN RNG, field of view, NOT TIMED OUT with the alignment time left.
 */
import { NM } from '../../core/units';
import type { StoreType } from '../../core/weapons/types';
import { ALIGN_LEFT, ALIGN_RIGHT } from '../hud/strokeFont';
import { avionicsExtras, type PageContext, type SeekerExtras } from './context';
import { MAV_PAGE, MFD_COLOR as C, MFD_TEXT as T, STORE_SHORT } from './mfdLayout';
import type { MfdPainter } from './painter';

/** What the last sensor page drew (tests and the sandbox). */
export interface SensorPageInfo {
  /** Crosshair / pointing cross centre, page units. */
  crossX: number;
  crossY: number;
  /** Track gate drawn and its kind. */
  gate: 'NONE' | 'POINT' | 'AREA' | 'SEARCH' | 'LOCK';
  /** Status shown instead of the picture's symbology ('' when the sensor delivers). */
  status: string;
}

export function createSensorPageInfo(): SensorPageInfo {
  return { crossX: 0, crossY: 0, gate: 'NONE', status: '' };
}

const TWO_HZ = 2;
const FOUR_HZ = 4;

function flash(time: number, hz: number): boolean {
  return Math.floor(time * hz * 2) % 2 === 0;
}

/** A centred status (sensor off, warming up…) with an optional time below it. */
function status(p: MfdPainter, info: SensorPageInfo, text: string, seconds = -1): void {
  info.status = text;
  p.color(C.white);
  p.str(text, 0, seconds >= 0 ? 0.07 : 0, T.body);
  if (seconds >= 0) {
    p.buf.clear().time(seconds);
    p.text(0, -0.07, T.body);
  }
}

// ---------------------------------------------------------------------------------------------
// TGP
// ---------------------------------------------------------------------------------------------

export function drawTgp(ctx: PageContext, p: MfdPainter, info: SensorPageInfo): void {
  const sim = ctx.sim;
  const av = sim.avionics;
  const tgp = sim.sensors.tgp;
  info.crossX = 0;
  info.crossY = 0;
  info.gate = 'NONE';
  info.status = '';
  if (!av.tgpPower || !tgp.powered) {
    status(p, info, 'TGP OFF');
    return;
  }
  if (tgp.warmup > 0) {
    status(p, info, 'NOT TIMED OUT', tgp.warmup);
    return;
  }
  const masked = tgp.masked;

  // Crosshair with a centre gap and range ticks.
  p.color(masked ? C.grey : C.green);
  const g = 0.06;
  const L = 0.6;
  p.seg(-L, 0, -g, 0);
  p.seg(g, 0, L, 0);
  p.seg(0, -L, 0, -g);
  p.seg(0, g, 0, L);
  for (let k = 1; k <= 3; k++) {
    const d = g + k * 0.15;
    p.seg(-d, -0.02, -d, 0.02);
    p.seg(d, -0.02, d, 0.02);
    p.seg(-0.02, -d, 0.02, -d);
    p.seg(-0.02, d, 0.02, d);
  }
  // Track gate.
  if (tgp.mode === 'POINT') {
    p.box(-0.08, -0.08, 0.08, 0.08, 1.4);
    info.gate = 'POINT';
  } else if (tgp.mode === 'AREA') {
    p.brackets(0, 0, 0.1, 0.035, 1.4);
    info.gate = 'AREA';
  }

  // Track mode (top left), field of view and zoom, picture (top right).
  p.color(C.white);
  p.buf.clear().str(tgp.mode);
  if (masked) p.buf.str('-M');
  p.text(-0.62, 0.62, T.body, ALIGN_LEFT);
  p.str(tgp.fovSetting === 'WIDE' ? 'WIDE' : 'NARO', 0.62, 0.62, T.body, ALIGN_RIGHT);
  if (tgp.zoom > 1.01) {
    p.buf.clear().fixed(tgp.zoom, 1).ch(88 /* X */);
    p.text(0.62, 0.53, T.small, ALIGN_RIGHT);
  }
  p.str(tgp.picture, 0.62, 0.44, T.small, ALIGN_RIGHT);

  // Laser: arming, T/L with the range (lower left), code and latch (lower right).
  const ext = avionicsExtras(sim);
  p.buf.clear().str('LSR ').str(av.laserArm === 'TRAIN' ? 'TRN' : av.laserArm);
  p.color(av.laserArm === 'ARM' ? C.green : C.white);
  p.text(-0.62, -0.53, T.small, ALIGN_LEFT);
  const lasing = tgp.lasing;
  const range =
    tgp.laserRange > 0
      ? tgp.laserRange
      : tgp.pointValid
        ? sim.aircraft.position.distanceTo(tgp.point)
        : 0;
  p.color(lasing ? C.yellow : C.white);
  if (!lasing || flash(ctx.time, TWO_HZ)) {
    p.buf.clear().ch(lasing ? 76 /* L */ : 84 /* T */);
    if (range > 0) p.buf.ch(32).fixed(range / NM, 1);
    p.text(-0.62, -0.62, T.body, ALIGN_LEFT);
  }
  p.color(C.white);
  const code = typeof ext.laserCode === 'number' ? ext.laserCode : tgp.laserCode;
  p.buf.clear().int(code, 4);
  p.text(0.62, -0.62, T.body, ALIGN_RIGHT);
  if (ext.laserLatch === true || tgp.latched) p.str('LTCH', 0.62, -0.53, T.small, ALIGN_RIGHT);
  if (av.spi.valid && av.spi.source === 'TGP') {
    p.color(C.green);
    p.str('SPI', 0, -0.62, T.body);
  }

  // Line-of-sight cue: the pod's azimuth (±180°) and elevation (+90…−90°) in a small box.
  const bx = 0.42;
  const by = -0.3;
  const h = 0.07;
  p.color(C.grey);
  p.box(bx - h, by - h, bx + h, by + h);
  p.color(C.white);
  const cx = bx + (Math.max(-Math.PI, Math.min(Math.PI, tgp.gimbalAz)) / Math.PI) * h;
  const cy = by + (Math.max(-Math.PI / 2, Math.min(Math.PI / 2, tgp.gimbalEl)) / (Math.PI / 2)) * h;
  p.seg(cx, cy, cx, cy, 3);

  if (masked) {
    p.color(C.yellow);
    p.str('MASK', 0, 0.3, T.large);
  }
  if (!ctx.picture) {
    p.color(C.grey);
    p.str('NO VIDEO', 0, -0.3, T.small);
  }
}

// ---------------------------------------------------------------------------------------------
// MAV
// ---------------------------------------------------------------------------------------------

export function drawMav(ctx: PageContext, p: MfdPainter, info: SensorPageInfo): void {
  const sim = ctx.sim;
  const sensors = sim.sensors;
  info.crossX = 0;
  info.crossY = 0;
  info.gate = 'NONE';
  info.status = '';
  const i = sensors.selectedMaverick;
  const s = i >= 0 ? sensors.mavericks[i] : undefined;
  if (!s) {
    status(p, info, 'NO MAV');
    return;
  }
  // Variant and station (top left).
  const st = sim.stores.stations[s.station - 1];
  const type = (s as typeof s & SeekerExtras).type ?? st?.stores[0];
  p.color(C.white);
  p.str(type ? (STORE_SHORT[type as StoreType] ?? type) : 'MAV', -0.62, 0.62, T.body, ALIGN_LEFT);
  p.buf.clear().str('STA ').int(s.station);
  p.text(-0.62, 0.53, T.small, ALIGN_LEFT);
  if (!s.powered) {
    status(p, info, 'MAV OFF');
    return;
  }
  if (s.align > 0) {
    status(p, info, 'NOT TIMED OUT', s.align);
    return;
  }
  p.str(s.fov === 'NARROW' ? 'NARO' : 'WIDE', 0.62, 0.62, T.body, ALIGN_RIGHT);
  const band = (s as typeof s & SeekerExtras).band;
  if (band) p.str(band, 0.62, 0.53, T.small, ALIGN_RIGHT);

  // Pointing cross: where the seeker looks relative to the aircraft's axis.
  const scale = 0.85 / MAV_PAGE.gimbalScale;
  const x = Math.max(-0.85, Math.min(0.85, s.gimbalAz * scale));
  const y = Math.max(-0.85, Math.min(0.85, s.gimbalEl * scale));
  info.crossX = x;
  info.crossY = y;
  if (!s.locked || flash(ctx.time, FOUR_HZ)) {
    p.color(C.green);
    const a = 0.2;
    const gap = 0.03;
    p.seg(x - a, y, x - gap, y, 1.4);
    p.seg(x + gap, y, x + a, y, 1.4);
    p.seg(x, y - a, x, y - gap, 1.4);
    p.seg(x, y + gap, x, y + a, 1.4);
  }

  // Track gate at the centre of the picture (the seeker tracks what is in it).
  const h = s.fov === 'NARROW' ? MAV_PAGE.gateNarrow : MAV_PAGE.gateWide;
  if (s.locked) {
    p.color(C.green);
    p.box(-h, -h, h, h, 1.6);
    info.gate = 'LOCK';
    p.str('TRK', -0.62, -0.62, T.body, ALIGN_LEFT);
    if (s.inZone) p.str('IN RNG', 0, -0.62, T.body);
  } else {
    p.color(C.white);
    p.box(-h, -h, h, h, 1, 2);
    info.gate = 'SEARCH';
  }
  // Seeker contrast of the gate (0..1) as a bar at the right.
  const c = Math.max(0, Math.min(1, s.contrast));
  p.color(C.grey);
  p.box(0.55, -0.4, 0.6, 0.0);
  if (c > 0) {
    p.color(C.white);
    p.seg(0.575, -0.4, 0.575, -0.4 + 0.4 * c, 3);
  }
  // Missiles left.
  p.color(C.white);
  p.buf.clear().int(sensors.mavericks.length).str(' MSL');
  p.text(0.62, -0.62, T.body, ALIGN_RIGHT);
  if (!ctx.picture) {
    p.color(C.grey);
    p.str('NO VIDEO', 0, -0.3, T.small);
  }
}
