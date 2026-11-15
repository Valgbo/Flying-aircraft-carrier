/**
 * Closed-loop scenario tests: the flight computer, manual control, actuators and force model
 * flown by the fixed-step integrator (no physics engine) on the real wave field. Every number
 * asserted here is part of the target feel in the physics brief.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { FLOATING_ALTITUDE } from '../../src/config/layout';
import { FLIGHT, HOVER_THROTTLE, PHYS, WIND } from '../../src/config/physicsConfig';
import { readAttitude, type Attitude, type PilotAxes } from '../../src/physics/flightComputer';
import {
  FIXED_DT,
  createFlightModel,
  setHover,
  stepFlightModel,
  type FlightModel,
} from '../../src/physics/flightModel';
import { DEG2RAD, RAD2DEG, deltaDeg } from '../../src/utils/math';

const NEUTRAL: PilotAxes = { collective: 0, tilt: 0, yaw: 0, strafe: 0 };
const _att: Attitude = { heading: 0, pitch: 0, roll: 0, upY: 1, forwardY: 0 };
const _v = new Vector3();

function attitude(model: FlightModel) {
  readAttitude(model.body.quaternion, _att);
  return {
    headingDeg: (_att.heading * RAD2DEG + 360) % 360,
    pitchDeg: _att.pitch * RAD2DEG,
    rollDeg: _att.roll * RAD2DEG,
    tiltDeg: Math.acos(Math.min(1, _att.upY)) * RAD2DEG,
  };
}

/** Speed along the ship's own bow (+) and starboard (+) directions, m/s. */
function bodySpeeds(model: FlightModel) {
  const forward = model.body.velocity.dot(_v.set(0, 0, -1).applyQuaternion(model.body.quaternion));
  const starboard = model.body.velocity.dot(_v.set(1, 0, 0).applyQuaternion(model.body.quaternion));
  return { forward, starboard };
}

/** Compass yaw rate, deg/s (positive = turning to starboard). */
function yawRateDeg(model: FlightModel): number {
  return -model.body.angularVelocity.y * RAD2DEG;
}

function fly(
  model: FlightModel,
  seconds: number,
  axes: Partial<PilotAxes> = {},
  assist = true,
  each?: (model: FlightModel) => void,
): void {
  const input = { ...NEUTRAL, ...axes };
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) {
    stepFlightModel(model, input, assist);
    each?.(model);
  }
}

function hovering(altitude: number, windLevel = 0): FlightModel {
  const model = createFlightModel({ windLevel });
  setHover(model, altitude);
  return model;
}

function expectFinite(model: FlightModel): void {
  const values = [
    ...model.body.position.toArray(),
    ...model.body.velocity.toArray(),
    ...model.body.angularVelocity.toArray(),
    ...model.body.quaternion.toArray(),
    ...model.turbines.flatMap((t) => [t.throttle, t.throttleCmd, t.tilt, t.tiltCmd, t.thrust]),
    model.controls.targetAltitude,
    model.controls.tiltLever,
    ...model.controls.manualThrottle,
    ...model.controls.manualTilt,
  ];
  for (const v of values) expect(Number.isFinite(v)).toBe(true);
}

