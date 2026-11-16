import { describe, expect, it } from 'vitest';
import {
  blastOf,
  impactKindOf,
  type Detonation,
  type RoundImpact,
} from '../../../src/a10/audio/classify';
import {
  BUS_IDS,
  DEFAULT_VOLUME,
  ENGINE_N1_IDLE,
  ENGINE_N2_IDLE,
  GUN_LOOP_FULL_RATE,
  GUN_LOOP_SHOT_RATE,
  MAX_TRIM,
  buffetGain,
  createEngineLayers,
  creakGain,
  defaultTrims,
  engineLayers,
  gearGain,
  gunFireLevel,
  gunLoopGain,
  gunLoopRate,
  gunPulseGain,
  gunPulseHz,
  gunRumbleGain,
  gunWhineGain,
  gunWhineHz,
  masterGain,
  parseTrims,
  sanitizeTrims,
  speedBrakeGain,
  windCutoff,
  windGain,
} from '../../../src/a10/audio/mappings';
import {
  airframeImpulse,
  growlWaveCoefficients,
  peakOf,
  pulseWaveCoefficients,
  renderCrack,
  renderCrackle,
  renderExplosion,
  renderImpact,
  renderMotor,
  renderWhoosh,
  rmsOf,
} from '../../../src/a10/audio/synth';
import { RoundType } from '../../../src/a10/core/weapons/types';
import { A10 } from '../../../src/a10/data/aircraft';
import { GAU8 } from '../../../src/a10/data/gun';

const BAD = [NaN, Infinity, -Infinity, -5, 1e12];

function range(from: number, to: number, count = 200): number[] {
  return Array.from({ length: count + 1 }, (_, i) => from + ((to - from) * i) / count);
}

function nonDecreasing(values: number[]) {
  for (let i = 1; i < values.length; i++)
    expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] - 1e-12);
}

function nonIncreasing(values: number[]) {
  for (let i = 1; i < values.length; i++)
    expect(values[i]).toBeLessThanOrEqual(values[i - 1] + 1e-12);
}

describe('mix settings', () => {
  it('master gain: square law, 0 when muted, junk falls back to the default volume', () => {
    expect(masterGain(1, false)).toBe(1);
    expect(masterGain(0.5, false)).toBeCloseTo(0.25, 12);
    expect(masterGain(0.8, true)).toBe(0);
    const fallback = DEFAULT_VOLUME * DEFAULT_VOLUME;
    for (const junk of [NaN, Infinity, undefined, null, '0.5', {}]) {
      expect(masterGain(junk, false)).toBeCloseTo(fallback, 12);
    }
    expect(masterGain(7, false)).toBe(1);
    expect(masterGain(-3, false)).toBe(0);
    // only `true` mutes
    expect(masterGain(1, 'yes')).toBe(1);
  });

  it('bus trims are sanitised field by field', () => {
    expect(sanitizeTrims(null)).toEqual(defaultTrims());
    expect(sanitizeTrims('loud')).toEqual(defaultTrims());
    const t = sanitizeTrims({
      gun: 0.5,
      engines: 9,
      world: -1,
      cockpit: NaN,
      airframe: '2',
      bogus: 1,
    });
    expect(t).toEqual({ gun: 0.5, engines: MAX_TRIM, world: 0, cockpit: 1, airframe: 1 });
    expect(Object.keys(t).sort()).toEqual([...BUS_IDS].sort());
    // a base keeps earlier trims
    expect(sanitizeTrims({ gun: 0.25 }, { ...defaultTrims(), world: 0.5 }).world).toBe(0.5);
  });

  it('the ?audiomix= flag parses into sanitised trims', () => {
    expect(parseTrims('gun:0.5,engines:3,foo:1,world:x,cockpit:')).toEqual({
      gun: 0.5,
      engines: MAX_TRIM,
      airframe: 1,
      world: 1,
      cockpit: 1,
    });
    expect(parseTrims(null)).toEqual(defaultTrims());
    expect(parseTrims('garbage')).toEqual(defaultTrims());
  });
});

