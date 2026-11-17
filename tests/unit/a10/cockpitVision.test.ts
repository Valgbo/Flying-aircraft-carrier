/**
 * Vision under g (src/a10/view/cockpit/vision.ts): onset ≈ 6.5 g, full loss ≈ 8.5 g with a time
 * lag (the eye's oxygen reserve), recovery, red-out below −2.5 g, and the tunnel that keeps the
 * middle of the screen (the HUD) clear until vision is nearly gone.
 */
import { describe, expect, it } from 'vitest';
import {
  createVisionState,
  stepVision,
  tunnelRadius,
  VISION,
  visionLoad,
  type VisionState,
} from '../../../src/a10/view/cockpit/vision';

function hold(v: VisionState, g: number, seconds: number, dt = 1 / 60): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) stepVision(v, g, dt);
}

describe('g-induced loss of vision', () => {
  it('does nothing up to the onset load, however long', () => {
    const v = createVisionState();
    hold(v, VISION.onsetG, 60);
    expect(v.level).toBe(0);
    expect(v.reserve).toBe(1);
    expect(visionLoad(6)).toBe(0);
    expect(visionLoad(VISION.fullG)).toBe(1);
  });

  it('lags: a short pull through 8.5 g only greys the edges', () => {
    const v = createVisionState();
    hold(v, 8.5, 1);
    expect(v.level).toBeGreaterThan(0);
    expect(v.level).toBeLessThan(0.25);
  });

  it('blacks out after a few seconds at 8.5 g, not at once', () => {
    const v = createVisionState();
    hold(v, 8.5, 2);
    const at2 = v.level;
    hold(v, 8.5, 6);
    expect(at2).toBeLessThan(0.6);
    expect(v.level).toBeGreaterThan(0.9);
  });

  it('a long 7.5 g turn greys out part way and stays there', () => {
    const v = createVisionState();
    hold(v, 7.5, 30);
    expect(v.level).toBeGreaterThan(0.35);
    expect(v.level).toBeLessThan(0.6);
  });

  it('recovers within seconds once the load comes off', () => {
    const v = createVisionState();
    hold(v, 8.5, 8);
    hold(v, 1, 6);
    expect(v.level).toBeLessThan(0.02);
    hold(v, 1, 4);
    expect(v.reserve).toBe(1);
  });

  it('does not change while paused', () => {
    const v = createVisionState();
    hold(v, 8.5, 3);
    const before = { ...v };
    stepVision(v, 9, 0);
    expect(v).toEqual(before);
  });
});

describe('red-out', () => {
  it('starts below −2.5 g and is complete near −4 g', () => {
    const v = createVisionState();
    hold(v, -2.4, 10);
    expect(v.red).toBe(0);
    hold(v, -4.2, 10);
    expect(v.red).toBeGreaterThan(0.95);
    hold(v, 1, 10);
    expect(v.red).toBeLessThan(0.01);
  });
});

describe('the tunnel', () => {
  it('keeps the screen clear at low levels and closes toward the centre', () => {
    expect(tunnelRadius(0)).toBeGreaterThan(1.5);
    expect(tunnelRadius(0.15)).toBeGreaterThan(1.5);
    expect(tunnelRadius(0.6)).toBeLessThan(tunnelRadius(0.3));
    // the HUD glass is within ≈0.3 screen half-heights of the centre at the default zoom
    expect(tunnelRadius(0.6)).toBeGreaterThan(0.3);
    expect(tunnelRadius(0.95)).toBeLessThan(0.15);
  });
});