describe('afloat', () => {
  it('floats upright at the design waterline with idle engines and rides the swell gently', () => {
    const model = createFlightModel({ windLevel: WIND.freeFlightLevel });
    let maxTilt = 0;
    let maxHeave = 0;
    let maxVertical = 0;
    let altitudeSum = 0;
    let samples = 0;
    fly(model, 90, {}, true, (m) => {
      maxTilt = Math.max(maxTilt, attitude(m).tiltDeg);
      maxHeave = Math.max(maxHeave, Math.abs(m.body.position.y - FLOATING_ALTITUDE));
      maxVertical = Math.max(maxVertical, Math.abs(m.body.velocity.y));
      altitudeSum += m.body.position.y;
      samples++;
      for (const t of m.turbines) expect(t.throttleCmd).toBe(0);
    });
    expect(altitudeSum / samples).toBeCloseTo(FLOATING_ALTITUDE, 0);
    expect(maxHeave).toBeLessThan(1.6);
    expect(maxTilt).toBeLessThan(3);
    expect(maxVertical).toBeLessThan(1);
    expect(model.computer.idle).toBe(true);
    expect(model.sensors.afloat).toBe(true);
    expect(model.keelClearance).toBeLessThan(0);
  });

  it('settles within a few seconds after being dropped in heeled over', () => {
    const model = createFlightModel();
    model.body.position.y = FLOATING_ALTITUDE + 4;
    model.body.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -6 * DEG2RAD);
    fly(model, 12);
    let maxTilt = 0;
    let maxHeave = 0;
    fly(model, 30, {}, true, (m) => {
      maxTilt = Math.max(maxTilt, attitude(m).tiltDeg);
      maxHeave = Math.max(maxHeave, Math.abs(m.body.position.y - FLOATING_ALTITUDE));
    });
    // what is left is the swell, not the drop
    expect(maxTilt).toBeLessThan(3);
    expect(maxHeave).toBeLessThan(1.6);
  });

  it('keeps the target altitude inside its range', () => {
    const model = createFlightModel();
    fly(model, 5, { collective: -1 });
    expect(model.controls.targetAltitude).toBe(FLOATING_ALTITUDE);
    expect(model.computer.idle).toBe(true);
    model.body.position.y = 3400;
    model.controls.targetAltitude = 9000;
    fly(model, 0.1);
    expect(model.controls.targetAltitude).toBe(FLIGHT.maxTargetAltitude);
    fly(model, 20, { collective: 1 });
    expect(model.controls.targetAltitude).toBe(FLIGHT.maxTargetAltitude);
  });
});

