import { describe, expect, it } from 'vitest';
import {
  PAN_WIDTH,
  TURBINE_DETUNE,
  WHINE_PARTIALS,
  bearingToPan,
  distanceCutoff,
  distanceGain,
  dopplerFactor,
  jetGain,
  jetNoiseHz,
  jetToneHz,
  offsetToPan,
  seaBedGain,
  splashIntensity,
  sprayGain,
  turbineRoarCutoff,
  turbineRoarGain,
  turbineRumbleGain,
  turbineWhineGain,
  turbineWhineHz,
  volumeToGain,
  windBuffetDepth,
  windCutoff,
  windGain,
} from '../../src/audio/engineAudio';

const BAD = [NaN, Infinity, -Infinity, -5, 1e12];

function samples(from: number, to: number, count = 200): number[] {
  return Array.from({ length: count + 1 }, (_, i) => from + ((to - from) * i) / count);
}

function expectNonDecreasing(values: number[]) {
  for (let i = 1; i < values.length; i++) {
    expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] - 1e-12);
  }
}

function expectNonIncreasing(values: number[]) {
  for (let i = 1; i < values.length; i++) {
    expect(values[i]).toBeLessThanOrEqual(values[i - 1] + 1e-12);
  }
}

describe('audio mappings: unit-range inputs', () => {
  const cases: [string, (v: number) => number, number, number][] = [
    ['volumeToGain', volumeToGain, 0, 1],
    ['turbineRoarGain', turbineRoarGain, 0, 0.8],
    ['turbineWhineGain', turbineWhineGain, 0, 0.07],
    ['turbineRumbleGain', turbineRumbleGain, 0, 0.55],
    ['sprayGain', sprayGain, 0, 0.3],
  ];

  it.each(cases)('%s is silent at zero, monotonic and bounded', (_name, fn, min, max) => {
    const values = samples(0, 1).map(fn);
    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBeCloseTo(max, 6);
    expectNonDecreasing(values);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(min);
      expect(v).toBeLessThanOrEqual(max + 1e-9);
    }
  });

  it.each(cases)('%s never returns NaN and clamps out-of-range input', (_name, fn, min, max) => {
    for (const bad of BAD) {
      const v = fn(bad);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(min);
      expect(v).toBeLessThanOrEqual(max + 1e-9);
    }
  });

  it('volume follows a square law', () => {
    expect(volumeToGain(0.5)).toBeCloseTo(0.25, 9);
    expect(volumeToGain(1)).toBe(1);
  });
});

describe('turbine voice', () => {
  it('idles quietly and is clearly louder at full power', () => {
    const idle = turbineRoarGain(0.1);
    expect(idle).toBeGreaterThan(0);
    expect(idle).toBeLessThan(0.1 * turbineRoarGain(1));
    expect(turbineWhineGain(0.1)).toBeGreaterThan(0);
    expect(turbineRumbleGain(0.3)).toBe(0);
    expect(turbineRumbleGain(1)).toBeGreaterThan(turbineRumbleGain(0.7));
  });

  it('pitch and brightness rise with fan speed and stay in the audible range', () => {
    const rpm = samples(0, 1);
    const hz = rpm.map(turbineWhineHz);
    const cutoff = rpm.map(turbineRoarCutoff);
    expectNonDecreasing(hz);
    expectNonDecreasing(cutoff);
    expect(hz[0]).toBeGreaterThanOrEqual(40);
    expect(
      hz[hz.length - 1] * Math.max(...WHINE_PARTIALS) * Math.max(...TURBINE_DETUNE),
    ).toBeLessThan(4000);
    expect(cutoff[0]).toBeGreaterThan(100);
    expect(cutoff[cutoff.length - 1]).toBeLessThanOrEqual(5000);
    for (const bad of BAD) {
      expect(Number.isFinite(turbineWhineHz(bad))).toBe(true);
      expect(Number.isFinite(turbineRoarCutoff(bad))).toBe(true);
    }
  });

  it('gives every turbine its own detune, within a few percent', () => {
    expect(new Set(TURBINE_DETUNE).size).toBe(4);
    for (const d of TURBINE_DETUNE) expect(Math.abs(d - 1)).toBeLessThan(0.03);
  });
});

