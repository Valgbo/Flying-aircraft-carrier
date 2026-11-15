import { describe, expect, it } from 'vitest';
import { PHYS } from '../../src/config/physicsConfig';
import { DEFAULT_KEY_BINDINGS } from '../../src/state/bindings';
import type { Telemetry } from '../../src/state/types';
import {
  ARC_START_DEG,
  ARC_SWEEP_DEG,
  HORIZON_CENTER,
  PITCH_LIMIT_DEG,
  PITCH_UNITS_PER_DEG,
  arcAngleDeg,
  arcLength,
  barFraction,
  buildPitchLadder,
  gaugeState,
  horizonRotationDeg,
  horizonShift,
  vsiFraction,
} from '../../src/ui/hud/attitude';
import {
  CAUTION_LIMITS,
  deriveCautions,
  sameCautions,
  selectVisibleCautions,
} from '../../src/ui/hud/cautions';
import {
  TAPE_OVERSCAN_DEG,
  TAPE_UNITS_PER_DEG,
  TAPE_WIDTH,
  buildTapeTicks,
  compassLabel,
  tapeOffset,
} from '../../src/ui/hud/compass';
import {
  formatHeading,
  formatInt,
  formatPercent,
  formatSigned,
  formatThrustMN,
  formatTiltDeg,
  motionSense,
  showSeaReadout,
  targetSense,
  thrustFraction,
  verticalTrend,
} from '../../src/ui/hud/format';
import { buildKeyHints } from '../../src/ui/hud/keyHints';

function telemetry(patch: Partial<Telemetry> = {}): Telemetry {
  return {
    time: 0,
    altitude: 600,
    keelClearance: 584,
    speedKts: 0,
    forwardSpeedKts: 0,
    verticalSpeed: 0,
    headingDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    gLoad: 1,
    afloat: false,
    throttle: [0.6, 0.6, 0.6, 0.6],
    throttleCmd: [0.6, 0.6, 0.6, 0.6],
    tiltDeg: [0, 0, 0, 0],
    tiltCmdDeg: [0, 0, 0, 0],
    thrustKN: [240_000, 240_000, 240_000, 240_000],
    enabled: [true, true, true, true],
    targetAltitude: 600,
    ...patch,
  };
}

const ids = (list: { id: string }[]): string[] => list.map((c) => c.id);

describe('hud formatting', () => {
  it('formats the heading as three digits and never shows 360', () => {
    expect(formatHeading(0)).toBe('000');
    expect(formatHeading(7.4)).toBe('007');
    expect(formatHeading(90)).toBe('090');
    expect(formatHeading(359.4)).toBe('359');
    expect(formatHeading(359.6)).toBe('000');
    expect(formatHeading(-90)).toBe('270');
    expect(formatHeading(NaN)).toBe('000');
  });

  it('formats signed values without a signed zero', () => {
    expect(formatSigned(3.24)).toBe('+3.2');
    expect(formatSigned(-12.36)).toBe('-12.4');
    expect(formatSigned(0.04)).toBe('0.0');
    expect(formatSigned(-0.04)).toBe('0.0');
    expect(formatSigned(NaN)).toBe('0.0');
    expect(Number(formatSigned(7.5))).toBe(7.5);
  });

  it('formats integers, tilt, percent and thrust', () => {
    expect(formatInt(419.6)).toBe('420');
    expect(formatInt(-0.2)).toBe('0');
    expect(formatTiltDeg(12.4)).toBe('+12°');
    expect(formatTiltDeg(-19.6)).toBe('-20°');
    expect(formatTiltDeg(0.3)).toBe('0°');
    expect(formatPercent(0.626)).toBe('63');
    expect(formatPercent(1.4)).toBe('100');
    expect(thrustFraction(PHYS.maxThrust / 2)).toBeCloseTo(0.5);
    expect(thrustFraction(PHYS.maxThrust * 2)).toBe(1);
    expect(formatThrustMN(248_400)).toBe('248');
  });

  it('classifies motion, vertical trend and the target altitude', () => {
    expect(motionSense(12, 12)).toBe('ahead');
    expect(motionSense(-3, 3)).toBe('astern');
    expect(motionSense(0.2, 0.2)).toBe('stopped');
    // climbing with the bow up: speed along the ship's axis but no way on
    expect(motionSense(1.4, 0.1)).toBe('stopped');
    // a strafe with a little drift along the axis is neither ahead nor astern
    expect(motionSense(-1.7, 16.6)).toBe('sideways');
    expect(motionSense(1.7, 16.6)).toBe('sideways');
    expect(motionSense(0.2, 17)).toBe('sideways');
    // a track 45° off the bow or the stern still counts as ahead / astern
    expect(motionSense(12, 17)).toBe('ahead');
    expect(motionSense(-12, 17)).toBe('astern');
    expect(verticalTrend(2)).toBe('climb');
    expect(verticalTrend(-2)).toBe('descent');
    expect(verticalTrend(0.1)).toBe('level');
    expect(targetSense(500, 420)).toBe('above');
    expect(targetSense(400, 420)).toBe('below');
    expect(targetSense(421, 420)).toBe('held');
  });

  it('shows the sea readout only near the water and not while afloat', () => {
    expect(showSeaReadout(35, false)).toBe(true);
    expect(showSeaReadout(249, false)).toBe(true);
    expect(showSeaReadout(250, false)).toBe(false);
    expect(showSeaReadout(-2, true)).toBe(false);
  });
});

