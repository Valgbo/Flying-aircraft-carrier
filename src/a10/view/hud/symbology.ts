/**
 * The HUD symbology, built every frame from the simulation state as strokes in the HUD plane
 * (hudMath.ts). Pure apart from writing into a `SegmentSink`: no three.js rendering, no
 * allocation per frame, so it runs in unit tests against a real `Sim`.
 *
 * What it draws (PLAN_A10.md §7, §6.2, §6.5):
 *  - NAV: total velocity vector, conformal pitch ladder centred on it, heading tape with the
 *    steerpoint bearing, airspeed, altitude, radar altitude, g and max g, the steerpoint
 *    block, master mode, Master Arm, GUN/PAC and rounds, break-X, altitude-alert flash.
 *  - GUNS: gun cross, CCIP gun reticle (pipper, 30-mil circle, analog range bar, minimum-range
 *    cue, out-of-range dashes, slant range), PAC annunciation, GUN INVALID.
 *  - CCIP / CCRP (first version for wave 2): bomb reticle and fall line, the delay cue when the
 *    pipper is below the glass, CCRP azimuth steering line, solution cue and release timer.
 *
 * The TOTAL VELOCITY VECTOR is the INERTIAL velocity (aircraft.velocity, over the ground),
 * as in the A-10C: it shows where the aircraft is actually going, drift included, which is
 * what the CCIP fall line and the strafing picture need.
 *
 * Order: texts first (they record their boxes), then the ladder (its numbers skip anything
 * that would land on a text), then the moving symbols.
 */
import { Vector3 } from 'three';
import type { Sim } from '../../core/types';
import { headingOf, worldToBody } from '../../core/frames';
import { msToKt, mToFt, NM } from '../../core/units';
import {
  belowGlass,
  bottomEdgeCrossing,
  clampToBox,
  clipSegment,
  clockPoint,
  DEG,
  headingDelta,
  headingLabel,
  headingTapeMarks,
  inBox,
  ladderBasis,
  ladderRungs,
  planeFromAngles,
  planeFromDir,
  rangeBarSweep,
  rungBend,
  rungDir,
  TextBuf,
  type LadderBasis,
  type Segment,
  type Vec2,
  type Vec3Like,
} from './hudMath';
import {
  GUN_LINE,
  GUN_SIGHT,
  HUD_GLASS,
  HUD_SIZES as S,
  HUD_WIDTHS as W,
  type HudLayout,
} from './hudLayout';
import {
  ALIGN_CENTER,
  ALIGN_LEFT,
  ALIGN_RIGHT,
  drawText,
  textWidth,
  type SegmentSink,
} from './strokeFont';

/** Optional record of every text drawn (tests and debugging; allocates). */
export type HudTextLog = (text: string, x: number, y: number) => void;

/** What the last build drew, for the renderer, the sandbox and tests (plane units). */
export interface HudBuildInfo {
  tvvX: number;
  tvvY: number;
  /** The velocity vector was held at the edge of the field. */
  tvvLimited: boolean;
  /** Elevation of the velocity vector above the horizon (flight-path angle), rad. */
  gamma: number;
  /** The gun or bomb pipper was drawn, and where. */
  pipper: boolean;
  pipperX: number;
  pipperY: number;
  /** The pipper's direction passes below the bottom of the glass from the current eye. */
  pipperBelowGlass: boolean;
  /** Segments written. */
  segments: number;
}

const CIRCLE_N = 48;
const COS = new Float64Array(CIRCLE_N + 1);
const SIN = new Float64Array(CIRCLE_N + 1);
for (let i = 0; i <= CIRCLE_N; i++) {
  COS[i] = Math.cos((i / CIRCLE_N) * Math.PI * 2);
  SIN[i] = Math.sin((i / CIRCLE_N) * Math.PI * 2);
}