describe('placement', () => {
  it('distance gain is 1 at the source, falls monotonically and never reaches zero in range', () => {
    const values = samples(0, 5000, 500).map(distanceGain);
    expect(values[0]).toBe(1);
    expectNonIncreasing(values);
    for (const v of values) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // usable across the whole camera range: bridge (60 m) to a wide orbit (900 m)
    expect(distanceGain(60)).toBeGreaterThan(0.7);
    expect(distanceGain(900)).toBeGreaterThan(0.1);
    expect(distanceGain(900)).toBeLessThan(0.3);
    for (const bad of [NaN, -10]) expect(distanceGain(bad)).toBe(1);
    expect(Number.isFinite(distanceGain(Infinity))).toBe(true);
  });

  it('distance low-pass closes with distance and stays within its limits', () => {
    const values = samples(0, 5000, 500).map(distanceCutoff);
    expectNonIncreasing(values);
    expect(values[0]).toBe(18000);
    expect(values[values.length - 1]).toBeGreaterThanOrEqual(1200);
    expect(distanceCutoff(900)).toBeLessThan(distanceCutoff(60) / 2);
    for (const bad of BAD) expect(Number.isFinite(distanceCutoff(bad))).toBe(true);
  });

  it('pan follows the bearing: centre ahead, right for +x, mirrored for -x', () => {
    expect(offsetToPan(0, 0, -100)).toBe(0);
    expect(offsetToPan(100, 0, 0)).toBeCloseTo(PAN_WIDTH, 9);
    expect(offsetToPan(-100, 0, 0)).toBeCloseTo(-PAN_WIDTH, 9);
    expect(offsetToPan(50, 0, -50)).toBeCloseTo(-offsetToPan(-50, 0, -50), 9);
    // behind the listener keeps its side
    expect(offsetToPan(50, 0, 80)).toBeGreaterThan(0);
    // straight above: centred
    expect(offsetToPan(0, 300, 0)).toBe(0);
    expect(offsetToPan(0, 0, 0)).toBe(0);
    expect(offsetToPan(NaN, NaN, NaN)).toBe(0);
    const sweep = samples(-200, 200).map((x) => offsetToPan(x, 10, -120));
    expectNonDecreasing(sweep);
    for (const p of sweep) expect(Math.abs(p)).toBeLessThanOrEqual(PAN_WIDTH);
  });

  it('bearingToPan agrees with offsetToPan', () => {
    expect(bearingToPan(0)).toBe(0);
    expect(bearingToPan(Math.PI / 2)).toBeCloseTo(PAN_WIDTH, 9);
    expect(bearingToPan(-Math.PI / 2)).toBeCloseTo(-PAN_WIDTH, 9);
    const bearing = 0.6;
    expect(bearingToPan(bearing)).toBeCloseTo(
      offsetToPan(Math.sin(bearing) * 300, 0, -Math.cos(bearing) * 300),
      9,
    );
    expect(bearingToPan(NaN)).toBe(0);
    expectNonDecreasing(samples(-Math.PI / 2, Math.PI / 2).map(bearingToPan));
  });

  it('doppler factor is 1 at rest, higher when closing, lower when receding, and clamped', () => {
    expect(dopplerFactor(0)).toBe(1);
    expect(dopplerFactor(-80)).toBeGreaterThan(1);
    expect(dopplerFactor(80)).toBeLessThan(1);
    expectNonIncreasing(samples(-400, 400).map(dopplerFactor));
    for (const bad of [...BAD, -1e9]) {
      const f = dopplerFactor(bad);
      expect(f).toBeGreaterThanOrEqual(0.6);
      expect(f).toBeLessThanOrEqual(1.6);
    }
  });
});

describe('wind and sea', () => {
  it('wind is silent in still air and builds with airspeed', () => {
    expect(windGain(0)).toBe(0);
    const values = samples(0, 200).map((v) => windGain(v));
    expectNonDecreasing(values);
    expect(values[values.length - 1]).toBeLessThanOrEqual(0.5);
    expect(windGain(60)).toBeGreaterThan(windGain(20));
    expectNonDecreasing(samples(0, 200).map(windCutoff));
    expect(windCutoff(0)).toBeGreaterThan(100);
    expect(windCutoff(1e9)).toBeLessThanOrEqual(2850);
  });

  it('g-load adds a bounded buffet', () => {
    expect(windGain(80, 2.2)).toBeGreaterThan(windGain(80, 1));
    expect(windGain(80, 0)).toBeGreaterThan(windGain(80, 1));
    expect(windGain(80, 50)).toBeLessThanOrEqual(0.5 * 1.35);
    expect(windBuffetDepth(1)).toBeLessThan(windBuffetDepth(2));
    for (const g of [...BAD, 0, 1, 3]) {
      expect(windBuffetDepth(g)).toBeGreaterThanOrEqual(0);
      expect(windBuffetDepth(g)).toBeLessThanOrEqual(0.6 + 1e-9);
      expect(Number.isFinite(windGain(50, g))).toBe(true);
    }
    expect(Number.isFinite(windGain(NaN, NaN))).toBe(true);
  });

  it('the surf bed is only heard near the surface', () => {
    const values = samples(0, 600).map(seaBedGain);
    expectNonIncreasing(values);
    expect(values[0]).toBeCloseTo(0.22, 9);
    expect(seaBedGain(200)).toBe(0);
    expect(seaBedGain(420)).toBe(0);
    expect(seaBedGain(100)).toBeGreaterThan(0);
    expect(seaBedGain(-20)).toBeCloseTo(0.22, 9);
    expect(Number.isFinite(seaBedGain(NaN))).toBe(true);
  });
});

describe('jets and one-shots', () => {
  it('an inactive jet is silent; an active one gets louder and higher with power', () => {
    expect(jetGain(1, false)).toBe(0);
    expect(jetGain(0, true)).toBeGreaterThan(0);
    expectNonDecreasing(samples(0, 1).map((p) => jetGain(p, true)));
    expect(jetGain(5, true)).toBeLessThanOrEqual(0.4 + 1e-9);
    expectNonDecreasing(samples(0, 1).map(jetToneHz));
    expectNonDecreasing(samples(0, 1).map(jetNoiseHz));
    for (const bad of BAD) {
      expect(Number.isFinite(jetGain(bad, true))).toBe(true);
      expect(Number.isFinite(jetToneHz(bad))).toBe(true);
      expect(Number.isFinite(jetNoiseHz(bad))).toBe(true);
    }
  });

  it('splash intensity scales with sink rate within 0.25..1', () => {
    expect(splashIntensity(0)).toBe(0.25);
    expect(splashIntensity(100)).toBe(1);
    expectNonDecreasing(samples(0, 30).map(splashIntensity));
    for (const bad of BAD) {
      const v = splashIntensity(bad);
      expect(v).toBeGreaterThanOrEqual(0.25);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
