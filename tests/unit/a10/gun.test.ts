/**
 * GAU-8/A mechanics (PLAN_A10.md §6.2, §16): rate, spin-up, spin-down, belt order, fire
 * permission, exact emission times and spacing, dispersion, recoil, bursts and events.
 * The aircraft is kinematic (core/weapons/testbed.ts), so only the weapons module is measured.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../../src/a10/core/constants';
import { createSim, realismFlags } from '../../../src/a10/core/sim';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { DEG, KT } from '../../../src/a10/core/units';
import {
  clearRoundPool,
  DISPERSION_SIGMA,
  gunLineBody,
  RECOIL_IMPULSE,
  RoundType,
  roundTypeAt,
  stepGun,
} from '../../../src/a10/core/weapons';
import {
  createGunTestbed,
  runKinematic,
  stepKinematic,
} from '../../../src/a10/core/weapons/testbed';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import { GAU8 } from '../../../src/a10/data/gun';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const of = <T extends SimEvent['type']>(sim: Sim, type: T): Ev<T>[] =>
  sim.events.filter((e): e is Ev<T> => e.type === type);

/** Rounds now in the pool, oldest first: [slot, id] pairs. */
function liveRounds(sim: Sim): number[] {
  const pool = sim.projectiles.rounds;
  const slots: number[] = [];
  for (let i = 0; i < pool.capacity; i++) if (pool.alive[i]) slots.push(i);
  return slots.sort((a, b) => pool.id[a] - pool.id[b]);
}

/**
 * Hold the trigger at stage 2 for `hold` seconds from now, run on to `total` seconds, and leave
 * the trigger released.
 */
function burst(sim: Sim, hold: number, total = hold, impulse?: Vector3): void {
  const n = Math.round(hold / SIM_DT);
  let k = 0;
  runKinematic(
    sim,
    total,
    (s) => {
      s.input.trigger = k++ < n ? 2 : 0;
    },
    impulse,
  );
  sim.input.trigger = 0;
}

describe('rate of fire', () => {
  it('ramps up: 47–52 rounds in the first second, then 65 ± 1 in any full-rate second', () => {
    const sim = createGunTestbed({ altitude: 3000 });
    const fired: number[] = [];
    runKinematic(sim, 6, (s) => {
      fired.push(s.gun.totalFired);
      s.input.trigger = 2;
    });
    fired.push(sim.gun.totalFired);
    const perStep = Math.round(1 / SIM_DT);
    const firstSecond = fired[perStep];
    expect(firstSecond).toBeGreaterThanOrEqual(47);
    expect(firstSecond).toBeLessThanOrEqual(52);
    // Every one-second window that starts after the spin-up.
    const start = Math.ceil(GAU8.spinUpTime / SIM_DT);
    for (let i = start; i + perStep < fired.length; i++) {
      const n = fired[i + perStep] - fired[i];
      expect(Math.abs(n - 65)).toBeLessThanOrEqual(1);
    }
    expect(sim.gun.rate).toBeCloseTo(GAU8.rate, 9);
    expect(sim.gun.spin).toBe(1);
  });

  it('a full load of 1,150 rounds is gone in 17.5–18.5 s', () => {
    const sim = createGunTestbed({ altitude: 30000, groundHeight: -1000 });
    expect(sim.gun.rounds).toBe(1150);
    runKinematic(sim, 20, (s) => {
      s.input.trigger = 2;
      clearRoundPool(s.projectiles.rounds);
    });
    expect(sim.gun.rounds).toBe(0);
    expect(sim.gun.totalFired).toBe(1150);
    const stop = of(sim, 'gunStop');
    expect(stop).toHaveLength(1);
    expect(stop[0].rounds).toBe(1150);
    expect(stop[0].t).toBeGreaterThanOrEqual(17.5);
    expect(stop[0].t).toBeLessThanOrEqual(18.5);
    expect(sim.gun.firing).toBe(false);
  });

  it('rounds leave at their exact times: 1/65 s apart at full rate, not on step boundaries', () => {
    const sim = createGunTestbed({ altitude: 3000 });
    const times: number[] = [];
    runKinematic(sim, 1.5, (s) => {
      s.input.trigger = 2;
      for (const i of liveRounds(s)) times.push(s.projectiles.rounds.fireTime[i]);
      clearRoundPool(s.projectiles.rounds);
    });
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    // Spin-up: the gaps shrink; full rate: exactly 1/65 s.
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeLessThanOrEqual(gaps[i - 1] + 1e-12);
    const full = times.filter((t) => t > GAU8.spinUpTime + 0.01).length;
    expect(full).toBeGreaterThan(50);
    for (let i = gaps.length - full + 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeCloseTo(1 / 65, 9);
    }
    // Many rounds leave strictly inside a step.
    const inside = times.filter((t) => {
      const f = t / SIM_DT - Math.round(t / SIM_DT);
      return Math.abs(f) > 0.01;
    });
    expect(inside.length).toBeGreaterThan(times.length * 0.8);
  });

  it('spins down after release without firing, the barrels coasting to a stop', () => {
    const sim = createGunTestbed({ altitude: 3000 });
    burst(sim, 1);
    expect(sim.gun.firing).toBe(true);
    stepKinematic(sim);
    const fired = sim.gun.totalFired;
    const angle = sim.gun.barrelAngle;
    expect(sim.gun.firing).toBe(false);
    expect(sim.gun.spin).toBeGreaterThan(0.9);
    // Half-way through the spin-down: still turning at the instantaneous rate, no rounds.
    runKinematic(sim, GAU8.spinDownTime / 2);
    expect(sim.gun.totalFired).toBe(fired);
    expect(sim.gun.spin).toBeGreaterThan(0.3);
    expect(sim.gun.spin).toBeLessThan(0.7);
    expect(sim.gun.rate).toBeCloseTo(GAU8.rate * sim.gun.spin, 9);
    expect(sim.gun.barrelAngle).not.toBe(angle);
    runKinematic(sim, GAU8.spinDownTime);
    expect(sim.gun.spin).toBe(0);
    expect(sim.gun.rate).toBe(0);
    expect(sim.gun.totalFired).toBe(fired);
  });

  it('the seven barrels turn one seventh of a turn per round', () => {
    const sim = createGunTestbed({ altitude: 3000 });
    sim.gun.phase = 0;
    const before = sim.gun.barrelAngle;
    // 0.5 s at full rate from a running start.
    sim.gun.spin = 1;
    runKinematic(sim, 7 / 65, (s) => {
      s.input.trigger = 2;
    });
    const turned = (sim.gun.barrelAngle - before + 2 * Math.PI) % (2 * Math.PI);
    // 7 rounds' worth of rotation is one full turn (back to the same angle), within a step.
    const perStep = (2 * Math.PI * GAU8.rate * SIM_DT) / GAU8.barrels;
    expect(Math.min(turned, 2 * Math.PI - turned)).toBeLessThan(perStep);
    expect(sim.gun.totalFired).toBe(7);
  });
});

