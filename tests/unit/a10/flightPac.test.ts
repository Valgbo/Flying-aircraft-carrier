/**
 * Precision Attitude Control in the whole simulation (stepSim: the real fire control, gun and
 * rounds) after transients and pilot inputs — the cases of reviews GFC-1, FC-1 and GFC-2:
 *  - squeezing while the nose is still moving (a correction just before the squeeze),
 *  - stick and pedal inputs while PAC-1 is held (walking the pipper, overriding PAC),
 *  - the keyboard procedure through the real input engine (PAC-1, one tap, fire),
 *  - the Relaxed preset's one-stage trigger.
 * PAC must settle without a limit cycle and a burst fired with PAC must be no wider than the same
 * burst fired with GUN/PAC at GUNARM (PAC off). flightControls.test.ts keeps the flight-only PAC
 * tests (turbulence, authority, recoil feed-forward).
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { pitchRate, yawRate } from '../../../src/a10/core/frames';
import { createTestbed } from '../../../src/a10/core/flight/testbed';
import { createSim, pushCommand, realismFlags, stepSim } from '../../../src/a10/core/sim';
import type { RealismPreset, Sim } from '../../../src/a10/core/types';
import { createFlatTerrain, tasFromCas } from '../../../src/a10/core/world';
import { defaultBindingsConfig } from '../../../src/a10/input/bindings';
import {
  InputEngine,
  createEngineOutput,
  type FrameContext,
  type KeyMods,
} from '../../../src/a10/input/engine';
import { writePilotInput } from '../../../src/a10/input/runtime';

const LONG = 120_000;
const KT = 0.514444;
const DEG = Math.PI / 180;
const MRAD = 1e-3;

/** Along- and across-track standard deviation of a burst's ground impacts (northbound pass). */
class Burst {
  private xs: number[] = [];
  private zs: number[] = [];
  collect(sim: Sim): void {
    for (const e of sim.events) {
      if (e.type === 'roundImpact' && e.outcome === 'ground') {
        this.xs.push(e.position.x);
        this.zs.push(e.position.z);
      }
    }
    sim.events.length = 0;
  }
  get n(): number {
    return this.zs.length;
  }
  static sd(v: number[]): number {
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
  }
  get along(): number {
    return Burst.sd(this.zs);
  }
  get across(): number {
    return Burst.sd(this.xs);
  }
}

/** A trimmed dive over flat ground with Master Arm ARM, GUNS and GUN/PAC at ARM (PAC) or GUNARM. */
function dive(o: {
  agl: number;
  kias: number;
  diveDeg: number;
  pac: boolean;
  preset?: RealismPreset;
  loadoutId?: 'gunOnly' | 'tankHunter';
}): Sim {
  const sim = createSim({
    seed: 7,
    terrain: createFlatTerrain(0),
    scenario: 'empty',
    realism: realismFlags(o.preset ?? 'authentic'),
    loadoutId: o.loadoutId ?? 'gunOnly',
    start: {
      x: 0,
      z: 0,
      agl: o.agl,
      heading: 0,
      speed: tasFromCas(o.kias * KT, o.agl),
      gamma: -o.diveDeg * DEG,
    },
  });
  sim.world.turbulence = 0;
  pushCommand(sim, { type: 'masterArm', value: 'ARM' });
  pushCommand(sim, { type: 'gunPac', value: o.pac ? 'ARM' : 'GUNARM' });
  pushCommand(sim, { type: 'masterMode', value: 'GUNS' });
  return sim;
}

/**
 * Review GFC-1: the pilot corrects (a stick pulse for 0.4 s at 1.5 km slant range), lets the stick
 * back to where it was and squeezes while the nose is still moving: PAC-1 for 1 s, then fire 2 s.
 */
