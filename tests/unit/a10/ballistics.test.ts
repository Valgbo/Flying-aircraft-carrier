/**
 * 30 mm ballistics and penetration (PLAN_A10.md §6.2, §6.3, §16; docs/a10/ARCHITECTURE.md §5):
 * the integrator against the closed-form parabola, the frozen trajectory table, Mach-dependent
 * drag, wind and air density, the predictor against live rounds, and the penetration fit
 * recomputed from the model.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { G0, SIM_DT } from '../../../src/a10/core/constants';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { DEG, KT } from '../../../src/a10/core/units';
import {
  airAtHeight,
  API_EXPONENT,
  API_P_REF,
  API_V_REF,
  dragCoefficient,
  dragFactor,
  fitApiPenetration,
  flyRoundToRange,
  integrateRound,
  muzzleVelocity,
  penetrationMm,
  predictRoundImpact,
  roundMass,
  RoundType,
  stepGun,
  stepProjectiles,
  type RoundAtRange,
  type RoundPrediction,
} from '../../../src/a10/core/weapons';
import { createGunTestbed, stepKinematic } from '../../../src/a10/core/weapons/testbed';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { GAU8, GAU8_TRAJECTORY_TABLE } from '../../../src/a10/data/gun';

const still = new Vector3();
const at: RoundAtRange = {
  time: 0,
  speed: 0,
  drop: 0,
  point: new Vector3(),
  velocity: new Vector3(),
};

/** A round fired along `dir` from `altitude` at muzzle velocity + `aircraftSpeed`. */
function fly(
  type: RoundType,
  range: number,
  opts: {
    altitude?: number;
    aircraftSpeed?: number;
    dir?: Vector3;
    wind?: Vector3;
    isa?: number;
    drag?: number;
  } = {},
): RoundAtRange {
  const dir = (opts.dir ?? new Vector3(0, 0, -1)).clone().normalize();
  const v = dir.multiplyScalar(muzzleVelocity(type) + (opts.aircraftSpeed ?? 0));
  const ok = flyRoundToRange(
    type,
    new Vector3(0, opts.altitude ?? 0, 0),
    v,
    range,
    opts.wind ?? still,
    at,
    SIM_DT,
    opts.isa ?? 0,
    opts.drag ?? 1,
  );
  expect(ok).toBe(true);
  return { ...at, point: at.point.clone(), velocity: at.velocity.clone() };
}

