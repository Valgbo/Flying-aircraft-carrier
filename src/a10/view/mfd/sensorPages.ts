/**
 * The sensor pages (PLAN_A10.md §6.4, §8; ARCHITECTURE §12.5, §12.7): the targeting pod (TGP) and
 * the selected Maverick's seeker (MAV). The picture itself is the sensor-view module's render
 * target, drawn underneath by the display renderer; these functions draw the symbology over it
 * from the sensors' state. Pure: no rendering, no allocation.
 *
 * The page's options and their settings — picture polarity, field of view, zoom, track mode,
 * laser latch and code, seeker power — are printed by the OSB labels (the avionics' OSB table
 * values), so the page itself does not repeat them.
 *
 * TGP: crosshair; the track gate of the track mode (POINT box, AREA brackets); laser arming;
 * at the lower left the slant range in nautical miles behind the letter of its source — "L"
 * a laser range (flashing while the laser fires), "T" the pod's track, none while the pod is
 * slaved or in inertial rate — and a solid "M" while the line of sight is masked; SPI when the
 * pod is the SPI generator; a line-of-sight cue (pod azimuth and elevation); MASK; NOT TIMED OUT
 * while the pod warms up.
 *
 * MAV: the variant and station; the pointing cross (where the seeker looks relative to the
 * boresight; it flashes while the seeker tracks), the gimbal-limit circle when the seeker is held
 * at its limit, the track gate (dashed searching, solid locked), TRK and IN RNG, the seeker's
 * slant range, the missiles left; NOT TIMED OUT with the alignment time left.
 */
import { NM } from '../../core/units';
import { MAVERICK } from '../../data/sensors';
import { ALIGN_LEFT, ALIGN_RIGHT } from '../hud/strokeFont';
import type { PageContext } from './context';
import { MAV_PAGE, MFD_COLOR as C, MFD_TEXT as T, STORE_SHORT, TGP_PAGE } from './mfdLayout';
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
  /** TGP: the range cue's source letter ('L', 'T' or ''), masked, and the range shown (m, 0 none). */
  rangeSource: '' | 'L' | 'T';
  masked: boolean;
  range: number;
  /** MAV: the gimbal-limit circle is drawn. */
  gimbalLimit: boolean;
}

export function createSensorPageInfo(): SensorPageInfo {
  return {
    crossX: 0,
    crossY: 0,
    gate: 'NONE',
    status: '',
    rangeSource: '',
    masked: false,
    range: 0,
    gimbalLimit: false,
  };
}

const TWO_HZ = 2;
const FOUR_HZ = 4;

function flash(time: number, hz: number): boolean {
  return Math.floor(time * hz * 2) % 2 === 0;
}