function squeezeAfterCorrection(o: {
  altitude: number;
  diveDeg: number;
  throttle: number;
  pulse: number;
  pac: boolean;
}) {
  const sim = createTestbed({
    altitude: o.altitude,
    groundHeight: 0,
    tas: 300 * KT,
    gamma: -o.diveDeg * DEG,
    throttle: o.throttle,
    seed: 5,
  });
  sim.avionics.masterArm = 'ARM';
  sim.avionics.gunPac = o.pac ? 'ARM' : 'GUNARM';
  sim.avionics.masterMode = 'GUNS';
  const burst = new Burst();
  let tPulse = -1;
  let tSqueeze = -1;
  let stick = 0;
  let hold = 0;
  let integ = 0;
  let qSqueeze = 0;
  let speedKt = 0;
  let lateErr = 0;
  let qMin = Infinity;
  let qMax = -Infinity;
  for (let n = 0; n < 120 * 30; n++) {
    const ac = sim.aircraft;
    const gun = sim.avionics.gun;
    if (tPulse < 0 && n > 2 && gun.valid && gun.slantRange <= 1500) {
      tPulse = sim.time;
      hold = stick;
    }
    if (tPulse < 0) {
      // A pilot holding the dive angle.
      const e = -o.diveDeg * DEG - ac.flightPathAngle;
      integ += e / 120;
      stick = Math.max(-1, Math.min(1, 2.0 * e + 0.8 * integ - 0.6 * ac.angularVelocity.x));
    } else if (sim.time < tPulse + 0.4) {
      stick = hold + o.pulse;
    } else {
      stick = hold;
      if (tSqueeze < 0) {
        tSqueeze = sim.time;
        qSqueeze = pitchRate(ac.angularVelocity);
        speedKt = ac.tas / KT;
      }
    }
    sim.input.pitch = stick;
    const tt = tSqueeze >= 0 ? sim.time - tSqueeze : -1;
    sim.input.trigger = tt < 0 ? 0 : tt < 1 ? 1 : tt < 3 ? 2 : 0;
    stepSim(sim);
    burst.collect(sim);
    if (tt >= 2 && tt < 3) {
      lateErr = Math.max(lateErr, Math.hypot(ac.pac.errorAz, ac.pac.errorEl));
      const q = pitchRate(ac.angularVelocity);
      qMin = Math.min(qMin, q);
      qMax = Math.max(qMax, q);
    }
    if (tt > 6) break;
  }
  return { qSqueeze, speedKt, lateErr, qPeakToPeak: qMax - qMin, burst, crashed: sim.aircraft.crashed };
}

/** PAC-1 held from the start; a stick, pedal or roll pulse at 0.5 s; hands off afterwards. */
function pulseWhileHeld(o: {
  axis: 'pitch' | 'rudder' | 'roll';
  value: number;
  duration: number;
  seconds: number;
}) {
  const sim = dive({ agl: 1100, kias: 300, diveDeg: 30, pac: true });
  const end = 0.5 + o.duration;
  let maxErrLate = 0;
  let qMin = Infinity;
  let qMax = -Infinity;
  let rMax = 0;
  let pointAt = new Vector3();
  let pointEnd = new Vector3();
  for (let i = 0; i < o.seconds * 120; i++) {
    const t = sim.time;
    const on = t >= 0.5 && t < end;
    sim.input.trigger = 1;
    sim.input.pitch = o.axis === 'pitch' && on ? o.value : 0;
    sim.input.rudder = o.axis === 'rudder' && on ? o.value : 0;
    sim.input.roll = o.axis === 'roll' && on ? o.value : 0;
    stepSim(sim);
    sim.events.length = 0;
    const ac = sim.aircraft;
    if (sim.time > end + 1.5) {
      maxErrLate = Math.max(maxErrLate, Math.hypot(ac.pac.errorAz, ac.pac.errorEl));
      const q = pitchRate(ac.angularVelocity);
      qMin = Math.min(qMin, q);
      qMax = Math.max(qMax, q);
      rMax = Math.max(rMax, Math.abs(yawRate(ac.angularVelocity)));
    }
    if (Math.abs(sim.time - (end + 1.5)) < 1e-6) pointAt = sim.avionics.gun.impact.clone();
    pointEnd = sim.avionics.gun.impact.clone();
  }
  return {
    sim,
    maxErrLate,
    qPeakToPeak: qMax - qMin,
    rMax,
    // How far the pipper's ground point crept after PAC took the point.
    creep: pointEnd.distanceTo(pointAt),
  };
}