describe('fire permission (docs/a10/ARCHITECTURE.md §4)', () => {
  function firedWith(setup: (sim: Sim) => void, trigger: 0 | 1 | 2 = 2): number {
    const sim = createGunTestbed({ altitude: 3000 });
    setup(sim);
    runKinematic(sim, 0.5, (s) => {
      s.input.trigger = trigger;
    });
    return sim.gun.totalFired;
  }

  it('fires only with Master Arm ARM, GUN/PAC armed and the second detent', () => {
    expect(firedWith(() => {})).toBeGreaterThan(10);
    expect(firedWith((s) => (s.avionics.masterArm = 'SAFE'))).toBe(0);
    expect(firedWith((s) => (s.avionics.masterArm = 'TRAIN'))).toBe(0);
    expect(firedWith((s) => (s.avionics.gunPac = 'SAFE'))).toBe(0);
    expect(firedWith((s) => (s.avionics.gunPac = 'GUNARM'))).toBeGreaterThan(10);
    expect(firedWith(() => {}, 1)).toBe(0);
    expect(firedWith(() => {}, 0)).toBe(0);
    expect(firedWith((s) => (s.aircraft.crashed = true))).toBe(0);
    expect(firedWith((s) => (s.gun.rounds = 0))).toBe(0);
  });

  it('a one-stage trigger fires on the first detent (relaxed preset)', () => {
    const sim = createGunTestbed({ altitude: 3000, realism: 'relaxed' });
    expect(sim.options.realism.twoStageTrigger).toBe(false);
    runKinematic(sim, 0.5, (s) => {
      s.input.trigger = 1;
    });
    expect(sim.gun.totalFired).toBeGreaterThan(10);
    // Unlimited ammunition: the counter does not run down.
    expect(sim.gun.rounds).toBe(GAU8.typicalLoad);
  });

  it('stops at the last round and ends the burst', () => {
    const sim = createGunTestbed({ altitude: 3000 });
    sim.gun.rounds = 20;
    runKinematic(sim, 1.5, (s) => {
      s.input.trigger = 2;
    });
    expect(sim.gun.rounds).toBe(0);
    expect(sim.gun.totalFired).toBe(20);
    expect(sim.gun.firing).toBe(false);
    expect(of(sim, 'gunStop')[0].rounds).toBe(20);
  });
});