describe('engines (TF34)', () => {
  const out = createEngineLayers();
  const n1s = range(ENGINE_N1_IDLE, 1);
  const n2For = (n1: number) =>
    ENGINE_N2_IDLE + (1 - ENGINE_N2_IDLE) * ((n1 - ENGINE_N1_IDLE) / (1 - ENGINE_N1_IDLE));

  it('spooling up raises every layer and the pitch of every loop', () => {
    const series = n1s.map((n1) => ({ ...engineLayers(n1, n2For(n1), true, out) }));
    for (const key of [
      'fan',
      'fanInside',
      'whine',
      'whineLow',
      'jet',
      'fanRate',
      'whineRate',
      'jetRate',
    ] as const) {
      nonDecreasing(series.map((s) => s[key]));
    }
    const idle = series[0];
    const max = series[series.length - 1];
    // the exhaust roar is what changes most: nearly nothing at idle, all of it at MAX
    expect(idle.jet).toBeLessThan(0.1);
    expect(max.jet).toBeCloseTo(1, 6);
    // the whine is there from idle (what a TF34 at idle sounds like)
    expect(idle.whine).toBeGreaterThan(0.7);
    expect(idle.fanRate).toBeCloseTo(0.55, 6);
    expect(max.fanRate).toBeCloseTo(1.15, 6);
    // core whine pitch follows N2 (blade passing is proportional to shaft speed)
    expect(max.whineRate / idle.whineRate).toBeCloseTo(1 / ENGINE_N2_IDLE, 6);
  });

  it('gains stay in 0..1 and rates finite for any input; a stopped engine is silent', () => {
    for (const a of [...BAD, 0, 0.5, 1]) {
      for (const b of [...BAD, 0, 0.6, 1]) {
        const l = engineLayers(a, b, true, out);
        for (const v of Object.values(l)) expect(Number.isFinite(v)).toBe(true);
        for (const k of ['fan', 'fanInside', 'whine', 'whineLow', 'jet'] as const) {
          expect(l[k]).toBeGreaterThanOrEqual(0);
          expect(l[k]).toBeLessThanOrEqual(1);
        }
        expect(l.whineRate).toBeGreaterThanOrEqual(0.4);
        expect(l.whineRate).toBeLessThanOrEqual(1.25);
      }
    }
    const off = engineLayers(1, 1, false, out);
    expect(off.fan + off.fanInside + off.whine + off.whineLow + off.jet).toBe(0);
    const dead = engineLayers(0, 0, true, out);
    expect(dead.whine).toBe(0);
  });
});

describe('airframe', () => {
  it('wind rises with IAS, from silence to full at Vne, and brightens', () => {
    const v = range(0, A10.vne * 1.2);
    nonDecreasing(v.map(windGain));
    nonDecreasing(v.map(windCutoff));
    expect(windGain(10)).toBe(0);
    expect(windGain(A10.vne)).toBeCloseTo(1, 9);
    expect(windGain(A10.vne * 2)).toBe(1);
    expect(windCutoff(0)).toBe(350);
    expect(windCutoff(A10.vne)).toBeCloseTo(4550, 6);
    // 250 kn cruise is clearly audible but not full
    const cruise = windGain(250 * 0.514444);
    expect(cruise).toBeGreaterThan(0.3);
    expect(cruise).toBeLessThan(0.7);
    for (const b of BAD) {
      expect(Number.isFinite(windGain(b))).toBe(true);
      expect(Number.isFinite(windCutoff(b))).toBe(true);
    }
  });

  it('buffet grows with angle of attack toward the stall, needs airflow, and comes back above Vne', () => {
    const deg = Math.PI / 180;
    nonDecreasing(range(0, 25 * deg).map((a) => buffetGain(a, 100)));
    expect(buffetGain(5 * deg, 100)).toBe(0);
    expect(buffetGain(20 * deg, 100)).toBe(1);
    expect(buffetGain(20 * deg, 0)).toBe(0);
    expect(buffetGain(2 * deg, A10.vne * 1.1)).toBeGreaterThan(0.5);
    for (const b of BAD) expect(buffetGain(b, b)).toBeGreaterThanOrEqual(0);
  });

  it('speed brake, gear and creaks', () => {
    nonDecreasing(range(0, 1).map((o) => speedBrakeGain(o, 150)));
    expect(speedBrakeGain(0, 200)).toBe(0);
    expect(speedBrakeGain(1, 20)).toBe(0);
    expect(gearGain(false, 150)).toBe(0);
    expect(gearGain(true, 150)).toBe(1);
    expect(creakGain(1)).toBe(0);
    expect(creakGain(3.9)).toBe(0);
    expect(creakGain(A10.gLimitPositive)).toBe(1);
    expect(creakGain(NaN)).toBe(0);
  });
});

