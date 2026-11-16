import { describe, expect, it } from 'vitest';
import { DEFAULT_CAL, PAD_STICK_CAL, type AxisCal } from '../../../src/a10/input/bindings';
import {
  TRIGGER_THRESHOLDS,
  buttonDown,
  effectiveStage,
  rampToward,
  shapeCentred,
  shapeLever,
  shapePressure,
  shapeStickAxis,
  triggerStage,
} from '../../../src/a10/input/curves';
import { responseCurve } from '../../../src/engine';

const cal = (patch: Partial<AxisCal> = {}): AxisCal => ({
  ...DEFAULT_CAL,
  deadZone: 0,
  ...patch,
});

describe('centred axes', () => {
  it('pass through linearly with no shaping, keep the ends and the sign', () => {
    for (const v of [-1, -0.5, 0, 0.25, 1]) expect(shapeCentred(v, cal())).toBeCloseTo(v, 9);
    expect(Object.is(shapeCentred(0, cal({ invert: true })), -0)).toBe(false);
  });

  it('dead zone: zero inside, rescaled outside so full travel still gives ±1', () => {
    const c = cal({ deadZone: 0.1 });
    expect(shapeCentred(0.09, c)).toBe(0);
    expect(shapeCentred(-0.1, c)).toBe(0);
    expect(shapeCentred(0.55, c)).toBeCloseTo(0.5, 9);
    expect(shapeCentred(1, c)).toBe(1);
    expect(shapeCentred(-1, c)).toBe(-1);
  });

  it('saturation: full output before the end of travel', () => {
    const c = cal({ saturation: 0.8 });
    expect(shapeCentred(0.8, c)).toBe(1);
    expect(shapeCentred(0.4, c)).toBeCloseTo(0.5, 9);
    expect(shapeCentred(-0.95, c)).toBe(-1);
  });

  it('curve: the carrier response curve, softer near the centre, monotonic', () => {
    const c = cal({ curve: 0.4 });
    expect(shapeCentred(0.5, c)).toBeCloseTo(responseCurve(0.5, 0.4), 9);
    expect(shapeCentred(0.5, c)).toBeLessThan(0.5);
    let prev = -Infinity;
    for (let v = -1; v <= 1.0001; v += 0.05) {
      const out = shapeCentred(v, c);
      expect(out).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = out;
    }
  });

  it('invert and a recorded centre (rest value)', () => {
    expect(shapeCentred(0.6, cal({ invert: true }))).toBeCloseTo(-0.6, 9);
    const c = cal({ centre: 0.1 });
    expect(shapeCentred(0.1, c)).toBe(0);
    expect(shapeCentred(1, c)).toBe(1);
    expect(shapeCentred(-1, c)).toBe(-1);
    expect(shapeCentred(0.55, c)).toBeCloseTo(0.5, 9);
  });

  it('is safe with NaN and out-of-range input', () => {
    expect(shapeCentred(Number.NaN, cal())).toBe(0);
    expect(shapeCentred(5, cal())).toBe(1);
  });
});

describe('levers and pressure', () => {
  it('map a throttle axis resting at -1 to IDLE 0 and +1 to MAX', () => {
    const c = cal();
    expect(shapeLever(-1, c)).toBe(0);
    expect(shapeLever(0, c)).toBeCloseTo(0.5, 9);
    expect(shapeLever(1, c)).toBe(1);
    expect(shapeLever(1, cal({ invert: true }))).toBe(0);
  });

  it('end dead zones make the ends reachable', () => {
    const c = cal({ deadZone: 0.02, saturation: 0.98 });
    expect(shapeLever(-0.97, c)).toBe(0);
    expect(shapeLever(0.97, c)).toBe(1);
    expect(shapePressure(0.01, c)).toBe(0);
    expect(shapePressure(0.99, c)).toBe(1);
    expect(shapePressure(0.5, cal())).toBeCloseTo(0.5, 9);
  });
});