describe('belt', () => {
  it('combat mix is five API to one HEI; the other loads are uniform', () => {
    const seq = Array.from({ length: 12 }, (_, n) => roundTypeAt('combatMix', n));
    const A = RoundType.API;
    const H = RoundType.HEI;
    expect(seq).toEqual([A, A, A, A, A, H, A, A, A, A, A, H]);
    expect(roundTypeAt('allHEI', 3)).toBe(H);
    expect(roundTypeAt('allAPI', 5)).toBe(A);
    expect(roundTypeAt('targetPractice', 0)).toBe(RoundType.TP);
  });

  it('rounds leave in belt order, each keeping its type', () => {
    for (const load of ['combatMix', 'allHEI', 'targetPractice'] as const) {
      const sim = createGunTestbed({ altitude: 3000, load });
      const types: number[] = [];
      runKinematic(sim, 1, (s) => {
        s.input.trigger = 2;
        for (const i of liveRounds(s)) types.push(s.projectiles.rounds.type[i]);
        clearRoundPool(s.projectiles.rounds);
      });
      expect(types.length).toBeGreaterThan(40);
      types.forEach((t, n) => expect(t).toBe(roundTypeAt(load, n)));
    }
  });

  it('the SimOptions ammunition load reaches the gun', () => {
    const sim = createSim({ terrain: createFlatTerrain(0), scenario: 'empty', ammoLoad: 'allAPI' });
    expect(sim.gun.load).toBe('allAPI');
    expect(sim.gun.rounds).toBe(1150);
  });
});

describe('events and burst records', () => {
  it('gunStart and gunStop carry the exact times of the first and last rounds', () => {
    const sim = createGunTestbed({ altitude: 3000 });
    const times: number[] = [];
    burst(sim, 0.6, 1.5);
    // Re-run identically, recording the fire times.
    const twin = createGunTestbed({ altitude: 3000 });
    const n = Math.round(0.6 / SIM_DT);
    let k = 0;
    runKinematic(twin, 1.5, (s) => {
      s.input.trigger = k++ < n ? 2 : 0;
      for (const i of liveRounds(s)) times.push(s.projectiles.rounds.fireTime[i]);
      clearRoundPool(s.projectiles.rounds);
    });
    const start = of(sim, 'gunStart');
    const stop = of(sim, 'gunStop');
    expect(start).toHaveLength(1);
    expect(stop).toHaveLength(1);
    expect(start[0].t).toBe(times[0]);
    expect(stop[0].t).toBe(times[times.length - 1]);
    expect(stop[0].rounds).toBe(times.length);
    expect(stop[0].duration).toBeCloseTo(times[times.length - 1] - times[0], 12);
    // gunStart comes before the first round of the burst lands.
    expect(sim.events.indexOf(start[0])).toBe(0);
  });

  it('a press too short for the barrels to reach a firing position fires nothing and logs no burst', () => {
    const sim = createGunTestbed({ altitude: 3000 });
    burst(sim, 0.05, 1);
    expect(sim.gun.totalFired).toBe(0);
    expect(of(sim, 'gunStart')).toHaveLength(0);
    expect(sim.debrief.bursts).toHaveLength(0);
  });

  it('each burst appends a BurstRecord with its conditions, rounds and trigger time', () => {
    const sim = createGunTestbed({ altitude: 1500, speed: 300 * KT, pathAngle: -30 * DEG });
    burst(sim, 1, 1.5);
    burst(sim, 0.5, 1);
    const records = sim.debrief.bursts;
    expect(records).toHaveLength(2);
    const [a, b] = records;
    expect(a.burst).toBe(1);
    expect(b.burst).toBe(2);
    expect(a.rounds + b.rounds).toBe(sim.gun.totalFired);
    expect(a.duration).toBeCloseTo(1, 6);
    expect(b.duration).toBeCloseTo(0.5, 6);
    expect(a.start.dive / DEG).toBeCloseTo(30, 6);
    expect(a.start.speed).toBeCloseTo(300 * KT, 6);
    expect(a.start.time).toBe(of(sim, 'gunStart')[0].t);
    expect(a.hits).toBe(0);
  });
});

