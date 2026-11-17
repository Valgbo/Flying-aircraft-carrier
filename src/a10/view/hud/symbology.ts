/**
 * The HUD symbology, built every frame from the simulation state as strokes in the HUD plane
 * (hudMath.ts). Pure apart from writing into a `SegmentSink`: no three.js rendering, no
 * allocation per frame, so it runs in unit tests against a real `Sim`.
 *
 * THE DRAWN STATE (ARCHITECTURE §6 "Interpolation", wave-1 review finding FC-4). The world is
 * drawn at the aircraft pose interpolated between the last two 120 Hz steps (`drawPose`), up to
 * one step behind the simulation. Every world-referenced symbol — velocity vector, pitch ladder,
 * heading, pippers, designated target, SPI and sensor marks — is projected from THAT pose
 * (`drawn`), from the design eye, exactly as avionics' `hudAnglesOfPoint` does at the step's
 * pose; otherwise the symbols slide against the world by ≈1.5 mrad per 10°/s of rotation.
 * Without `drawn` the HUD is drawn for the step's own state and uses the avionics' angles.
 *
 * What it draws (PLAN_A10.md §7, §6.2, §6.4–6.7):
 *  - NAV: total velocity vector, conformal pitch ladder centred on it, heading tape with the
 *    steerpoint bearing, airspeed, altitude, radar altitude, g and max g, the steerpoint
 *    block, the SPI source, master mode (with the SOI asterisk when the HUD is the sensor of
 *    interest), Master Arm, GUN/PAC and rounds, break-X, altitude-alert flash.
 *  - GUNS: gun cross, CCIP gun reticle (pipper, 30-mil circle, analog range bar, minimum-range
 *    cue, out-of-range dashes, slant range), PAC annunciation, GUN INVALID.
 *  - CCIP bombs: the projected bomb impact line (PBIL) from the velocity vector to the reticle,
 *    the minimum range staple on it, and — when the pipper is below the glass — a dashed PBIL
 *    with the delay cue: pressing the release designates the ground under the cue (consent
 *    release), after which the designated target (TD box), the steering line, the solution cue,
 *    the time to release and the release cue show.
 *  - CCIP rockets: rocket reticle and slant range.
 *  - CCRP: azimuth steering line, solution cue with the time to release beside it, release cue,
 *    time to release then time of fall (time to impact while a bomb is falling, to time the
 *    laser), CCIP / CCRP INVALID.
 *  - Sensors: SPI diamond with its slant range (held at the edge as a dashed square when it is
 *    outside the field), targeting-pod line-of-sight diamond (with a tail when the pod is the
 *    SPI generator), Maverick seeker line of sight (wagon wheel), the weapon block (profile
 *    name, stores left and the release mode).
 *  - Relaxed realism: boxes around vehicles.
 *
 * The TOTAL VELOCITY VECTOR is the INERTIAL velocity (over the ground), as in the A-10C: it shows
 * where the aircraft is actually going, drift included, which the CCIP fall line needs.
 *
 * Order: texts first — the readouts, the blocks, the heading tape and the SPI's range — (they
 * record their boxes), then the ladder (its numbers skip anything that would land on a text),
 * then the moving symbols.
 */