describe('compass tape', () => {
  it('labels cardinals with letters and every 30° with tens', () => {
    expect(compassLabel(0)).toBe('N');
    expect(compassLabel(90)).toBe('E');
    expect(compassLabel(180)).toBe('S');
    expect(compassLabel(270)).toBe('W');
    expect(compassLabel(360)).toBe('N');
    expect(compassLabel(-90)).toBe('W');
    expect(compassLabel(30)).toBe('03');
    expect(compassLabel(330)).toBe('33');
    expect(compassLabel(40)).toBeNull();
  });

  it('has a tick every 10° with long ticks every 30°', () => {
    const ticks = buildTapeTicks();
    expect(ticks[0].deg).toBe(-TAPE_OVERSCAN_DEG);
    expect(ticks[ticks.length - 1].deg).toBe(360 + TAPE_OVERSCAN_DEG);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].deg - ticks[i - 1].deg).toBe(10);
    expect(ticks.find((t) => t.deg === 60)?.major).toBe(true);
    expect(ticks.find((t) => t.deg === 50)?.major).toBe(false);
    expect(ticks.find((t) => t.deg === 360)?.label).toBe('N');
    expect(ticks.find((t) => t.deg === 420)?.label).toBe('06');
  });

  it('centres the current heading: 090 puts E under the caret', () => {
    const east = buildTapeTicks().find((t) => t.deg === 90)!;
    expect(east.label).toBe('E');
    expect(east.x + tapeOffset(90)).toBeCloseTo(TAPE_WIDTH / 2);
  });

  it('moves the strip left as the heading increases (turning to starboard)', () => {
    expect(tapeOffset(100)).toBeLessThan(tapeOffset(90));
    expect(tapeOffset(90) - tapeOffset(100)).toBeCloseTo(10 * TAPE_UNITS_PER_DEG);
  });

  it('always has ticks across the whole view, also at the 0 / 360 seam', () => {
    const ticks = buildTapeTicks();
    for (const heading of [0, 0.5, 179, 359.9]) {
      const offset = tapeOffset(heading);
      const xs = ticks.map((t) => t.x + offset);
      expect(Math.min(...xs)).toBeLessThanOrEqual(0);
      expect(Math.max(...xs)).toBeGreaterThanOrEqual(TAPE_WIDTH);
    }
    // the seam is continuous: N is under the caret at 0 and at 360
    const north = ticks.find((t) => t.deg === 360)!;
    expect(north.x + tapeOffset(359.999)).toBeCloseTo(TAPE_WIDTH / 2, 1);
  });
});

