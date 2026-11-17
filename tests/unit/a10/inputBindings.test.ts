import { describe, expect, it } from 'vitest';
import {
  BINDINGS_STORAGE_KEY,
  DEFAULT_OPTIONS,
  applyBinding,
  bindingEquals,
  bindingsOverlap,
  defaultBindingsConfig,
  defaultBindingsFor,
  findConflicts,
  isDefaultControl,
  loadBindings,
  removeBinding,
  resetControl,
  sanitizeBinding,
  sanitizeBindings,
  sanitizeCal,
  saveBindings,
  updateCal,
  type Binding,
  type BindingsConfig,
} from '../../../src/a10/input/bindings';
import { CONTROL_DEFS, CONTROL_IDS, type ControlId } from '../../../src/a10/input/controls';
import { bindingName } from '../../../src/a10/input/labels';

const key = (code: string, extra: Partial<Binding> = {}): Binding => ({
  src: { type: 'key', code },
  ...extra,
});

function names(config: BindingsConfig, id: ControlId): string[] {
  return config.controls[id].map((b) => bindingName(b, config));
}

describe('default bindings (PLAN_A10.md §12)', () => {
  const d = defaultBindingsConfig();

  it('lay the keyboard out as the plan says', () => {
    expect(names(d, 'pitch')).toEqual(['↑', '↓', 'Left stick ↕']);
    expect(names(d, 'roll')).toEqual(['←', '→', 'Left stick ↔']);
    expect(names(d, 'rudder')).toEqual(['Z', 'X', 'LB', 'RB']);
    expect(names(d, 'throttleBoth')).toEqual(['Page Up', 'Page Down', 'D-pad ↑', 'D-pad ↓']);
    expect(names(d, 'speedBrakeToggle')).toEqual(['B', 'B']);
    expect(names(d, 'flaps')).toEqual(['F']);
    expect(names(d, 'gear')).toEqual(['G']);
    expect(names(d, 'trimPitch')).toEqual([
      'Ctrl + ↑',
      'Ctrl + ↓',
      'Ctrl + Shift + ↑',
      'Ctrl + Shift + ↓',
      'LT + D-pad ↑',
      'LT + D-pad ↓',
    ]);
    expect(names(d, 'trimRoll')).toEqual([
      'Ctrl + ←',
      'Ctrl + →',
      'Ctrl + Shift + ←',
      'Ctrl + Shift + →',
      'LT + D-pad ←',
      'LT + D-pad →',
    ]);
    expect(names(d, 'triggerFirst')).toEqual(['Left Shift']);
    expect(names(d, 'triggerSecond')).toEqual(['Space']);
    expect(names(d, 'triggerAxis')).toEqual(['RT']);
    expect(names(d, 'weaponRelease')).toEqual(['Enter', 'A']);
    expect(names(d, 'masterMode')).toEqual(['M', 'X']);
    expect(names(d, 'profilePrev')).toEqual(['[']);
    expect(names(d, 'profileNext')).toEqual([']', 'Y']);
    expect(names(d, 'soiHud')).toEqual(['H']);
    expect(names(d, 'soiLeft')).toEqual([',']);
    expect(names(d, 'soiRight')).toEqual(['.']);
    expect(names(d, 'soiStepLeft')).toEqual(['D-pad ←']);
    expect(names(d, 'slewX')).toEqual(['A', 'D', 'LT + Right stick ↔']);
    expect(names(d, 'slewY')).toEqual(['S', 'W', 'LT + Right stick ↕']);
    expect(names(d, 'tmsUp')).toEqual(['T', 'LT + A']);
    expect(names(d, 'tmsDown')).toEqual(['R', 'LT + B']);
    expect(names(d, 'chinaFwd')).toEqual(['V', 'LT + X']);
    expect(names(d, 'sensorPicture')).toEqual(['C']);
    expect(names(d, 'sensorZoomIn')).toEqual(['E']);
    expect(names(d, 'sensorZoomOut')).toEqual(['Q']);
    expect(names(d, 'laser')).toEqual(['L', 'LT + Y']);
    expect(names(d, 'masterArm')).toEqual(['1']);
    expect(names(d, 'gunPac')).toEqual(['2']);
    expect(names(d, 'laserArm')).toEqual(['3']);
    expect(names(d, 'tgpPower')).toEqual(['4']);
    expect(names(d, 'autopilot')).toEqual(['P']);
    expect(names(d, 'autopilotMode')).toEqual(['O']);
    expect(names(d, 'lookAtSpi')).toEqual(['N']);
    expect(names(d, 'cursorFree')).toEqual(['Left Alt']);
    expect(names(d, 'viewCockpit')).toEqual(['F1']);
    expect(names(d, 'viewWeapon')).toEqual(['F5']);
    expect(names(d, 'viewCycle')).toEqual(['Back']);
    expect(names(d, 'pause')).toEqual(['Esc', 'Start']);
    expect(names(d, 'zoomIn')).toEqual(['Wheel up']);
    expect(names(d, 'zoomHold')).toEqual(['Mouse middle', 'Right stick click']);
    expect(names(d, 'lookX')).toContain('Right stick ↔');
    expect(names(d, 'padShift')).toEqual(['LT']);
  });

  it('give pitch = +axis 1 (stick back) and the keys the plan directions', () => {
    const pitch = d.controls.pitch;
    expect(pitch[0]).toMatchObject({ src: { code: 'ArrowUp' }, dir: -1 });
    expect(pitch[1]).toMatchObject({ src: { code: 'ArrowDown' }, dir: 1 });
    expect(pitch[2].src).toEqual({ type: 'padAxis', axis: 1 });
    expect(pitch[2].cal?.invert).toBe(false);
    // standard axis 3 is -1 pushed up; slew and look are + up
    expect(d.controls.slewY[2].cal?.invert).toBe(true);
    expect(d.controls.lookY[2].cal?.invert).toBe(true);
  });

  it('never use one input for two controls', () => {
    expect(findConflicts(d).size).toBe(0);
  });

  it('are valid bindings for their controls (sanitising changes nothing)', () => {
    const clean = sanitizeBindings(JSON.parse(JSON.stringify(d)));
    for (const id of CONTROL_IDS) {
      expect(clean.controls[id].length, id).toBe(d.controls[id].length);
      clean.controls[id].forEach((b, i) =>
        expect(bindingEquals(b, d.controls[id][i]), id).toBe(true),
      );
      expect(isDefaultControl(d, id)).toBe(true);
    }
  });
});