describe('flight assist', () => {
  it('lifts off when collective is held and climbs', () => {
    const model = createFlightModel();
    fly(model, 3);
    fly(model, 12, { collective: 1 });
    expect(model.controls.targetAltitude).toBeGreaterThan(100);
    expect(model.body.position.y).toBeGreaterThan(40);
    expect(model.body.velocity.y).toBeGreaterThan(5);
    expect(model.keelClearance).toBeGreaterThan(10);
    expect(model.sensors.afloat).toBe(false);
    // released: the computer stops at the target instead of drifting on
    fly(model, 30);
    expect(Math.abs(model.body.position.y - model.controls.targetAltitude)).toBeLessThan(2);
    expect(model.controls.targetAltitude - 6).toBeLessThan(12 * FLIGHT.targetRate + 1);
  });

  it('takes off from the sea to 300 m in 20-35 s with little overshoot and no oscillation', () => {
    const model = createFlightModel();
    fly(model, 3);
    model.controls.targetAltitude = 300;
    const start = model.time;
    let reached = Number.NaN;
    let peak = 0;
    let lateError = 0;
    let lateTilt = 0;
    fly(model, 70, {}, true, (m) => {
      const altitude = m.body.position.y;
      const elapsed = m.time - start;
      peak = Math.max(peak, altitude);
      if (Number.isNaN(reached) && altitude >= 297) reached = elapsed;
      if (elapsed > 35) {
        lateError = Math.max(lateError, Math.abs(altitude - 300));
        lateTilt = Math.max(lateTilt, attitude(m).tiltDeg);
      }
    });
    expect(reached).toBeGreaterThan(18);
    expect(reached).toBeLessThan(35);
    expect(peak).toBeLessThan(300 + 0.1 * 294);
    expect(peak).toBeLessThan(306);
    expect(lateError).toBeLessThan(2);
    expect(lateTilt).toBeLessThan(0.5);
    for (const t of model.turbines) expect(t.throttle).toBeCloseTo(HOVER_THROTTLE, 1);
  });

  it('holds a level hover within 2 m and 1 degree in light wind', () => {
    const model = hovering(420, WIND.freeFlightLevel);
    let maxError = 0;
    let maxTilt = 0;
    fly(model, 120, {}, true, (m) => {
      maxError = Math.max(maxError, Math.abs(m.body.position.y - 420));
      maxTilt = Math.max(maxTilt, attitude(m).tiltDeg);
    });
    expect(maxError).toBeLessThan(2);
    expect(maxTilt).toBeLessThan(1);
  });

  it('stays usable in the stronger wind of flight ops', () => {
    const model = hovering(600, WIND.opsLevel);
    let maxError = 0;
    let maxTilt = 0;
    fly(model, 120, {}, true, (m) => {
      maxError = Math.max(maxError, Math.abs(m.body.position.y - 600));
      maxTilt = Math.max(maxTilt, attitude(m).tiltDeg);
    });
    expect(maxError).toBeLessThan(3);
    expect(maxTilt).toBeGreaterThan(0.3); // the deck visibly works against the gusts...
    expect(maxTilt).toBeLessThan(2.5); // ...but stays safe to land on
  });

  it('accelerates smoothly to 55-75 m/s with the lever at 20 degrees, holding altitude and a level deck', () => {
    const model = hovering(300, WIND.freeFlightLevel);
    fly(model, 5);
    fly(model, 20 / (FLIGHT.leverRate * RAD2DEG), { tilt: 1 });
    expect(model.controls.tiltLever * RAD2DEG).toBeCloseTo(20, 0);
    let maxError = 0;
    let maxTilt = 0;
    let previous = bodySpeeds(model).forward;
    let maxAccel = 0;
    fly(model, 80, {}, true, (m) => {
      maxError = Math.max(maxError, Math.abs(m.body.position.y - 300));
      maxTilt = Math.max(maxTilt, attitude(m).tiltDeg);
      const speed = bodySpeeds(m).forward;
      maxAccel = Math.max(maxAccel, Math.abs(speed - previous) / FIXED_DT);
      previous = speed;
    });
    const { forward } = bodySpeeds(model);
    expect(forward).toBeGreaterThan(55);
    expect(forward).toBeLessThan(75);
    expect(maxError).toBeLessThan(5);
    expect(maxTilt).toBeLessThan(2);
    expect(maxAccel).toBeLessThan(5);
    for (const t of model.turbines) expect(t.tilt * RAD2DEG).toBeCloseTo(20, 0);
  });

  it('tops out at 100-125 m/s with the lever fully forward', () => {
    const model = hovering(300);
    model.controls.tiltLever = PHYS.tiltMax;
    let maxError = 0;
    let maxTilt = 0;
    fly(model, 110, {}, true, (m) => {
      maxError = Math.max(maxError, Math.abs(m.body.position.y - 300));
      maxTilt = Math.max(maxTilt, attitude(m).tiltDeg);
    });
    const { forward } = bodySpeeds(model);
    expect(forward).toBeGreaterThan(100);
    expect(forward).toBeLessThan(125);
    expect(maxError).toBeLessThan(5);
    expect(maxTilt).toBeLessThan(2);
    // the computer holds the nacelles back so that lift is never traded for speed
    expect(model.turbines[0].tilt).toBeLessThan(PHYS.tiltMax);
    expect(model.computer.saturated).toBe(false);
  });

  it('brakes with the lever pulled back', () => {
    const model = hovering(300);
    model.controls.tiltLever = 20 * DEG2RAD;
    fly(model, 40);
    const cruising = bodySpeeds(model).forward;
    fly(model, 25, { tilt: -1 });
    expect(model.controls.tiltLever).toBeCloseTo(PHYS.tiltMin, 6);
    expect(bodySpeeds(model).forward).toBeLessThan(cruising - 40);
  });

  it('turns at 5-8 deg/s on full yaw and stops on the heading when released', () => {
    for (const direction of [1, -1]) {
      const model = hovering(300);
      fly(model, 2);
      fly(model, 10, { yaw: direction });
      let minRate = Infinity;
      let maxRate = 0;
      fly(model, 10, { yaw: direction }, true, (m) => {
        const rate = yawRateDeg(m) * direction;
        minRate = Math.min(minRate, rate);
        maxRate = Math.max(maxRate, rate);
      });
      expect(minRate).toBeGreaterThan(5);
      expect(maxRate).toBeLessThan(8);
      const turned = deltaDeg(0, attitude(model).headingDeg) * direction;
      expect(turned).toBeGreaterThan(60);

      // release: stopped within three seconds, then held
      const released = attitude(model).headingDeg;
      let furthest = 0;
      fly(model, 3, {}, true, (m) => {
        furthest = Math.max(furthest, deltaDeg(released, attitude(m).headingDeg) * direction);
      });
      expect(Math.abs(yawRateDeg(model))).toBeLessThan(0.7);
      fly(model, 12, {}, true, (m) => {
        furthest = Math.max(furthest, deltaDeg(released, attitude(m).headingDeg) * direction);
      });
      const settled = deltaDeg(released, attitude(model).headingDeg) * direction;
      expect(Math.abs(yawRateDeg(model))).toBeLessThan(0.05);
      expect(furthest - settled).toBeLessThan(3);
      expect(settled).toBeLessThan(12);
      expect(model.computer.headingHold).toBe(true);
      expect(attitude(model).tiltDeg).toBeLessThan(0.5);
      expect(Math.abs(model.body.position.y - 300)).toBeLessThan(2);
    }
  });

  it('turns at the same 5-8 deg/s in forward flight', () => {
    for (const leverDeg of [20, 60]) {
      const model = hovering(300, WIND.freeFlightLevel);
      model.controls.tiltLever = leverDeg * DEG2RAD;
      fly(model, 70);
      fly(model, 8, { yaw: -1 });
      let minRate = Infinity;
      let maxRate = 0;
      let maxError = 0;
      let maxTilt = 0;
      fly(model, 8, { yaw: -1 }, true, (m) => {
        minRate = Math.min(minRate, -yawRateDeg(m));
        maxRate = Math.max(maxRate, -yawRateDeg(m));
        maxError = Math.max(maxError, Math.abs(m.body.position.y - 300));
        maxTilt = Math.max(maxTilt, attitude(m).tiltDeg);
      });
      expect(minRate).toBeGreaterThan(5);
      expect(maxRate).toBeLessThan(8);
      expect(maxError).toBeLessThan(5);
      expect(maxTilt).toBeLessThan(2);
    }
  });

  it('holds its heading against a disturbance', () => {
    const model = hovering(300);
    fly(model, 2);
    model.body.angularVelocity.y = 2 * DEG2RAD;
    fly(model, 25);
    expect(Math.abs(deltaDeg(0, attitude(model).headingDeg))).toBeLessThan(0.5);
  });

  it('obeys the documented sign conventions', () => {
    const yaw = hovering(300);
    fly(yaw, 8, { yaw: 1 });
    expect(attitude(yaw).headingDeg).toBeGreaterThan(10);
    expect(attitude(yaw).headingDeg).toBeLessThan(90); // turning to starboard: north → east

    const tilt = hovering(300);
    fly(tilt, 10, { tilt: 1 });
    expect(bodySpeeds(tilt).forward).toBeGreaterThan(5);
    expect(tilt.body.velocity.z).toBeLessThan(-5); // heading north = world -Z

    const strafe = hovering(300);
    fly(strafe, 10, { strafe: 1 });
    expect(bodySpeeds(strafe).starboard).toBeGreaterThan(3);
    expect(strafe.body.velocity.x).toBeGreaterThan(3); // starboard of north = east = +X
    expect(attitude(strafe).rollDeg).toBeGreaterThan(4); // starboard side down

    const collective = hovering(300);
    fly(collective, 10, { collective: 1 });
    expect(collective.body.velocity.y).toBeGreaterThan(5);
    expect(collective.body.position.y).toBeGreaterThan(320);
    fly(collective, 10, { collective: -1 });
    expect(collective.body.velocity.y).toBeLessThan(-5);
  });

  it('banks about 8 degrees to slide sideways and levels on release', () => {
    const model = hovering(300);
    let maxRoll = 0;
    let maxError = 0;
    fly(model, 15, { strafe: -1 }, true, (m) => {
      maxRoll = Math.max(maxRoll, -attitude(m).rollDeg);
      maxError = Math.max(maxError, Math.abs(m.body.position.y - 300));
    });
    expect(attitude(model).rollDeg).toBeCloseTo(-8, 0);
    expect(maxRoll).toBeLessThan(10);
    expect(bodySpeeds(model).starboard).toBeLessThan(-8);
    fly(model, 8, {}, true, (m) => {
      maxError = Math.max(maxError, Math.abs(m.body.position.y - 300));
    });
    expect(Math.abs(attitude(model).rollDeg)).toBeLessThan(0.5);
    expect(Math.abs(attitude(model).pitchDeg)).toBeLessThan(0.5);
    expect(maxError).toBeLessThan(2);
  });

  it('descends to the sea, splashes down gently and idles the engines', () => {
    const model = hovering(250);
    model.controls.targetAltitude = FLOATING_ALTITUDE;
    let contactSink = Number.NaN;
    let maxSink = 0;
    fly(model, 70, {}, true, (m) => {
      maxSink = Math.max(maxSink, -m.body.velocity.y);
      if (Number.isNaN(contactSink) && m.keelClearance < 0) contactSink = -m.body.velocity.y;
    });
    expect(maxSink).toBeGreaterThan(15);
    expect(maxSink).toBeLessThan(FLIGHT.sinkRateMax + 2);
    expect(contactSink).toBeLessThan(3);
    expect(model.computer.idle).toBe(true);
    for (const t of model.turbines) expect(t.throttle).toBeLessThan(0.01);
    expect(Math.abs(model.body.position.y - FLOATING_ALTITUDE)).toBeLessThan(1.6);
  });

  it('keeps attitude authority when the fans saturate near the ceiling', () => {
    const model = hovering(3350);
    model.controls.targetAltitude = FLIGHT.maxTargetAltitude;
    let maxTilt = 0;
    let saturated = false;
    fly(model, 20, { yaw: 1, strafe: 1 }, true, (m) => {
      saturated ||= m.computer.saturated;
      maxTilt = Math.max(maxTilt, attitude(m).tiltDeg);
    });
    expect(saturated).toBe(true);
    expect(maxTilt).toBeLessThan(FLIGHT.maxBank * RAD2DEG + 2.5);
    fly(model, 60);
    expect(attitude(model).tiltDeg).toBeLessThan(0.5);
    expect(Math.abs(model.body.position.y - FLIGHT.maxTargetAltitude)).toBeLessThan(3);
    expect(model.turbines[0].throttle).toBeLessThan(0.95);
  });
});