describe('integrator', () => {
  it('without drag it follows the closed-form parabola to within 0.1 m at 2,000 m', () => {
    const p = new Vector3(0, 500, 0);
    const v0 = new Vector3(0, 50, -GAU8.muzzleVelocity);
    const v = v0.clone();
    let t = 0;
    while (-p.z < 2000) {
      integrateRound(RoundType.API, p, v, still, SIM_DT, 0, 0);
      t += SIM_DT;
    }
    expect(Math.abs(p.z - v0.z * t)).toBeLessThan(0.1);
    expect(Math.abs(p.y - (500 + v0.y * t - 0.5 * G0 * t * t))).toBeLessThan(0.1);
    expect(Math.abs(v.y - (v0.y - G0 * t))).toBeLessThan(1e-6);
    // In fact exactly: Heun's method integrates constant acceleration without error.
    expect(Math.abs(p.y - (500 + v0.y * t - 0.5 * G0 * t * t))).toBeLessThan(1e-6);
  });

  it('flies, bit for bit, the plain formula with the shared air and drag functions', () => {
    // integrateRound passes its state through scratch fields and does the air and Cd look-ups
    // itself (no allocation, ARCHITECTURE §3). It must give exactly the numbers of Heun's step
    // written plainly with airAtHeight and dragFactor: in and outside the air tables, any ISA
    // deviation, in vacuum and with no relative wind.
    const air = { density: 0, sound: 0 };
    const a0 = new Vector3();
    const a1 = new Vector3();
    const plainStep = (
      type: RoundType,
      p: Vector3,
      v: Vector3,
      wind: Vector3,
      dt: number,
      isa: number,
      drag: number,
    ) => {
      const accel = (y: number, vx: number, vy: number, vz: number, out: Vector3) => {
        const ax = vx - wind.x;
        const ay = vy - wind.y;
        const az = vz - wind.z;
        const speed = Math.sqrt(ax * ax + ay * ay + az * az);
        let k = 0;
        if (drag !== 0 && speed > 0) {
          airAtHeight(y, isa, air);
          k = drag * dragFactor(type, speed / air.sound) * air.density * speed;
        }
        out.set(-k * ax, -k * ay - G0, -k * az);
      };
      const vx0 = v.x;
      const vy0 = v.y;
      const vz0 = v.z;
      accel(p.y, vx0, vy0, vz0, a0);
      accel(p.y + vy0 * dt, vx0 + a0.x * dt, vy0 + a0.y * dt, vz0 + a0.z * dt, a1);
      const h = 0.5 * dt;
      const vx1 = vx0 + (a0.x + a1.x) * h;
      const vy1 = vy0 + (a0.y + a1.y) * h;
      const vz1 = vz0 + (a0.z + a1.z) * h;
      p.x += (vx0 + vx1) * h;
      p.y += (vy0 + vy1) * h;
      p.z += (vz0 + vz1) * h;
      v.set(vx1, vy1, vz1);
    };
    const wind = new Vector3(3.3, 0.4, -6.2);
    const velocities = [
      new Vector3(0, 0, -GAU8.muzzleVelocity - 154.3),
      new Vector3(12.4, -95.6, -700.25),
      new Vector3(-180.5, 120.125, 230.75),
      wind.clone(), // no relative wind: no drag
    ];
    const p = new Vector3();
    const v = new Vector3();
    const q = new Vector3();
    const w = new Vector3();
    const mismatches: string[] = [];
    let checked = 0;
    for (const type of [RoundType.API, RoundType.HEI, RoundType.TP])
      for (const isa of [0, 7.5, -12.25])
        for (const drag of [1, 0, 0.37])
          for (const height of [-1500, -999.5, 0.3, 812.7, 5000, 19995.5, 20000.25, 26000])
            for (const v0 of velocities)
              for (const dt of [SIM_DT, SIM_DT * 0.37]) {
                p.set(12.5, height, -7.75);
                q.copy(p);
                v.copy(v0);
                w.copy(v0);
                for (let k = 0; k < 3; k++) {
                  integrateRound(type, p, v, wind, dt, isa, drag);
                  plainStep(type, q, w, wind, dt, isa, drag);
                  checked++;
                  const same =
                    Object.is(p.x, q.x) &&
                    Object.is(p.y, q.y) &&
                    Object.is(p.z, q.z) &&
                    Object.is(v.x, w.x) &&
                    Object.is(v.y, w.y) &&
                    Object.is(v.z, w.z);
                  if (!same && mismatches.length < 5) {
                    mismatches.push(
                      `type ${type} isa ${isa} drag ${drag} h ${height} v ${v0.toArray()} dt ${dt}`,
                    );
                  }
                }
              }
    expect(checked).toBe(5184);
    expect(mismatches).toEqual([]);
  });

  it('is converged at the simulation step: halving or doubling dt moves a 1,500 m shot < 1 mm', () => {
    const shot = (dt: number) => {
      const r: RoundAtRange = { ...at, point: new Vector3(), velocity: new Vector3() };
      flyRoundToRange(RoundType.API, new Vector3(), new Vector3(0, 0, -1013), 1500, still, r, dt);
      return r;
    };
    const a = shot(SIM_DT);
    for (const dt of [SIM_DT / 4, SIM_DT * 2]) {
      const b = shot(dt);
      expect(Math.abs(b.drop - a.drop)).toBeLessThan(0.001);
      expect(Math.abs(b.time - a.time)).toBeLessThan(1e-4);
      expect(Math.abs(b.speed - a.speed)).toBeLessThan(0.05);
    }
  });
});