describe('sanitising stored bindings', () => {
  it('falls back to the defaults for garbage', () => {
    for (const raw of [null, 42, 'x', [], { controls: 'nope' }]) {
      expect(sanitizeBindings(raw)).toEqual(defaultBindingsConfig());
    }
  });

  it('checks each control on its own: missing or broken controls get their defaults', () => {
    const raw = {
      controls: {
        pitch: 'broken',
        roll: [{ src: { type: 'key', code: 'KeyJ' }, dir: -1 }],
        rudder: [{ src: { type: 'nonsense' } }, { foo: 1 }],
        gear: [],
        notAControl: [{ src: { type: 'key', code: 'KeyG' } }],
      },
    };
    const c = sanitizeBindings(raw);
    expect(c.controls.pitch).toEqual(defaultBindingsFor('pitch'));
    expect(c.controls.roll).toEqual([{ src: { type: 'key', code: 'KeyJ' }, dir: -1 }]);
    // every entry broken → the defaults
    expect(c.controls.rudder).toEqual(defaultBindingsFor('rudder'));
    // cleared by the pilot → stays empty
    expect(c.controls.gear).toEqual([]);
    expect(c.controls.weaponRelease).toEqual(defaultBindingsFor('weaponRelease'));
    expect((c.controls as Record<string, unknown>).notAControl).toBeUndefined();
  });

  it('drops bad entries of an otherwise good list and duplicates', () => {
    const c = sanitizeBindings({
      controls: {
        masterArm: [
          { src: { type: 'key', code: 'Digit9' } },
          { src: { type: 'key', code: 'not a code!' } },
          { src: { type: 'key', code: 'Digit9' } },
          { src: { type: 'mouse', button: 99 } },
        ],
      },
    });
    expect(c.controls.masterArm).toEqual([{ src: { type: 'key', code: 'Digit9' } }]);
  });

  it('validates sources against the kind of control', () => {
    // a key cannot be the analogue trigger, an axis cannot be a press, a wheel cannot fly
    expect(sanitizeBinding(key('KeyQ'), 'triggerAxis')).toBeNull();
    expect(sanitizeBinding({ src: { type: 'padAxis', axis: 1 } }, 'masterArm')).toBeNull();
    expect(sanitizeBinding({ src: { type: 'wheel', dir: 1 } }, 'pitch')).toBeNull();
    // digital inputs on an axis need a direction
    expect(sanitizeBinding(key('KeyJ'), 'pitch')).toBeNull();
    expect(sanitizeBinding(key('KeyJ', { dir: 1 }), 'pitch')).toEqual(key('KeyJ', { dir: 1 }));
    // an axis used as a button in one direction is a valid press
    expect(sanitizeBinding({ src: { type: 'padAxis', axis: 7, dir: -1 } }, 'coolieLeft')).toEqual({
      src: { type: 'padAxis', axis: 7, dir: -1 },
    });
    // the shift layer only exists for gamepad and joystick inputs
    expect(sanitizeBinding({ ...key('KeyJ'), layer: 'shift' }, 'gear')).toEqual(key('KeyJ'));
    // a device reference must be complete
    expect(
      sanitizeBinding({ src: { type: 'hidButton', device: { key: 'x' }, button: 1 } }, 'gear'),
    ).toBeNull();
  });

  it('fixes calibration field by field', () => {
    const cal = sanitizeCal({
      invert: 'yes',
      deadZone: 0.2,
      saturation: 7,
      curve: -1,
      centre: 0.1,
    });
    expect(cal).toEqual({ invert: false, deadZone: 0.2, saturation: 1, curve: 0, centre: 0.1 });
    // a saturation below the dead zone is pushed above it
    expect(sanitizeCal({ deadZone: 0.5, saturation: 0.5 }).saturation).toBeCloseTo(0.55);
    const b = sanitizeBinding(
      { src: { type: 'padAxis', axis: 1 }, cal: { deadZone: 'big', curve: 0.7 } },
      'pitch',
    );
    expect(b?.cal?.curve).toBe(0.7);
    expect(b?.cal?.deadZone).toBe(0.12);
  });

  it('checks options field by field', () => {
    const c = sanitizeBindings({ options: { mouseLookSpeed: 2, keyRampTime: -3, rumble: 'no' } });
    expect(c.options).toEqual({ ...DEFAULT_OPTIONS, mouseLookSpeed: 2 });
  });

  it('round-trips through storage under a10-bindings-v1', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    const c = applyBinding(defaultBindingsConfig(), 'gear', key('KeyY'), 0).config;
    saveBindings(storage, c);
    expect([...mem.keys()]).toEqual([BINDINGS_STORAGE_KEY]);
    expect(loadBindings(storage)).toEqual(c);
    mem.set(BINDINGS_STORAGE_KEY, '{not json');
    expect(loadBindings(storage)).toEqual(defaultBindingsConfig());
    expect(loadBindings(null)).toEqual(defaultBindingsConfig());
  });
});