describe('the GAU-8 mappings', () => {
  it('the recorded 69.7 shots/s loop plays at 65 shots/s at full rate', () => {
    expect(GUN_LOOP_SHOT_RATE).toBeCloseTo(69.7, 6);
    expect(GUN_LOOP_FULL_RATE).toBeCloseTo(GAU8.rate / 69.7, 9);
    expect(gunLoopRate(GAU8.rate)).toBeCloseTo(0.9326, 3);
    // shots per second heard = loop rate × playback rate
    expect(GUN_LOOP_SHOT_RATE * gunLoopRate(GAU8.rate)).toBeCloseTo(GAU8.rate, 9);
  });

  it('during the spin-up the loop follows the rate down to half speed, then fades instead', () => {
    const rates = range(0, GAU8.rate);
    nonDecreasing(rates.map(gunLoopRate));
    nonDecreasing(rates.map(gunLoopGain));
    expect(gunLoopRate(0)).toBe(0.5);
    expect(gunLoopRate(20)).toBe(0.5);
    expect(gunLoopRate(50)).toBeCloseTo(50 / 69.7, 9);
    expect(gunLoopGain(0)).toBe(0);
    expect(gunLoopGain(GAU8.rate)).toBe(1);
  });

  it('one pulse per round at the instantaneous rate; the first round is already a thump', () => {
    expect(gunPulseHz(GAU8.rate)).toBeCloseTo(65, 9);
    expect(gunPulseHz(0)).toBe(1);
    expect(gunPulseHz(1e9)).toBe(120);
    expect(gunPulseGain(20)).toBeGreaterThan(0.5);
    expect(gunFireLevel(GAU8.rate * 2)).toBe(1);
    nonDecreasing(range(0, 65).map(gunRumbleGain));
  });

  it('the drive whine rises over the spin-up and falls with the spin-down', () => {
    const spins = range(0, 1);
    nonDecreasing(spins.map(gunWhineHz));
    nonDecreasing(spins.map(gunWhineGain));
    expect(gunWhineHz(0)).toBe(70);
    expect(gunWhineHz(1)).toBe(600);
    expect(gunWhineGain(0)).toBe(0);
    expect(gunWhineGain(1)).toBe(1);
    for (const b of BAD) {
      for (const f of [
        gunLoopRate,
        gunLoopGain,
        gunPulseHz,
        gunPulseGain,
        gunRumbleGain,
        gunWhineHz,
        gunWhineGain,
      ]) {
        expect(Number.isFinite(f(b))).toBe(true);
      }
    }
  });
});

describe('which sound an event makes', () => {
  const impact = (over: Partial<RoundImpact>): RoundImpact => ({
    type: 'roundImpact',
    t: 0,
    round: RoundType.API,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: -300, z: 600 },
    normal: { x: 0, y: 1, z: 0 },
    target: { kind: 'ground', surface: 'dirt' },
    outcome: 'ground',
    ...over,
  });

  it('impacts: armour, HEI bursts, ground, water, ricochets', () => {
    expect(impactKindOf(impact({}))).toBe('ground');
    expect(
      impactKindOf(
        impact({ target: { kind: 'vehicle', vehicleId: 1, part: 'hull' }, outcome: 'stopped' }),
      ),
    ).toBe('armour');
    expect(impactKindOf(impact({ round: RoundType.HEI }))).toBe('hei');
    expect(
      impactKindOf(
        impact({
          round: RoundType.HEI,
          target: { kind: 'vehicle', vehicleId: 1, part: 'hull' },
          outcome: 'burst',
        }),
      ),
    ).toBe('hei');
    expect(impactKindOf(impact({ outcome: 'skip' }))).toBe('ricochet');
    expect(
      impactKindOf(
        impact({ target: { kind: 'vehicle', vehicleId: 2, part: 'turret' }, outcome: 'ricochet' }),
      ),
    ).toBe('ricochet');
    expect(
      impactKindOf(impact({ target: { kind: 'ground', surface: 'water' }, outcome: 'water' })),
    ).toBe('water');
    expect(
      impactKindOf(impact({ round: RoundType.HEI, target: { kind: 'ground', surface: 'water' } })),
    ).toBe('water');
  });

  it('detonations: sized by warhead; HEI shells and duds make no blast', () => {
    const det = (kind: Detonation['kind'], charge: number): Detonation => ({
      type: 'detonation',
      t: 0,
      position: { x: 0, y: 0, z: 0 },
      charge,
      kind,
      vehicleId: -1,
      surface: 'grass',
    });
    expect(blastOf(det('hei', 0.05))).toBeNull();
    expect(blastOf(det('dud', 87))).toBeNull();
    expect(blastOf(det('rocket', 4))).toEqual({ size: 'medium', scale: 1 });
    expect(blastOf(det('bomb', 80))?.size).toBe('large');
    expect(blastOf(det('missile', 57))?.size).toBe('large');
    expect(blastOf(det('secondary', 150))).toEqual({ size: 'huge', scale: 1 });
    // bigger charge, bigger blast, within bounds
    expect(blastOf(det('bomb', 200))!.scale).toBeGreaterThan(blastOf(det('bomb', 80))!.scale);
    expect(blastOf(det('bomb', 1e9))!.scale).toBe(1.8);
    expect(blastOf(det('bomb', NaN))!.scale).toBeGreaterThanOrEqual(0.4);
  });
});

