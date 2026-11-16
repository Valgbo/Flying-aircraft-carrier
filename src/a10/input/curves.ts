/**
 * Axis shaping: dead zones, saturation, response curve, invert; the keyboard ramp; the trigger
 * detents with hysteresis. Pure functions; OWNED BY THE INPUT MODULE.
 */
import { clamp, responseCurve } from '../../engine';
import type { AxisCal } from './bindings';

const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

/** Dead zone, saturation and curve on a magnitude 0..1 (shared by the centred shapes). */
function shapeMagnitude(mag: number, cal: AxisCal, deadZone: number): number {
  const dz = clamp(deadZone, 0, 0.9);
  if (mag <= dz) return 0;
  const sat = Math.max(dz + 0.05, clamp(cal.saturation, 0.1, 1));
  const m = Math.min(1, (mag - dz) / (sat - dz));
  return responseCurve(m, clamp(cal.curve, 0, 1));
}

/**
 * A centred axis (stick, pedals, slew, look): raw -1..1 → -1..1. The raw value is re-centred on
 * `cal.centre` (each half rescaled so the ends stay ±1), then dead zone, saturation, curve and
 * invert.
 */
export function shapeCentred(raw: number, cal: AxisCal): number {
  const c = clamp(finite(cal.centre), -0.9, 0.9);
  let v = clamp(finite(raw), -1, 1) - c;
  v = v >= 0 ? v / (1 - c) : v / (1 + c);
  v = clamp(v, -1, 1);
  const out = Math.sign(v) * shapeMagnitude(Math.abs(v), cal, cal.deadZone);
  return (cal.invert ? -out : out) + 0;
}

/**
 * A lever or analogue trigger: raw -1..1 → 0..1 (raw -1 = idle unless inverted), with a dead
 * zone at the idle end and saturation at the far end.
 */
export function shapeLever(raw: number, cal: AxisCal): number {
  let v = (clamp(finite(raw), -1, 1) + 1) / 2;
  if (cal.invert) v = 1 - v;
  const dz = clamp(cal.deadZone, 0, 0.45);
  const sat = Math.max(dz + 0.05, clamp(cal.saturation, 0.5, 1));
  return clamp((v - dz) / (sat - dz), 0, 1);
}

/** A gamepad trigger or button read as a lever: value 0..1 → 0..1 (no -1..1 remap). */
export function shapePressure(value: number, cal: AxisCal): number {
  let v = clamp(finite(value), 0, 1);
  if (cal.invert) v = 1 - v;
  const dz = clamp(cal.deadZone, 0, 0.45);
  const sat = Math.max(dz + 0.05, clamp(cal.saturation, 0.5, 1));
  return clamp((v - dz) / (sat - dz), 0, 1);
}

/**
 * One component of a two-axis gamepad stick with a RADIAL dead zone: the dead zone works on the
 * stick's distance from centre (so diagonals stay smooth and the direction is kept), then this
 * component gets saturation, curve and invert. `x` is the component, `y` its partner axis.
 */
export function shapeStickAxis(x: number, y: number, cal: AxisCal): number {
  const fx = clamp(finite(x), -1, 1);
  const fy = clamp(finite(y), -1, 1);
  const mag = Math.hypot(fx, fy);
  const dz = clamp(cal.deadZone, 0, 0.9);
  if (mag <= dz || mag === 0) return 0;
  const radial = (Math.min(mag, 1) - dz) / (1 - dz);
  const v = clamp((fx / mag) * radial, -1, 1);
  const out = Math.sign(v) * shapeMagnitude(Math.abs(v), cal, 0);
  return (cal.invert ? -out : out) + 0;
}

/**
 * Move `current` toward `target`: toward zero (or a smaller value of the same sign) at
 * `fallRate`, away from zero at `riseRate` (units per second; Infinity = at once). Reversing
 * passes through zero, falling first, then rising with the time left. `jump` is applied at once
 * when moving away from zero from below it (slew keys start gently, then accelerate).
 */
export function rampToward(
  current: number,
  target: number,
  riseRate: number,
  fallRate: number,
  dt: number,
  jump = 0,
): number {
  let cur = current;
  let t = Math.max(0, dt);
  if (cur === target) return cur;
  const shrinking =
    cur !== 0 &&
    (target === 0 || Math.sign(target) !== Math.sign(cur) || Math.abs(target) < Math.abs(cur));
  if (shrinking) {
    const goal = Math.sign(target) === Math.sign(cur) ? target : 0;
    const dist = Math.abs(cur - goal);
    const step = fallRate * t;
    if (step < dist) return cur + Math.sign(goal - cur) * step;
    t = fallRate === Infinity ? t : Math.max(0, t - dist / fallRate);
    cur = goal;
    if (cur === target) return cur;
  }
  if (jump > 0 && Math.abs(cur) < jump) cur = Math.sign(target) * Math.min(jump, Math.abs(target));
  const dist = Math.abs(target - cur);
  const step = riseRate * t;
  return step >= dist ? target : cur + Math.sign(target - cur) * step;
}

/** Gun trigger detents on an analogue reading 0..1 (PLAN_A10.md §6.2, two-stage trigger). */
export interface TriggerThresholds {
  /** First detent (PAC-1) engages at this pressure and releases below `firstOff`. */
  firstOn: number;
  firstOff: number;
  /** Second detent (fire) engages at this pressure and releases below `secondOff`. */
  secondOn: number;
  secondOff: number;
}

export const TRIGGER_THRESHOLDS: TriggerThresholds = {
  firstOn: 0.3,
  firstOff: 0.2,
  secondOn: 0.9,
  secondOff: 0.8,
};

/** The detent for this reading, given the previous one (hysteresis keeps it from chattering). */
export function triggerStage(
  previous: 0 | 1 | 2,
  value: number,
  t: TriggerThresholds = TRIGGER_THRESHOLDS,
): 0 | 1 | 2 {
  const v = finite(value);
  if (previous === 2 && v >= t.secondOff) return 2;
  if (previous !== 2 && v >= t.secondOn) return 2;
  if (previous >= 1) return v >= t.firstOff ? 1 : 0;
  return v >= t.firstOn ? 1 : 0;
}

/** The stage the simulation sees: with the one-stage trigger any press fires. */
export function effectiveStage(stage: 0 | 1 | 2, twoStage: boolean): 0 | 1 | 2 {
  return !twoStage && stage > 0 ? 2 : stage;
}

/** On/off reading of an analogue button with hysteresis (worn triggers rest above zero). */
export function buttonDown(wasDown: boolean, value: number): boolean {
  return wasDown ? value > 0.45 : value > 0.55;
}
