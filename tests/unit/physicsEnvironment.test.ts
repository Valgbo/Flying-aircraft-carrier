/** Wind model and water-contact detection (the parts of the physics module around the flight model). */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { WIND } from '../../src/config/physicsConfig';
import { createWaterContactState, updateWaterContact } from '../../src/physics/flightEvents';
import { createFlightModel, setHover, stepFlightModel } from '../../src/physics/flightModel';
import { sampleWind } from '../../src/physics/wind';

function windStats(level: number) {
  const wind = new Vector3();
  const turbulence = new Vector3();
  let peakWind = 0;
  let peakTurbulence = 0;
  let peakStep = 0;
  let meanSpeed = 0;
  const previous = new Vector3();
  const samples = 60 * 600;
  for (let i = 0; i < samples; i++) {
    sampleWind(i / 60, level, wind, turbulence);
    peakWind = Math.max(peakWind, wind.length());
    peakTurbulence = Math.max(peakTurbulence, turbulence.length());
    if (i > 0) peakStep = Math.max(peakStep, wind.distanceTo(previous));
    previous.copy(wind);
    meanSpeed += wind.length() / samples;
  }
  return { peakWind, peakTurbulence, peakStep, meanSpeed };
}

describe('wind', () => {
  it('is dead calm at level 0 and for invalid input', () => {
    const wind = new Vector3(1, 2, 3);
    const turbulence = new Vector3(4, 5, 6);
    sampleWind(12, 0, wind, turbulence);
    expect(wind.length()).toBe(0);
    expect(turbulence.length()).toBe(0);
    sampleWind(Number.NaN, 1, wind.set(1, 1, 1), turbulence.set(1, 1, 1));
    expect(wind.length()).toBe(0);
    expect(turbulence.length()).toBe(0);
  });

  it('is a smooth, deterministic function of simulation time', () => {
    const a = new Vector3();
    const b = new Vector3();
    const t = new Vector3();
    sampleWind(73.25, WIND.opsLevel, a, t);
    sampleWind(73.25, WIND.opsLevel, b, t);
    expect(a.toArray()).toEqual(b.toArray());
    // no jumps from one physics step to the next, even in the strongest wind
    expect(windStats(WIND.opsLevel).peakStep).toBeLessThan(0.2);
  });

  it('is light in free flight and clearly stronger on flight ops', () => {
    const free = windStats(WIND.freeFlightLevel);
    const ops = windStats(WIND.opsLevel);
    expect(free.meanSpeed).toBeGreaterThan(1.5);
    expect(free.peakWind).toBeLessThan(7);
    expect(ops.meanSpeed).toBeGreaterThan(2 * free.meanSpeed);
    expect(ops.peakWind).toBeLessThan(18);
    expect(ops.peakTurbulence).toBeGreaterThan(4 * free.peakTurbulence);
  });

  it('is written to the model environment and drifts a hovering ship downwind', () => {
    const model = createFlightModel({ windLevel: WIND.opsLevel });
    setHover(model, 500);
    for (let i = 0; i < 60 * 60; i++) {
      stepFlightModel(model, { collective: 0, tilt: 0, yaw: 0, strafe: 0 }, true);
    }
    expect(model.env.wind.length()).toBeGreaterThan(2);
    const drift = new Vector3(model.body.velocity.x, 0, model.body.velocity.z);
    const downwind = new Vector3(model.env.wind.x, 0, model.env.wind.z);
    expect(drift.length()).toBeGreaterThan(1);
    expect(drift.dot(downwind)).toBeGreaterThan(0);
  });
});

describe('water contact', () => {
  it('starts in the state the ship is in and reports no event without a transition', () => {
    const afloat = createWaterContactState(-10);
    expect(afloat.inWater).toBe(true);
    expect(updateWaterContact(afloat, -9.5)).toBeNull();
    const flying = createWaterContactState(400);
    expect(flying.inWater).toBe(false);
    expect(updateWaterContact(flying, 399)).toBeNull();
  });

  it('reports lift-off once the keel is clear and splashdown when it meets the water', () => {
    const state = createWaterContactState(-10);
    expect(updateWaterContact(state, -2)).toBeNull();
    expect(updateWaterContact(state, 0.8)).toBeNull(); // a wave trough is not a lift-off
    expect(updateWaterContact(state, 1.6)).toBe('liftOff');
    expect(updateWaterContact(state, 30)).toBeNull();
    expect(updateWaterContact(state, 0.5)).toBeNull();
    expect(updateWaterContact(state, -0.1)).toBe('splashdown');
    expect(updateWaterContact(state, -0.5)).toBeNull();
    expect(updateWaterContact(state, 0.5)).toBeNull(); // bobbing does not chatter
    expect(updateWaterContact(state, -3)).toBeNull();
  });

  it('sees exactly one lift-off and one splashdown in a take-off and landing', () => {
    const model = createFlightModel();
    const state = createWaterContactState(model.keelClearance);
    const events: string[] = [];
    const fly = (seconds: number) => {
      for (let i = 0; i < seconds * 60; i++) {
        stepFlightModel(model, { collective: 0, tilt: 0, yaw: 0, strafe: 0 }, true);
        const event = updateWaterContact(state, model.keelClearance);
        if (event) events.push(event);
      }
    };
    fly(5);
    model.controls.targetAltitude = 80;
    fly(30);
    model.controls.targetAltitude = 0;
    fly(60);
    expect(events).toEqual(['liftOff', 'splashdown']);
  });
});
