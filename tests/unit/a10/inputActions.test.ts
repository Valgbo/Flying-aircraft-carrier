import { describe, expect, it } from 'vitest';
import {
  ALTITUDE_ALERT_STEPS_FT,
  appActionForPress,
  commandForPress,
  nextAltitudeAlert,
  nextView,
  stepSoi,
  weaponView,
  type SwitchState,
} from '../../../src/a10/input/actions';
import { applyBinding, defaultBindingsConfig } from '../../../src/a10/input/bindings';
import { CONTROL_DEFS, CONTROL_IDS } from '../../../src/a10/input/controls';
import { buildControlsReference } from '../../../src/a10/input/controlsReference';

const S: SwitchState = {
  masterArm: 'SAFE',
  laserArm: 'SAFE',
  soi: 'HUD',
  flapHandle: 0,
  altitudeAlert: 0,
};

describe('presses → commands', () => {
  it('the armament panel keys are two-way switches', () => {
    expect(commandForPress('masterArm', false, S)).toEqual({ type: 'masterArm', value: 'ARM' });
    expect(commandForPress('masterArm', false, { ...S, masterArm: 'ARM' })).toEqual({
      type: 'masterArm',
      value: 'SAFE',
    });
    expect(commandForPress('masterArm', false, { ...S, masterArm: 'TRAIN' })).toEqual({
      type: 'masterArm',
      value: 'ARM',
    });
    expect(commandForPress('laserArm', false, S)).toEqual({ type: 'laserArm', value: 'ARM' });
    expect(commandForPress('gunPac', false, S)).toEqual({ type: 'gunPac', value: 'cycle' });
    expect(commandForPress('tgpPower', false, S)).toEqual({ type: 'tgpPower', value: 'toggle' });
    expect(commandForPress('altSource', false, S)).toEqual({ type: 'altSource', value: 'cycle' });
  });

  it('HOTAS hats carry short or long', () => {
    expect(commandForPress('tmsUp', true, S)).toEqual({ type: 'tms', dir: 'up', long: true });
    expect(commandForPress('tmsDown', false, S)).toEqual({ type: 'tms', dir: 'down', long: false });
    expect(commandForPress('dmsLeft', false, S)).toEqual({ type: 'dms', dir: 'left', long: false });
    expect(commandForPress('coolieRight', true, S)).toEqual({
      type: 'coolie',
      dir: 'right',
      long: true,
    });
    expect(commandForPress('chinaFwd', true, S)).toEqual({
      type: 'chinaHat',
      dir: 'fwd',
      long: true,
    });
  });

  it('the sensor of interest: direct keys and steps along the cockpit', () => {
    expect(commandForPress('soiLeft', false, S)).toEqual({ type: 'soi', value: 'LMFD' });
    expect(stepSoi('HUD', -1)).toBe('LMFD');
    expect(stepSoi('LMFD', -1)).toBe('LMFD');
    expect(stepSoi('LMFD', 1)).toBe('HUD');
    expect(stepSoi('HUD', 1)).toBe('RMFD');
    expect(commandForPress('soiStepRight', false, { ...S, soi: 'RMFD' })).toEqual({
      type: 'soi',
      value: 'RMFD',
    });
  });

  it('flaps step UP → MVR → DN → UP; the altitude alert steps through its settings', () => {
    expect(commandForPress('flaps', false, S)).toEqual({ type: 'flaps', value: 1 });
    expect(commandForPress('flaps', false, { ...S, flapHandle: 2 })).toEqual({
      type: 'flaps',
      value: 0,
    });
    const m = ALTITUDE_ALERT_STEPS_FT.map((ft) => ft * 0.3048);
    expect(nextAltitudeAlert(0)).toBeCloseTo(m[1], 6);
    expect(nextAltitudeAlert(m[1])).toBeCloseTo(m[2], 6);
    expect(nextAltitudeAlert(m[m.length - 1])).toBe(0);
    expect(nextAltitudeAlert(350 * 0.3048)).toBeCloseTo(m[2], 6);
  });

  it('jettison needs the long hold', () => {
    expect(commandForPress('jettison', false, S)).toBeNull();
    expect(commandForPress('jettison', true, S)).toEqual({ type: 'jettison', stations: 'all' });
  });

  it('every press control maps to a command or an app action (except the engine-handled ones)', () => {
    const engineHandled = new Set(['speedBrakeToggle']);
    for (const id of CONTROL_IDS) {
      if (CONTROL_DEFS[id].kind !== 'press' || engineHandled.has(id)) continue;
      const mapped = commandForPress(id, true, S) ?? appActionForPress(id);
      expect(mapped, id).not.toBeNull();
    }
  });

  it('views: F1–F4 select, F5 alternates weapon and target, Back cycles all', () => {
    expect(appActionForPress('viewChase')).toEqual({ type: 'view', view: 'chase' });
    expect(weaponView('cockpit')).toBe('weapon');
    expect(weaponView('weapon')).toBe('target');
    expect(nextView('cockpit')).toBe('chase');
    expect(nextView('target')).toBe('cockpit');
    expect(appActionForPress('zoomIn')).toEqual({ type: 'zoom', steps: 1 });
  });
});

