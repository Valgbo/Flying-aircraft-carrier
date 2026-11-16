/**
 * Where the fixed HUD symbology goes, in HUD-plane units (≈ rad), and how big it is.
 *
 * The A-10's combiner glass is narrow: from the design eye (data/geometry.ts) it spans about
 * +2.0° to −14.7° in elevation and ±7.1° (top) to ±6.4° (bottom) in azimuth, with the
 * boresight near its top edge. The layout is computed from that field at start-up, so it
 * follows the measured geometry. Two text columns with straight margins frame the middle,
 * where the velocity vector, the pitch ladder, the gun cross and the reticle move:
 *
 *   annunciations (GUN INVALID, CCIP INVALID) — top, above the gun cross
 *   airspeed (kt)                                          barometric altitude (ft)
 *   g                                                      R radar altitude (< 5,000 ft AGL)
 *   max g (once above 2.5 g)
 *   master mode
 *   Master Arm                                             steerpoint name
 *   gun / PAC state (or the weapon profile)                range (nm)
 *   rounds                                                 time to go
 *                   heading tape, heading index, steerpoint bearing
 */
import { A10_GEOMETRY } from '../../data/geometry';
import { GAU8 } from '../../data/gun';
import { FT } from '../../core/units';
import { DEG, glassField, type Box, type GlassCorners, type GlassField } from './hudMath';

/** The combiner glass corners (body frame), as the clipping math expects them. */
export const HUD_GLASS: GlassCorners = [
  A10_GEOMETRY.hudCorners[0],
  A10_GEOMETRY.hudCorners[1],
  A10_GEOMETRY.hudCorners[2],
  A10_GEOMETRY.hudCorners[3],
];

/** Sizes of the symbols, HUD-plane units (≈ rad). */
export const HUD_SIZES = {
  /** Cap height of the HUD text. */
  text: 0.68 * DEG,
  /** Vertical distance between text lines. */
  line: 0.95 * DEG,
  /** Velocity vector: circle radius, wing length beyond the circle, tail length. */
  tvvRadius: 0.38 * DEG,
  tvvWing: 0.62 * DEG,
  tvvTail: 0.42 * DEG,
  /** Pitch ladder: gap either side of the centre, rung length, end tick, horizon length. */
  ladderGap: 1.05 * DEG,
  ladderRung: 1.3 * DEG,
  ladderTick: 0.32 * DEG,
  horizonLength: 2.6 * DEG,
  /** Rungs drawn within this many degrees of the velocity vector's elevation. */
  ladderSpanDeg: 20,
  ladderStepDeg: 5,
  /** Gun cross half-arm. */
  gunCross: 0.55 * DEG,
  /** CCIP gun reticle radius (15 mrad: a 30-mil circle) and range-bar inset. */
  reticleRadius: 0.015,
  rangeBarInset: 0.0017,
  /** Range-bar ticks (outside the circle) and the minimum-range cue. */
  reticleTick: 0.0025,
  minRangeCue: 0.0042,
  /** CCIP bomb reticle radius. */
  bombReticleRadius: 0.012,
  /** Heading tape: degrees of heading per HUD-plane unit (5° of heading per 1° of HUD). */
  tapeDegPerUnit: 5 / DEG,
  tapeMajorTick: 0.5 * DEG,
  tapeMinorTick: 0.3 * DEG,
  tapeHalfSpanDeg: 20,
} as const;

/** Stroke widths relative to the HUD line width. */
export const HUD_WIDTHS = {
  line: 1,
  pipper: 3.2,
  rangeBar: 2.4,
  breakX: 3,
  bearing: 1.8,
} as const;

/** Range scales of the gun sight. */
export const GUN_SIGHT = {
  /** The analog range bar is a full circle at 12,000 ft. */
  rangeBarFull: 12000 * FT,
  /**
   * Minimum-range cue position, m. Matches the fire-control computer's `tooClose` limit
   * (the avionics stand-in uses 600 m); the cue only marks it on the range scale.
   */
  minRange: 600,
} as const;

/** The gun line seen from the eye (collimated: a direction), HUD angles. */
export const GUN_LINE = { az: 0, el: -GAU8.gunLineDepression } as const;

/** Number of text lines in each column (line 0 lowest). */
export const HUD_LINES = 7;