const UP = new Vector3(0, 1, 0);
const NOSE = new Vector3(0, 0, -1);
const MAX_G_SHOWN = 2.5;
const RADAR_ALT_MAX_FT = 5000;
/** Flash rates: 2 Hz for warnings, 4 Hz for the minimum-range reticle. */
const FLASH_HZ = 2;
const FAST_FLASH_HZ = 4;
/** Column texts remembered per frame, and the clearance ladder numbers keep from them. */
const MAX_BOXES = 24;
const TEXT_MARGIN = 0.3 * DEG;
/** CCRP solution cue: HUD angle per second to release above the velocity vector. */
const CCRP_CUE_PER_S = 0.4 * DEG;

export class HudSymbology {
  readonly layout: HudLayout;
  readonly info: HudBuildInfo = {
    tvvX: 0,
    tvvY: 0,
    tvvLimited: false,
    gamma: 0,
    pipper: false,
    pipperX: 0,
    pipperY: 0,
    pipperBelowGlass: false,
    segments: 0,
  };

  private sink: SegmentSink = { seg() {} };
  private log: HudTextLog | undefined;
  private count = 0;
  private time = 0;
  private readonly buf = new TextBuf(48);
  private readonly up = new Vector3();
  private readonly tvv = new Vector3();
  private readonly dir = new Vector3();
  private readonly basis: LadderBasis = { h: new Vector3(), u: new Vector3(), s: new Vector3() };
  private basisValid = false;
  private readonly p: Vec2 = { x: 0, y: 0 };
  private readonly q: Vec2 = { x: 0, y: 0 };
  private readonly r: Vec2 = { x: 0, y: 0 };
  private readonly d3: Vec3Like = { x: 0, y: 0, z: 0 };
  private readonly clip: Segment = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private readonly rungs = new Int16Array(48);
  private readonly marks = new Int16Array(24);
  private readonly offsets = new Float32Array(24);
  /** Axis-aligned boxes of the texts drawn this frame (x0, y0, x1, y1). */
  private readonly boxes = new Float64Array(MAX_BOXES * 4);
  private boxCount = 0;

  /** Writes through to the sink and keeps the segment count (drawText uses it). */
  private readonly counting: SegmentSink = {
    seg: (x0, y0, x1, y1, w, i) => {
      this.sink.seg(x0, y0, x1, y1, w, i);
      this.count++;
    },
  };

  constructor(layout: HudLayout) {
    this.layout = layout;
  }

  /**
   * Build the whole HUD for this frame. `eye` is the head position in body coordinates (it
   * only decides "below the glass" cues: the symbols themselves are directions).
   */
  build(sim: Sim, eye: Vec3Like, sink: SegmentSink, log?: HudTextLog): HudBuildInfo {
    this.sink = sink;
    this.log = log;
    this.count = 0;
    this.boxCount = 0;
    this.time = sim.time;
    const info = this.info;
    info.pipper = false;
    info.pipperBelowGlass = false;
    const ac = sim.aircraft;
    worldToBody(ac.orientation, UP, this.up);

    this.velocityVector(sim);
    this.pipper(sim, eye);

    // Texts (recorded for the ladder's collision test).
    this.readouts(sim);
    this.leftBlock(sim);
    this.steerpointBlock(sim);
    this.modeTexts(sim);

    // Symbols.
    this.ladder();
    this.drawTvv(info.tvvX, info.tvvY);
    this.headingTape(sim);
    // The sight follows avionics.sight (the gun reticle also in CCIP when the gun is the CCIP
    // weapon), not the master mode alone.
    switch (sim.avionics.sight) {
      case 'GUN':
        this.gunCross();
        this.gunReticle(sim);
        break;
      case 'CCIP':
        this.gunCross();
        this.ccip(sim, eye);
        break;
      case 'CCRP':
        this.ccrp(sim);
        break;
      default:
        break;
    }
    if (ac.warnings.pullUp) this.breakX();

    info.segments = this.count;
    return info;
  }

  // ------------------------------------------------------------------------------------------
  // Primitives
  // ------------------------------------------------------------------------------------------

  private seg(x0: number, y0: number, x1: number, y1: number, w = 1, i = 1): void {
    this.sink.seg(x0, y0, x1, y1, w, i);
    this.count++;
  }

