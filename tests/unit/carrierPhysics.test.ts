/**
 * Force-model and actuator unit tests. The sea is mocked flat here so hydrostatic equilibrium
 * can be asserted exactly; the closed-loop tests (flightAssist.test.ts) run on the real waves.
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config/waves', () => ({ waveHeightAt: () => 0 }));

import {
  BUOYANCY_COLUMNS,
  airDensityFactor,
  computeCarrierForces,
  createCarrierForces,
  groundEffectFactor,
  turbineThrustFactor,
  type CarrierEnvironment,
  type RigidState,
  type TurbineForceState,
} from '../../src/carrier/carrierPhysics';
import { FLOATING_ALTITUDE, TURBINE_MOUNTS } from '../../src/config/layout';
import { HOVER_THROTTLE, PHYS, WEIGHT } from '../../src/config/physicsConfig';
import { stepTurbineActuator, stepTurbineActuators } from '../../src/physics/actuators';
import type { Quad, TurbineSim } from '../../src/state/types';
import { DEG2RAD } from '../../src/utils/math';

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

function body(altitude: number): RigidState {
  return {
    position: new Vector3(0, altitude, 0),
    quaternion: new Quaternion(),
    velocity: new Vector3(),
    angularVelocity: new Vector3(),
  };
}

function env(): CarrierEnvironment {
  return { time: 0, wind: new Vector3(), turbulence: new Vector3() };
}

function turbines(throttle: number, tilt = 0): TurbineForceState[] {
  return [0, 1, 2, 3].map(() => ({ throttle, tilt }));
}

/** Net force and torque with the weight removed (what the engines, the air and the sea do). */
function applied(b: RigidState, t: TurbineForceState[], e = env()) {
  const out = computeCarrierForces(b, t, e, createCarrierForces());
  return { ...out, force: out.force.clone().add(new Vector3(0, WEIGHT, 0)) };
}