describe('controls reference', () => {
  const row = (rows: ReturnType<typeof buildControlsReference>, id: string) =>
    rows.find((r) => r.id === id)!;

  it('matches the PLAN_A10.md §12 table with the default bindings', () => {
    const rows = buildControlsReference(defaultBindingsConfig(), false);
    const expectRow = (id: string, keyboard: string, gamepad: string) =>
      expect({ id, keyboard: row(rows, id).keyboard, gamepad: row(rows, id).gamepad }).toEqual({
        id,
        keyboard,
        gamepad,
      });
    expectRow('stick', 'Arrow keys', 'Left stick');
    expectRow('rudder', 'Z / X', 'LB / RB');
    expectRow('throttles', 'Page Up / Page Down', 'D-pad ↑ / ↓');
    expectRow('speedBrake', 'B', 'B');
    expectRow('trim', 'Ctrl + arrow keys', 'LT + D-pad');
    expectRow('trigger1', 'Left Shift', 'RT half');
    expectRow('trigger2', 'Space', 'RT full');
    expectRow('weaponRelease', 'Enter', 'A');
    expectRow('masterMode', 'M', 'X');
    expectRow('profile', '[ / ]', 'Y');
    expectRow('soi', 'H / comma / full stop', 'D-pad ← / →');
    expectRow('slew', 'W A S D', 'LT + right stick');
    expectRow('tmsUp', 'T', 'LT + A');
    expectRow('tmsDown', 'R', 'LT + B');
    expectRow('chinaFwd', 'V', 'LT + X');
    expectRow('picture', 'C', '—');
    expectRow('sensorZoom', 'E / Q', '—');
    expectRow('laser', 'L', 'LT + Y');
    expectRow('masterArm', '1', '—');
    expectRow('autopilot', 'P / O', '—');
    expectRow('look', 'Mouse, Num 2 4 6 8', 'Right stick');
    expectRow('zoom', 'Wheel / Mouse middle', 'Right stick click');
    expectRow('lookAtSpi', 'N', '—');
    expectRow('cursorFree', 'Left Alt', '—');
    expectRow('views', 'F1 to F5', 'Back');
    expectRow('pause', 'Esc', 'Start');
    expect(row(rows, 'trigger1').action).toBe('Trigger: first detent (PAC-1)');
    expect(row(rows, 'masterArm').group).toBe('Armament panel');
  });

  it('leaves out unbound HOTAS rows and follows rebinding', () => {
    let config = defaultBindingsConfig();
    let rows = buildControlsReference(config, false);
    expect(rows.find((r) => r.id === 'dms')).toBeUndefined();
    config = applyBinding(config, 'masterArm', { src: { type: 'key', code: 'KeyY' } }, 0).config;
    config = applyBinding(config, 'dmsUp', { src: { type: 'padButton', button: 10 } }, null).config;
    rows = buildControlsReference(config, false);
    expect(row(rows, 'masterArm').keyboard).toBe('Y');
    expect(row(rows, 'dms').gamepad).toBe('Left stick click');
  });

  it('mentions the mouse in mouse-stick mode', () => {
    const rows = buildControlsReference(defaultBindingsConfig(), true);
    expect(row(rows, 'stick').keyboard).toBe('Arrow keys, mouse');
    expect(row(rows, 'look').keyboard).toBe('Mouse with Mouse right held, Num 2 4 6 8');
  });
});