describe('gamepad sticks: radial dead zone', () => {
  it('is zero inside the circle whichever the direction', () => {
    expect(shapeStickAxis(0.08, 0.08, PAD_STICK_CAL)).toBe(0);
    expect(shapeStickAxis(0.11, 0, PAD_STICK_CAL)).toBe(0);
  });

  it('keeps the direction of a diagonal push and reaches full travel', () => {
    const c = cal({ deadZone: 0.12 });
    const x = shapeStickAxis(0.5, 0.5, c);
    const y = shapeStickAxis(0.5, 0.5, c);
    expect(x).toBeCloseTo(y, 9);
    const r = Math.hypot(0.5, 0.5);
    expect(Math.hypot(x, y)).toBeCloseTo((r - 0.12) / 0.88, 6);
    expect(shapeStickAxis(1, 0, c)).toBe(1);
    expect(shapeStickAxis(-1, 0, c)).toBe(-1);
  });

  it('a component near zero is not cut off by its own dead zone (no cross-shaped notch)', () => {
    // pushed almost straight forward: the small sideways part survives
    const v = shapeStickAxis(0.05, 0.9, cal({ deadZone: 0.12 }));
    expect(v).toBeGreaterThan(0.03);
  });
});

describe('keyboard ramp', () => {
  it('rises at the rise rate and falls at the fall rate', () => {
    let v = 0;
    v = rampToward(v, 1, 1 / 0.3, 1 / 0.12, 0.15);
    expect(v).toBeCloseTo(0.5, 9);
    v = rampToward(v, 1, 1 / 0.3, 1 / 0.12, 0.2);
    expect(v).toBe(1);
    v = rampToward(v, 0, 1 / 0.3, 1 / 0.12, 0.06);
    expect(v).toBeCloseTo(0.5, 9);
  });

  it('reverses through zero: falls first, then rises with the time left', () => {
    // from +0.5, fall rate 10/s reaches 0 after 0.05 s, then rises 0.05 s at 2/s
    const v = rampToward(0.5, -1, 2, 10, 0.1);
    expect(v).toBeCloseTo(-0.1, 9);
  });

  it('applies a jump at once (slew keys), and infinite rates are instant', () => {
    expect(rampToward(0, 1, 1, Infinity, 0.1, 0.15)).toBeCloseTo(0.25, 9);
    expect(rampToward(0, -1, Infinity, Infinity, 0.001)).toBe(-1);
    expect(rampToward(0.7, 0, 1, Infinity, 0.001)).toBe(0);
  });
});

describe('two-stage trigger', () => {
  it('engages and releases each detent with hysteresis', () => {
    const t = TRIGGER_THRESHOLDS;
    expect(t).toMatchObject({ firstOn: 0.3, firstOff: 0.2, secondOn: 0.9, secondOff: 0.8 });
    let s = triggerStage(0, 0.25);
    expect(s).toBe(0);
    s = triggerStage(s, 0.31);
    expect(s).toBe(1);
    s = triggerStage(s, 0.22); // still above firstOff
    expect(s).toBe(1);
    s = triggerStage(s, 0.85); // below secondOn
    expect(s).toBe(1);
    s = triggerStage(s, 0.91);
    expect(s).toBe(2);
    s = triggerStage(s, 0.82); // still above secondOff
    expect(s).toBe(2);
    s = triggerStage(s, 0.79);
    expect(s).toBe(1);
    s = triggerStage(s, 0.19);
    expect(s).toBe(0);
    // a fast squeeze goes straight to the second detent
    expect(triggerStage(0, 1)).toBe(2);
  });

  it('the one-stage trigger fires on any press', () => {
    expect(effectiveStage(1, false)).toBe(2);
    expect(effectiveStage(2, false)).toBe(2);
    expect(effectiveStage(0, false)).toBe(0);
    expect(effectiveStage(1, true)).toBe(1);
  });

  it('analogue buttons use hysteresis for on/off', () => {
    expect(buttonDown(false, 0.5)).toBe(false);
    expect(buttonDown(false, 0.6)).toBe(true);
    expect(buttonDown(true, 0.5)).toBe(true);
    expect(buttonDown(true, 0.4)).toBe(false);
  });
});