describe('dispersion and geometry', () => {
  it('10,000 rounds from a fixed mount: 80 ± 1.5 % inside the 5 mrad circle', () => {
    const sim = createGunTestbed({ altitude: 30000, groundHeight: -1000 });
    sim.options.realism.unlimitedAmmo = true;
    const ac = sim.aircraft;
    const line = gunLineBody(new Vector3()).applyQuaternion(ac.orientation);
    const pool = sim.projectiles.rounds;
    const v = new Vector3();
    let n = 0;
    let inside = 0;
    let sumSq = 0;
    sim.input.trigger = 2;
    while (n < 10000) {
      stepGun(sim, SIM_DT);
      sim.time += SIM_DT;
      for (const i of liveRounds(sim)) {
        if (n === 10000) break;
        v.set(pool.vx[i], pool.vy[i], pool.vz[i]);
        const angle = v.angleTo(line);
        if (angle < GAU8.dispersion80Diameter / 2) inside++;
        sumSq += angle * angle;
        n++;
      }
      clearRoundPool(pool);
      ac.externalForceBody.set(0, 0, 0);
      ac.externalMomentBody.set(0, 0, 0);
    }
    const fraction = inside / n;
    expect(Math.abs(fraction - 0.8)).toBeLessThan(0.015);
    // Circular normal: mean square angle = 2σ².
    expect(Math.sqrt(sumSq / n / 2) / DISPERSION_SIGMA).toBeCloseTo(1, 1);
    expect(DISPERSION_SIGMA * 1000).toBeCloseTo(2.5 / Math.sqrt(2 * Math.log(5)), 9);
  });

  it('rounds start at the muzzle with muzzle velocity along the gun line plus the aircraft velocity', () => {
    const sim = createGunTestbed({ altitude: 2000, speed: 150, heading: 1, pathAngle: -0.2 });
    sim.gun.dispersionScale = 0;
    sim.gun.spin = 1;
    sim.gun.phase = 0.999;
    sim.input.trigger = 2;
    // The flight step's part: the aircraft moves on; then only the gun steps, so the new round
    // is still where it left the muzzle.
    sim.aircraft.prevPosition.copy(sim.aircraft.position);
    sim.aircraft.position.addScaledVector(sim.aircraft.velocity, SIM_DT);
    stepGun(sim, SIM_DT);
    const pool = sim.projectiles.rounds;
    const i = liveRounds(sim)[0];
    const f = (pool.fireTime[i] - sim.time) / SIM_DT;
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(0.01);
    const ac = sim.aircraft;
    const m = A10_GEOMETRY.muzzle;
    const expectedPos = new Vector3(m.x, m.y, m.z)
      .applyQuaternion(ac.orientation)
      .add(ac.prevPosition)
      .addScaledVector(ac.velocity, f * SIM_DT);
    expect(pool.px[i]).toBeCloseTo(expectedPos.x, 6);
    expect(pool.py[i]).toBeCloseTo(expectedPos.y, 6);
    expect(pool.pz[i]).toBeCloseTo(expectedPos.z, 6);
    const expectedVel = gunLineBody(new Vector3())
      .multiplyScalar(GAU8.muzzleVelocity)
      .applyQuaternion(ac.orientation)
      .add(ac.velocity);
    expect(pool.vx[i]).toBeCloseTo(expectedVel.x, 6);
    expect(pool.vy[i]).toBeCloseTo(expectedVel.y, 6);
    expect(pool.vz[i]).toBeCloseTo(expectedVel.z, 6);
    expect(pool.type[i]).toBe(RoundType.API);
  });

  it('a rolling aircraft adds ω × r at the muzzle', () => {
    const make = (roll: number) => {
      const sim = createGunTestbed({ altitude: 2000, speed: 150 });
      sim.gun.dispersionScale = 0;
      sim.gun.spin = 1;
      sim.gun.phase = 0.999;
      sim.input.trigger = 2;
      sim.aircraft.angularVelocity.set(0, 0, roll);
      stepGun(sim, SIM_DT);
      const pool = sim.projectiles.rounds;
      const i = liveRounds(sim)[0];
      return new Vector3(pool.vx[i], pool.vy[i], pool.vz[i]);
    };
    const still = make(0);
    // ω.z = 1 rad/s: rolling left about the body origin. The muzzle, below the roll axis, swings
    // to the right (body +X, which is east on a northbound heading) at ω·|y|.
    const rolling = make(1);
    const r = A10_GEOMETRY.muzzle;
    expect(rolling.x - still.x).toBeCloseTo(-r.y, 6);
  });
});