describe('synthesised sounds', () => {
  const SR = 48000;

  /**
   * Brightness: energy of the first difference over the energy of the signal (4·sin²(πf/sr) for
   * a sine of frequency f, so it grows monotonically with frequency).
   */
  function centroid(x: Float32Array): number {
    let d = 0;
    let e = 0;
    for (let i = 1; i < x.length; i++) {
      d += (x[i] - x[i - 1]) ** 2;
      e += x[i] * x[i];
    }
    return d / e;
  }

  it('explosions: normalised, finite, and bigger ones are longer and darker', () => {
    const sizes = ['small', 'medium', 'large', 'huge'] as const;
    const blasts = sizes.map((s) => renderExplosion(SR, s, 1));
    for (const b of blasts) {
      expect(peakOf(b)).toBeCloseTo(0.9, 5);
      expect(b.every(Number.isFinite)).toBe(true);
      // no click at the end
      expect(Math.abs(b[b.length - 1])).toBeLessThan(1e-3);
    }
    nonDecreasing(blasts.map((b) => b.length));
    nonIncreasing(blasts.map(centroid));
    // deterministic
    expect(renderExplosion(SR, 'medium', 1)).toEqual(blasts[1]);
  });

  it('impacts of every kind and the supersonic crack are short, finite and normalised', () => {
    for (const kind of ['armour', 'hei', 'ground', 'water', 'ricochet'] as const) {
      const x = renderImpact(SR, kind, 1);
      expect(x.length).toBeGreaterThan(SR * 0.2);
      expect(x.length).toBeLessThan(SR * 0.6);
      expect(peakOf(x)).toBeCloseTo(0.9, 5);
      expect(x.every(Number.isFinite)).toBe(true);
    }
    // armour rings bright, ground thuds dark
    expect(centroid(renderImpact(SR, 'armour', 1))).toBeGreaterThan(
      centroid(renderImpact(SR, 'ground', 1)),
    );
    const crack = renderCrack(SR);
    expect(crack.length).toBe(Math.round(0.08 * SR));
    expect(peakOf(crack)).toBeCloseTo(0.9, 5);
  });

  it('fire crackle and rocket motor loops have no seam', () => {
    for (const x of [renderCrackle(SR, 1.5), renderMotor(SR, 1.5)]) {
      const steps: number[] = [];
      for (let i = 1; i < x.length; i++) steps.push(Math.abs(x[i] - x[i - 1]));
      steps.sort((a, b) => a - b);
      const p99 = steps[Math.floor(steps.length * 0.99)];
      expect(Math.abs(x[0] - x[x.length - 1])).toBeLessThan(p99);
      // the level near the seam matches the rest of the loop
      const w = Math.round(0.05 * SR);
      const edge = Math.hypot(rmsOf(x, 0, w), rmsOf(x, x.length - w, x.length)) / Math.SQRT2;
      expect(edge / rmsOf(x)).toBeGreaterThan(0.5);
      expect(edge / rmsOf(x)).toBeLessThan(2);
    }
    const whoosh = renderWhoosh(SR);
    expect(whoosh.every(Number.isFinite)).toBe(true);
  });

  it('the airframe response has unit energy; the pulse and growl waves are cosine series', () => {
    const ir = airframeImpulse(SR);
    let e = 0;
    for (const v of ir) e += v * v;
    expect(e).toBeCloseTo(1, 6);
    expect(Math.abs(ir[0])).toBeLessThan(1e-3);
    const pulse = pulseWaveCoefficients(96);
    expect(pulse.real.length).toBe(97);
    expect(pulse.real[0]).toBe(0);
    nonIncreasing(Array.from(pulse.real.slice(1)));
    expect(pulse.imag.every((v) => v === 0)).toBe(true);
    const growl = growlWaveCoefficients();
    expect(growl.real.length).toBe(7);
    nonIncreasing(Array.from(growl.real.slice(1)));
  });
});