describe('engine failures', () => {
  it('falls flat at 25-30 m/s with all engines cut, stays upright and floats afterwards', () => {
    const model = hovering(1500, WIND.freeFlightLevel);
    fly(model, 3);
    for (const t of model.turbines) t.enabled = false;
    let maxTilt = 0;
    let maxSink = 0;
    let contactSink = Number.NaN;
    fly(model, 62, {}, true, (m) => {
      maxTilt = Math.max(maxTilt, attitude(m).tiltDeg);
      maxSink = Math.max(maxSink, -m.body.velocity.y);
      if (Number.isNaN(contactSink) && m.keelClearance < 0) contactSink = -m.body.velocity.y;
    });
    expect(maxSink).toBeGreaterThan(25);
    expect(maxSink).toBeLessThan(30);
    expect(contactSink).toBeGreaterThan(24);
    expect(maxTilt).toBeLessThan(8);
    // after the splash
    let lateTilt = 0;
    let lateHeave = 0;
    fly(model, 40);
    fly(model, 30, {}, true, (m) => {
      lateTilt = Math.max(lateTilt, attitude(m).tiltDeg);
      lateHeave = Math.max(lateHeave, Math.abs(m.body.position.y - FLOATING_ALTITUDE));
    });
    expect(lateTilt).toBeLessThan(4);
    expect(lateHeave).toBeLessThan(1.8);
    expect(model.sensors.afloat).toBe(true);
    for (const t of model.turbines) expect(t.throttle).toBe(0);
    expectFinite(model);
  });

  it.each([0, 1, 2, 3])('comes down upright and under control with engine %d out', (dead) => {
    const model = hovering(700, WIND.freeFlightLevel);
    fly(model, 3);
    model.turbines[dead].enabled = false;
    let maxTilt = 0;
    let maxSink = 0;
    let contactSink = Number.NaN;
    fly(model, 90, {}, true, (m) => {
      maxTilt = Math.max(maxTilt, attitude(m).tiltDeg);
      maxSink = Math.max(maxSink, -m.body.velocity.y);
      if (Number.isNaN(contactSink) && m.keelClearance < 0) contactSink = -m.body.velocity.y;
    });
    expect(model.turbines[dead].throttle).toBe(0);
    expect(maxTilt).toBeLessThan(9);
    expect(maxSink).toBeGreaterThan(5); // three engines cannot hold altitude...
    expect(maxSink).toBeLessThan(16); // ...but the descent is far gentler than a free fall
    expect(contactSink).toBeLessThan(14);
    expect(model.body.position.y).toBeLessThan(40);
    expectFinite(model);
  });

  it('stays controllable about yaw on three engines', () => {
    const model = hovering(900);
    model.turbines[3].enabled = false;
    fly(model, 15);
    fly(model, 10, { yaw: 1 });
    expect(attitude(model).headingDeg).toBeGreaterThan(15);
    expect(attitude(model).headingDeg).toBeLessThan(120);
    expect(attitude(model).tiltDeg).toBeLessThan(9);
  });

  it.each([
    ['both forward engines', [0, 1]],
    ['both port engines', [0, 2]],
    ['a diagonal pair', [0, 3]],
    ['three engines', [0, 1, 2]],
  ] as const)('never tumbles with %s out', (_label, dead) => {
    const model = hovering(900, WIND.freeFlightLevel);
    fly(model, 2);
    for (const i of dead) model.turbines[i].enabled = false;
    let maxTilt = 0;
    fly(model, 80, { yaw: 1, strafe: -1, collective: 1 }, true, (m) => {
      maxTilt = Math.max(maxTilt, attitude(m).tiltDeg);
    });
    expect(maxTilt).toBeLessThan(20);
    expect(model.body.position.y).toBeLessThan(60);
    expectFinite(model);
  });

  it('recovers when the engine is switched back on', () => {
    const model = hovering(900);
    model.turbines[1].enabled = false;
    fly(model, 20);
    expect(model.body.position.y).toBeLessThan(820);
    model.turbines[1].enabled = true;
    fly(model, 60);
    expect(Math.abs(model.body.position.y - 900)).toBeLessThan(3);
    expect(attitude(model).tiltDeg).toBeLessThan(0.5);
  });
});