  /** Draw the text buffer; horizontal texts are recorded for the ladder's collision test. */
  private text(x: number, y: number, align: number, ux = 1, uy = 0): void {
    const b = this.buf;
    if (b.len === 0) return;
    drawText(this.counting, b.codes, b.len, x, y, S.text, align, W.line, 1, ux, uy);
    if (this.log) this.log(b.toString(), x, y);
    if (uy === 0 && this.boxCount < MAX_BOXES) {
      const w = textWidth(b.len, S.text);
      const o = this.boxCount * 4;
      this.boxes[o] = x - align * w;
      this.boxes[o + 1] = y - S.text / 2;
      this.boxes[o + 2] = x + (1 - align) * w;
      this.boxes[o + 3] = y + S.text / 2;
      this.boxCount++;
    }
  }

  /** True when the box overlaps (with a margin) any text drawn so far this frame. */
  private hitsText(x0: number, y0: number, x1: number, y1: number): boolean {
    const m = TEXT_MARGIN;
    for (let k = 0; k < this.boxCount; k++) {
      const o = k * 4;
      if (
        x1 + m > this.boxes[o] &&
        x0 - m < this.boxes[o + 2] &&
        y1 + m > this.boxes[o + 1] &&
        y0 - m < this.boxes[o + 3]
      )
        return true;
    }
    return false;
  }

  private circle(cx: number, cy: number, r: number, step = 1, dashed = false, w = 1): void {
    for (let k = 0; k < CIRCLE_N; k += step) {
      if (dashed && (k / step) % 2 === 1) continue;
      const k1 = k + step;
      this.seg(cx + r * COS[k], cy + r * SIN[k], cx + r * COS[k1], cy + r * SIN[k1], w);
    }
  }

  /** Arc counter-clockwise from 12 o'clock through `sweep` rad (the range-bar convention). */
  private clockArc(cx: number, cy: number, r: number, sweep: number, w: number): void {
    if (sweep <= 0) return;
    const n = Math.max(1, Math.ceil((sweep / (Math.PI * 2)) * CIRCLE_N));
    clockPoint(cx, cy, r, 0, this.p);
    for (let k = 1; k <= n; k++) {
      clockPoint(cx, cy, r, (sweep * k) / n, this.q);
      this.seg(this.p.x, this.p.y, this.q.x, this.q.y, w);
      this.p.x = this.q.x;
      this.p.y = this.q.y;
    }
  }

  /** Dashed straight line (`n` dashes). */
  private dashes(x0: number, y0: number, x1: number, y1: number, n: number): void {
    const m = n * 2 - 1;
    for (let d = 0; d < m; d += 2) {
      const t0 = d / m;
      const t1 = (d + 1) / m;
      this.seg(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0, x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1);
    }
  }

  private flash(hz: number): boolean {
    return Math.floor(this.time * hz * 2) % 2 === 0;
  }

  // ------------------------------------------------------------------------------------------
  // Velocity vector and the pipper's position (needed before the texts)
  // ------------------------------------------------------------------------------------------

  /** Total velocity vector: the inertial velocity as a body direction, held inside the field. */
  private velocityVector(sim: Sim): void {
    const ac = sim.aircraft;
    const info = this.info;
    if (ac.velocity.lengthSq() > 1) worldToBody(ac.orientation, ac.velocity, this.tvv);
    else this.tvv.copy(NOSE);
    this.tvv.normalize();
    if (!planeFromDir(this.tvv, this.p)) {
      // Moving backwards relative to the nose (tail slide): hold it at the bottom of the field.
      this.p.x = 0;
      this.p.y = -10;
    }
    info.tvvLimited = clampToBox(this.p.x, this.p.y, this.layout.tvvBox, this.q);
    info.tvvX = this.q.x;
    info.tvvY = this.q.y;
    info.gamma = Math.asin(Math.max(-1, Math.min(1, this.tvv.dot(this.up))));
    // The ladder hangs on the (held) velocity vector's direction.
    this.dir.set(this.q.x, this.q.y, -1).normalize();
    this.basisValid = ladderBasis(this.dir, this.up, NOSE, this.basis);
  }