describe('PAC after a transient (whole sim, real fire control)', () => {
  it(
    'squeezing while the nose still moves (0.7–7.5°/s): settles below 1 mrad within 2 s, burst no wider than with PAC off',
    () => {
      const rows: string[] = [];
      for (const [altitude, diveDeg, throttle] of [
        [900, 30, 0.4],
        [1500, 30, 0.5],
        [2200, 45, 0.3],
      ] as const) {
        for (const pulse of [0.01, 0.05, 0.1, -0.1]) {
          const on = squeezeAfterCorrection({ altitude, diveDeg, throttle, pulse, pac: true });
          const off = squeezeAfterCorrection({ altitude, diveDeg, throttle, pulse, pac: false });
          rows.push(
            `${on.speedKt.toFixed(0)} kt ${diveDeg}° q ${(on.qSqueeze / DEG).toFixed(1)}°/s: error after 2 s ${(on.lateErr / MRAD).toFixed(2)} mrad, burst σ along ${on.burst.along.toFixed(1)} m (PAC off ${off.burst.along.toFixed(1)} m)`,
          );
          expect(on.crashed).toBe(false);
          expect(on.burst.n).toBeGreaterThan(100);
          expect(on.lateErr).toBeLessThan(1 * MRAD);
          // No limit cycle: the nose is steady in the last second of the burst.
          expect(on.qPeakToPeak).toBeLessThan(0.5 * DEG);
          expect(on.burst.along).toBeLessThanOrEqual(off.burst.along);
          expect(on.burst.across).toBeLessThanOrEqual(off.burst.across * 1.1);
        }
      }
      console.log(`[flight] PAC squeezed with a pitch rate:\n  ${rows.join('\n  ')}`);
    },
    LONG,
  );

  it(
    'stick pulses while PAC-1 is held (0.05, 0.15, an override of 0.3 and 0.4): the pipper settles within 1.5 s and stays',
    () => {
      for (const [value, duration] of [
        [0.05, 0.1],
        [0.15, 0.1],
        [0.3, 0.15],
        [0.4, 0.5],
      ] as const) {
        const r = pulseWhileHeld({ axis: 'pitch', value, duration, seconds: 6 });
        expect(r.sim.aircraft.pac.active).toBe(true);
        expect(r.sim.aircraft.pac.walking).toBe(false);
        expect(r.maxErrLate).toBeLessThan(1 * MRAD);
        expect(r.qPeakToPeak).toBeLessThan(0.5 * DEG);
        expect(r.creep).toBeLessThan(3);
      }
    },
    LONG,
  );

  it(
    'pedal and roll inputs while PAC-1 is held: no sustained yaw oscillation',
    () => {
      for (const [axis, value, duration] of [
        ['rudder', 0.15, 0.4],
        ['rudder', 0.35, 0.15],
        ['roll', 0.1, 0.3],
      ] as const) {
        const r = pulseWhileHeld({ axis, value, duration, seconds: 6 });
        expect(r.maxErrLate).toBeLessThan(1.5 * MRAD);
        expect(r.rMax).toBeLessThan(0.3 * DEG);
        expect(r.creep).toBeLessThan(4);
      }
    },
    LONG,
  );

  it(
    'a hands-off squeeze after a throttle chop in the default tank-hunter load settles (Authentic, Standard)',
    () => {
      for (const preset of ['authentic', 'standard'] as const) {
        const sim = dive({ agl: 1300, kias: 330, diveDeg: 30, pac: true, preset, loadoutId: 'tankHunter' });
        sim.input.throttle[0] = 0;
        sim.input.throttle[1] = 0;
        let late = 0;
        let qMin = Infinity;
        let qMax = -Infinity;
        for (let i = 0; i < 4.5 * 120; i++) {
          sim.input.trigger = sim.time >= 1.5 ? 1 : 0;
          stepSim(sim);
          sim.events.length = 0;
          if (sim.time > 3.5) {
            const ac = sim.aircraft;
            late = Math.max(late, Math.hypot(ac.pac.errorAz, ac.pac.errorEl));
            const q = pitchRate(ac.angularVelocity);
            qMin = Math.min(qMin, q);
            qMax = Math.max(qMax, q);
          }
        }
        expect(sim.aircraft.pac.active).toBe(true);
        expect(late).toBeLessThan(1 * MRAD);
        expect(qMax - qMin).toBeLessThan(0.3 * DEG);
      }
    },
    LONG,
  );
});

describe('walking the pipper with PAC-1 held (review GFC-2)', () => {
  /** Ground point of the pipper before a 0.5 s stick input, at its end, and 3 s later. */
  function walk(pac: boolean, stick: number, duration: number) {
    const sim = dive({ agl: 1500, kias: 350, diveDeg: 30, pac });
    let p0: Vector3 | null = null;
    let pEnd: Vector3 | null = null;
    let pLate: Vector3 | null = null;
    let qMin = Infinity;
    let qMax = -Infinity;
    for (let i = 0; i < (duration + 5) * 120; i++) {
      const t = sim.time;
      sim.input.trigger = 1;
      sim.input.pitch = t >= 1 && t < 1 + duration ? stick : 0;
      stepSim(sim);
      sim.events.length = 0;
      const g = sim.avionics.gun.impact;
      if (!p0 && sim.time >= 1) p0 = g.clone();
      if (!pEnd && sim.time >= 1 + duration) pEnd = g.clone();
      if (sim.time >= 2 + duration && !pLate) pLate = g.clone();
      if (sim.time > 2.5 + duration) {
        const q = pitchRate(sim.aircraft.angularVelocity);
        qMin = Math.min(qMin, q);
        qMax = Math.max(qMax, q);
      }
    }
    const pFinal = sim.avionics.gun.impact;
    return {
      moved: pEnd!.distanceTo(p0!),
      creep: pFinal.distanceTo(pLate!),
      runOn: pFinal.distanceTo(pEnd!),
      qPeakToPeak: qMax - qMin,
    };
  }

  it(
    'a small stick input moves the held point at least half as far as without PAC; PAC then holds the new point',
    () => {
      const rows: string[] = [];
      for (const [stick, duration] of [
        [0.03, 0.5],
        [0.1, 0.5],
        [0.1, 0.08],
      ] as const) {
        const on = walk(true, stick, duration);
        const off = walk(false, stick, duration);
        rows.push(
          `stick ${stick} for ${duration} s: PAC ${on.moved.toFixed(1)} m then ${on.creep.toFixed(1)} m in 4 s; PAC off ${off.moved.toFixed(1)} m, running on ${off.runOn.toFixed(0)} m`,
        );
        expect(on.moved).toBeGreaterThan(0.5 * off.moved);
        // Then it holds where the pilot left it, without oscillation, while without PAC the
        // pipper keeps running.
        expect(on.creep).toBeLessThan(3);
        expect(on.qPeakToPeak).toBeLessThan(0.3 * DEG);
        expect(off.runOn).toBeGreaterThan(5 * on.creep + 20);
      }
      console.log(`[flight] walking the pipper, 30° dive at 350 KIAS:\n  ${rows.join('\n  ')}`);
    },
    LONG,
  );
});

