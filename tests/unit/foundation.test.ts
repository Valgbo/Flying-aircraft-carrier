import { Quaternion, Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { FLOATING_ALTITUDE, TURBINE_MOUNTS } from '../../src/config/layout';
import { HOVER_THROTTLE, IDLE_ALTITUDE, OPS_START_ALTITUDE } from '../../src/config/physicsConfig';
import { waveHeightAt } from '../../src/config/waves';
import { combineInput, clearInput, input, inputSources } from '../../src/controls/input';
import { emitAction, onAction } from '../../src/state/actions';
import { resetSimForScreen, sim, updateDerived } from '../../src/state/sim';
import {
  carrierLocalToWorld,
  getDownwash,
  getTurbineExhaust,
  thrustAxisLocal,
} from '../../src/state/simHelpers';
import {
  CAMERA_CYCLE,
  DEFAULT_SETTINGS,
  overrideSettings,
  sanitizeSettings,
  useGameStore,
  type Settings,
} from '../../src/state/useGameStore';
import {
  clamp,
  damp,
  deadzone,
  deltaDeg,
  moveToward,
  wrapAngle,
  wrapDeg360,
} from '../../src/utils/math';

describe('math helpers', () => {
  it('clamps, wraps and steps', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(wrapDeg360(-10)).toBe(350);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(deltaDeg(350, 10)).toBe(20);
    expect(deltaDeg(10, 350)).toBe(-20);
    expect(moveToward(0, 1, 0.25)).toBe(0.25);
    expect(moveToward(0.9, 1, 0.25)).toBe(1);
    expect(deadzone(0.05)).toBe(0);
    expect(deadzone(1)).toBe(1);
  });

  it('damp converges without overshoot and is frame-rate independent', () => {
    let a = 0;
    for (let i = 0; i < 60; i++) a = damp(a, 1, 3, 1 / 60);
    let b = 0;
    for (let i = 0; i < 30; i++) b = damp(b, 1, 3, 1 / 30);
    expect(a).toBeCloseTo(b, 6);
    expect(a).toBeGreaterThan(0.9);
    expect(a).toBeLessThan(1);
  });
});

describe('sim state', () => {
  it('starts each screen in the documented state', () => {
    resetSimForScreen('flight');
    expect(sim.carrier.position.y).toBe(FLOATING_ALTITUDE);
    expect(sim.turbines.every((t) => t.throttle === 0)).toBe(true);
    expect(sim.carrier.afloat).toBe(true);

    resetSimForScreen('ops');
    expect(sim.carrier.position.y).toBe(OPS_START_ALTITUDE);
    expect(sim.turbines[0].throttle).toBeCloseTo(HOVER_THROTTLE);
    expect(sim.controls.targetAltitude).toBe(OPS_START_ALTITUDE);
    expect(sim.carrier.afloat).toBe(false);

    resetSimForScreen('menu');
    expect(sim.carrier.position.y).toBe(IDLE_ALTITUDE);
  });

  it('derives heading, pitch and roll with the documented sign conventions', () => {
    resetSimForScreen('menu');
    const c = sim.carrier;
    // bow initially points to world -Z = north
    expect(c.headingDeg).toBeCloseTo(0);
    // a positive rotation about +Y turns the bow to port (west = 270°)
    c.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    updateDerived();
    expect(c.headingDeg).toBeCloseTo(270);
    // bow up: positive rotation about +X lifts the bow (-Z)
    c.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.2);
    updateDerived();
    expect(c.pitch).toBeCloseTo(0.2);
    // starboard side down: a negative rotation about +Z drops +X
    c.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -0.15);
    updateDerived();
    expect(c.roll).toBeCloseTo(0.15);
    c.quaternion.copy(new Quaternion());
    c.velocity.set(0, 3, -20);
    updateDerived();
    expect(c.forwardSpeed).toBeCloseTo(20);
    expect(c.verticalSpeed).toBeCloseTo(3);
  });

  it('thrust axis and exhaust geometry follow the tilt convention', () => {
    resetSimForScreen('menu');
    const axis = thrustAxisLocal(0, new Vector3());
    expect(axis.x).toBeCloseTo(0);
    expect(axis.y).toBeCloseTo(1);
    expect(axis.z).toBeCloseTo(0);
    thrustAxisLocal(Math.PI / 6, axis);
    expect(axis.z).toBeLessThan(0); // leans toward the bow
    const pos = new Vector3();
    const dir = new Vector3();
    getTurbineExhaust(0, pos, dir);
    expect(dir.y).toBeCloseTo(-1);
    expect(pos.x).toBeCloseTo(TURBINE_MOUNTS[0][0]);
    expect(pos.y).toBeLessThan(sim.carrier.position.y + TURBINE_MOUNTS[0][1]);
    const world = carrierLocalToWorld([1, 2, 3], new Vector3());
    expect(world.y).toBeCloseTo(IDLE_ALTITUDE + 2);
  });

  it('downwash only reaches the sea at low altitude', () => {
    resetSimForScreen('menu');
    const high = getDownwash(0, { x: 0, z: 0, distance: 0, strength: 0 });
    expect(high.strength).toBe(0);
    sim.carrier.position.y = 30;
    const low = getDownwash(0, { x: 0, z: 0, distance: 0, strength: 0 });
    expect(low.strength).toBeGreaterThan(0.3);
    expect(low.x).toBeCloseTo(TURBINE_MOUNTS[0][0]);
    resetSimForScreen('menu');
  });

  it('waves stay within a sane envelope', () => {
    let max = 0;
    for (let i = 0; i < 500; i++)
      max = Math.max(max, Math.abs(waveHeightAt(i * 7.3, i * -3.1, i * 0.37)));
    expect(max).toBeGreaterThan(0.5);
    expect(max).toBeLessThan(3);
  });
});