describe('thrust', () => {
  it('hover throttle balances the weight at sea level', () => {
    expect(4 * PHYS.maxThrust * HOVER_THROTTLE).toBeCloseTo(WEIGHT, 6);
    expect(HOVER_THROTTLE).toBeGreaterThan(0.58);
    expect(HOVER_THROTTLE).toBeLessThan(0.64);
    // out of ground effect the model produces exactly weight × air density at that throttle
    const b = body(1000);
    const out = computeCarrierForces(b, turbines(HOVER_THROTTLE), env(), createCarrierForces());
    const lift = out.thrust.reduce((a, v) => a + v, 0);
    expect(lift / turbineThrustFactor(b, 0)).toBeCloseTo(WEIGHT, 3);
    expect(out.force.y / WEIGHT).toBeCloseTo(turbineThrustFactor(b, 0) - 1, 6);
    expect(out.torque.length()).toBeLessThan(1e-3);
  });

  it('falls off with air density and gains a little in ground effect', () => {
    expect(airDensityFactor(0)).toBe(1);
    expect(airDensityFactor(PHYS.densityScaleHeight)).toBeCloseTo(Math.exp(-1), 9);
    expect(airDensityFactor(-50)).toBe(1);
    expect(groundEffectFactor(5)).toBeGreaterThan(1.03);
    expect(groundEffectFactor(5)).toBeLessThan(1.08);
    expect(groundEffectFactor(600)).toBeCloseTo(1, 6);
    const low = applied(body(1000), turbines(0.5)).force.y;
    const high = applied(body(3000), turbines(0.5)).force.y;
    expect(high / low).toBeCloseTo(airDensityFactor(3000) / airDensityFactor(1000), 3);
  });

  it.each([-20, 0, 20, 45, 60])(
    'each turbine pushes along the tilted thrust axis at its mount (tilt %d°)',
    (tiltDeg) => {
      const tilt = tiltDeg * DEG2RAD;
      for (let i = 0; i < 4; i++) {
        const b = body(2000);
        const t = turbines(0);
        t[i] = { throttle: 1, tilt };
        const out = applied(b, t);
        const thrust = PHYS.maxThrust * turbineThrustFactor(b, i);
        expect(out.thrust[i]).toBeCloseTo(thrust, 3);
        expect(out.force.x).toBeCloseTo(0, 3);
        expect(out.force.y).toBeCloseTo(thrust * Math.cos(tilt), 3);
        expect(out.force.z).toBeCloseTo(-thrust * Math.sin(tilt), 3);
        const expected = new Vector3(...TURBINE_MOUNTS[i]).cross(out.force);
        expect(out.torque.distanceTo(expected)).toBeLessThan(1e-3 * thrust);
      }
    },
  );

  it('positive tilt pushes toward the bow wherever the bow points', () => {
    const b = body(2000);
    b.quaternion.setFromAxisAngle(Y, -Math.PI / 2); // bow now points east (+X)
    const out = applied(b, turbines(0.6, 30 * DEG2RAD));
    expect(out.force.x).toBeGreaterThan(0.2 * WEIGHT);
    expect(Math.abs(out.force.z)).toBeLessThan(1e-3);
  });

  it('differential throttle and tilt give torques with the documented signs', () => {
    const b = body(2000);
    const base = 0.6;
    const fore = turbines(base);
    fore[0].throttle = fore[1].throttle = base + 0.1;
    fore[2].throttle = fore[3].throttle = base - 0.1;
    const pitch = applied(b, fore).torque;
    expect(pitch.x).toBeGreaterThan(1e6); // about +X: bow up
    expect(Math.abs(pitch.y) + Math.abs(pitch.z)).toBeLessThan(1);

    const port = turbines(base);
    port[0].throttle = port[2].throttle = base + 0.1;
    port[1].throttle = port[3].throttle = base - 0.1;
    const roll = applied(b, port).torque;
    expect(roll.z).toBeLessThan(-1e6); // about -Z: starboard side down (roll > 0)
    expect(Math.abs(roll.x) + Math.abs(roll.y)).toBeLessThan(1);

    const yaw = turbines(base);
    yaw[0].tilt = yaw[2].tilt = 10 * DEG2RAD; // port pair forward
    yaw[1].tilt = yaw[3].tilt = -10 * DEG2RAD; // starboard pair back
    const turn = applied(b, yaw).torque;
    expect(turn.y).toBeLessThan(-1e6); // about -Y: bow swings to starboard
    expect(Math.abs(turn.x) + Math.abs(turn.z)).toBeLessThan(1);
  });

  it('ignores corrupt turbine values instead of producing NaN', () => {
    const t = turbines(0.5);
    t[1] = { throttle: Number.NaN, tilt: Number.POSITIVE_INFINITY };
    t[2] = { throttle: 7, tilt: 0 };
    const out = computeCarrierForces(body(500), t, env(), createCarrierForces());
    expect(out.thrust[1]).toBe(0);
    expect(out.thrust[2]).toBeLessThanOrEqual(PHYS.maxThrust);
    for (const v of [...out.force.toArray(), ...out.torque.toArray()]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    const broken = body(500);
    broken.velocity.set(Number.NaN, 0, 0);
    const safe = computeCarrierForces(broken, t, env(), createCarrierForces());
    expect(safe.force.toArray()).toEqual([0, -WEIGHT, 0]);
  });
});

describe('aerodynamics', () => {
  it('drag opposes motion and is least along the keel, most through the deck', () => {
    const speed = 30;
    const magnitudes = [X, Y, Z].map((axis) => {
      for (const sign of [1, -1]) {
        const b = body(2000);
        b.velocity.copy(axis).multiplyScalar(sign * speed);
        const f = applied(b, turbines(0)).force;
        expect(f.dot(b.velocity)).toBeLessThan(0);
        expect(f.clone().cross(b.velocity).length()).toBeLessThan(1e-6 * f.length() * speed);
      }
      const b = body(2000);
      b.velocity.copy(axis).multiplyScalar(speed);
      return applied(b, turbines(0)).force.length();
    });
    const [side, vertical, keel] = magnitudes;
    expect(vertical).toBeGreaterThan(2 * side);
    expect(side).toBeGreaterThan(2 * keel);
  });

  it('acts in the body frame: a yawed ship still has least drag bow-first', () => {
    const b = body(2000);
    b.quaternion.setFromAxisAngle(Y, Math.PI / 2); // bow points west (-X)
    b.velocity.set(-40, 0, 0);
    const bowFirst = applied(b, turbines(0)).force.length();
    b.velocity.set(0, 0, 40);
    const sideways = applied(b, turbines(0)).force.length();
    expect(sideways).toBeGreaterThan(2 * bowFirst);
  });

  it('wind pushes a stationary ship downwind and thin air weakens drag', () => {
    const e = env();
    e.wind.set(12, 0, 0);
    const pushed = applied(body(2000), turbines(0), e).force;
    expect(pushed.x).toBeGreaterThan(0);
    const b = body(2000);
    b.velocity.set(12, 0, 0);
    expect(applied(b, turbines(0), e).force.length()).toBeLessThan(1e-6);

    const low = body(500);
    const high = body(3500);
    low.velocity.set(0, -20, 0);
    high.velocity.set(0, -20, 0);
    expect(applied(high, turbines(0)).force.y).toBeLessThan(applied(low, turbines(0)).force.y);
  });

  it('terminal sink rate with dead engines is 25-30 m/s', () => {
    const slow = body(1000);
    slow.velocity.set(0, -25, 0);
    const fast = body(1000);
    fast.velocity.set(0, -30, 0);
    expect(applied(slow, turbines(0)).force.y).toBeLessThan(WEIGHT);
    expect(applied(fast, turbines(0)).force.y).toBeGreaterThan(WEIGHT);
  });

  it('damps rotation about every axis', () => {
    for (const axis of [X, Y, Z]) {
      const b = body(2000);
      b.angularVelocity.copy(axis).multiplyScalar(0.1);
      const torque = applied(b, turbines(0)).torque;
      expect(torque.dot(axis)).toBeLessThan(-1e5);
    }
  });

  it('a flat fall rights the ship, and turbulence is passed through', () => {
    const rolled = body(2000);
    rolled.quaternion.setFromAxisAngle(Z, -10 * DEG2RAD); // starboard down
    rolled.velocity.set(0, -27, 0);
    expect(applied(rolled, turbines(0)).torque.z).toBeGreaterThan(1e5); // lifts the starboard side

    const pitched = body(2000);
    pitched.quaternion.setFromAxisAngle(X, -10 * DEG2RAD); // bow down
    pitched.velocity.set(0, -27, 0);
    expect(applied(pitched, turbines(0)).torque.x).toBeGreaterThan(1e5); // lifts the bow

    const e = env();
    e.turbulence.set(1000, -2000, 3000);
    const t = applied(body(250), turbines(0), e).torque;
    const density = airDensityFactor(250);
    expect(t.x).toBeCloseTo(1000 * density, 6);
    expect(t.y).toBeCloseTo(-2000 * density, 6);
    expect(t.z).toBeCloseTo(3000 * density, 6);
  });
});

describe('buoyancy (flat sea)', () => {
  it('samples the hull with a grid of columns of positive area', () => {
    expect(BUOYANCY_COLUMNS.length).toBeGreaterThanOrEqual(20);
    for (const c of BUOYANCY_COLUMNS) expect(c.area).toBeGreaterThan(0);
  });

  it('is in equilibrium at the floating altitude: waterline at local y = -6', () => {
    const out = computeCarrierForces(
      body(FLOATING_ALTITUDE),
      turbines(0),
      env(),
      createCarrierForces(),
    );
    expect(out.buoyancy / WEIGHT).toBeCloseTo(1, 9);
    expect(Math.abs(out.force.y)).toBeLessThan(1e-6 * WEIGHT);
    expect(out.torque.length()).toBeLessThan(1e-3);
    expect(out.supportForceY / WEIGHT).toBeCloseTo(1, 9);
  });

  it('pushes back toward the design draft', () => {
    const deep = computeCarrierForces(
      body(FLOATING_ALTITUDE - 1),
      turbines(0),
      env(),
      createCarrierForces(),
    );
    const shallow = computeCarrierForces(
      body(FLOATING_ALTITUDE + 1),
      turbines(0),
      env(),
      createCarrierForces(),
    );
    expect(deep.force.y).toBeGreaterThan(0.05 * WEIGHT);
    expect(shallow.force.y).toBeLessThan(-0.05 * WEIGHT);
    expect(deep.force.y).toBeCloseTo(-shallow.force.y, 3);
  });

  it('rights the ship when it heels or trims', () => {
    const heeled = body(FLOATING_ALTITUDE);
    heeled.quaternion.setFromAxisAngle(Z, -5 * DEG2RAD); // starboard down
    const heel = applied(heeled, turbines(0)).torque;
    expect(heel.z).toBeGreaterThan(1e5); // raises the starboard side

    const other = body(FLOATING_ALTITUDE);
    other.quaternion.setFromAxisAngle(Z, 5 * DEG2RAD); // port down
    expect(applied(other, turbines(0)).torque.z).toBeLessThan(-1e5);

    const trimmed = body(FLOATING_ALTITUDE);
    trimmed.quaternion.setFromAxisAngle(X, -3 * DEG2RAD); // bow down
    expect(applied(trimmed, turbines(0)).torque.x).toBeGreaterThan(1e6); // raises the bow
  });

  it('damps heave, sway and surge in the water and vanishes in the air', () => {
    for (const [axis, sign] of [
      [Y, 1],
      [Y, -1],
      [X, 1],
      [Z, 1],
    ] as const) {
      const b = body(FLOATING_ALTITUDE);
      b.velocity.copy(axis).multiplyScalar(2 * sign);
      const still = applied(body(FLOATING_ALTITUDE), turbines(0)).force;
      const moving = applied(b, turbines(0)).force;
      expect(moving.sub(still).dot(b.velocity)).toBeLessThan(-1000);
    }
    const flying = computeCarrierForces(body(60), turbines(0), env(), createCarrierForces());
    expect(flying.buoyancy).toBe(0);
    expect(flying.supportForceY).toBe(0);
  });

  it('keeps a submerged ship coming back up', () => {
    const sunk = computeCarrierForces(body(-40), turbines(0), env(), createCarrierForces());
    expect(sunk.force.y).toBeGreaterThan(WEIGHT);
  });
});

describe('turbine actuators', () => {
  function turbine(partial: Partial<TurbineSim> = {}): TurbineSim {
    return {
      enabled: true,
      throttleCmd: 0,
      throttle: 0,
      tiltCmd: 0,
      tilt: 0,
      thrust: 0,
      ...partial,
    };
  }

  function run(t: TurbineSim, seconds: number): void {
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps; i++) stepTurbineActuator(t, 1 / 60);
  }

  it('spools up as a first-order lag at spoolUpRate', () => {
    const t = turbine({ throttleCmd: 1 });
    run(t, 1 / PHYS.spoolUpRate);
    expect(t.throttle).toBeCloseTo(1 - Math.exp(-1), 2);
    run(t, 10);
    expect(t.throttle).toBeCloseTo(1, 3);
  });

  it('spools down more slowly than it spools up', () => {
    const up = turbine({ throttleCmd: 1 });
    const down = turbine({ throttle: 1, throttleCmd: 0 });
    run(up, 1);
    run(down, 1);
    expect(down.throttle).toBeCloseTo(Math.exp(-PHYS.spoolDownRate), 2);
    expect(up.throttle).toBeGreaterThan(1 - down.throttle);
  });

  it('slews the tilt at tiltRate and stops at the limits', () => {
    const t = turbine({ tiltCmd: 40 * DEG2RAD });
    run(t, 1);
    expect(t.tilt).toBeCloseTo(PHYS.tiltRate, 6);
    run(t, 5);
    expect(t.tilt).toBeCloseTo(40 * DEG2RAD, 9);
    t.tiltCmd = 5;
    run(t, 10);
    expect(t.tilt).toBeCloseTo(PHYS.tiltMax, 9);
    t.tiltCmd = -5;
    run(t, 10);
    expect(t.tilt).toBeCloseTo(PHYS.tiltMin, 9);
  });

  it('a disabled engine spools to zero whatever is commanded', () => {
    const t = turbine({ enabled: false, throttle: 0.8, throttleCmd: 1 });
    run(t, 1);
    expect(t.throttleCmd).toBe(0);
    expect(t.throttle).toBeLessThan(0.45);
    run(t, 20);
    expect(t.throttle).toBe(0);
  });

  it('sanitises commands and steps all four turbines', () => {
    const quad: Quad<TurbineSim> = [
      turbine({ throttleCmd: Number.NaN, tiltCmd: Number.NaN }),
      turbine({ throttleCmd: 5 }),
      turbine({ throttleCmd: -3, throttle: 0.5 }),
      turbine({ throttle: Number.POSITIVE_INFINITY, tilt: Number.NaN, throttleCmd: 0.5 }),
    ];
    for (let i = 0; i < 600; i++) stepTurbineActuators(quad, 1 / 60);
    expect(quad[0].throttle).toBe(0);
    expect(quad[0].tilt).toBe(0);
    expect(quad[1].throttle).toBeCloseTo(1, 2);
    expect(quad[2].throttle).toBeLessThan(0.01);
    expect(quad[3].throttle).toBeCloseTo(0.5, 2);
    expect(quad[3].tilt).toBe(0);
  });
});