describe('attitude indicator', () => {
  it('rolls the horizon counter-clockwise for a roll to starboard', () => {
    // SVG rotate(): positive = clockwise, so counter-clockwise is negative
    expect(horizonRotationDeg(20)).toBe(-20);
    expect(horizonRotationDeg(-12)).toBe(12);
    expect(horizonRotationDeg(0)).toBe(0);
  });

  it('moves the horizon down when the bow pitches up, and clamps at the ladder limit', () => {
    // SVG +y is down
    expect(horizonShift(10)).toBe(10 * PITCH_UNITS_PER_DEG);
    expect(horizonShift(-5)).toBe(-5 * PITCH_UNITS_PER_DEG);
    expect(horizonShift(80)).toBe(PITCH_LIMIT_DEG * PITCH_UNITS_PER_DEG);
  });

  it('draws nose-up rungs above the horizon line', () => {
    const ladder = buildPitchLadder();
    const up10 = ladder.find((r) => r.deg === 10)!;
    const down10 = ladder.find((r) => r.deg === -10)!;
    expect(up10.y).toBeLessThan(HORIZON_CENTER);
    expect(down10.y).toBeGreaterThan(HORIZON_CENTER);
    expect(up10.label).toBe('10');
    expect(ladder.find((r) => r.deg === 5)?.label).toBeNull();
    expect(ladder.some((r) => r.deg === 0)).toBe(false);
  });

  it('deflects the vertical-speed needle monotonically and saturates', () => {
    expect(vsiFraction(0)).toBe(0);
    expect(vsiFraction(5)).toBeGreaterThan(0);
    expect(vsiFraction(-5)).toBeCloseTo(-vsiFraction(5));
    expect(vsiFraction(10)).toBeGreaterThan(vsiFraction(5));
    expect(vsiFraction(500)).toBe(1);
    expect(vsiFraction(-500)).toBe(-1);
  });
});

describe('turbine gauges', () => {
  it('maps throttle onto the arc', () => {
    expect(arcAngleDeg(0)).toBe(ARC_START_DEG);
    expect(arcAngleDeg(1)).toBe(ARC_START_DEG + ARC_SWEEP_DEG);
    expect(arcAngleDeg(2)).toBe(ARC_START_DEG + ARC_SWEEP_DEG);
    expect(arcLength(0.5, 10)).toBeCloseTo(0.5 * 2 * Math.PI * 10 * 0.75);
    expect(arcLength(-1, 10)).toBe(0);
  });

  it('colours by state: off, amber above 95 %, accent otherwise', () => {
    expect(gaugeState(true, 0.6)).toBe('normal');
    expect(gaugeState(true, 0.96)).toBe('high');
    expect(gaugeState(false, 0.96)).toBe('off');
  });

  it('places values on a linear bar', () => {
    expect(barFraction(0, PHYS.tiltMin, PHYS.tiltMax)).toBeCloseTo(0.25);
    expect(barFraction(PHYS.tiltMax, PHYS.tiltMin, PHYS.tiltMax)).toBe(1);
    expect(barFraction(-9, 0, 1)).toBe(0);
  });
});

