/**
 * Flight-model acceptance (PLAN_A10.md §5 and §16 "Flight"): the model is FLOWN (flight module
 * stepped alone over flat ground, core/flight/testbed.ts) by simple test pilots, and the measured
 * numbers are checked against the public figures in data/aircraft.ts. Every measurement is
 * printed (the flight report's measurements table comes from this output).
 */
import { describe, expect, it } from 'vitest';
import { A10, A10_AERO, TF34 } from '../../../src/a10/data/aircraft';
import { G0, SIM_DT } from '../../../src/a10/core/constants';
import { pitchRate, rollRate } from '../../../src/a10/core/frames';
import {
  createEngineState,
  maxThrust,
  settleEngine,
  stepEngine,
} from '../../../src/a10/core/flight/engine';
import { createTestbed, runFlightOnly, stepFlightOnly } from '../../../src/a10/core/flight/testbed';
import { trimAircraft } from '../../../src/a10/core/flight';
import { qSchedule } from '../../../src/a10/core/flight/util';
import type { Sim } from '../../../src/a10/core/types';

/** Generous timeout for flights of a minute or more (the CI machine may be loaded). */
const LONG = 60_000;
const KT = 0.514444;
const DEG = Math.PI / 180;
const FPM = 0.3048 / 60;

function report(name: string, value: string): void {
  console.log(`[flight] ${name}: ${value}`);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Test pilot: flight-path command → pitch-attitude command → stick (gains ∝ 1/q̄). */
function pathPilot(gammaCmd: (sim: Sim) => number) {
  let thetaRef = NaN;
  let integ = 0;
  return (sim: Sim) => {
    const ac = sim.aircraft;
    if (Number.isNaN(thetaRef)) thetaRef = ac.pitch;
    const k = qSchedule(ac.dynamicPressure);
    const eg = gammaCmd(sim) - ac.flightPathAngle;
    thetaRef += 0.5 * eg * SIM_DT;
    const et = thetaRef + eg - ac.pitch;
    integ = clamp(integ + 0.6 * k * et * SIM_DT, -1, 1);
    sim.input.pitch = clamp(integ + k * (2.0 * et - 0.6 * pitchRate(ac.angularVelocity)), -1, 1);
  };
}

const holdAltitude = (h: number) =>
  pathPilot((s) => clamp(0.01 * (h - s.aircraft.altitude), -0.05, 0.05));

/**
 * Test pilot: load-factor command. Stick = trim stick + (n − n0)/k_e, with k_e the static g per
 * unit stick from the elevator power, plus an integrator on the g error.
 */
function gPilot(nCmd: (sim: Sim) => number) {
  let base = NaN;
  let n0 = 0;
  let integ = 0;
  return (sim: Sim) => {
    const ac = sim.aircraft;
    if (Number.isNaN(base)) {
      base = sim.input.pitch;
      n0 = ac.gLoad;
    }
    const ke =
      ((A10_AERO.cmElevator * A10_AERO.elevatorMax) / -A10_AERO.cmAlpha) *
      A10_AERO.clAlpha *
      ((ac.dynamicPressure * A10.wingArea) / (ac.mass * G0));
    const n = nCmd(sim);
    integ += 1.5 * (n - ac.gLoad) * SIM_DT;
    sim.input.pitch = clamp(base + (n - n0 + integ) / ke, -1, 1);
  };
}

/** Test pilot: bank hold with the ailerons. */
function bankPilot(bankCmd: (sim: Sim) => number) {
  let integ = 0;
  return (sim: Sim) => {
    const ac = sim.aircraft;
    const k = qSchedule(ac.dynamicPressure);
    const e = bankCmd(sim) - ac.bank;
    integ = clamp(integ + 0.3 * k * e * SIM_DT, -0.5, 0.5);
    sim.input.roll = clamp(integ + k * (1.5 * e - 0.3 * rollRate(ac.angularVelocity)), -1, 1);
  };
}

describe('flight model: PLAN §5 checks', () => {
  it(
    'maximum level speed, clean, sea level: 381 kn ± 3 %',
    () => {
      const sim = createTestbed({ altitude: 0, ias: 370 * KT, throttle: 1 });
      runFlightOnly(sim, 240, holdAltitude(0));
      const ac = sim.aircraft;
      const kn = ac.ias / KT;
      report(
        'max level speed SL (60 % fuel, full ammo, clean)',
        `${kn.toFixed(1)} kn at ${ac.mass.toFixed(0)} kg`,
      );
      expect(Math.abs(ac.altitude)).toBeLessThan(10);
      expect(Math.abs(kn - A10.maxLevelSpeed / KT) / (A10.maxLevelSpeed / KT)).toBeLessThan(0.03);
    },
    LONG,
  );

  it(
    'stall speed, clean, 13,600 kg, 1 g: 120 kn ± 5 %, with the stall tones first',
    () => {
      // Idle, altitude held with the stick until the wing lets go (FAR 25.103 reference stall
      // speed: V_SR = V(CLmax) / √n at the lift peak of a slow deceleration).
      const sim = createTestbed({
        altitude: 3000,
        ias: 145 * KT,
        mass: A10.stallReferenceMass,
        rounds: 0,
        throttle: 0,
      });
      const pilot = holdAltitude(3000);
      let clPeak = 0;
      let vPeak = 0;
      let nPeak = 1;
      let broken = false;
      let steadyAt = -1;
      let choppedAt = -1;
      let bankAfter = 0;
      let breakTime = -1;
      runFlightOnly(sim, 40, (s) => {
        pilot(s);
        const ac = s.aircraft;
        if (steadyAt < 0 && ac.warnings.stall) steadyAt = ac.ias;
        if (choppedAt < 0 && ac.warnings.stallChopped) choppedAt = ac.ias;
        if (!broken && ac.liftCoefficient > clPeak) {
          clPeak = ac.liftCoefficient;
          vPeak = ac.ias;
          nPeak = ac.gLoad;
        }
        if (!broken && ac.fcs.flowAttachment < 0.3) {
          broken = true;
          breakTime = s.time;
        }
        if (broken && s.time < breakTime + 3) bankAfter = Math.max(bankAfter, Math.abs(ac.bank));
      });
      const vs = vPeak / Math.sqrt(nPeak) / KT;
      report(
        'stall speed 1 g (13,600 kg, clean)',
        `${vs.toFixed(1)} kn IAS (CLmax ${clPeak.toFixed(3)})`,
      );
      report(
        'stall tones',
        `steady from ${(steadyAt / KT).toFixed(1)} kn, chopped from ${(choppedAt / KT).toFixed(1)} kn`,
      );
      report(
        'wing drop within 3 s of the break (stick held aft, no aileron)',
        `${(bankAfter / DEG).toFixed(0)}°`,
      );
      expect(broken).toBe(true);
      expect(Math.abs(vs - 120) / 120).toBeLessThan(0.05);
      // The steady tone sounds well before the stall, the chopped tone before or at it.
      expect(steadyAt / KT).toBeGreaterThan(vs + 5);
      expect(choppedAt / KT).toBeGreaterThan(vs - 1);
      // Docile: a wing drop, not a snap roll.
      expect(bankAfter).toBeLessThan(45 * DEG);
    },
    LONG,
  );

  it(
    'initial climb rate, clean, MAX thrust, best climb speed: ≈6,000 ft/min ± 10 %',
    () => {
      let best = 0;
      let bestKias = 0;
      for (const kias of [160, 180, 200, 220, 240, 260]) {
        const sim = createTestbed({ altitude: -300, ias: kias * KT, throttle: 1 });
        // Start in the steady climb at full thrust (iterate the trim on the path acceleration).
        let gamma = 0;
        for (let i = 0; i < 8; i++)
          gamma += Math.asin(clamp(trimAircraft(sim, gamma).alongPath / G0, -0.5, 0.5));
        trimAircraft(sim, gamma);
        let gCmd = gamma;
        let integ = 0;
        const pilot = pathPilot(() => gCmd);
        let sum = 0;
        let n = 0;
        runFlightOnly(sim, 30, (s) => {
          const ac = s.aircraft;
          const e = (ac.ias - kias * KT) / KT;
          integ += 0.0005 * e * SIM_DT;
          gCmd = gamma + clamp(0.003 * e + integ, -0.2, 0.2);
          pilot(s);
          if (ac.altitude > -100 && ac.altitude < 100) {
            sum += ac.verticalSpeed;
            n++;
          }
        });
        const roc = sum / n / FPM;
        report(`climb at ${kias} kn`, `${roc.toFixed(0)} ft/min`);
        if (roc > best) {
          best = roc;
          bestKias = kias;
        }
      }
      report('initial climb rate (best)', `${best.toFixed(0)} ft/min at ${bestKias} kn`);
      expect(Math.abs(best - 6000) / 6000).toBeLessThan(0.1);
    },
    LONG,
  );

  it(
    'full aft stick at 300 kn pulls past +7.33 g and the over-g warning sounds',
    () => {
      const run = (mass?: number) => {
        const sim = createTestbed({ altitude: 0, ias: 300 * KT, mass });
        let peak = 0;
        let warned = false;
        runFlightOnly(sim, 3, (s) => {
          s.input.pitch = s.time > 0.1 ? 1 : 0;
          peak = Math.max(peak, s.aircraft.gLoad);
          warned ||= s.aircraft.warnings.overG;
        });
        return { peak, warned, mass: sim.aircraft.mass };
      };
      const light = run(A10.stallReferenceMass);
      const reference = run();
      report('peak g, full aft stick at 300 kn SL, 13,600 kg', light.peak.toFixed(2));
      report(
        `peak g, full aft stick at 300 kn SL, ${reference.mass.toFixed(0)} kg`,
        reference.peak.toFixed(2),
      );
      expect(light.peak).toBeGreaterThan(A10.gLimitPositive);
      expect(light.warned).toBe(true);
      expect(reference.peak).toBeGreaterThan(6.5);
    },
    LONG,
  );

  it(
    'Vne 450 kn: overspeed warning and buffet above it, none below',
    () => {
      const above = createTestbed({ altitude: 1000, ias: 460 * KT, throttle: 1 });
      runFlightOnly(above, 1, holdAltitude(1000));
      const below = createTestbed({ altitude: 1000, ias: 440 * KT, throttle: 1 });
      runFlightOnly(below, 1, holdAltitude(1000));
      report(
        'at 460 kn',
        `overspeed ${above.aircraft.warnings.overspeed}, buffet ${above.aircraft.buffet.toFixed(2)}`,
      );
      expect(above.aircraft.warnings.overspeed).toBe(true);
      expect(above.aircraft.buffet).toBeGreaterThan(0);
      expect(below.aircraft.warnings.overspeed).toBe(false);
      expect(below.aircraft.buffet).toBe(0);
    },
    LONG,
  );

  it(
    'engines: 2 × 40.3 kN static; idle → 95 % thrust in 4–8 s, quicker from mid-range',
    () => {
      const sl = { mach: 0, delta: 1, theta: 1, temperature: 288.15 };
      const t0 = maxThrust(sl);
      report('static thrust per engine (SL, MAX)', `${(t0 / 1000).toFixed(2)} kN`);
      expect(t0).toBeCloseTo(TF34.staticThrust, 0);
      expect(Math.abs(t0 - 40300) / 40300).toBeLessThan(0.01);
      const spool = (from: number) => {
        const e = createEngineState(from);
        settleEngine(e, sl);
        e.lever = 1;
        for (let i = 1; i < 20 * 120; i++) {
          stepEngine(e, sl, SIM_DT, true);
          if (e.thrust >= 0.95 * t0) return i * SIM_DT;
        }
        return Infinity;
      };
      const fromIdle = spool(0);
      const fromMid = spool(0.6);
      report('spool idle → 95 % thrust', `${fromIdle.toFixed(2)} s`);
      report('spool 60 % lever → 95 % thrust', `${fromMid.toFixed(2)} s`);
      expect(fromIdle).toBeGreaterThan(4);
      expect(fromIdle).toBeLessThan(8);
      expect(fromMid).toBeLessThan(fromIdle / 2);
      // Thrust falls with speed and altitude (thrust lapse).
      expect(maxThrust({ mach: 0.5, delta: 1, theta: 1, temperature: 288.15 })).toBeLessThan(t0);
      expect(maxThrust({ mach: 0.5, delta: 0.69, theta: 0.931, temperature: 268.3 })).toBeLessThan(
        maxThrust({ mach: 0.5, delta: 1, theta: 1, temperature: 288.15 }),
      );
    },
    LONG,
  );

  it(
    'dive recovery: a 4 g pull-out from a 30° dive at 300 kn matches the closed form ± 15 % and, with the g onset allowed for, the plan\'s 105 m ± 10 %',
    () => {
      const v0 = 300 * KT;
      const sim = createTestbed({ altitude: 1500, tas: v0, gamma: -30 * DEG, throttle: 0 });
      const pilot = gPilot(() => 4);
      const hStart = sim.aircraft.altitude;
      const n0 = sim.aircraft.gLoad;
      let at4: { h: number; v: number; gamma: number } | null = null;
      let hMin = hStart;
      let level = false;
      // Equivalent delay of the g onset: the time the pull lags an instantaneous 4 g,
      // ∫ (1 − (n − n₀)/(4 − n₀)) dt over the pull.
      let onsetDelay = 0;
      runFlightOnly(sim, 8, (s) => {
        if (level) return;
        pilot(s);
        const ac = s.aircraft;
        onsetDelay += (1 - clamp((ac.gLoad - n0) / (4 - n0), 0, 1)) * SIM_DT;
        if (!at4 && ac.gLoad >= 4) at4 = { h: ac.altitude, v: ac.tas, gamma: ac.flightPathAngle };
        hMin = Math.min(hMin, ac.altitude);
        if (ac.flightPathAngle >= 0) level = true;
      });
      expect(level).toBe(true);
      expect(at4).not.toBeNull();
      const s4 = at4 as unknown as { h: number; v: number; gamma: number };
      // Closed form for a constant-speed, constant-n pull-out from dive angle γ:
      // Δh = V²/g · ln((n − cos γ) / (n − 1)).
      const closed = (v: number, gamma: number) =>
        ((v * v) / G0) * Math.log((4 - Math.cos(gamma)) / 3);
      const nominal = closed(v0, 30 * DEG);
      const reference = closed(s4.v, -s4.gamma);
      const measured = s4.h - hMin;
      report('dive recovery closed form (300 kn, 30°, 4 g)', `${nominal.toFixed(1)} m`);
      report(
        'dive recovery from the moment 4 g is reached',
        `${measured.toFixed(1)} m vs closed form ${reference.toFixed(1)} m (${(((measured - reference) / reference) * 100).toFixed(1)} %)`,
      );
      // The plan's ≈105 m is the closed form for 4 g reached instantly (PLAN §5). The model's pull
      // reaches 4 g after an onset; while it builds, the dive goes on at the start's sink rate.
      // Take that allowance (sink rate × the onset's equivalent delay) off the loss measured from
      // the start of the pull and compare with the plan's figure (review FC-8).
      const total = hStart - hMin;
      const onsetAllowance = v0 * Math.sin(30 * DEG) * onsetDelay;
      report(
        'dive recovery including the g onset',
        `${total.toFixed(1)} m; onset delay ${onsetDelay.toFixed(2)} s → allowance ${onsetAllowance.toFixed(1)} m; without it ${(total - onsetAllowance).toFixed(1)} m vs the plan's 105 m`,
      );
      expect(Math.abs(measured - reference) / reference).toBeLessThan(0.15);
      expect(Math.abs(total - onsetAllowance - 105) / 105).toBeLessThan(0.1);
      // The plan's figure is the closed form for these conditions.
      expect(Math.abs(nominal - 105) / 105).toBeLessThan(0.02);
    },
    LONG,
  );

  it(
    'sustained level turn at 300 kn, sea level, MAX thrust (plausible A-10 range)',
    () => {
      // Fixed bank, altitude held with the g loop, full thrust: the speed settles where thrust
      // equals drag. Bisect on bank for a settled speed of 300 kn.
      const settle = (bank: number) => {
        const sim = createTestbed({ altitude: 300, ias: 300 * KT, throttle: 1 });
        const roll = bankPilot(() => bank);
        const g = gPilot(
          (s) =>
            1 / Math.max(0.15, Math.cos(s.aircraft.bank)) +
            0.004 * (300 - s.aircraft.altitude) -
            0.04 * s.aircraft.verticalSpeed,
        );
        runFlightOnly(sim, 50, (s) => {
          roll(s);
          g(s);
        });
        return sim.aircraft;
      };
      let lo = 60 * DEG;
      let hi = 82 * DEG;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        if (settle(mid).ias > 300 * KT) lo = mid;
        else hi = mid;
      }
      const ac = settle((lo + hi) / 2);
      const rate = (G0 * Math.sqrt(Math.max(0, ac.gLoad ** 2 - 1))) / ac.tas / DEG;
      report(
        'sustained turn at 300 kn SL',
        `${rate.toFixed(1)} °/s (bank ${(ac.bank / DEG).toFixed(1)}°, ${ac.gLoad.toFixed(2)} g, ${(ac.ias / KT).toFixed(0)} kn)`,
      );
      expect(rate).toBeGreaterThan(9);
      expect(rate).toBeLessThan(17);
    },
    LONG,
  );

  it(
    'roll rate at 300 kn, full stick: ≈90–140 °/s (and faster with the speed brakes partly open)',
    () => {
      const measure = (speedBrake: number) => {
        const sim = createTestbed({ altitude: 1000, ias: 300 * KT });
        sim.aircraft.speedBrakeCmd = speedBrake;
        sim.aircraft.surfaces.speedBrake = speedBrake;
        let peak = 0;
        runFlightOnly(sim, 2.5, (s) => {
          s.input.roll = s.time > 0.1 ? 1 : 0;
          peak = Math.max(peak, rollRate(s.aircraft.angularVelocity));
        });
        return peak / DEG;
      };
      const clean = measure(0);
      const brakes40 = measure(0.4);
      report(
        'roll rate 300 kn full stick',
        `${clean.toFixed(0)} °/s; with 40 % speed brakes ${brakes40.toFixed(0)} °/s`,
      );
      expect(clean).toBeGreaterThan(90);
      expect(clean).toBeLessThan(140);
      expect(brakes40).toBeGreaterThan(clean * 1.3);
    },
    LONG,
  );

  it(
    'trimmed straight and level: holds altitude ± 30 m for 60 s hands off',
    () => {
      // Untrimmed start: the pilot holds altitude with the stick and trims the stick force out
      // with the hat, then lets go of everything.
      const sim = createTestbed({ altitude: 3000, ias: 250 * KT });
      sim.aircraft.trim.pitch = 0;
      const pilot = holdAltitude(3000);
      runFlightOnly(sim, 40, (s) => {
        pilot(s);
        s.input.trimPitch = clamp(s.input.pitch * 8, -1, 1);
      });
      sim.input.pitch = 0;
      sim.input.trimPitch = 0;
      const h0 = sim.aircraft.altitude;
      let dev = 0;
      runFlightOnly(sim, 60, (s) => {
        dev = Math.max(dev, Math.abs(s.aircraft.altitude - h0));
      });
      report(
        'hands-off 60 s after trimming (250 kn)',
        `max altitude deviation ${dev.toFixed(1)} m`,
      );
      expect(dev).toBeLessThan(30);
    },
    LONG,
  );

  it(
    'speed brakes fully open at 300 kn decelerate noticeably',
    () => {
      const sim = createTestbed({ altitude: 1000, ias: 300 * KT });
      const pilot = holdAltitude(1000);
      let open = -1;
      let vOpen = 0;
      runFlightOnly(sim, 8, (s) => {
        pilot(s);
        s.input.speedBrake = 1;
        if (open < 0 && s.aircraft.surfaces.speedBrake >= 1) {
          open = s.time;
          vOpen = s.aircraft.ias;
        }
      });
      const decel = (vOpen - sim.aircraft.ias) / KT / (sim.time - open);
      report(
        'speed brakes',
        `full open after ${open.toFixed(2)} s; ${decel.toFixed(1)} kn/s at ≈300 kn (throttle for level flight)`,
      );
      expect(open).toBeGreaterThan(2);
      expect(open).toBeLessThan(3.1);
      expect(decel).toBeGreaterThan(3);
    },
    LONG,
  );

  it(
    'recoil convention: ∓44.5 kN along the gun line for 2 s at 18,000 kg changes speed 4.4–5.4 m/s',
    () => {
      const depression = 2 * DEG;
      const run = (force: number) => {
        const sim = createTestbed({ altitude: 1000, ias: 300 * KT, mass: 18000 });
        const pilot = pathPilot(() => 0);
        runFlightOnly(sim, 2, (s) => {
          pilot(s);
          // + = aft along the (depressed) gun line: the recoil of the GAU-8.
          s.aircraft.externalForceBody.set(
            0,
            force * Math.sin(depression),
            force * Math.cos(depression),
          );
        });
        return sim.aircraft.velocity.length();
      };
      const none = run(0);
      const recoil = none - run(44500);
      const push = run(-44500) - none;
      report(
        'recoil 44.5 kN aft, 2 s, 18,000 kg',
        `−${recoil.toFixed(2)} m/s; forward: +${push.toFixed(2)} m/s`,
      );
      expect(recoil).toBeGreaterThan(4.4);
      expect(recoil).toBeLessThan(5.4);
      expect(push).toBeGreaterThan(4.4);
      expect(push).toBeLessThan(5.4);
    },
    LONG,
  );

  it(
    'is deterministic: same seed and inputs give the same state after 60 s',
    () => {
      const fly = () => {
        const sim = createTestbed({ altitude: 600, ias: 280 * KT, seed: 77, turbulence: 0.6 });
        runFlightOnly(sim, 60, (s) => {
          s.input.roll = Math.sin(s.time * 0.7) * 0.4;
          s.input.pitch = Math.sin(s.time * 0.31) * 0.2;
          s.input.rudder = Math.sin(s.time * 0.2) * 0.1;
          s.input.throttle[0] = s.input.throttle[1] = 0.8;
          s.input.trigger = s.time > 30 && s.time < 32 ? 1 : 0;
        });
        const ac = sim.aircraft;
        return [
          ...ac.position.toArray(),
          ...ac.velocity.toArray(),
          ...ac.orientation.toArray(),
          ...ac.angularVelocity.toArray(),
          ac.fuel,
        ];
      };
      const a = fly();
      const b = fly();
      expect(a).toEqual(b);
      expect(a.every(Number.isFinite)).toBe(true);
    },
    LONG,
  );

  it(
    'steps at 120 Hz without drift in a steady state (energy check)',
    () => {
      // Trimmed, level, speed held: one second of flight changes the total energy only by the
      // (tiny) residual of the trim, i.e. the integrator does not create energy.
      const sim = createTestbed({ altitude: 2000, ias: 250 * KT });
      const ac = sim.aircraft;
      const e0 = ac.velocity.lengthSq() / 2 + G0 * ac.altitude;
      for (let i = 0; i < 120; i++) stepFlightOnly(sim);
      const e1 = ac.velocity.lengthSq() / 2 + G0 * ac.altitude;
      expect(Math.abs(e1 - e0)).toBeLessThan(5);
    },
    LONG,
  );
});
