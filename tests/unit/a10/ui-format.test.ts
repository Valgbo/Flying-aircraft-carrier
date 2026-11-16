import { describe, expect, it } from 'vitest';
import { KT, FT, LB } from '../../../src/a10/core/units';
import {
  capitalize,
  DASH,
  formatClock,
  formatClockDirection,
  formatDegFromRad,
  formatDragArea,
  formatFeetFromM,
  formatFixed,
  formatG,
  formatHitRate,
  formatInt,
  formatKg,
  formatKnots,
  formatLbFromKg,
  formatMiss,
  formatMm,
  formatPct,
  formatRangeM,
  formatSeconds,
  humanize,
  MINUS,
  NBSP,
} from '../../../src/a10/ui/format';

describe('A-10 UI formatting', () => {
  it('numbers: separators, typographic minus, unknown values', () => {
    expect(formatInt(1150)).toBe('1,150');
    expect(formatInt(-1234.6)).toBe(`${MINUS}1,235`);
    expect(formatInt(NaN)).toBe(DASH);
    expect(formatFixed(-0.04, 1)).toBe('0.0');
    expect(formatFixed(-1.26, 1)).toBe(`${MINUS}1.3`);
  });

  it('mass in kilograms and pounds', () => {
    expect(formatKg(3412.4)).toBe(`3,412${NBSP}kg`);
    expect(formatLbFromKg(1000 * LB)).toBe(`1,000${NBSP}lb`);
    expect(formatKg(NaN)).toBe(DASH);
  });

  it('ranges, misses, speeds, heights', () => {
    expect(formatRangeM(1218)).toBe(`1,218${NBSP}m`);
    expect(formatRangeM(1218, 10)).toBe(`1,220${NBSP}m`);
    expect(formatRangeM(0)).toBe(DASH);
    expect(formatMiss(3.46)).toBe(`3.5${NBSP}m`);
    expect(formatMiss(23.4)).toBe(`23${NBSP}m`);
    expect(formatMiss(NaN)).toBe(DASH);
    expect(formatKnots(300 * KT)).toBe(`300${NBSP}kn`);
    expect(formatFeetFromM(8000 * FT)).toBe(`8,000${NBSP}ft`);
  });

  it('angles, load, durations, clock', () => {
    expect(formatDegFromRad(-Math.PI / 6)).toBe(`${MINUS}30°`);
    expect(formatDegFromRad(Math.PI / 4)).toBe('45°');
    expect(formatG(4.26)).toBe(`4.3${NBSP}g`);
    expect(formatSeconds(1.43)).toBe(`1.4${NBSP}s`);
    expect(formatClock(75.4)).toBe('1:15');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-1)).toBe(DASH);
    expect(formatClockDirection(3)).toBe("3 o'clock");
    expect(formatClockDirection(0)).toBe(DASH);
    expect(formatClockDirection(NaN)).toBe(DASH);
  });

  it('percentages and hit rates', () => {
    expect(formatPct(0.347)).toBe(`35${NBSP}%`);
    expect(formatPct(NaN)).toBe(DASH);
    expect(formatHitRate(12, 120)).toBe(`12 / 120 (10${NBSP}%)`);
    expect(formatHitRate(0, 0)).toBe('0 / 0');
  });

  it('drag area and armour', () => {
    expect(formatDragArea(0.4234)).toBe(`0.42${NBSP}m²`);
    expect(formatDragArea(NaN)).toBe(DASH);
    expect(formatMm(27.6)).toBe(`28${NBSP}mm`);
  });

  it('words from identifiers', () => {
    expect(humanize('runningGear')).toBe('running gear');
    expect(humanize('passedThrough')).toBe('passed through');
    expect(humanize('engine-deck')).toBe('engine deck');
    expect(capitalize('penetrated')).toBe('Penetrated');
    expect(capitalize('')).toBe('');
  });
});