  /** Where the gun or bomb (CCIP) pipper goes, and whether it is below the glass. */
  private pipper(sim: Sim, eye: Vec3Like): void {
    const av = sim.avionics;
    const info = this.info;
    let az: number;
    let el: number;
    if (av.sight === 'GUN' && av.gun.valid) {
      az = av.gun.pipperAz;
      el = av.gun.pipperEl;
    } else if (av.sight === 'CCIP' && av.release.valid && !av.ccipInvalid) {
      az = av.release.az;
      el = av.release.el;
    } else return;
    planeFromAngles(az, el, this.r);
    info.pipper = true;
    info.pipperX = this.r.x;
    info.pipperY = this.r.y;
    this.d3.x = this.r.x;
    this.d3.y = this.r.y;
    this.d3.z = -1;
    info.pipperBelowGlass =
      belowGlass(eye, this.d3, HUD_GLASS) || (av.sight === 'CCIP' && av.release.belowGlass);
  }

  // ------------------------------------------------------------------------------------------
  // Texts
  // ------------------------------------------------------------------------------------------

  private readouts(sim: Sim): void {
    const L = this.layout;
    const ac = sim.aircraft;
    const b = this.buf;
    // Indicated airspeed, knots.
    b.clear().int(Math.max(0, msToKt(ac.ias)));
    this.text(L.leftX, L.lineY[6], ALIGN_LEFT);
    // g, and the highest g of the flight once it is worth noting (not over the CCRP timer).
    b.clear().fixed(ac.gLoad, 1).ch(71 /* G */);
    this.text(L.leftX, L.lineY[5], ALIGN_LEFT);
    if (ac.maxG >= MAX_G_SHOWN && sim.avionics.masterMode !== 'CCRP') {
      b.clear().str('MAX ').fixed(ac.maxG, 1);
      this.text(L.leftX, L.lineY[4], ALIGN_LEFT);
    }
    // Barometric altitude, feet (to 10 ft).
    b.clear().int(Math.round(mToFt(ac.altitude) / 10) * 10);
    this.text(L.rightX, L.lineY[6], ALIGN_RIGHT);
    // Radar altitude below 5,000 ft AGL; it flashes with the altitude alert.
    const aglFt = mToFt(ac.agl);
    if (aglFt < RADAR_ALT_MAX_FT && (!ac.warnings.altitude || this.flash(FLASH_HZ))) {
      b.clear()
        .str('R ')
        .int(Math.max(0, Math.round(aglFt / 10) * 10));
      this.text(L.rightX, L.lineY[5], ALIGN_RIGHT);
    }
  }

  /** Weapon block: master mode, Master Arm, gun / PAC (or the profile), rounds. */
  private leftBlock(sim: Sim): void {
    const L = this.layout;
    const av = sim.avionics;
    const b = this.buf;
    b.clear().str(av.masterMode);
    this.text(L.leftX, L.lineY[3], ALIGN_LEFT);
    b.clear().str(av.masterArm);
    this.text(L.leftX, L.lineY[2], ALIGN_LEFT);
    b.clear();
    if (av.masterMode === 'CCIP' || av.masterMode === 'CCRP') {
      let store = '';
      for (let k = 0; k < av.profiles.length; k++)
        if (av.profiles[k].id === av.selectedProfile) store = av.profiles[k].store;
      b.str(store || av.selectedProfile, 8);
    } else if (av.gunPac === 'SAFE') b.str('GUN SAFE');
    else if (av.gunPac === 'GUNARM') b.str('GUN');
    else {
      const pac = sim.aircraft.pac;
      b.str('PAC');
      // PAC annunciation: PAC1 at the first detent, PAC2 while firing.
      if (pac.active && pac.stage > 0) b.int(pac.stage);
    }
    this.text(L.leftX, L.lineY[1], ALIGN_LEFT);
    b.clear().int(sim.gun.rounds);
    this.text(L.leftX, L.lineY[0], ALIGN_LEFT);
    // CCRP: time to release, then time of fall.
    if (av.masterMode === 'CCRP' && av.release.valid) {
      const t = av.release.timeToRelease;
      b.clear();
      if (t > 0) b.str('REL ').int(Math.ceil(t));
      else b.str('TOF ').int(Math.ceil(av.release.timeOfFall));
      this.text(L.leftX, L.lineY[4], ALIGN_LEFT);
    }
  }