describe('drag (G7 × form factor, Mach-dependent)', () => {
  it('has the transonic rise and the supersonic fall of a boat-tailed projectile', () => {
    const cd = (m: number) => dragCoefficient(RoundType.API, m);
    expect(cd(0.5)).toBeCloseTo(0.1194 * GAU8.formFactorApi, 4);
    expect(cd(1.05)).toBeGreaterThan(3 * cd(0.8));
    expect(cd(1.2)).toBeGreaterThan(cd(2));
    expect(cd(2)).toBeGreaterThan(cd(3));
    expect(cd(6)).toBeCloseTo(cd(5), 9);
    // Smooth: no jumps between table points.
    for (let m = 0.3; m < 4; m += 0.013) expect(Math.abs(cd(m + 0.001) - cd(m))).toBeLessThan(0.01);
  });

  it('the HEI drags more than the API; TP flies like the API', () => {
    for (const m of [0.8, 1.1, 2, 3]) {
      expect(dragCoefficient(RoundType.HEI, m)).toBeGreaterThan(dragCoefficient(RoundType.API, m));
      expect(dragCoefficient(RoundType.TP, m)).toBe(dragCoefficient(RoundType.API, m));
    }
    expect(roundMass(RoundType.API)).toBe(GAU8.massApi);
    expect(roundMass(RoundType.HEI)).toBe(GAU8.massHei);
    expect(muzzleVelocity(RoundType.HEI)).toBe(GAU8.muzzleVelocityHei);
    expect(muzzleVelocity(RoundType.TP)).toBe(GAU8.muzzleVelocity);
  });

  it('dragFactor is Cd·A / 2m', () => {
    const area = Math.PI * 0.015 * 0.015;
    expect(dragFactor(RoundType.API, 2.5)).toBeCloseTo(
      (0.5 * dragCoefficient(RoundType.API, 2.5) * area) / GAU8.massApi,
      12,
    );
  });

  it('thinner air drags less: higher, or on a hot day, the round keeps more speed', () => {
    const sea = fly(RoundType.API, 1000).speed;
    expect(fly(RoundType.API, 1000, { altitude: 3000 }).speed).toBeGreaterThan(sea + 25);
    expect(fly(RoundType.API, 1000, { isa: 20 }).speed).toBeGreaterThan(sea + 5);
  });
});

describe('trajectory (PLAN §16)', () => {
  it('a static gun at sea level reaches 1,220 m (4,000 ft) in 1.3–1.5 s', () => {
    const r = fly(RoundType.API, 1220);
    expect(r.time).toBeGreaterThan(1.3);
    expect(r.time).toBeLessThan(1.5);
  });

  it('time of flight and remaining speed match the frozen table within 2 %', () => {
    const table = GAU8_TRAJECTORY_TABLE;
    const rows: string[] = [];
    let worst = 0;
    for (const [name, type] of [
      ['api', RoundType.API],
      ['hei', RoundType.HEI],
    ] as const) {
      for (const row of table[name]) {
        const r = fly(type, row.range, { altitude: table.conditions.altitude });
        rows.push(
          `${name} ${row.range} m: tof ${r.time.toFixed(4)} s, speed ${r.speed.toFixed(1)}`,
        );
        worst = Math.max(worst, Math.abs(r.time / row.tof - 1), Math.abs(r.speed / row.speed - 1));
      }
    }
    // On a deliberate drag-data change, copy the printed values into GAU8_TRAJECTORY_TABLE.
    expect(worst, rows.join('\n')).toBeLessThan(0.02);
    // TP is ballistically matched to the API.
    const tp = fly(RoundType.TP, 1000);
    const api = fly(RoundType.API, 1000);
    expect(tp.time).toBeCloseTo(api.time, 9);
  });

  it('a crosswind drifts the round by the classical lag rule, W·(t − x/v0)', () => {
    const wind = new Vector3(10, 0, 0);
    const r = fly(RoundType.API, 1000, { wind });
    const lag = r.time - 1000 / GAU8.muzzleVelocity;
    expect(r.point.x).toBeGreaterThan(0);
    expect(Math.abs(r.point.x / (10 * lag) - 1)).toBeLessThan(0.03);
  });
});