describe('PAC through the real input engine and in the Relaxed preset (review FC-1)', () => {
  const SHIFT: KeyMods = { ctrl: false, alt: false, shift: true, meta: false };

  /**
   * The keyboard procedure at 60 fps: Left Shift (PAC-1) from 0 s, one ArrowDown tap at 0.5 s to
   * walk the pipper, Space (fire) from 1.5 s to 3.5 s. Returns the burst.
   */
  function keyboardPass(pac: boolean, tapMs: number): { burst: Burst; minG: number; maxG: number } {
    const sim = dive({ agl: 1200, kias: 300, diveDeg: 30, pac });
    const engine = new InputEngine(defaultBindingsConfig());
    const out = createEngineOutput();
    engine.resetLevers(sim.input.throttle);
    engine.setGate({ live: true, app: true });
    const ctx: FrameContext = {
      dt: 1 / 60,
      gate: { live: true, app: true },
      pads: [],
      twoStageTrigger: true,
      mouseStick: false,
      invertLook: false,
      speedBrakePosition: 0,
    };
    const burst = new Burst();
    let minG = Infinity;
    let maxG = -Infinity;
    engine.keyDown('ShiftLeft', SHIFT);
    const tapFrames = Math.round((tapMs / 1000) * 60);
    for (let f = 0; f < 7 * 60; f++) {
      if (tapFrames > 0 && f === 30) engine.keyDown('ArrowDown', SHIFT);
      if (tapFrames > 0 && f === 30 + tapFrames) engine.keyUp('ArrowDown');
      if (f === 90) engine.keyDown('Space', SHIFT);
      if (f === 210) {
        engine.keyUp('Space');
        engine.keyUp('ShiftLeft');
      }
      engine.update(ctx, out);
      writePilotInput(out, sim.input);
      for (let k = 0; k < 2; k++) {
        stepSim(sim);
        if (sim.gun.firing) {
          minG = Math.min(minG, sim.aircraft.gLoad);
          maxG = Math.max(maxG, sim.aircraft.gLoad);
        }
        burst.collect(sim);
      }
    }
    return { burst, minG, maxG };
  }

  it(
    'PAC-1, a 50 or 80 ms tap to walk the pipper, then a 2 s burst: no wider than without PAC',
    () => {
      const off = keyboardPass(false, 80);
      for (const tap of [50, 80]) {
        const on = keyboardPass(true, tap);
        console.log(
          `[flight] keyboard pass, ${tap} ms tap: σ along ${on.burst.along.toFixed(1)} m with PAC (g ${on.minG.toFixed(2)}..${on.maxG.toFixed(2)}), ${off.burst.along.toFixed(1)} m with GUN/PAC at GUNARM`,
        );
        expect(on.burst.n).toBeGreaterThan(100);
        expect(on.burst.along).toBeLessThanOrEqual(off.burst.along);
        // No porpoising while firing.
        expect(on.maxG - on.minG).toBeLessThan(0.4);
      }
    },
    LONG,
  );

  it(
    'Relaxed one-stage trigger: a correction during a 3 s burst sprays no wider than without PAC',
    () => {
      const burst = (pac: boolean) => {
        const sim = dive({ agl: 1300, kias: 300, diveDeg: 30, pac, preset: 'relaxed' });
        const b = new Burst();
        for (let i = 0; i < 7 * 120; i++) {
          const t = sim.time;
          sim.input.trigger = t >= 0.3 && t < 3.3 ? 2 : 0;
          sim.input.pitch = t >= 0.6 && t < 0.7 ? 0.05 : 0;
          stepSim(sim);
          b.collect(sim);
        }
        return b;
      };
      const on = burst(true);
      const off = burst(false);
      expect(on.n).toBeGreaterThan(150);
      expect(on.along).toBeLessThanOrEqual(off.along);
    },
    LONG,
  );
});