  /** Steerpoint block: name, range (nm), time to go at the present closure speed. */
  private steerpointBlock(sim: Sim): void {
    const sp = activeSteerpoint(sim);
    if (!sp) return;
    const L = this.layout;
    const ac = sim.aircraft;
    const b = this.buf;
    const dx = sp.position.x - ac.position.x;
    const dz = sp.position.z - ac.position.z;
    const range = Math.hypot(dx, dz);
    b.clear().str(sp.name, 8);
    this.text(L.rightX, L.lineY[2], ALIGN_RIGHT);
    const nm = range / NM;
    b.clear();
    if (nm < 100) b.fixed(nm, 1);
    else b.int(nm);
    this.text(L.rightX, L.lineY[1], ALIGN_RIGHT);
    const closure = range > 1 ? (ac.velocity.x * dx + ac.velocity.z * dz) / range : 0;
    b.clear().time(closure > 1 ? range / closure : -1);
    this.text(L.rightX, L.lineY[0], ALIGN_RIGHT);
  }

  /** Annunciations and the slant range beside the gun reticle. */
  private modeTexts(sim: Sim): void {
    const av = sim.avionics;
    const L = this.layout;
    const b = this.buf;
    if (av.sight === 'GUN') {
      if (!av.gun.valid) {
        b.clear().str('GUN INVALID');
        this.text(L.centerX, L.warnY, ALIGN_CENTER);
      } else {
        // Slant range, thousands of feet, at 3 o'clock of the reticle.
        b.clear().fixed(mToFt(av.gun.slantRange) / 1000, 1);
        this.text(this.info.pipperX + S.reticleRadius + 0.3 * DEG, this.info.pipperY, ALIGN_LEFT);
      }
    } else if (av.masterMode === 'CCIP' && av.ccipInvalid) {
      b.clear().str('CCIP INVALID');
      this.text(L.centerX, L.warnY, ALIGN_CENTER);
    } else if (av.masterMode === 'CCRP' && !av.release.valid) {
      b.clear().str('CCRP INVALID');
      this.text(L.centerX, L.warnY, ALIGN_CENTER);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Flight symbols
  // ------------------------------------------------------------------------------------------

  private drawTvv(x: number, y: number): void {
    const r = S.tvvRadius;
    this.circle(x, y, r, 3);
    this.seg(x - r, y, x - r - S.tvvWing, y);
    this.seg(x + r, y, x + r + S.tvvWing, y);
    this.seg(x, y + r, x, y + r + S.tvvTail);
  }

  /** Project a point of a ladder rung into the plane (false when it is behind the eye). */
  private rungPoint(p: number, a: number, b: number, out: Vec2): boolean {
    return planeFromDir(rungDir(this.basis, p, a, b, this.d3), out);
  }

  /**
   * A rung stroke, clipped to the ladder window: wide above the text columns, narrow between
   * them (the two boxes do not overlap, so nothing is drawn twice).
   */
  private rungSeg(p: number, a0: number, b0: number, a1: number, b1: number): void {
    if (!this.rungPoint(p, a0, b0, this.p) || !this.rungPoint(p, a1, b1, this.q)) return;
    const c = this.clip;
    const L = this.layout;
    if (clipSegment(this.p.x, this.p.y, this.q.x, this.q.y, L.ladderBox, c))
      this.seg(c.x0, c.y0, c.x1, c.y1);
    if (clipSegment(this.p.x, this.p.y, this.q.x, this.q.y, L.ladderBandBox, c))
      this.seg(c.x0, c.y0, c.x1, c.y1);
  }

  /**
   * Conformal pitch ladder: rungs every 5° at their true elevation, the 0° rung on the true
   * horizon, centred laterally on the velocity vector, rolled with the bank. Climb rungs
   * solid with end ticks pointing down to the horizon; dive rungs dashed, bent toward the
   * horizon by half the pitch angle, ticks pointing up.
   */
  private ladder(): void {
    if (!this.basisValid) return;
    // Elevation of the (held) velocity vector above the horizon picks the rungs.
    const elDeg = Math.asin(Math.max(-1, Math.min(1, this.dir.dot(this.up)))) / DEG;
    const n = ladderRungs(elDeg, S.ladderSpanDeg, S.ladderStepDeg, this.rungs);
    const gap = S.ladderGap;
    const len = S.ladderRung;
    const bottom = this.layout.ladderBandBox.bottom;
    for (let k = 0; k < n; k++) {
      const deg = this.rungs[k];
      const p = deg * DEG;
      // A rung centred below the window is left out whole (no clipped fragments over the tape).
      if (!this.rungPoint(p, 0, 0, this.r) || this.r.y < bottom) continue;
      if (deg === 0) {
        this.rungSeg(p, -gap, 0, -gap - S.horizonLength, 0);
        this.rungSeg(p, gap, 0, gap + S.horizonLength, 0);
        continue;
      }
      if (Math.abs(deg) === 90) {
        this.zenithNadir(p, deg < 0);
        continue;
      }
      const bend = rungBend(deg);
      const ca = Math.cos(bend) * len;
      const cb = Math.sin(bend) * len;
      const tick = deg > 0 ? -S.ladderTick : S.ladderTick;
      for (let side = -1; side <= 1; side += 2) {
        const a0 = side * gap;
        const a1 = side * (gap + ca);
        if (deg > 0) this.rungSeg(p, a0, 0, a1, cb);
        else {
          // Three dashes.
          for (let d = 0; d < 3; d++) {
            const t0 = d * 0.37;
            const t1 = t0 + 0.26;
            this.rungSeg(p, a0 + (a1 - a0) * t0, cb * t0, a0 + (a1 - a0) * t1, cb * t1);
          }
        }
        this.rungSeg(p, a1, cb, a1, cb + tick);
        this.rungNumber(p, deg, side, a1, cb);
      }
    }
  }

  /** The rung's number beyond its end, upright on the rung, unless it would hit a text. */
  private rungNumber(p: number, deg: number, side: number, a: number, b: number): void {
    if (!this.rungPoint(p, a, b, this.p) || !this.rungPoint(p, a + side * 0.01, b, this.q)) return;
    let ux = (this.q.x - this.p.x) * side;
    let uy = (this.q.y - this.p.y) * side;
    const l = Math.hypot(ux, uy) || 1;
    ux /= l;
    uy /= l;
    const off = 0.24 * DEG;
    this.buf.clear().int(Math.abs(deg));
    const nx = this.p.x + side * ux * off;
    const ny = this.p.y + side * uy * off;
    const far = side * textWidth(this.buf.len, S.text);
    const fx = nx + ux * far;
    const fy = ny + uy * far;
    const box = this.layout.ladderOuterBox;
    const h = S.text / 2;
    if (!inBox(nx, ny, box) || !inBox(fx, fy, box)) return;
    if (
      this.hitsText(
        Math.min(nx, fx) - h * Math.abs(uy),
        Math.min(ny, fy) - h,
        Math.max(nx, fx) + h * Math.abs(uy),
        Math.max(ny, fy) + h,
      )
    )
      return;
    this.text(nx, ny, side > 0 ? ALIGN_LEFT : ALIGN_RIGHT, ux, uy);
  }

  /** Zenith and nadir: a small circle (with a cross at the nadir). */
  private zenithNadir(p: number, nadir: boolean): void {
    if (!this.rungPoint(p, 0, 0, this.r)) return;
    const { x, y } = this.r;
    if (!inBox(x, y, this.layout.ladderOuterBox)) return;
    const r = 0.6 * DEG;
    this.circle(x, y, r, 4);
    if (nadir) {
      const c = r * 0.7;
      this.seg(x - c, y - c, x + c, y + c);
      this.seg(x - c, y + c, x + c, y - c);
    }
  }

  private headingTape(sim: Sim): void {
    const L = this.layout;
    const ac = sim.aircraft;
    const hdg = ac.heading / DEG;
    const n = headingTapeMarks(hdg, S.tapeHalfSpanDeg, 5, this.marks, this.offsets);
    const y = L.tapeY;
    for (let k = 0; k < n; k++) {
      const x = L.centerX + this.offsets[k] / S.tapeDegPerUnit;
      const major = this.marks[k] % 10 === 0;
      this.seg(x, y, x, y - (major ? S.tapeMajorTick : S.tapeMinorTick), 1, major ? 1 : 0.85);
      if (major && Math.abs(this.offsets[k]) < S.tapeHalfSpanDeg - 2) {
        this.buf.clear().int(headingLabel(this.marks[k]), 2);
        this.text(x, y + 0.6 * DEG, ALIGN_CENTER);
      }
    }
    // Heading index: a caret under the tape centre.
    const cy = y - S.tapeMajorTick - 0.12 * DEG;
    this.seg(L.centerX - 0.26 * DEG, cy - 0.42 * DEG, L.centerX, cy);
    this.seg(L.centerX, cy, L.centerX + 0.26 * DEG, cy - 0.42 * DEG);
    // Steerpoint bearing: a bar under the tape (held, flashing, at the end when outside it).
    const sp = activeSteerpoint(sim);
    if (sp) {
      const brg = headingOf(sp.position.x - ac.position.x, sp.position.z - ac.position.z) / DEG;
      const delta = headingDelta(brg, hdg);
      const held = Math.abs(delta) > S.tapeHalfSpanDeg;
      const dx = Math.max(-S.tapeHalfSpanDeg, Math.min(S.tapeHalfSpanDeg, delta));
      if (!held || this.flash(FLASH_HZ)) {
        const x = L.centerX + dx / S.tapeDegPerUnit;
        this.seg(
          x,
          y - S.tapeMajorTick - 0.05 * DEG,
          x,
          y - S.tapeMajorTick - 0.62 * DEG,
          W.bearing,
        );
      }
    }
  }

  private breakX(): void {
    const X = this.layout.breakX;
    this.seg(X.cx - X.hx, X.cy + X.hy, X.cx + X.hx, X.cy - X.hy, W.breakX);
    this.seg(X.cx - X.hx, X.cy - X.hy, X.cx + X.hx, X.cy + X.hy, W.breakX);
  }

  // ------------------------------------------------------------------------------------------
  // GUNS
  // ------------------------------------------------------------------------------------------

  /** The gun cross: the gun line seen from the eye (2° below the boresight). */
  private gunCross(): void {
    planeFromAngles(GUN_LINE.az, GUN_LINE.el, this.p);
    const a = S.gunCross;
    const gapC = 0.12 * DEG;
    const { x, y } = this.p;
    this.seg(x - a, y, x - gapC, y);
    this.seg(x + gapC, y, x + a, y);
    this.seg(x, y + gapC, x, y + a);
    this.seg(x, y - gapC, x, y - a);
  }

  /**
   * CCIP gun reticle around the pipper: a 30-mil circle (dashed beyond the range scale,
   * flashing inside minimum range), scale ticks every 3,000 ft, the analog range bar and the
   * minimum-range cue. The pipper is drawn wherever it is: below the glass it is clipped.
   */
  private gunReticle(sim: Sim): void {
    const g = sim.avionics.gun;
    const info = this.info;
    if (!info.pipper) return;
    const px = info.pipperX;
    const py = info.pipperY;
    this.seg(px, py, px, py, W.pipper);
    const R = S.reticleRadius;
    const show = !g.tooClose || this.flash(FAST_FLASH_HZ);
    if (show) this.circle(px, py, R, 1, g.tooFar);
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      clockPoint(px, py, R, a, this.p);
      clockPoint(px, py, R + S.reticleTick, a, this.q);
      this.seg(this.p.x, this.p.y, this.q.x, this.q.y);
    }
    const sweep = rangeBarSweep(g.slantRange, GUN_SIGHT.rangeBarFull);
    if (show) this.clockArc(px, py, R - S.rangeBarInset, sweep, W.rangeBar);
    const am = rangeBarSweep(GUN_SIGHT.minRange, GUN_SIGHT.rangeBarFull);
    clockPoint(px, py, R - S.minRangeCue, am, this.p);
    clockPoint(px, py, R + 0.0008, am, this.q);
    this.seg(this.p.x, this.p.y, this.q.x, this.q.y, 1.4);
  }

  // ------------------------------------------------------------------------------------------
  // CCIP / CCRP (bombs and rockets; first version, wave 2 refines it)
  // ------------------------------------------------------------------------------------------

  private ccip(sim: Sim, eye: Vec3Like): void {
    const rel = sim.avionics.release;
    const info = this.info;
    if (!info.pipper) return;
    const px = info.pipperX;
    const py = info.pipperY;
    // Bomb fall line from the velocity vector to the pipper.
    const tx = info.tvvX;
    const ty = info.tvvY - S.tvvRadius;
    this.seg(tx, ty, px, py);
    this.seg(px, py, px, py, W.pipper);
    if (!rel.belowMinimum || this.flash(FLASH_HZ)) this.circle(px, py, S.bombReticleRadius);
    if (info.pipperBelowGlass) {
      // Delay cue where the fall line leaves the glass: hold the pickle and fly through it.
      if (bottomEdgeCrossing(eye, HUD_GLASS, tx, ty, px, py, this.q) >= 0) {
        const c = 0.9 * DEG;
        this.seg(this.q.x - c, this.q.y + 0.25 * DEG, this.q.x + c, this.q.y + 0.25 * DEG, 1.6);
      }
    }
  }

  private ccrp(sim: Sim): void {
    const rel = sim.avionics.release;
    if (!rel.valid) return;
    const L = this.layout;
    const info = this.info;
    planeFromAngles(rel.az, rel.el, this.r);
    // The horizon's image direction is the rung axis s; the ASL is perpendicular to it.
    const s = this.basis.s;
    const len = Math.hypot(s.x, s.y) || 1;
    const vx = -s.y / len;
    const vy = s.x / len;
    // Through the target azimuth; held at the field's edge (dashed, above the text columns)
    // when the target is outside.
    const box = L.tvvBox;
    const held = this.r.x < box.left || this.r.x > box.right;
    const ax = Math.min(box.right, Math.max(box.left, this.r.x));
    const ay = info.tvvY;
    const top = L.aslTop;
    const bottom = held ? L.ladderBandBox.top : L.aslBottom;
    const k0 = vy !== 0 ? (bottom - ay) / vy : 0;
    const k1 = vy !== 0 ? (top - ay) / vy : 0;
    if (held) this.dashes(ax + vx * k0, bottom, ax + vx * k1, top, 5);
    else this.seg(ax + vx * k0, bottom, ax + vx * k1, top);
    // Target designator (where the target is: the glass clips it when outside).
    this.circle(this.r.x, this.r.y, 0.35 * DEG, 6);
    // Solution cue: slides down the ASL toward the velocity vector as release approaches.
    const t = Math.max(0, rel.timeToRelease);
    const cueY = Math.min(top, info.tvvY + t * CCRP_CUE_PER_S);
    const kc = vy !== 0 ? (cueY - ay) / vy : 0;
    const cx = ax + vx * kc;
    this.seg(cx - 0.7 * DEG, cueY, cx + 0.7 * DEG, cueY, 1.8);
  }
}

function activeSteerpoint(sim: Sim) {
  const list = sim.avionics.steerpoints;
  if (list.length === 0) return null;
  const i = sim.avionics.activeSteerpoint;
  return list[i >= 0 && i < list.length ? i : 0] ?? null;
}