describe('rebinding and conflicts', () => {
  const d = defaultBindingsConfig();

  it('changing a binding to a key in use swaps the two', () => {
    // Master Arm "1" changed to "M" (master mode): master mode gets "1"
    const r = applyBinding(d, 'masterArm', key('KeyM'), 0);
    expect(r.changed).toBe(true);
    expect(r.conflict).toEqual({ control: 'masterMode', action: 'swapped' });
    expect(names(r.config, 'masterArm')).toEqual(['M']);
    expect(names(r.config, 'masterMode')).toEqual(['1', 'X']);
    expect(findConflicts(r.config).size).toBe(0);
    expect(d.controls.masterArm[0].src).toEqual({ type: 'key', code: 'Digit1' });
  });

  it('a swapped key keeps the direction of the slot it lands in', () => {
    // pitch "↑" (push) changed to "Z" (rudder left): rudder left becomes "↑"
    const r = applyBinding(d, 'pitch', key('KeyZ', { dir: -1 }), 0);
    expect(r.conflict).toEqual({ control: 'rudder', action: 'swapped' });
    expect(r.config.controls.rudder[0]).toEqual(key('ArrowUp', { dir: -1 }));
    expect(r.config.controls.pitch[0]).toEqual(key('KeyZ', { dir: -1 }));
  });

  it('adding a key in use clears it from the other control', () => {
    const r = applyBinding(d, 'gear', key('KeyF'), null);
    expect(r.conflict).toEqual({ control: 'flaps', action: 'cleared' });
    expect(names(r.config, 'gear')).toEqual(['G', 'F']);
    expect(r.config.controls.flaps).toEqual([]);
  });

  it('does not swap a key with an axis', () => {
    const stick: Binding = { src: { type: 'padAxis', axis: 0 }, cal: d.controls.roll[2].cal };
    // rudder "Z" replaced by the left stick X axis (roll's): roll loses the axis, gets no key
    const r = applyBinding(d, 'rudder', stick, 0);
    expect(r.conflict).toEqual({ control: 'roll', action: 'cleared' });
    expect(names(r.config, 'roll')).toEqual(['←', '→']);
  });

  it('refuses an input already bound to the same control', () => {
    const r = applyBinding(d, 'pitch', key('ArrowDown', { dir: -1 }), null);
    expect(r).toMatchObject({ changed: false, duplicate: true });
    expect(r.config).toBe(d);
  });

  it('treats modifiers and the gamepad layer as different inputs', () => {
    const shiftA: Binding = { src: { type: 'padButton', button: 0 }, layer: 'shift' };
    const plainA: Binding = { src: { type: 'padButton', button: 0 } };
    expect(bindingsOverlap(shiftA, plainA)).toBe(false);
    expect(
      bindingsOverlap(key('ArrowUp'), { src: { type: 'key', code: 'ArrowUp', ctrl: true } }),
    ).toBe(false);
    expect(
      bindingsOverlap(
        { src: { type: 'padAxis', axis: 7, dir: 1 } },
        { src: { type: 'padAxis', axis: 7, dir: -1 } },
      ),
    ).toBe(false);
    expect(
      bindingsOverlap(
        { src: { type: 'padAxis', axis: 7 } },
        { src: { type: 'padAxis', axis: 7, dir: -1 } },
      ),
    ).toBe(true);
  });

  it('removes, re-tunes and resets one control', () => {
    let c = removeBinding(d, 'pitch', 2);
    expect(names(c, 'pitch')).toEqual(['↑', '↓']);
    expect(isDefaultControl(c, 'pitch')).toBe(false);
    c = resetControl(c, 'pitch');
    expect(isDefaultControl(c, 'pitch')).toBe(true);
    c = updateCal(c, 'pitch', 2, { ...c.controls.pitch[2].cal!, deadZone: 0.3, curve: 2 });
    expect(c.controls.pitch[2].cal).toMatchObject({ deadZone: 0.3, curve: 0.4 });
    // only analogue bindings have a calibration
    expect(updateCal(c, 'pitch', 0, c.controls.pitch[2].cal!)).toBe(c);
  });

  it('flags controls that share an input (settings from an older build)', () => {
    const c = sanitizeBindings({ controls: { gear: [{ src: { type: 'key', code: 'KeyF' } }] } });
    expect([...findConflicts(c)].sort()).toEqual(['flaps', 'gear']);
  });

  it('every control has a group, a label and a kind', () => {
    for (const id of CONTROL_IDS) {
      const def = CONTROL_DEFS[id];
      expect(def.label.length).toBeGreaterThan(2);
      expect(def.id).toBe(id);
      if (def.kind === 'axis' || def.kind === 'lever') expect(def.dirWords).toHaveLength(2);
      if (def.kind === 'lever') expect(def.levers?.length).toBeGreaterThan(0);
    }
  });
});