describe('exact emission spacing on the ground (PLAN §6.2, §16)', () => {
  it('a steady 300 kn aircraft lays its rounds 2.4 m apart along its track', () => {
    // Level at 300 m, nose 15° down: every round flies the same path relative to the aircraft
    // (all API: an HEI round's higher muzzle velocity and drag land it elsewhere).
    const speed = 300 * KT;
    const sim = createGunTestbed({ altitude: 300, speed, pitch: -15 * DEG, load: 'allAPI' });
    sim.gun.dispersionScale = 0;
    burst(sim, 1.5, 3.5);
    const impacts = of(sim, 'roundImpact')
      .filter((e) => e.target.kind === 'ground')
      .sort((a, b) => a.t - b.t);
    expect(impacts.length).toBe(sim.gun.totalFired);
    const fullRate = impacts.filter((e) => e.t - impacts[0].t > GAU8.spinUpTime + 0.05);
    expect(fullRate.length).toBeGreaterThan(40);
    const spacing = speed / GAU8.rate;
    expect(spacing).toBeCloseTo(2.374, 3);
    for (let i = 1; i < fullRate.length; i++) {
      const d = fullRate[i - 1].position.z - fullRate[i].position.z;
      expect(Math.abs(d - spacing) / spacing).toBeLessThan(0.1);
    }
    const mean =
      (fullRate[0].position.z - fullRate[fullRate.length - 1].position.z) / (fullRate.length - 1);
    expect(Math.abs(mean - spacing) / spacing).toBeLessThan(0.01);
    // All on the track line (x = 0).
    for (const e of fullRate) expect(Math.abs(e.position.x)).toBeLessThan(1e-6);
  });
});

describe('recoil (PLAN §6.2, §16)', () => {
  it('a 2 s burst delivers the impulse that slows an 18,000 kg aircraft by 3.8–4.8 m/s', () => {
    const sim = createGunTestbed({ altitude: 3000, speed: 300 * KT });
    const impulse = new Vector3();
    burst(sim, 2, 3, impulse);
    const dv = impulse.length() / 18000;
    expect(dv).toBeGreaterThanOrEqual(3.8);
    expect(dv).toBeLessThanOrEqual(4.8);
    // The impulse is the rounds' impulses: one per round, within one round.
    expect(Math.abs(impulse.length() - sim.gun.totalFired * RECOIL_IMPULSE)).toBeLessThan(
      RECOIL_IMPULSE,
    );
    // Along the gun line, toward the tail.
    const back = gunLineBody(new Vector3()).negate();
    expect(impulse.clone().normalize().dot(back)).toBeCloseTo(1, 9);
  });

  it('averages 44.5 kN at full rate, proportional to the rate, and pitches the nose down', () => {
    const sim = createGunTestbed({ altitude: 3000 });
    sim.input.trigger = 2;
    const forces: number[] = [];
    const rates: number[] = [];
    let moment = new Vector3();
    for (let i = 0; i < 120; i++) {
      stepGun(sim, SIM_DT);
      forces.push(sim.gun.recoil);
      rates.push(sim.gun.rate);
      moment = sim.aircraft.externalMomentBody.clone();
      sim.aircraft.externalForceBody.set(0, 0, 0);
      sim.aircraft.externalMomentBody.set(0, 0, 0);
      sim.time += SIM_DT;
      clearRoundPool(sim.projectiles.rounds);
    }
    const last = forces[forces.length - 1];
    expect(last).toBeCloseTo(GAU8.recoilForce, 3);
    expect(last).toBeCloseTo(44482, -1);
    // During the spin-up the force follows the rate (step averages of a linear ramp).
    for (let i = 5; i < 50; i++) {
      const mid = (rates[i] + (rates[i - 1] ?? 0)) / 2;
      expect(forces[i]).toBeCloseTo((GAU8.recoilForce * mid) / GAU8.rate, 0);
    }
    // The gun line passes below the centre of gravity: a nose-down moment, no yaw or roll.
    expect(moment.x).toBeLessThan(-0.2 * last);
    expect(Math.abs(moment.y)).toBeLessThan(1e-6 * last);
    expect(Math.abs(moment.z)).toBeLessThan(1e-6 * last);
  });
});

describe('determinism', () => {
  it('the same seed gives identical rounds and impacts; another seed does not', () => {
    const run = (seed: number) => {
      const sim = createGunTestbed({ seed, altitude: 500, speed: 300 * KT, pitch: -20 * DEG });
      burst(sim, 1, 3);
      return JSON.stringify(of(sim, 'roundImpact'));
    };
    const a = run(7);
    expect(a.length).toBeGreaterThan(1000);
    expect(run(7)).toBe(a);
    expect(run(8)).not.toBe(a);
  });

  it('realism flags are honoured per sim (no shared state)', () => {
    const a = realismFlags('authentic');
    const b = realismFlags('relaxed');
    expect(a.unlimitedAmmo).toBe(false);
    expect(b.unlimitedAmmo).toBe(true);
  });
});