function resetInfo(info: SensorPageInfo): void {
  info.crossX = 0;
  info.crossY = 0;
  info.gate = 'NONE';
  info.status = '';
  info.rangeSource = '';
  info.masked = false;
  info.range = 0;
  info.gimbalLimit = false;
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
  resetInfo(info);
  if (!av.tgpPower || !tgp.powered) {
    status(p, info, 'TGP OFF');
    return;
  }
  if (tgp.warmup > 0) {
    status(p, info, 'NOT TIMED OUT', tgp.warmup);
    return;
  }
  const masked = tgp.masked;
  info.masked = masked;

  // Crosshair with a centre gap and range ticks.
  p.color(masked ? C.grey : C.green);
  const g = TGP_PAGE.crossGap;
  const L = TGP_PAGE.crossArm;
  p.seg(-L, 0, -g, 0);
  p.seg(g, 0, L, 0);
  p.seg(0, -L, 0, -g);
  p.seg(0, g, 0, L);
  for (let k = 1; k <= 3; k++) {
    const d = g + k * TGP_PAGE.tickStep;
    p.seg(-d, -0.02, -d, 0.02);
    p.seg(d, -0.02, d, 0.02);
    p.seg(-0.02, -d, 0.02, -d);
    p.seg(-0.02, d, 0.02, d);
  }
  // Track gate.
  if (tgp.mode === 'POINT') {
    const h = TGP_PAGE.pointGate;
    p.box(-h, -h, h, h, 1.4);
    info.gate = 'POINT';
  } else if (tgp.mode === 'AREA') {
    p.brackets(0, 0, TGP_PAGE.areaGate, 0.035, 1.4);
    info.gate = 'AREA';
  }

  // Laser arming (the armament panel's LASER switch).
  const x0 = TGP_PAGE.leftX;
  p.buf
    .clear()
    .str('LSR ')
    .str(av.laserArm === 'TRAIN' ? 'TRN' : av.laserArm);
  p.color(av.laserArm === 'ARM' ? C.green : C.white);
  p.text(x0, TGP_PAGE.lowerY + TGP_PAGE.rowStep, T.small, ALIGN_LEFT);

  // Range and its source: L (laser, flashing while it fires), T (track), none (slaved / INR).
  const lasing = tgp.lasing && tgp.laserRange > 0;
  const tracking = tgp.mode === 'POINT' || tgp.mode === 'AREA';
  const range = lasing
    ? tgp.laserRange
    : tgp.pointRange > 0
      ? tgp.pointRange
      : tgp.pointValid
        ? sim.aircraft.position.distanceTo(tgp.point)
        : 0;
  info.rangeSource = lasing ? 'L' : tracking ? 'T' : '';
  info.range = range;
  const y = TGP_PAGE.lowerY;
  const cw = T.body * 0.95;
  if (lasing) {
    p.color(C.yellow);
    if (flash(ctx.time, TWO_HZ)) p.str('L', x0, y, T.body, ALIGN_LEFT);
  } else if (tracking) {
    p.color(C.white);
    p.str('T', x0, y, T.body, ALIGN_LEFT);
  }
  if (masked) {
    p.color(C.yellow);
    p.str('M', x0 + cw, y, T.body, ALIGN_LEFT);
  }
  if (range > 0) {
    p.color(C.white);
    p.buf.clear().fixed(range / NM, 1);
    p.text(x0 + 2.6 * cw, y, T.body, ALIGN_LEFT);
  }

  if (av.spi.valid && av.spi.source === 'TGP') {
    p.color(C.green);
    p.str('SPI', 0, y, T.body);
  }

  // Line-of-sight cue: the pod's azimuth (±180°) and elevation (+90…−90°) in a small box.
  const bx = TGP_PAGE.losX;
  const by = TGP_PAGE.losY;
  const h = TGP_PAGE.losHalf;
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
  resetInfo(info);
  const i = sensors.selectedMaverick;
  const s = i >= 0 ? sensors.mavericks[i] : undefined;
  if (!s) {
    status(p, info, 'NO MAV');
    return;
  }
  // Variant and station (top left).
  const type = s.type ?? sim.stores.stations[s.station - 1]?.stores[0];
  p.color(C.white);
  p.str(type ? (STORE_SHORT[type] ?? type) : 'MAV', -0.62, 0.62, T.body, ALIGN_LEFT);
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

  // Pointing cross: where the seeker looks relative to the aircraft's axis.
  const scale = MAV_PAGE.crossRange / MAV_PAGE.gimbalScale;
  const r = MAV_PAGE.crossRange;
  const x = Math.max(-r, Math.min(r, s.gimbalAz * scale));
  const y = Math.max(-r, Math.min(r, s.gimbalEl * scale));
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
  // Gimbal cue: held at the limit, the limit shows as a dashed circle the cross rides on.
  if (s.atLimit) {
    p.color(C.yellow);
    p.circle(0, 0, MAVERICK.gimbalLimit * scale, true);
    info.gimbalLimit = true;
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
  // Slant range (nm) and the missiles left (lower right).
  p.color(C.white);
  if (s.range > 0) {
    info.range = s.range;
    p.buf.clear().fixed(s.range / NM, 1);
    p.text(0.62, -0.53, T.small, ALIGN_RIGHT);
  }
  p.buf.clear().int(sensors.mavericks.length).str(' MSL');
  p.text(0.62, -0.62, T.body, ALIGN_RIGHT);
  if (!ctx.picture) {
    p.color(C.grey);
    p.str('NO VIDEO', 0, -0.3, T.small);
  }
}