describe('input and actions', () => {
  it('sums and clamps sources', () => {
    clearInput();
    inputSources.keyboard.collective = 1;
    inputSources.gamepad.collective = 0.6;
    inputSources.touch.yaw = -0.4;
    combineInput();
    expect(input.collective).toBe(1);
    expect(input.yaw).toBeCloseTo(-0.4);
    clearInput();
    expect(input.collective).toBe(0);
  });

  it('delivers actions to subscribers until unsubscribed', () => {
    let n = 0;
    const off = onAction('launchJet', () => n++);
    emitAction('launchJet');
    off();
    emitAction('launchJet');
    expect(n).toBe(1);
  });
});

describe('game store', () => {
  beforeEach(() => {
    useGameStore.getState().setScreen('menu');
  });

  it('switching to a flying screen resets the sim and selects the chase camera', () => {
    const before = useGameStore.getState().resetNonce;
    useGameStore.getState().setScreen('flight');
    const s = useGameStore.getState();
    expect(s.screen).toBe('flight');
    expect(s.cameraMode).toBe('chase');
    expect(s.assistEnabled).toBe(true);
    expect(s.resetNonce).toBe(before + 1);
    expect(sim.carrier.position.y).toBe(FLOATING_ALTITUDE);
  });

  it('menu ↔ hangar keeps the idle scene running', () => {
    const before = useGameStore.getState().resetNonce;
    useGameStore.getState().setScreen('hangar');
    expect(useGameStore.getState().resetNonce).toBe(before);
    expect(useGameStore.getState().cameraMode).toBe('orbit');
  });

  it('cycles cameras only while flying', () => {
    useGameStore.getState().cycleCamera();
    expect(useGameStore.getState().cameraMode).toBe('orbit');
    useGameStore.getState().setScreen('flight');
    for (let i = 0; i < CAMERA_CYCLE.length; i++) {
      expect(useGameStore.getState().cameraMode).toBe(CAMERA_CYCLE[i]);
      useGameStore.getState().cycleCamera();
    }
    expect(useGameStore.getState().cameraMode).toBe(CAMERA_CYCLE[0]);
  });

  it('choosing a quality preset also resets the effective preset', () => {
    useGameStore.getState().setEffectiveQuality('low');
    useGameStore.getState().updateSettings({ quality: 'high' });
    expect(useGameStore.getState().effectiveQuality).toBe('high');
    useGameStore.getState().updateSettings({ muted: true });
    expect(useGameStore.getState().effectiveQuality).toBe('high');
  });

  it('a URL-flag override lasts for the session and is saved only once the player changes it', () => {
    const { partialize } = useGameStore.persist.getOptions();
    const saved = () => partialize!(useGameStore.getState()) as { settings: Settings };
    useGameStore.getState().resetSettings();
    overrideSettings({ quality: 'low', adaptiveQuality: false, muted: true });
    expect(useGameStore.getState().settings).toMatchObject({ quality: 'low', muted: true });
    expect(useGameStore.getState().effectiveQuality).toBe('low');
    expect(saved().settings).toEqual(DEFAULT_SETTINGS);

    // an unrelated change is saved, the overridden settings still are not
    useGameStore.getState().updateSettings({ invertY: true });
    expect(saved().settings).toEqual({ ...DEFAULT_SETTINGS, invertY: true });

    // the player picks a preset: that choice is saved, the other overrides stay session-only
    useGameStore.getState().updateSettings({ quality: 'high' });
    expect(saved().settings).toEqual({ ...DEFAULT_SETTINGS, invertY: true, quality: 'high' });
    expect(useGameStore.getState().settings.muted).toBe(true);

    useGameStore.getState().resetSettings();
    expect(useGameStore.getState().settings.muted).toBe(false);
    expect(saved().settings).toEqual(DEFAULT_SETTINGS);
  });

  it('stored settings are taken field by field and bad values fall back to the defaults', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(
      sanitizeSettings({
        quality: 'ultra',
        adaptiveQuality: 'no',
        masterVolume: null,
        engineVolume: 9,
        effectsVolume: 0.25,
        muted: true,
        timeOfDay: 'noon',
        touchControls: 7,
        keyBindings: 'x',
        unknownSetting: 1,
      }),
    ).toEqual({ ...DEFAULT_SETTINGS, engineVolume: 1, effectsVolume: 0.25, muted: true });
    expect(
      sanitizeSettings({
        quality: 'high',
        timeOfDay: 30,
        touchControls: 'off',
        keyBindings: { throttleUp: 'KeyI', yawLeft: '', launchJet: 5, bogus: 'KeyZ' },
      }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      quality: 'high',
      timeOfDay: 24,
      touchControls: 'off',
      keyBindings: { ...DEFAULT_SETTINGS.keyBindings, throttleUp: 'KeyI' },
    });

    // the store's own merge uses it, whatever was stored
    const merge = useGameStore.persist.getOptions().merge!;
    const merged = merge({ settings: { quality: 'ultra' } }, useGameStore.getState());
    expect(merged.settings.quality).toBe(DEFAULT_SETTINGS.quality);
    expect(merged.effectiveQuality).toBe(DEFAULT_SETTINGS.quality);
    expect(merge(null, useGameStore.getState())).toBe(useGameStore.getState());
  });

  it('messages de-duplicate and expire', () => {
    const s = useGameStore.getState();
    s.pushMessage('HELLO', 'info', 10);
    s.pushMessage('HELLO', 'info', 10);
    expect(useGameStore.getState().messages).toHaveLength(1);
    useGameStore.getState().pruneMessages(performance.now() + 1000);
    expect(useGameStore.getState().messages).toHaveLength(0);
  });
});