describe('predictor and live rounds agree (PLAN §6.1 rule 2)', () => {
  type Impact = Extract<SimEvent, { type: 'roundImpact' }>;

  /** One live round from a 30° dive at 300 kn, and its initial state as it left the muzzle. */
  function liveShot(): { sim: Sim; origin: Vector3; velocity: Vector3; fireTime: number } {
    const sim = createGunTestbed({
      altitude: 700,
      speed: 300 * KT,
      pathAngle: -30 * DEG,
      load: 'allAPI',
    });
    sim.gun.dispersionScale = 0;
    sim.gun.spin = 1;
    sim.gun.phase = 0.999;
    sim.input.trigger = 2;
    const ac = sim.aircraft;
    ac.prevPosition.copy(ac.position);
    ac.position.addScaledVector(ac.velocity, SIM_DT);
    stepGun(sim, SIM_DT);
    const pool = sim.projectiles.rounds;
    expect(pool.live).toBe(1);
    const i = pool.alive.indexOf(1);
    const origin = new Vector3(pool.px[i], pool.py[i], pool.pz[i]);
    const velocity = new Vector3(pool.vx[i], pool.vy[i], pool.vz[i]);
    const fireTime = pool.fireTime[i];
    stepProjectiles(sim, SIM_DT);
    sim.time += SIM_DT;
    sim.input.trigger = 0;
    for (let k = 0; k < 600 && pool.live > 0; k++) stepKinematic(sim);
    return { sim, origin, velocity, fireTime };
  }

  it('the predicted impact is where the live round lands, within 1 cm and 1 ms', () => {
    const { sim, origin, velocity, fireTime } = liveShot();
    const impact = sim.events.find((e): e is Impact => e.type === 'roundImpact');
    expect(impact).toBeDefined();
    const pred: RoundPrediction = { point: new Vector3(), velocity: new Vector3(), time: 0 };
    expect(
      predictRoundImpact(RoundType.API, origin, velocity, sim.world.terrain, still, 6, pred),
    ).toBe(true);
    const p = impact!.position;
    expect(pred.point.distanceTo(new Vector3(p.x, p.y, p.z))).toBeLessThan(0.01);
    expect(Math.abs(pred.time - (impact!.t - fireTime))).toBeLessThan(0.001);
    // Slant range ≈ 1,220 m class shot.
    expect(pred.point.distanceTo(origin)).toBeGreaterThan(1000);
  });

  it('the predictor gives the same answer with a coarser step', () => {
    const terrain = createFlatTerrain(0);
    const v = new Vector3(0, -Math.sin(30 * DEG), -Math.cos(30 * DEG)).multiplyScalar(
      GAU8.muzzleVelocity + 300 * KT,
    );
    const a: RoundPrediction = { point: new Vector3(), velocity: new Vector3(), time: 0 };
    const b: RoundPrediction = { point: new Vector3(), velocity: new Vector3(), time: 0 };
    predictRoundImpact(RoundType.API, new Vector3(0, 700, 0), v, terrain, still, 6, a);
    predictRoundImpact(RoundType.API, new Vector3(0, 700, 0), v, terrain, still, 6, b, SIM_DT * 2);
    expect(a.point.distanceTo(b.point)).toBeLessThan(0.01);
    expect(Math.abs(a.time - b.time)).toBeLessThan(1e-4);
    expect(a.velocity.distanceTo(b.velocity)).toBeLessThan(0.05);
  });

  it('no impact within maxTime is reported as such', () => {
    const terrain = createFlatTerrain(0);
    const pred: RoundPrediction = { point: new Vector3(), velocity: new Vector3(), time: 0 };
    const up = new Vector3(0, 300, -1000);
    expect(
      predictRoundImpact(RoundType.API, new Vector3(0, 100, 0), up, terrain, still, 2, pred),
    ).toBe(false);
  });
});