export interface HudLayout {
  field: GlassField;
  /** Where the velocity vector is held when it would leave the field (plane units). */
  tvvBox: Box;
  /**
   * The pitch ladder is drawn inside a T-shaped window so a banked or dive ladder does not run
   * through the text columns or the heading tape: `ladderBox` above the columns (wide) and
   * `ladderBandBox` between them (narrow), stacked without overlap. Rung numbers may use
   * `ladderOuterBox` when they do not hit column text.
   */
  ladderBox: Box;
  ladderBandBox: Box;
  ladderOuterBox: Box;
  /** Left column: left-aligned at leftX. Right column: right-aligned at rightX. */
  leftX: number;
  rightX: number;
  /** Plane y of each text line, line 0 lowest. */
  lineY: Float64Array;
  /** Heading tape: plane y of the tick row's top, half width (plane units), centre x. */
  tapeY: number;
  tapeHalfWidth: number;
  centerX: number;
  /** Centre of the annunciations ("GUN INVALID", "CCIP INVALID"). */
  warnY: number;
  /** The break-X: centre and half extents. */
  breakX: { cx: number; cy: number; hx: number; hy: number };
  /** The CCRP azimuth steering line spans this elevation range (plane y). */
  aslTop: number;
  aslBottom: number;
}

/** Half-width of the field at an elevation (linear between the top and bottom edges). */
export function fieldHalfWidthAt(f: GlassField, el: number): number {
  const t = (f.top - el) / (f.top - f.bottom);
  return f.halfWidthTop + (f.halfWidthBottom - f.halfWidthTop) * Math.min(1, Math.max(0, t));
}

/** Compute the layout for the glass seen from `eye` (the design eye by default). */
export function computeHudLayout(
  eye: { x: number; y: number; z: number } = A10_GEOMETRY.eye,
  glass: GlassCorners = HUD_GLASS,
): HudLayout {
  const f = glassField(eye, glass, {
    top: 0,
    bottom: 0,
    halfWidthTop: 0,
    halfWidthBottom: 0,
    center: 0,
  });
  const S = HUD_SIZES;
  const line0El = f.bottom + 3.56 * DEG;
  const lineY = new Float64Array(HUD_LINES);
  for (let k = 0; k < HUD_LINES; k++) lineY[k] = Math.tan(line0El + k * S.line);
  // Straight margins, set by the narrowest (lowest) line.
  const margin = fieldHalfWidthAt(f, line0El) - 0.5 * DEG;
  const mid = (f.top + f.bottom) / 2;
  // The text band: from above the heading tape to just over the top line of the columns.
  const ladderBottom = Math.tan(f.bottom + 3.0 * DEG);
  const bandTop = Math.tan(line0El + (HUD_LINES - 1) * S.line + S.text / 2 + 0.2 * DEG);
  return {
    field: f,
    tvvBox: {
      left: Math.tan(f.center - (f.halfWidthBottom - 0.9 * DEG)),
      right: Math.tan(f.center + (f.halfWidthBottom - 0.9 * DEG)),
      bottom: Math.tan(f.bottom + 1.0 * DEG),
      top: Math.tan(f.top - 0.5 * DEG),
    },
    ladderBox: {
      left: Math.tan(f.center - 4.1 * DEG),
      right: Math.tan(f.center + 4.1 * DEG),
      bottom: bandTop,
      top: Math.tan(f.top + 5 * DEG),
    },
    ladderBandBox: {
      left: Math.tan(f.center - 2.45 * DEG),
      right: Math.tan(f.center + 2.45 * DEG),
      bottom: ladderBottom,
      top: bandTop,
    },
    ladderOuterBox: {
      left: Math.tan(f.center - 4.1 * DEG),
      right: Math.tan(f.center + 4.1 * DEG),
      bottom: ladderBottom,
      top: Math.tan(f.top + 5 * DEG),
    },
    leftX: Math.tan(f.center - margin),
    rightX: Math.tan(f.center + margin),
    lineY,
    tapeY: Math.tan(f.bottom + 1.85 * DEG),
    tapeHalfWidth: S.tapeHalfSpanDeg / S.tapeDegPerUnit,
    centerX: Math.tan(f.center),
    warnY: Math.tan(f.top - 1.6 * DEG),
    breakX: {
      cx: Math.tan(f.center),
      cy: Math.tan(mid),
      hx: Math.tan(Math.min(5 * DEG, f.halfWidthBottom - 0.6 * DEG)),
      hy: Math.tan(6.5 * DEG),
    },
    aslTop: Math.tan(f.top - 0.3 * DEG),
    aslBottom: Math.tan(f.bottom + 3.0 * DEG),
  };
}
