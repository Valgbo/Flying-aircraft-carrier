/**
 * Touch-control maths — pure helpers, unit-tested, shared by the on-screen stick and the
 * throttle slider. Screen coordinates in, input values out; every function writes into a
 * caller-owned result object so pointer handlers do not allocate.
 */
import { deadzone } from '../utils/math';
import { responseCurve } from './response';

/** How far the knob may travel from where the thumb landed, in CSS pixels. */
export const STICK_RADIUS = 60;
/** Radial dead zone as a fraction of the travel: a resting thumb gives no input. */
export const STICK_DEADZONE = 0.1;
/**
 * Per-axis notch applied after the radial shaping. Yaw and tilt share one stick and tilt is a
 * lever that stays where it is put, so a push that is almost purely sideways must not creep
 * the nacelles (and the other way round).
 */
export const STICK_AXIS_NOTCH = 0.12;
/** Half-height of the throttle slider's centre detent, in CSS pixels. */
export const SLIDER_DETENT_PX = 10;

export interface StickResult {
  /** -1..1, +1 = pushed right. */
  x: number;
  /** -1..1, +1 = pushed up (toward the top of the screen). */
  y: number;
  /** Where to draw the knob relative to the origin, in screen pixels (clamped to the radius). */
  knobX: number;
  knobY: number;
}

/**
 * Stick deflection for a pointer that is (dx, dy) screen pixels away from the stick origin
 * (screen Y grows downward).
 */
export function stickVector(
  dx: number,
  dy: number,
  out: StickResult,
  radius = STICK_RADIUS,
  zone = STICK_DEADZONE,
): StickResult {
  const length = Math.hypot(dx, dy);
  if (length === 0 || radius <= 0) {
    out.x = 0;
    out.y = 0;
    out.knobX = 0;
    out.knobY = 0;
    return out;
  }
  const clamped = Math.min(length, radius);
  out.knobX = (dx * clamped) / length;
  out.knobY = (dy * clamped) / length;
  const shaped = responseCurve(deadzone(clamped / radius, zone));
  // "+ 0" turns a negative zero into a plain zero
  out.x = deadzone((dx / length) * shaped, STICK_AXIS_NOTCH) + 0;
  out.y = deadzone((-dy / length) * shaped, STICK_AXIS_NOTCH) + 0;
  return out;
}

export interface SliderResult {
  /** -1..1, +1 = fully up. */
  value: number;
  /** Where to draw the thumb, in pixels above the centre (snaps to 0 inside the detent). */
  thumb: number;
}

/**
 * Value of the spring-centred vertical slider for a pointer `offsetUp` pixels above the
 * centre of the track. `travel` is the distance from the centre to either end stop.
 * Inside the detent the value is exactly 0; beyond it the value ramps linearly to ±1.
 */
export function sliderValue(
  offsetUp: number,
  travel: number,
  out: SliderResult,
  detent = SLIDER_DETENT_PX,
): SliderResult {
  const distance = Math.abs(offsetUp);
  if (travel <= detent || distance <= detent) {
    out.value = 0;
    out.thumb = 0;
    return out;
  }
  const clamped = Math.min(distance, travel);
  const sign = offsetUp < 0 ? -1 : 1;
  out.value = (sign * (clamped - detent)) / (travel - detent);
  out.thumb = sign * clamped;
  return out;
}