describe('penetration fit (docs/a10/ARCHITECTURE.md §5)', () => {
  it('refitted from the model: 69 mm at 500 m and 38 mm at 1,000 m within 1 mm', () => {
    const fit = fitApiPenetration();
    expect(Math.abs(fit.vRef - API_V_REF)).toBeLessThan(0.05);
    expect(Math.abs(fit.exponent - API_EXPONENT)).toBeLessThan(0.001);
    expect(API_P_REF).toBe(GAU8.penetration500m);
    expect(Math.abs(penetrationMm(RoundType.API, fit.v500) - 69)).toBeLessThan(1);
    expect(Math.abs(penetrationMm(RoundType.API, fit.v1000) - 38)).toBeLessThan(1);
  });

  it('a faster attack penetrates more, a slower one less', () => {
    const at500 = (kn: number) =>
      penetrationMm(
        RoundType.API,
        fly(RoundType.API, 500, { altitude: 1000, aircraftSpeed: kn * KT }).speed,
      );
    expect(at500(300)).toBeCloseTo(69, 0);
    expect(at500(400)).toBeGreaterThan(at500(300) + 5);
    expect(at500(200)).toBeLessThan(at500(300) - 5);
  });

  /** Penetration and the roof plate's thickness along the path, from a dive at `range`. */
  function roof(diveDeg: number, range: number) {
    const dir = new Vector3(0, -Math.sin(diveDeg * DEG), -Math.cos(diveDeg * DEG));
    const r = fly(RoundType.API, range, { altitude: 1000, aircraftSpeed: 300 * KT, dir });
    const cos = Math.abs(r.velocity.y) / r.velocity.length();
    return { pen: penetrationMm(RoundType.API, r.speed), plate: 20 / cos, cos };
  }

  it('reproduces the plan table (PLAN §6.3) for a T-72-class tank', () => {
    // 45° dive at 1,200 m onto the 20 mm roof: ≈28 mm along the path, just penetrates.
    const a = roof(45, 1200);
    expect(a.plate).toBeGreaterThan(26);
    expect(a.plate).toBeLessThan(30);
    expect(a.pen).toBeGreaterThan(a.plate);
    // 30° dive: ≈40 mm, fails at 1,200 m, works inside about 950 m.
    expect(roof(30, 1200).pen).toBeLessThan(roof(30, 1200).plate);
    expect(roof(30, 900).pen).toBeGreaterThan(roof(30, 900).plate);
    // 10° strafe from behind onto the 40 mm rear plate: penetrates inside about 950 m.
    const rear = (range: number) => {
      const dir = new Vector3(0, -Math.sin(10 * DEG), -Math.cos(10 * DEG));
      const r = fly(RoundType.API, range, { altitude: 1000, aircraftSpeed: 300 * KT, dir });
      const cos = Math.hypot(r.velocity.x, r.velocity.z) / r.velocity.length();
      return penetrationMm(RoundType.API, r.speed) - 40 / cos;
    };
    expect(rear(900)).toBeGreaterThan(0);
    expect(rear(1000)).toBeLessThan(0);
    // 80 mm side plate, level pass: never beyond 400 m.
    const side = (range: number) =>
      penetrationMm(
        RoundType.API,
        fly(RoundType.API, range, { altitude: 1000, aircraftSpeed: 300 * KT }).speed,
      );
    expect(side(400)).toBeLessThan(80);
    expect(side(300)).toBeGreaterThan(80);
  });

  it('HEI and TP hole only thin skin', () => {
    for (const v of [600, 900, 1200]) {
      const hei = penetrationMm(RoundType.HEI, v);
      const tp = penetrationMm(RoundType.TP, v);
      expect(hei).toBeGreaterThan(0);
      expect(hei).toBeLessThan(12);
      expect(tp).toBeGreaterThan(hei);
      expect(tp).toBeLessThan(20);
    }
    expect(penetrationMm(RoundType.API, -5)).toBe(0);
  });
});