describe('manual mode', () => {
  it('switches from assist to manual without a bump', () => {
    const model = hovering(300, WIND.freeFlightLevel);
    model.controls.tiltLever = 15 * DEG2RAD;
    fly(model, 30);
    const before = model.turbines.map((t) => ({ throttle: t.throttle, tilt: t.tilt }));
    fly(model, FIXED_DT, {}, false);
    model.turbines.forEach((t, i) => {
      expect(model.controls.manualThrottle[i]).toBeCloseTo(before[i].throttle, 6);
      expect(model.controls.manualTilt[i]).toBeCloseTo(before[i].tilt, 6);
      expect(t.throttleCmd).toBeCloseTo(before[i].throttle, 6);
      expect(t.tiltCmd).toBeCloseTo(before[i].tilt, 6);
    });
    // hands off, the trimmed ship carries on for a while by itself
    fly(model, 4, {}, false);
    expect(Math.abs(model.body.position.y - 300)).toBeLessThan(3);
    expect(attitude(model).tiltDeg).toBeLessThan(2);
    // and the computer's set-points follow the ship while the pilot flies
    expect(model.controls.targetAltitude).toBeCloseTo(model.body.position.y, 1);
    expect(model.controls.tiltLever).toBeCloseTo(15 * DEG2RAD, 2);
  });

  it('maps the axes as documented: collective and tilt move the levers, yaw and strafe are momentary', () => {
    const model = hovering(300);
    fly(model, 1, {}, false);
    const base = [...model.controls.manualThrottle];

    fly(model, 1, { collective: 1 }, false);
    model.controls.manualThrottle.forEach((v, i) =>
      expect(v).toBeCloseTo(base[i] + FLIGHT.manualThrottleRate, 3),
    );
    fly(model, 1, { collective: -1 }, false);
    model.controls.manualThrottle.forEach((v, i) => expect(v).toBeCloseTo(base[i], 3));

    fly(model, 1, { tilt: 1 }, false);
    model.controls.manualTilt.forEach((v) => expect(v).toBeCloseTo(FLIGHT.manualTiltRate, 3));
    for (const t of model.turbines) expect(t.tiltCmd).toBeCloseTo(FLIGHT.manualTiltRate, 3);
    fly(model, 1, { tilt: -1 }, false);
    model.controls.manualTilt.forEach((v) => expect(v).toBeCloseTo(0, 3));

    fly(model, 0.5, { yaw: 1 }, false);
    expect(model.turbines[0].tiltCmd).toBeCloseTo(FLIGHT.manualYawTilt, 3); // port pair forward
    expect(model.turbines[2].tiltCmd).toBeCloseTo(FLIGHT.manualYawTilt, 3);
    expect(model.turbines[1].tiltCmd).toBeCloseTo(-FLIGHT.manualYawTilt, 3);
    expect(model.turbines[3].tiltCmd).toBeCloseTo(-FLIGHT.manualYawTilt, 3);
    model.controls.manualTilt.forEach((v) => expect(v).toBeCloseTo(0, 3)); // levers untouched
    fly(model, FIXED_DT, {}, false);
    for (const t of model.turbines) expect(t.tiltCmd).toBeCloseTo(0, 3);

    const lever = [...model.controls.manualThrottle];
    fly(model, 0.5, { strafe: 1 }, false);
    expect(model.turbines[0].throttleCmd).toBeCloseTo(lever[0] + FLIGHT.manualStrafeThrottle, 3);
    expect(model.turbines[2].throttleCmd).toBeCloseTo(lever[2] + FLIGHT.manualStrafeThrottle, 3);
    expect(model.turbines[1].throttleCmd).toBeCloseTo(lever[1] - FLIGHT.manualStrafeThrottle, 3);
    expect(model.turbines[3].throttleCmd).toBeCloseTo(lever[3] - FLIGHT.manualStrafeThrottle, 3);
    model.controls.manualThrottle.forEach((v, i) => expect(v).toBeCloseTo(lever[i], 6));
  });

  it('responds in the documented directions', () => {
    const yaw = hovering(300);
    fly(yaw, 6, { yaw: 1 }, false);
    expect(attitude(yaw).headingDeg).toBeGreaterThan(3);
    expect(attitude(yaw).headingDeg).toBeLessThan(120);

    const strafe = hovering(300);
    fly(strafe, 5, { strafe: 1 }, false);
    expect(attitude(strafe).rollDeg).toBeGreaterThan(1);
    expect(bodySpeeds(strafe).starboard).toBeGreaterThan(0);

    const collective = hovering(300);
    fly(collective, 5, { collective: 1 }, false);
    expect(collective.body.velocity.y).toBeGreaterThan(2);

    const tilt = hovering(300);
    fly(tilt, 5, { tilt: 1 }, false);
    expect(bodySpeeds(tilt).forward).toBeGreaterThan(2);
  });

  it('honours per-turbine values set from the turbine panel', () => {
    const model = hovering(300);
    fly(model, 0.5, {}, false);
    model.controls.manualThrottle[1] = 0.9;
    model.controls.manualTilt[2] = 30 * DEG2RAD;
    model.controls.manualThrottle[3] = Number.NaN;
    fly(model, 6, {}, false);
    expect(model.turbines[1].throttle).toBeGreaterThan(0.85);
    expect(model.turbines[2].tilt).toBeCloseTo(30 * DEG2RAD, 3);
    expect(model.turbines[3].throttle).toBeLessThan(0.05);
    expect(model.turbines[0].throttle).toBeCloseTo(HOVER_THROTTLE, 1);
    expectFinite(model);
  });

  it('does not stabilise anything: a disturbance that assist removes keeps growing', () => {
    const disturbed = (assist: boolean) => {
      const model = hovering(600);
      fly(model, 2, {}, assist);
      model.body.angularVelocity.z = -3 * DEG2RAD; // rolling starboard-down
      fly(model, 12, {}, assist);
      return attitude(model).tiltDeg;
    };
    expect(disturbed(true)).toBeLessThan(0.3);
    expect(disturbed(false)).toBeGreaterThan(3);
  });

  it('is hard but possible: a pilot who watches the vertical speed can hold altitude', () => {
    const model = hovering(400);
    fly(model, 1, {}, false);
    model.body.velocity.y = -4; // caught sinking
    let previous = model.body.velocity.y;
    let maxError = 0;
    for (let i = 0; i < 60 * 60; i++) {
      // crude human: aim for a vertical speed that closes the altitude error, and ease off
      // the lever as soon as the ship answers (felt as acceleration)
      const verticalSpeed = model.body.velocity.y;
      const felt = (verticalSpeed - previous) / FIXED_DT;
      previous = verticalSpeed;
      const wanted = Math.max(-5, Math.min(5, (400 - model.body.position.y) * 0.15));
      const collective = Math.max(-1, Math.min(1, (wanted - verticalSpeed) * 0.6 - felt));
      stepFlightModel(model, { ...NEUTRAL, collective }, false);
      if (i > 60 * 25) maxError = Math.max(maxError, Math.abs(model.body.position.y - 400));
    }
    expect(maxError).toBeLessThan(5);
  });

  it('hands back to the computer without a bump: target altitude starts from the current altitude', () => {
    const model = hovering(500, WIND.freeFlightLevel);
    fly(model, 2);
    fly(model, 4, { collective: 0.4, tilt: 1 }, false);
    fly(model, 3, {}, false);
    const altitude = model.body.position.y;
    const lever = model.turbines.reduce((a, t) => a + t.tilt, 0) / 4;
    const throttles = model.turbines.map((t) => t.throttle);
    fly(model, FIXED_DT, {}, true);
    expect(model.controls.targetAltitude).toBeCloseTo(altitude, 1);
    expect(model.controls.tiltLever).toBeCloseTo(lever, 3);
    model.turbines.forEach((t, i) =>
      expect(Math.abs(t.throttle - throttles[i])).toBeLessThan(0.02),
    );
    const target = model.controls.targetAltitude;
    fly(model, 45);
    expect(model.controls.targetAltitude).toBe(target);
    expect(Math.abs(model.body.position.y - target)).toBeLessThan(3);
    expect(attitude(model).tiltDeg).toBeLessThan(1);
    expect(Math.abs(yawRateDeg(model))).toBeLessThan(0.2);
  });

  it('idles the engines again when assist is switched on while afloat', () => {
    const model = createFlightModel();
    fly(model, 2);
    fly(model, 1.5, { collective: 1 }, false);
    expect(model.turbines[0].throttle).toBeGreaterThan(0.1);
    fly(model, 10, {}, true);
    expect(model.computer.idle).toBe(true);
    for (const t of model.turbines) expect(t.throttle).toBeLessThan(0.01);
  });
});