describe('cautions', () => {
  it('is quiet in a steady hover with assist on', () => {
    expect(deriveCautions(telemetry(), true)).toEqual([]);
  });

  it('raises each caution at its threshold', () => {
    const L = CAUTION_LIMITS;
    expect(
      ids(deriveCautions(telemetry({ verticalSpeed: -16, keelClearance: 300 }), true)),
    ).toEqual(['sinkRate']);
    expect(
      ids(deriveCautions(telemetry({ verticalSpeed: -16, keelClearance: 500 }), true)),
    ).toEqual([]);
    expect(ids(deriveCautions(telemetry({ verticalSpeed: -2, keelClearance: 30 }), true))).toEqual([
      'lowAltitude',
    ]);
    expect(ids(deriveCautions(telemetry({ verticalSpeed: 2, keelClearance: 30 }), true))).toEqual(
      [],
    );
    expect(ids(deriveCautions(telemetry({ rollDeg: -(L.bankDeg + 1) }), true))).toEqual([
      'bankAngle',
    ]);
    expect(ids(deriveCautions(telemetry({ rollDeg: L.bankDeg - 1 }), true))).toEqual([]);
    expect(ids(deriveCautions(telemetry({ pitchDeg: L.pitchDeg + 1 }), true))).toEqual(['pitch']);
    expect(ids(deriveCautions(telemetry({ altitude: L.ceiling + 10 }), true))).toEqual(['ceiling']);
    expect(ids(deriveCautions(telemetry(), false))).toEqual(['manual']);
  });

  it('reports ENGINE OUT only while airborne', () => {
    const enabled: Telemetry['enabled'] = [true, false, true, true];
    expect(ids(deriveCautions(telemetry({ enabled }), true))).toEqual(['engineOut']);
    expect(
      ids(deriveCautions(telemetry({ enabled, afloat: true, keelClearance: -8 }), true)),
    ).toEqual([]);
  });

  it('does not warn about low altitude while afloat', () => {
    const t = telemetry({ afloat: true, keelClearance: -6, verticalSpeed: -1 });
    expect(deriveCautions(t, true)).toEqual([]);
  });

  it('orders by priority and keeps the manual chip when banners are limited', () => {
    const t = telemetry({
      verticalSpeed: -20,
      keelClearance: 30,
      rollDeg: 30,
      pitchDeg: -20,
      enabled: [true, true, false, true],
    });
    const all = deriveCautions(t, false);
    expect(ids(all)).toEqual([
      'sinkRate',
      'lowAltitude',
      'engineOut',
      'bankAngle',
      'pitch',
      'manual',
    ]);
    expect(ids(selectVisibleCautions(all, 2))).toEqual(['sinkRate', 'lowAltitude', 'manual']);
    expect(all[0].level).toBe('warning');
    expect(all[all.length - 1].level).toBe('advisory');
  });

  it('holds a showing banner slightly past its threshold (hysteresis)', () => {
    const edge = telemetry({ rollDeg: CAUTION_LIMITS.bankDeg - 0.5 });
    expect(deriveCautions(edge, true)).toEqual([]);
    const showing = deriveCautions(telemetry({ rollDeg: 25 }), true);
    expect(ids(deriveCautions(edge, true, showing))).toEqual(['bankAngle']);
    expect(deriveCautions(telemetry({ rollDeg: 10 }), true, showing)).toEqual([]);
    // feeding the result back in is stable
    const next = deriveCautions(edge, true, showing);
    expect(sameCautions(deriveCautions(edge, true, next), next)).toBe(true);
  });
});

describe('key legend', () => {
  it('uses the live bindings and pairs opposite controls', () => {
    const hints = buildKeyHints({ ...DEFAULT_KEY_BINDINGS, throttleUp: 'KeyI' }, 'flight', true);
    const collective = hints.find((h) => h.id === 'collective')!;
    expect(collective.keys).toEqual(['I', 'S']);
    expect(collective.label).toBe('Climb / descend');
    expect(hints.find((h) => h.id === 'tilt')?.keys).toEqual(['↑', '↓']);
    expect(hints.find((h) => h.id === 'togglePause')?.keys).toEqual(['Esc']);
  });

  it('lists the launch key only in flight ops and renames the collective in manual', () => {
    expect(
      buildKeyHints(DEFAULT_KEY_BINDINGS, 'flight', true).some((h) => h.id === 'launchJet'),
    ).toBe(false);
    expect(buildKeyHints(DEFAULT_KEY_BINDINGS, 'ops', true).some((h) => h.id === 'launchJet')).toBe(
      true,
    );
    const manual = buildKeyHints(DEFAULT_KEY_BINDINGS, 'flight', false);
    expect(manual.find((h) => h.id === 'collective')?.label).toBe('Throttle up / down');
  });
});
