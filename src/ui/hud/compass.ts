/**
 * Compass-tape maths. The tape is one long strip of ticks drawn once; the HUD scrolls it by
 * translating the strip so the current heading sits under the fixed centre caret.
 *
 * Tape coordinates are SVG user units: x grows to the right = increasing heading (turning to
 * starboard moves the strip to the left, as on a real heading tape).
 */
import { wrapDeg360 } from '../../utils/math';

/** Width of the tape view box, user units. */
export const TAPE_WIDTH = 360;
/** Horizontal scale: 3 units per degree shows 120° of heading across the tape. */
export const TAPE_UNITS_PER_DEG = 3;
/** A tick every 10°. */
export const TAPE_TICK_STEP = 10;
/** Every third tick (30°) is long and labelled. */
export const TAPE_LABEL_STEP = 30;

/** Degrees drawn beyond 0 and 360 so the strip never runs out at either end of the view. */
export const TAPE_OVERSCAN_DEG =
  Math.ceil(TAPE_WIDTH / 2 / TAPE_UNITS_PER_DEG / TAPE_TICK_STEP) * TAPE_TICK_STEP + TAPE_TICK_STEP;

const CARDINALS: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

export interface TapeTick {
  /** Unwrapped strip angle (may be below 0 or above 360 in the overscan). */
  deg: number;
  /** Position on the strip, user units. */
  x: number;
  /** Long tick (every 30°). */
  major: boolean;
  /** Cardinal letter or two-digit tens ("03" = 030°); null for unlabelled ticks. */
  label: string | null;
  cardinal: boolean;
}

/** Label of a tape tick: N / E / S / W on the cardinals, tens of degrees every 30°. */
export function compassLabel(deg: number): string | null {
  const wrapped = Math.round(wrapDeg360(deg)) % 360;
  const cardinal = CARDINALS[wrapped];
  if (cardinal) return cardinal;
  if (wrapped % TAPE_LABEL_STEP !== 0) return null;
  return String(wrapped / 10).padStart(2, '0');
}

/** Position of a strip angle on the (untranslated) tape. */
export function tapeX(deg: number): number {
  return deg * TAPE_UNITS_PER_DEG;
}

/** All ticks of the strip, from -overscan to 360 + overscan. Built once. */
export function buildTapeTicks(): TapeTick[] {
  const ticks: TapeTick[] = [];
  for (let deg = -TAPE_OVERSCAN_DEG; deg <= 360 + TAPE_OVERSCAN_DEG; deg += TAPE_TICK_STEP) {
    const wrapped = Math.round(wrapDeg360(deg)) % 360;
    ticks.push({
      deg,
      x: tapeX(deg),
      major: wrapped % TAPE_LABEL_STEP === 0,
      label: compassLabel(deg),
      cardinal: wrapped in CARDINALS,
    });
  }
  return ticks;
}

/** Translation of the strip that puts `headingDeg` under the centre of the view. */
export function tapeOffset(headingDeg: number): number {
  const heading = Number.isFinite(headingDeg) ? wrapDeg360(headingDeg) : 0;
  return TAPE_WIDTH / 2 - tapeX(heading);
}