import { Quaternion, Vector3 } from 'three';
import type { ReleaseSolution, WeaponProfile } from '../../core/avionics/types';
import { attitudeFromQuaternion, headingOf, type Attitude } from '../../core/frames';
import type { Sim } from '../../core/types';
import { msToKt, mToFt, NM } from '../../core/units';
import type { StoreType } from '../../core/weapons/types';
import { A10_GEOMETRY } from '../../data/geometry';
import { STORES, type StoreKind } from '../../data/munitions';
import {
  belowGlass,
  clampToBox,
  clipSegment,
  clockPoint,
  DEG,
  headingDelta,
  headingLabel,
  headingTapeMarks,
  holdOnBox,
  inBox,
  ladderBasis,
  ladderRungs,
  minimumRangeFraction,
  planeFromAngles,
  planeFromDir,
  rangeBarSweep,
  rungBend,
  rungDir,
  segmentLineIntersection,
  TextBuf,
  type Box,
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
  HUD_STORE_SYMBOLS,
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

/** The aircraft as the world is drawn this frame (drawPose, and the velocity at that time). */
export interface HudDrawState {
  /** World position of the reference point, m. */
  position: Vector3;
  /** Body → world rotation. */
  orientation: Quaternion;
  /** Inertial velocity, world m/s. */
  velocity: Vector3;
}

/** Optional record of every text drawn, with its alignment (tests and debugging; allocates). */
export type HudTextLog = (text: string, x: number, y: number, align: number) => void;

/** What the last build drew, for the renderer, the sandbox and tests (plane units). */
export interface HudBuildInfo {
  tvvX: number;
  tvvY: number;
  /** The velocity vector was held at the edge of the field. */
  tvvLimited: boolean;
  /** Elevation of the velocity vector above the horizon (flight-path angle), rad. */
  gamma: number;
  /** Heading the tape shows (the drawn attitude), rad. */
  heading: number;
  /** The gun or bomb pipper was drawn, and where. */
  pipper: boolean;
  pipperX: number;
  pipperY: number;
  /** The pipper's direction passes below the bottom of the glass from the current eye. */
  pipperBelowGlass: boolean;
  /**
   * The pipper is below the bottom of the glass seen from the DESIGN eye — the symbol
   * generator's field, which knows nothing of the pilot's head. The CCIP delay cue follows it.
   */
  pipperBelowField: boolean;
  /** CCIP bombs: the projected bomb impact line, from (x0, y0) at the velocity vector to (x1, y1). */
  pbil: boolean;
  pbilDashed: boolean;
  pbilX0: number;
  pbilY0: number;
  pbilX1: number;
  pbilY1: number;
  /** Minimum range staple on the PBIL. */
  staple: boolean;
  stapleX: number;
  stapleY: number;
  /** Delay cue (pipper below the glass): the point the release designates. */
  delayCue: boolean;
  delayCueX: number;
  delayCueY: number;
  /** Designated target of a consent release (TD box). */
  designated: boolean;
  designatedX: number;
  designatedY: number;
  /** Azimuth steering line, and its offset from the velocity vector at the TVV's elevation (+ right). */
  asl: boolean;
  aslDx: number;
  /** Solution cue on the steering line; the release cue. */
  cue: boolean;
  cueX: number;
  cueY: number;
  releaseCue: boolean;
  /** Countdowns in the weapon block, s (NaN when not shown). */
  timeToRelease: number;
  timeOfFall: number;
  /** SPI marker: drawn, where, held at the edge of the field. */
  spi: boolean;
  spiX: number;
  spiY: number;
  spiHeld: boolean;
  /** Targeting-pod line-of-sight diamond. */
  tgp: boolean;
  tgpX: number;
  tgpY: number;
  /** Selected Maverick's seeker line of sight. */
  mav: boolean;
  mavX: number;
  mavY: number;
  /** Relaxed realism: vehicles boxed. */
  vehicleBoxes: number;
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

const NOSE = new Vector3(0, 0, -1);
const DESIGN_EYE = A10_GEOMETRY.eye;
const MAX_G_SHOWN = 2.5;
const RADAR_ALT_MAX_FT = 5000;
/** Flash rates: 2 Hz for warnings, 4 Hz for the minimum-range reticle and the release cue. */
const FLASH_HZ = 2;
const FAST_FLASH_HZ = 4;
/** Column texts remembered per frame, and the clearance ladder numbers keep from them. */
const MAX_BOXES = 40;
const TEXT_MARGIN = 0.3 * DEG;
/** Elevation step between the two points that define the steering line, rad. */
const ASL_STEP = 5 * DEG;
/** Largest elevation the solution cue is projected at (it is held at the line's end anyway). */
const CUE_EL_MAX = 80 * DEG;
/** Countdown kinds in the weapon block. */
const COUNT_NONE = 0;
const COUNT_REL = 1;
const COUNT_TOF = 2;

const RELEASE_LABEL: Record<WeaponProfile['release'], string> = {
  SGL: 'SGL',
  PRS: 'PRS',
  RIP_SGL: 'RIP SGL',
  RIP_PRS: 'RIP PRS',
};

export class HudSymbology {
  readonly layout: HudLayout;
  readonly info: HudBuildInfo = {
    tvvX: 0,
    tvvY: 0,
    tvvLimited: false,
    gamma: 0,
    heading: 0,
    pipper: false,
    pipperX: 0,
    pipperY: 0,
    pipperBelowGlass: false,
    pipperBelowField: false,
    pbil: false,
    pbilDashed: false,
    pbilX0: 0,
    pbilY0: 0,
    pbilX1: 0,
    pbilY1: 0,
    staple: false,
    stapleX: 0,
    stapleY: 0,
    delayCue: false,
    delayCueX: 0,
    delayCueY: 0,
    designated: false,
    designatedX: 0,
    designatedY: 0,
    asl: false,
    aslDx: 0,
    cue: false,
    cueX: 0,
    cueY: 0,
    releaseCue: false,
    timeToRelease: NaN,
    timeOfFall: NaN,
    spi: false,
    spiX: 0,
    spiY: 0,
    spiHeld: false,
    tgp: false,
    tgpX: 0,
    tgpY: 0,
    mav: false,
    mavX: 0,
    mavY: 0,
    vehicleBoxes: 0,
    segments: 0,
  };

  private sink: SegmentSink = { seg() {} };
  private log: HudTextLog | undefined;
  private count = 0;
  private time = 0;
  private readonly buf = new TextBuf(48);
  // The drawn state: position, orientation (and its inverse), velocity, design eye, heading.
  private readonly P = new Vector3();
  private readonly Q = new Quaternion();
  private readonly Qinv = new Quaternion();
  private readonly V = new Vector3();
  private readonly eyeW = new Vector3();
  private readonly att: Attitude = { heading: 0, pitch: 0, bank: 0 };
  private headingRad = 0;
  /** No drawn state: use the avionics' angles for the solutions (the step's own state). */
  private useAngles = true;
  private profile: WeaponProfile | null = null;
  private kind: StoreKind | null = null;
  // Countdown chosen for this frame.
  private countKind = COUNT_NONE;
  private countValue = 0;
  // The newest falling bomb (time to impact) and the last release.
  private watchedSim: Sim | null = null;
  private trackedBody = -1;
  private inFlight = false;
  private impactAt = 0;
  private releasedAt = -Infinity;

  private readonly up = new Vector3();
  private readonly tvv = new Vector3();
  private readonly dir = new Vector3();
  private readonly tmp = new Vector3();
  private readonly basis: LadderBasis = { h: new Vector3(), u: new Vector3(), s: new Vector3() };
  private basisValid = false;
  private readonly p: Vec2 = { x: 0, y: 0 };
  private readonly q: Vec2 = { x: 0, y: 0 };
  private readonly r: Vec2 = { x: 0, y: 0 };
  private readonly a2: Vec2 = { x: 0, y: 0 };
  private readonly b2: Vec2 = { x: 0, y: 0 };
  private readonly d3: Vec3Like = { x: 0, y: 0, z: 0 };
  private readonly clip: Segment = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private readonly aslBox: Box = { left: 0, right: 0, bottom: 0, top: 0 };
  /** The SPI mark this frame (spiPlace, drawn by sensorMarks): where, and held at the edge. */
  private spiShown = false;
  private spiHeld = false;
  private spiX = 0;
  private spiY = 0;
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
    const b = layout.tvvBox;
    this.aslBox.left = b.left;
    this.aslBox.right = b.right;
    this.aslBox.bottom = layout.aslBottom;
    this.aslBox.top = layout.aslTop;
  }

  /**
   * Build the whole HUD for this frame. `eye` is the head position in body coordinates (it only
   * decides `pipperBelowGlass`: the symbols are directions). `drawn` is the aircraft state the
   * world is drawn with (FC-4); without it the step's own state is drawn.
   */
  build(
    sim: Sim,
    eye: Vec3Like,
    sink: SegmentSink,
    log?: HudTextLog,
    drawn?: HudDrawState,
  ): HudBuildInfo {
    this.sink = sink;
    this.log = log;
    this.count = 0;
    this.boxCount = 0;
    this.time = sim.time;
    this.resetInfo();
    this.drawnState(sim, drawn);
    this.selectProfile(sim);

    this.velocityVector();
    this.pipper(sim, eye);
    this.watchReleases(sim);
    this.countdown(sim);

    // Texts (recorded for the ladder's collision test).
    this.readouts(sim);
    this.leftBlock(sim);
    this.steerpointBlock(sim);
    this.spiSource(sim);
    this.modeTexts(sim);
    // The heading tape's numbers are texts too (its marks depend only on the heading).
    this.headingTape(sim);
    this.spiPlace(sim);

    // Symbols.
    this.ladder();
    this.drawTvv(this.info.tvvX, this.info.tvvY);
    // The sight follows avionics.sight (the gun reticle also in CCIP when the gun is the CCIP
    // weapon), not the master mode alone.
    switch (sim.avionics.sight) {
      case 'GUN':
        this.gunCross();
        this.gunReticle(sim);
        break;
      case 'CCIP':
        this.gunCross();
        if (this.kind === 'rocketPod') this.rocketReticle(sim);
        else this.bombs(sim);
        break;
      case 'CCRP':
        this.ccrp(sim);
        break;
      default:
        break;
    }
    this.sensorMarks(sim);
    this.vehicleBoxes(sim);
    if (sim.aircraft.warnings.pullUp) this.breakX();

    this.info.segments = this.count;
    return this.info;
  }

  private resetInfo(): void {
    const i = this.info;
    i.pipper = false;
    i.pipperBelowGlass = false;
    i.pipperBelowField = false;
    i.pbil = false;
    i.pbilDashed = false;
    i.staple = false;
    i.delayCue = false;
    i.designated = false;
    i.asl = false;
    i.aslDx = 0;
    i.cue = false;
    i.releaseCue = false;
    i.timeToRelease = NaN;
    i.timeOfFall = NaN;
    i.spi = false;
    i.spiHeld = false;
    i.tgp = false;
    i.mav = false;
    i.vehicleBoxes = 0;
  }

  // ------------------------------------------------------------------------------------------
  // The drawn state and projection
  // ------------------------------------------------------------------------------------------

  private drawnState(sim: Sim, drawn: HudDrawState | undefined): void {
    const ac = sim.aircraft;
    if (drawn) {
      this.P.copy(drawn.position);
      this.Q.copy(drawn.orientation);
      this.V.copy(drawn.velocity);
      this.headingRad = attitudeFromQuaternion(this.Q, this.att).heading;
    } else {
      this.P.copy(ac.position);
      this.Q.copy(ac.orientation);
      this.V.copy(ac.velocity);
      this.headingRad = ac.heading;
    }
    this.useAngles = drawn === undefined;
    this.Qinv.copy(this.Q).invert();
    this.eyeW.set(DESIGN_EYE.x, DESIGN_EYE.y, DESIGN_EYE.z).applyQuaternion(this.Q).add(this.P);
    this.up.set(0, 1, 0).applyQuaternion(this.Qinv);
    this.info.heading = this.headingRad;
  }

  /** Body direction (from the design eye) of a world point. */
  private bodyDirOf(p: Vec3Like, out: Vector3): Vector3 {
    return out
      .set(p.x - this.eyeW.x, p.y - this.eyeW.y, p.z - this.eyeW.z)
      .applyQuaternion(this.Qinv);
  }

  /** HUD-plane point of a world point, from the design eye (false when behind the eye). */
  private projectPoint(p: Vec3Like, out: Vec2): boolean {
    return planeFromDir(this.bodyDirOf(p, this.tmp), out);
  }

  /** HUD-plane point of a world direction (a point at infinity). */
  private projectDir(d: Vec3Like, out: Vec2): boolean {
    this.tmp.set(d.x, d.y, d.z).applyQuaternion(this.Qinv);
    return planeFromDir(this.tmp, out);
  }

  /** A fire-control solution's direction: the avionics' angles (step state) or its point. */
  private solutionPoint(point: Vector3, az: number, el: number, out: Vec2): boolean {
    if (this.useAngles) {
      planeFromAngles(az, el, out);
      return true;
    }
    return this.projectPoint(point, out);
  }

  private selectProfile(sim: Sim): void {
    const av = sim.avionics;
    this.profile = null;
    this.kind = null;
    const list = av.profiles;
    for (let k = 0; k < list.length; k++) {
      if (list[k].id === av.selectedProfile) {
        this.profile = list[k];
        this.kind = STORES[list[k].store as StoreType]?.kind ?? null;
        return;
      }
    }
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
    if (this.log) this.log(b.toString(), x, y, align);
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

  /** Dashes of fixed length along a unit direction, starting with a dash, for `length`. */
  private dashedRun(
    x: number,
    y: number,
    ux: number,
    uy: number,
    length: number,
    dash: number,
    gap: number,
  ): void {
    for (let s = 0; s < length; s += dash + gap) {
      const e = Math.min(length, s + dash);
      this.seg(x + ux * s, y + uy * s, x + ux * e, y + uy * e);
    }
  }

  /** Square (half-size h), dashed when asked. */
  private square(x: number, y: number, h: number, dashed = false): void {
    if (dashed) {
      this.dashes(x - h, y - h, x + h, y - h, 3);
      this.dashes(x + h, y - h, x + h, y + h, 3);
      this.dashes(x + h, y + h, x - h, y + h, 3);
      this.dashes(x - h, y + h, x - h, y - h, 3);
      return;
    }
    this.seg(x - h, y - h, x + h, y - h);
    this.seg(x + h, y - h, x + h, y + h);
    this.seg(x + h, y + h, x - h, y + h);
    this.seg(x - h, y + h, x - h, y - h);
  }

  /** Diamond (half-diagonal h). */
  private diamond(x: number, y: number, h: number): void {
    this.seg(x, y + h, x + h, y);
    this.seg(x + h, y, x, y - h);
    this.seg(x, y - h, x - h, y);
    this.seg(x - h, y, x, y + h);
  }

  private flash(hz: number): boolean {
    return Math.floor(this.time * hz * 2) % 2 === 0;
  }

  // ------------------------------------------------------------------------------------------
  // Velocity vector and the pipper's position (needed before the texts)
  // ------------------------------------------------------------------------------------------

  /** Total velocity vector: the inertial velocity as a body direction, held inside the field. */
  private velocityVector(): void {
    const info = this.info;
    if (this.V.lengthSq() > 1) this.tvv.copy(this.V).applyQuaternion(this.Qinv);
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

  /** Where the gun or bomb/rocket (CCIP) pipper goes, and whether it is below the glass. */
  private pipper(sim: Sim, eye: Vec3Like): void {
    const av = sim.avionics;
    const info = this.info;
    let ok = false;
    if (av.sight === 'GUN' && av.gun.valid) {
      ok = this.solutionPoint(av.gun.impact, av.gun.pipperAz, av.gun.pipperEl, this.r);
    } else if (av.sight === 'CCIP' && av.release.valid && !av.ccipInvalid) {
      const rel = av.release;
      ok = this.solutionPoint(rel.impact, rel.az, rel.el, this.r);
    }
    if (!ok) return;
    info.pipper = true;
    info.pipperX = this.r.x;
    info.pipperY = this.r.y;
    this.d3.x = this.r.x;
    this.d3.y = this.r.y;
    this.d3.z = -1;
    info.pipperBelowGlass =
      belowGlass(eye, this.d3, HUD_GLASS) || (av.sight === 'CCIP' && av.release.belowGlass);
    info.pipperBelowField = belowGlass(DESIGN_EYE, this.d3, HUD_GLASS);
  }

  /**
   * Follow the newest bomb in flight (time to impact, PLAN §6.6: timing the laser). Its time of
   * fall is the release solution's at the frame it appears (the computer's prediction at
   * release); a vacuum fall from its state if there is none.
   */
  private watchReleases(sim: Sim): void {
    if (sim !== this.watchedSim) {
      this.watchedSim = sim;
      this.trackedBody = -1;
      this.releasedAt = -Infinity;
    }
    const bodies = sim.projectiles.bodies;
    let newest = -1;
    let index = -1;
    let tracked = false;
    for (let k = 0; k < bodies.length; k++) {
      const b = bodies[k];
      if (!b.alive || b.delivery === 'JETTISON') continue;
      if (b.kind !== 'bomb' && b.kind !== 'laserBomb' && b.kind !== 'dispenser') continue;
      if (b.id === this.trackedBody) tracked = true;
      if (b.id > newest) {
        newest = b.id;
        index = k;
      }
    }
    if (index >= 0 && newest > this.trackedBody) {
      const b = bodies[index];
      const rel = sim.avionics.release;
      this.trackedBody = newest;
      this.releasedAt = b.releaseTime;
      let tof = rel.valid && rel.timeOfFall > 0 ? b.releaseTime + rel.timeOfFall - sim.time : 0;
      if (!(tof > 0)) {
        const terrain = sim.world.terrain;
        const h = b.position.y - terrain.heightAt(b.position.x, b.position.z);
        const w = -b.velocity.y;
        tof = h > 0 ? (-w + Math.sqrt(w * w + 2 * 9.80665 * h)) / 9.80665 : 0;
      }
      this.impactAt = sim.time + tof;
      tracked = true;
    }
    this.inFlight = tracked;
  }

  /** The weapon block's countdown: time to impact of a falling bomb, else time to release. */
  private countdown(sim: Sim): void {
    const av = sim.avionics;
    const rel = av.release;
    this.countKind = COUNT_NONE;
    // The computer's own time to impact when it keeps one, else the HUD's watch of the bomb.
    const tti = rel.timeToImpact;
    const left = tti >= 0 ? tti : this.inFlight ? this.impactAt - sim.time : -1;
    if (left > 0) {
      this.countKind = COUNT_TOF;
      this.countValue = left;
    } else if (av.sight === 'CCRP' && rel.valid && !rel.passed) {
      if (rel.timeToRelease > 0) {
        this.countKind = COUNT_REL;
        this.countValue = rel.timeToRelease;
      } else {
        this.countKind = COUNT_TOF;
        this.countValue = rel.timeOfFall;
      }
    } else if (av.sight === 'CCIP' && rel.valid && rel.designatedValid && rel.timeToRelease > 0) {
      this.countKind = COUNT_REL;
      this.countValue = rel.timeToRelease;
    }
    if (this.countKind === COUNT_REL) this.info.timeToRelease = this.countValue;
    else if (this.countKind === COUNT_TOF) this.info.timeOfFall = this.countValue;
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
    // g, and the highest g of the flight once it is worth noting (not over a countdown).
    b.clear().fixed(ac.gLoad, 1).ch(71 /* G */);
    this.text(L.leftX, L.lineY[5], ALIGN_LEFT);
    if (
      ac.maxG >= MAX_G_SHOWN &&
      sim.avionics.masterMode !== 'CCRP' &&
      this.countKind === COUNT_NONE
    ) {
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

  /**
   * Weapon block: master mode (and the SOI asterisk), Master Arm, then the weapon: the gun and
   * its rounds, or the selected profile with the stores left and its release mode; the
   * countdown (REL / TOF) above.
   */
  private leftBlock(sim: Sim): void {
    const L = this.layout;
    const av = sim.avionics;
    const b = this.buf;
    b.clear().str(av.masterMode);
    this.text(L.leftX, L.lineY[3], ALIGN_LEFT);
    if (av.soi === 'HUD') {
      // The HUD is the sensor of interest.
      const w = textWidth(av.masterMode.length, S.text);
      b.clear().ch(42 /* * */);
      this.text(L.leftX + w + S.text * 0.7, L.lineY[3], ALIGN_LEFT);
    }
    b.clear().str(av.masterArm);
    this.text(L.leftX, L.lineY[2], ALIGN_LEFT);
    const p = this.profile;
    const stores =
      p !== null && (av.masterMode === 'CCRP' || (av.masterMode === 'CCIP' && av.sight !== 'GUN'));
    if (stores && p) {
      b.clear().str(p.name ?? p.id, 8);
      this.text(L.leftX, L.lineY[1], ALIGN_LEFT);
      b.clear()
        .int(storesLeft(sim, p.store))
        .ch(32)
        .str(RELEASE_LABEL[p.release] ?? p.release);
      this.text(L.leftX, L.lineY[0], ALIGN_LEFT);
    } else {
      b.clear();
      if (av.gunPac === 'SAFE') b.str('GUN SAFE');
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
    }
    // Time to release, then time of fall / to impact.
    if (this.countKind !== COUNT_NONE) {
      b.clear()
        .str(this.countKind === COUNT_REL ? 'REL ' : 'TOF ')
        .int(Math.ceil(this.countValue));
      this.text(L.leftX, L.lineY[4], ALIGN_LEFT);
    }
  }

  /** Steerpoint block: name, range (nm), time to go at the present closure speed. */
  private steerpointBlock(sim: Sim): void {
    const sp = activeSteerpoint(sim);
    if (!sp) return;
    const L = this.layout;
    const b = this.buf;
    const dx = sp.position.x - this.P.x;
    const dz = sp.position.z - this.P.z;
    const range = Math.hypot(dx, dz);
    b.clear().str(sp.name, 8);
    this.text(L.rightX, L.lineY[2], ALIGN_RIGHT);
    const nm = range / NM;
    b.clear();
    if (nm < 100) b.fixed(nm, 1);
    else b.int(nm);
    this.text(L.rightX, L.lineY[1], ALIGN_RIGHT);
    const closure = range > 1 ? (this.V.x * dx + this.V.z * dz) / range : 0;
    b.clear().time(closure > 1 ? range / closure : -1);
    this.text(L.rightX, L.lineY[0], ALIGN_RIGHT);
  }

  /** The SPI's source (steerpoint, pod, Maverick, HUD, map). */
  private spiSource(sim: Sim): void {
    const spi = sim.avionics.spi;
    if (!spi.valid) return;
    this.buf.clear().str('SPI ').str(spi.source);
    this.text(this.layout.rightX, this.layout.lineY[3], ALIGN_RIGHT);
  }

  /** Annunciations and the slant ranges beside the gun and rocket reticles. */
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
    } else if (av.masterMode === 'CCRP' && (av.sight !== 'CCRP' || !av.release.valid)) {
      b.clear().str('CCRP INVALID');
      this.text(L.centerX, L.warnY, ALIGN_CENTER);
    } else if (av.sight === 'CCIP' && this.kind === 'rocketPod' && this.info.pipper) {
      // Rockets: slant range to the impact, thousands of feet.
      const range = this.P.distanceTo(av.release.impact);
      b.clear().fixed(mToFt(range) / 1000, 1);
      this.text(
        this.info.pipperX + S.rocketReticleRadius + 0.5 * DEG,
        this.info.pipperY,
        ALIGN_LEFT,
      );
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
    const hdg = this.headingRad / DEG;
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
      const brg = headingOf(sp.position.x - this.P.x, sp.position.z - this.P.z) / DEG;
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
  // CCIP bombs and rockets
  // ------------------------------------------------------------------------------------------

  /**
   * CCIP bombs. The PBIL runs from the velocity vector to the reticle. With the pipper below
   * the glass (from the design eye) it is dashed and carries the DELAY CUE: the point of the
   * PBIL `delayCueMargin` above the glass's bottom edge; pressing the release designates the
   * ground under it and the computer releases when the impact reaches it (consent release).
   * After the press the designated target and the release steering show.
   */
  private bombs(sim: Sim): void {
    const rel = sim.avionics.release;
    const info = this.info;
    if (info.pipper) {
      const px = info.pipperX;
      const py = info.pipperY;
      const tx = info.tvvX;
      const ty = info.tvvY;
      const dx = px - tx;
      const dy = py - ty;
      const len = Math.hypot(dx, dy);
      const ux = len > 1e-9 ? dx / len : 0;
      const uy = len > 1e-9 ? dy / len : -1;
      const below = info.pipperBelowField;
      // Delay cue: where the PBIL is the margin above the glass's bottom edge — at the ground
      // point the computer designates on a press when it publishes one (the same definition).
      let cueT = -1;
      if (below) {
        const g = this.layout.glassBottom;
        const m = S.delayCueMargin;
        cueT = segmentLineIntersection(tx, ty, px, py, g.x0, g.y0 + m, g.x1, g.y1 + m, this.a2);
      }
      let cue = cueT >= 0;
      if (rel.delayCueValid && this.projectPoint(rel.delayCue, this.a2)) {
        cue = true;
        if (cueT < 0)
          cueT = Math.max(
            0,
            Math.min(1, ((this.a2.x - tx) * ux + (this.a2.y - ty) * uy) / (len || 1)),
          );
      }
      const R = S.bombReticleRadius;
      if (len > S.tvvRadius + R) {
        const x0 = tx + ux * S.tvvRadius;
        const y0 = ty + uy * S.tvvRadius;
        info.pbil = true;
        info.pbilDashed = below;
        info.pbilX0 = x0;
        info.pbilY0 = y0;
        let run = len - R - S.tvvRadius;
        if (below) {
          if (cueT >= 0) run = Math.min(run, cueT * len - S.tvvRadius + S.pbilBeyond);
          this.dashedRun(x0, y0, ux, uy, run, S.pbilDash, S.pbilGap);
        } else this.seg(x0, y0, x0 + ux * run, y0 + uy * run);
        info.pbilX1 = x0 + ux * run;
        info.pbilY1 = y0 + uy * run;
      }
      // Reticle and pipper (below the glass the glass hides them; a lowered head sees them).
      this.seg(px, py, px, py, W.pipper);
      // The reticle flashes when the release would be too low (or the fuze could not arm).
      const tooLow = rel.belowMinimum || rel.fuzeNoArm;
      if (!tooLow || this.flash(FLASH_HZ)) this.circle(px, py, R);
      this.staple(tx, ty, px, py, ux, uy, rel);
      if (cue) {
        const cx = this.a2.x;
        const cy = this.a2.y;
        const h = S.delayCue;
        this.seg(cx + uy * h, cy - ux * h, cx - uy * h, cy + ux * h, W.delayCue);
        info.delayCue = true;
        info.delayCueX = cx;
        info.delayCueY = cy;
      }
    }
    if (rel.valid && rel.designatedValid) {
      // Consent release: the designated target, then CCRP-like steering to the release.
      if (this.projectPoint(rel.designated, this.p)) {
        this.square(this.p.x, this.p.y, S.tdBox);
        info.designated = true;
        info.designatedX = this.p.x;
        info.designatedY = this.p.y;
      }
      this.steering(sim, rel);
    }
  }

  /**
   * Minimum range staple: where the pipper will be when the aircraft reaches the profile's
   * minimum release height above the target on its present path (a "⊓" across the PBIL with
   * its legs toward the pipper). The reticle must stay below it; above it, the release is too
   * low for the fuze to arm or to clear the fragments.
   */
  private staple(
    tx: number,
    ty: number,
    px: number,
    py: number,
    ux: number,
    uy: number,
    rel: ReleaseSolution,
  ): void {
    const p = this.profile;
    if (!p || !(p.minAltitude > 0)) return;
    const height = this.P.y - rel.impact.y;
    const f = minimumRangeFraction(height, p.minAltitude, this.V.x, this.V.y, this.V.z);
    if (!(f > 0) || f > 1.6) return;
    const sx = tx + (px - tx) * f;
    const sy = ty + (py - ty) * f;
    if (Math.hypot(sx - tx, sy - ty) < S.tvvRadius + S.stapleLeg) return;
    const h = S.staple;
    const ax = sx + uy * h;
    const ay = sy - ux * h;
    const bx = sx - uy * h;
    const by = sy + ux * h;
    this.seg(ax, ay, bx, by, W.staple);
    this.seg(ax, ay, ax + ux * S.stapleLeg, ay + uy * S.stapleLeg, W.staple);
    this.seg(bx, by, bx + ux * S.stapleLeg, by + uy * S.stapleLeg, W.staple);
    const info = this.info;
    info.staple = true;
    info.stapleX = sx;
    info.stapleY = sy;
  }

  /** CCIP rockets: reticle with four ticks, the pipper, flashing below the minimum. */
  private rocketReticle(sim: Sim): void {
    const info = this.info;
    if (!info.pipper) return;
    const px = info.pipperX;
    const py = info.pipperY;
    const R = S.rocketReticleRadius;
    this.seg(px, py, px, py, W.pipper);
    if (!sim.avionics.release.belowMinimum || this.flash(FLASH_HZ)) this.circle(px, py, R, 2);
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      clockPoint(px, py, R, a, this.p);
      clockPoint(px, py, R + S.reticleTick * 1.6, a, this.q);
      this.seg(this.p.x, this.p.y, this.q.x, this.q.y);
    }
  }

  // ------------------------------------------------------------------------------------------
  // CCRP and the release steering
  // ------------------------------------------------------------------------------------------

  private ccrp(sim: Sim): void {
    const rel = sim.avionics.release;
    if (!rel.valid) return;
    this.steering(sim, rel);
  }

  /** HUD-plane point of the world direction at compass azimuth `az` and elevation `el`. */
  private planeOfAzEl(az: number, el: number, out: Vec2): boolean {
    const c = Math.cos(el);
    this.d3.x = Math.sin(az) * c;
    this.d3.y = Math.sin(el);
    this.d3.z = -Math.cos(az) * c;
    return this.projectDir(this.d3, out);
  }

  /**
   * The release steering (CCRP, and a consent release after designation):
   *  - the AZIMUTH STEERING LINE: the image of the vertical plane through the eye in the
   *    direction to fly — the drawn ground track turned by `azimuthError` — so it passes
   *    through the velocity vector when the steering is right (fly the velocity vector onto
   *    it); held dashed at the edge of the field when it is outside;
   *  - the SOLUTION CUE on it, `cueEl` above the velocity vector's elevation (avionics: 0 at
   *    release), with the time to release beside it; held at the top of the line while higher;
   *  - the RELEASE CUE: a bar over the velocity vector as the store leaves.
   */
  private steering(sim: Sim, rel: ReleaseSolution): void {
    const info = this.info;
    const V = this.V;
    const vh = Math.hypot(V.x, V.z);
    if (vh < 1) return;
    const track = Math.atan2(V.x, -V.z);
    const gamma = Math.atan2(V.y, vh);
    const az = track + rel.azimuthError;
    // Two points of the steering plane: at the velocity vector's elevation and above it.
    if (!this.planeOfAzEl(az, gamma, this.a2) || !this.planeOfAzEl(az, gamma + ASL_STEP, this.b2))
      return;
    let ux = this.b2.x - this.a2.x;
    let uy = this.b2.y - this.a2.y;
    const ul = Math.hypot(ux, uy);
    if (ul < 1e-9) return;
    ux /= ul;
    uy /= ul;
    // Held at the field's edge (dashed) when the steering is far off.
    const box = this.layout.tvvBox;
    const held = this.a2.x < box.left || this.a2.x > box.right;
    const shift = held ? Math.min(box.right, Math.max(box.left, this.a2.x)) - this.a2.x : 0;
    const ax = this.a2.x + shift;
    const ay = this.a2.y;
    info.asl = true;
    info.aslDx = this.a2.x - info.tvvX;
    if (clipSegment(ax - ux * 2, ay - uy * 2, ax + ux * 2, ay + uy * 2, this.aslBox, this.clip)) {
      const c = this.clip;
      if (held) this.dashes(c.x0, c.y0, c.x1, c.y1, 7);
      else this.seg(c.x0, c.y0, c.x1, c.y1);
    }

    // Solution cue. Past the release point (`passed`) it stays where the computer puts it,
    // below the velocity vector: no release cue and no countdown.
    const t = rel.timeToRelease;
    const passed = rel.passed;
    const releasing = !passed && (rel.releaseNow || t <= 0);
    let cueEl = releasing ? 0 : rel.cueEl;
    if (!releasing && !passed && !(cueEl > 0)) {
      // No cue angle from the avionics: wait at the top, fall to the velocity vector in the
      // last seconds to release.
      const T = HUD_STORE_SYMBOLS.cueFallTime;
      const topEl = Math.atan(this.aslBox.top) - gamma;
      cueEl = (Math.min(t, T) / T) * Math.max(0, topEl);
    }
    // Far from the release the computer's angle grows past the field (even past the zenith):
    // keep the direction in front of the eye; the cue waits at the end of the line.
    cueEl = Math.max(-CUE_EL_MAX - gamma, Math.min(CUE_EL_MAX - gamma, cueEl));
    if (this.planeOfAzEl(az, gamma + cueEl, this.q)) {
      let cx = this.q.x + shift;
      let cy = this.q.y;
      const end =
        cy > this.aslBox.top ? this.aslBox.top : cy < this.aslBox.bottom ? this.aslBox.bottom : cy;
      if (end !== cy) {
        // Held at the end of the line.
        const k = Math.abs(uy) > 1e-6 ? (end - ay) / uy : 0;
        cx = ax + ux * k;
        cy = end;
      }
      this.circle(cx, cy, S.cueRadius, 4);
      info.cue = true;
      info.cueX = cx;
      info.cueY = cy;
      if (t > 0) {
        this.buf.clear().int(Math.ceil(t));
        this.text(cx + S.cueRadius + 0.35 * DEG, cy, ALIGN_LEFT);
      }
    }

    // Release cue: as the store leaves (and for a moment after, so a frame shows it).
    const recent = sim.time - this.releasedAt < HUD_STORE_SYMBOLS.releaseCueHold;
    if ((rel.releaseNow && !passed) || recent) {
      info.releaseCue = true;
      if (this.flash(FAST_FLASH_HZ) || rel.releaseNow) {
        const x = info.tvvX;
        const y = info.tvvY + S.tvvRadius + S.tvvTail + 0.25 * DEG;
        const h = S.tvvRadius + S.tvvWing;
        this.seg(x - h, y, x + h, y, W.releaseCue);
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Sensors: SPI, targeting pod, Maverick
  // ------------------------------------------------------------------------------------------

  /**
   * The SPI diamond (with a centre dot) and its slant range; outside the field a dashed square
   * held at the edge in the SPI's direction. The targeting pod's line-of-sight diamond grows a
   * tail when the pod is the SPI generator (and then stands for the SPI). The selected
   * Maverick's seeker line of sight is a wagon wheel (a square around it when locked).
   */
  private sensorMarks(sim: Sim): void {
    const av = sim.avionics;
    const sensors = sim.sensors;
    const info = this.info;
    const spi = av.spi;
    const tgpSpi = spi.valid && spi.source === 'TGP';

    const tgp = sensors.tgp;
    if (av.tgpPower && tgp.powered && tgp.warmup <= 0) {
      const ok = tgp.pointValid
        ? this.projectPoint(tgp.point, this.p)
        : this.projectDir(tgp.los, this.p);
      if (ok) {
        info.tgp = true;
        info.tgpX = this.p.x;
        info.tgpY = this.p.y;
        this.diamond(this.p.x, this.p.y, S.tgpDiamond);
        if (tgpSpi)
          this.seg(
            this.p.x,
            this.p.y - S.tgpDiamond,
            this.p.x,
            this.p.y - S.tgpDiamond - S.tgpTail,
          );
      }
    }

    const i = sensors.selectedMaverick;
    const mav = i >= 0 ? sensors.mavericks[i] : undefined;
    if (mav && mav.powered && mav.align <= 0) {
      const ok = mav.locked
        ? this.projectPoint(mav.lockPoint, this.p)
        : this.projectDir(mav.los, this.p);
      if (ok) {
        info.mav = true;
        info.mavX = this.p.x;
        info.mavY = this.p.y;
        const r = S.mavWheel;
        const { x, y } = this.p;
        this.circle(x, y, r, 3);
        for (let k = 0; k < 4; k++) {
          const a = (k * Math.PI) / 2 + Math.PI / 4;
          this.seg(
            x + Math.cos(a) * r * 0.25,
            y + Math.sin(a) * r * 0.25,
            x + Math.cos(a) * r,
            y + Math.sin(a) * r,
          );
        }
        if (mav.locked) this.square(x, y, r * 1.45);
      }
    }

    if (!this.spiShown) return;
    const x = this.spiX;
    const y = this.spiY;
    if (this.spiHeld) {
      this.square(x, y, S.spiSquare, true);
      if (tgpSpi) this.diamond(x, y, S.tgpDiamond);
    } else if (!tgpSpi) {
      this.diamond(x, y, S.spiDiamond);
      this.seg(x, y, x, y, W.pipper * 0.6);
    }
    info.spi = true;
    info.spiX = x;
    info.spiY = y;
    info.spiHeld = this.spiHeld;
  }

  /**
   * Where the SPI mark goes (inside the field, or held on its edge in the SPI's direction), and
   * its slant range — drawn with the texts, before the ladder, so the ladder's numbers keep
   * clear of it, and itself clear of the texts already drawn. A mark held at the edge is only a
   * direction cue: no range (it would sit on the side text blocks or below the glass).
   */
  private spiPlace(sim: Sim): void {
    const spi = sim.avionics.spi;
    this.spiShown = spi.valid;
    this.spiHeld = false;
    if (!spi.valid) return;
    const field = this.layout.tvvBox;
    const inFront = this.projectPoint(spi.position, this.p);
    let x = this.p.x;
    let y = this.p.y;
    const inside = inFront && inBox(x, y, field);
    if (!inside) {
      // Held in the SPI's direction on the edge of the hold box (between the text columns).
      const hold = this.layout.spiHoldBox;
      const d = this.bodyDirOf(spi.position, this.tmp);
      const cx = (hold.left + hold.right) / 2;
      const cy = (hold.bottom + hold.top) / 2;
      // Behind the eye the plane point does not exist: aim along the direction's x, y.
      const far = inFront ? 1 : 1e3;
      const tx = inFront ? x : cx + d.x * far;
      const ty = inFront ? y : cy + d.y * far;
      holdOnBox(cx, cy, tx, ty, hold, this.q);
      x = this.q.x;
      y = this.q.y;
      this.spiHeld = true;
    }
    this.spiX = x;
    this.spiY = y;
    if (this.spiHeld) return;
    // Slant range, nautical miles, under the mark — above it when that would sit on another
    // text (the side blocks), left out when both would.
    const nm = this.P.distanceTo(spi.position) / NM;
    this.buf.clear();
    if (nm < 100) this.buf.fixed(nm, 1);
    else this.buf.int(nm);
    const hw = textWidth(this.buf.len, S.text) / 2;
    const off = S.spiSquare + 0.25 * DEG + S.text / 2;
    for (let k = 0; k < 2; k++) {
      const ty = k === 0 ? y - off : y + off;
      if (this.hitsText(x - hw, ty - S.text / 2, x + hw, ty + S.text / 2)) continue;
      this.text(x, ty, ALIGN_CENTER);
      return;
    }
  }

  /** Relaxed realism (PLAN §2): a box around every live vehicle within range. */
  private vehicleBoxes(sim: Sim): void {
    if (!sim.options.realism.hudBoxes) return;
    const list = sim.targets.vehicles;
    const range = HUD_STORE_SYMBOLS.vehicleBoxRange;
    let n = 0;
    for (let k = 0; k < list.length; k++) {
      const v = list[k];
      if (v.condition === 'destroyed' || v.condition === 'catastrophic') continue;
      this.d3.x = v.position.x;
      this.d3.y = v.position.y + 1.2;
      this.d3.z = v.position.z;
      const dist = this.eyeW.distanceTo(this.tmp.set(this.d3.x, this.d3.y, this.d3.z));
      if (dist > range || !this.projectPoint(this.d3, this.p)) continue;
      const h = Math.max(S.vehicleBoxMin, 4 / Math.max(1, dist));
      this.square(this.p.x, this.p.y, h);
      n++;
    }
    this.info.vehicleBoxes = n;
  }
}

function activeSteerpoint(sim: Sim) {
  const list = sim.avionics.steerpoints;
  if (list.length === 0) return null;
  const i = sim.avionics.activeSteerpoint;
  return list[i >= 0 && i < list.length ? i : 0] ?? null;
}

/** Stores of a type left on the stations; rocket pods count their rockets. */
export function storesLeft(sim: Sim, store: string): number {
  const stations = sim.stores.stations;
  const pod = STORES[store as StoreType]?.kind === 'rocketPod';
  let n = 0;
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const list = st.stores;
    for (let j = 0; j < list.length; j++) {
      if (list[j] !== store) continue;
      n += pod ? (st.rockets ?? 0) : 1;
      if (pod) break;
    }
  }
  return n;
}