describe('robustness', () => {
  it('is deterministic', () => {
    const run = () => {
      const model = createFlightModel({ windLevel: WIND.opsLevel });
      fly(model, 2);
      fly(model, 10, { collective: 1, yaw: 0.5 });
      fly(model, 10, { tilt: 1, strafe: -0.5 });
      return [...model.body.position.toArray(), ...model.body.quaternion.toArray()];
    };
    expect(run()).toEqual(run());
  });

  it('never produces NaN or Infinity, whatever comes in', () => {
    const garbage = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e9, -1e9];
    for (const assist of [true, false]) {
      const model = hovering(300, WIND.opsLevel);
      for (let i = 0; i < 60 * 40; i++) {
        const g = garbage[i % garbage.length];
        if (i % 97 === 0) model.controls.targetAltitude = g;
        if (i % 89 === 0) model.controls.tiltLever = g;
        if (i % 83 === 0) model.controls.manualThrottle[i % 4] = g;
        if (i % 79 === 0) model.controls.manualTilt[i % 4] = g;
        if (i % 71 === 0) model.turbines[i % 4].throttleCmd = g;
        if (i % 331 === 0) model.turbines[i % 4].enabled = !model.turbines[i % 4].enabled;
        stepFlightModel(model, { collective: g, tilt: -g, yaw: g, strafe: g }, assist);
      }
      expectFinite(model);
    }
  });

  it('survives absurd states: inverted, spinning, deep under water, far above the ceiling', () => {
    const cases: ((m: FlightModel) => void)[] = [
      (m) => m.body.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI),
      (m) => m.body.angularVelocity.set(3, -2, 5),
      (m) => m.body.position.setY(-300),
      (m) => m.body.position.setY(60000),
      (m) => m.body.velocity.set(900, -900, 900),
    ];
    for (const assist of [true, false]) {
      for (const disturb of cases) {
        const model = hovering(500, WIND.freeFlightLevel);
        disturb(model);
        fly(model, 40, { collective: 0.3 }, assist);
        expectFinite(model);
      }
    }
  });

  it('rights itself from a large upset with flight assist', () => {
    const model = hovering(1200);
    model.body.quaternion.setFromAxisAngle(new Vector3(1, 0, 1).normalize(), 35 * DEG2RAD);
    fly(model, 40);
    expect(attitude(model).tiltDeg).toBeLessThan(1);
  });
});
