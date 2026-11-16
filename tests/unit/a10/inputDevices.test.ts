import { describe, expect, it } from 'vitest';
import {
  HID_STICK_CAL,
  applyBinding,
  defaultBindingsConfig,
  type BindingsConfig,
  type DeviceRef,
} from '../../../src/a10/input/bindings';
import {
  HAT_DOWN,
  HAT_LEFT,
  HAT_RIGHT,
  HAT_UP,
  buttonValue,
  deviceIdentity,
  deviceOrdinal,
  hatMask,
  isHatRest,
  type PadLike,
} from '../../../src/a10/input/devices';
import { InputEngine, createEngineOutput, type FrameContext } from '../../../src/a10/input/engine';

const DT = 1 / 60;

/** A standard-mapping gamepad: 17 buttons, 4 axes. */
function gamepad(
  axes: number[] = [0, 0, 0, 0],
  pressed: Record<number, number> = {},
  index = 0,
): PadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const v = pressed[i] ?? 0;
    return { pressed: v > 0.5, value: v };
  });
  return {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    index,
    mapping: 'standard',
    connected: true,
    axes,
    buttons,
  };
}

const STICK_ID = 'Thrustmaster HOTAS Warthog Joystick (Vendor: 044f Product: 0402)';
const HAT_REST = 1.2857142857142858;

/** A generic stick: axes [x, y, hat], 19 buttons. */
function stick(
  x = 0,
  y = 0,
  hat = HAT_REST,
  buttons: number[] = [],
  index = 1,
  id = STICK_ID,
): PadLike {
  return {
    id,
    index,
    mapping: '',
    connected: true,
    axes: [x, y, hat],
    buttons: Array.from({ length: 19 }, (_, i) => ({
      pressed: buttons.includes(i),
      value: buttons.includes(i) ? 1 : 0,
    })),
  };
}

const STICK_REF: DeviceRef = {
  key: '044f:0402',
  name: 'Thrustmaster HOTAS Warthog Joystick',
  ordinal: 0,
};

function run(config: BindingsConfig, frames: PadLike[][], patch: Partial<FrameContext> = {}) {
  const engine = new InputEngine(config);
  engine.resetLevers([0.5, 0.5]);
  engine.setGate({ live: true, app: true });
  const out = createEngineOutput();
  const presses: string[] = [];
  for (const pads of frames) {
    engine.update(
      {
        dt: DT,
        gate: { live: true, app: true },
        pads,
        twoStageTrigger: true,
        mouseStick: false,
        invertLook: false,
        speedBrakePosition: Number.NaN,
        ...patch,
      },
      out,
    );
    presses.push(...out.presses.map((p) => `${p.id}${p.long ? ':long' : ''}`));
  }
  return { out, presses, engine };
}

describe('device identity', () => {
  it('reads vendor and product from Chromium and Firefox ids alike', () => {
    expect(deviceIdentity(STICK_ID)).toEqual({
      key: '044f:0402',
      name: 'Thrustmaster HOTAS Warthog Joystick',
    });
    expect(deviceIdentity('44f-402-Thrustmaster HOTAS Warthog Joystick')).toEqual({
      key: '044f:0402',
      name: 'Thrustmaster HOTAS Warthog Joystick',
    });
    expect(deviceIdentity('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toEqual({
      key: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)',
      name: 'Xbox 360 Controller',
    });
  });

  it('tells identical devices apart by their order', () => {
    const a = stick(0, 0, HAT_REST, [], 1, 'Rudder Pedals (Vendor: 06a3 Product: 0763)');
    const b = stick(0, 0, HAT_REST, [], 3, 'Rudder Pedals (Vendor: 06a3 Product: 0763)');
    const pads = [gamepad(), a, null, b];
    expect(deviceOrdinal(pads, 1)).toBe(0);
    expect(deviceOrdinal(pads, 3)).toBe(1);
    expect(deviceOrdinal(pads, 0)).toBe(0);
  });

  it('decodes a point-of-view hat reported as one axis', () => {
    expect(isHatRest(HAT_REST)).toBe(true);
    expect(hatMask(HAT_REST)).toBe(0);
    expect(hatMask(-1)).toBe(HAT_UP);
    expect(hatMask(-1 + 2 / 7)).toBe(HAT_UP | HAT_RIGHT);
    expect(hatMask(-1 + 4 / 7)).toBe(HAT_RIGHT);
    expect(hatMask(-1 + 8 / 7)).toBe(HAT_DOWN);
    expect(hatMask(-1 + 12 / 7)).toBe(HAT_LEFT);
    expect(hatMask(1)).toBe(HAT_LEFT | HAT_UP);
    expect(hatMask(0.05)).toBe(0);
  });

  it('reads digital-only buttons as fully pressed', () => {
    const p: PadLike = { ...gamepad(), buttons: [{ pressed: true, value: 0 }] };
    expect(buttonValue(p, 0)).toBe(1);
    expect(buttonValue(p, 5)).toBe(0);
  });
});

describe('standard gamepad (PLAN_A10.md §12 layout)', () => {
  const d = defaultBindingsConfig();

  it('left stick flies: pulled back (axis 1 = +1) is nose up, with a radial dead zone', () => {
    let { out } = run(d, [[gamepad([0, 1, 0, 0])]]);
    expect(out.pitch).toBe(1);
    ({ out } = run(d, [[gamepad([-1, 0, 0, 0])]]));
    expect(out.roll).toBe(-1);
    ({ out } = run(d, [[gamepad([0.08, 0.08, 0, 0])]]));
    expect(out.pitch).toBe(0);
    expect(out.roll).toBe(0);
  });

  it('right stick looks (up = +), LT + right stick slews instead', () => {
    let { out } = run(d, [[gamepad([0, 0, 0, -1])]]);
    expect(out.lookY).toBe(1);
    expect(out.slewY).toBe(0);
    // a diagonal keeps its direction (radial dead zone)
    ({ out } = run(d, [[gamepad([0, 0, 0.6, -0.6])]]));
    expect(out.lookX).toBeCloseTo(out.lookY, 9);
    expect(out.lookX).toBeGreaterThan(0.4);
    ({ out } = run(d, [[gamepad([0, 0, 0, -1], { 6: 1 })]]));
    expect(out.slewY).toBeGreaterThan(0.9);
    expect(out.lookY).toBe(0);
  });

  it('LB / RB are the pedals and ramp like keys', () => {
    const frames = Array.from({ length: 30 }, () => [gamepad([0, 0, 0, 0], { 5: 1 })]);
    const { out } = run(d, [[gamepad()], ...frames]);
    expect(out.rudder).toBe(1);
    const short = run(d, [[gamepad()], [gamepad([0, 0, 0, 0], { 5: 1 })]]);
    expect(short.out.rudder).toBeGreaterThan(0);
    expect(short.out.rudder).toBeLessThan(0.2);
  });

  it('RT is the two-stage trigger', () => {
    const at = (v: number) => [gamepad([0, 0, 0, 0], { 7: v })];
    let r = run(d, [at(0), at(0.5)]);
    expect(r.out.trigger).toBe(1);
    r = run(d, [at(0), at(0.95)]);
    expect(r.out.trigger).toBe(2);
    r = run(d, [at(0), at(0.95), at(0.85)]);
    expect(r.out.trigger).toBe(2);
    r = run(d, [at(0), at(0.95), at(0.5)]);
    expect(r.out.trigger).toBe(1);
    r = run(d, [at(0), at(0.5)], { twoStageTrigger: false });
    expect(r.out.trigger).toBe(2);
  });

  it('A releases weapons; with LT held it is TMS up (short, or long after 0.4 s)', () => {
    let r = run(d, [[gamepad()], [gamepad([0, 0, 0, 0], { 0: 1 })]]);
    expect(r.out.weaponRelease).toBe(true);
    expect(r.presses).toEqual([]);
    const lt = { 6: 1 };
    r = run(d, [
      [gamepad([0, 0, 0, 0], lt)],
      [gamepad([0, 0, 0, 0], { ...lt, 0: 1 })],
      [gamepad([0, 0, 0, 0], lt)],
    ]);
    expect(r.out.weaponRelease).toBe(false);
    expect(r.presses).toEqual(['tmsUp']);
    const hold = Array.from({ length: 30 }, () => [gamepad([0, 0, 0, 0], { ...lt, 0: 1 })]);
    r = run(d, [[gamepad([0, 0, 0, 0], lt)], ...hold]);
    expect(r.presses).toEqual(['tmsUp:long']);
  });

  it('the layer is fixed when the button is pressed', () => {
    // A pressed first, then LT: still weapon release, no TMS
    const r = run(d, [
      [gamepad()],
      [gamepad([0, 0, 0, 0], { 0: 1 })],
      [gamepad([0, 0, 0, 0], { 0: 1, 6: 1 })],
      [gamepad([0, 0, 0, 0], { 6: 1 })],
    ]);
    expect(r.presses).toEqual([]);
  });

  it('D-pad: up/down throttles, left/right steps the sensor of interest, with LT it trims', () => {
    const up = Array.from({ length: 60 }, () => [gamepad([0, 0, 0, 0], { 12: 1 })]);
    let r = run(d, [[gamepad()], ...up]);
    expect(r.out.throttle[0]).toBeCloseTo(0.5 + 1 / 2.5, 1);
    r = run(d, [[gamepad()], [gamepad([0, 0, 0, 0], { 15: 1 })], [gamepad()]]);
    expect(r.presses).toEqual(['soiStepRight']);
    r = run(d, [[gamepad([0, 0, 0, 0], { 6: 1 })], [gamepad([0, 0, 0, 0], { 6: 1, 13: 1 })]]);
    expect(r.out.trimPitch).toBe(1);
    expect(r.out.throttle[0]).toBe(0.5);
  });

  it('X master mode, Y profile, B speed brake, Back views, Start pause', () => {
    const r = run(d, [
      [gamepad()],
      [gamepad([0, 0, 0, 0], { 2: 1 })],
      [gamepad([0, 0, 0, 0], { 3: 1 })],
      [gamepad([0, 0, 0, 0], { 8: 1 })],
      [gamepad([0, 0, 0, 0], { 9: 1 })],
    ]);
    expect(r.presses).toEqual(['masterMode', 'profileNext', 'viewCycle', 'pause']);
  });

  it('a button held when the pad first appears does not fire (browsers reveal pads on a press)', () => {
    const r = run(d, [
      [gamepad([0, 0, 0, 0], { 9: 1 })],
      [gamepad([0, 0, 0, 0], { 9: 1 })],
      [gamepad()],
    ]);
    expect(r.presses).toEqual([]);
  });

  it('a pad that disappears lets go of everything', () => {
    const r = run(d, [[gamepad()], [gamepad([0, 0, 0, 0], { 0: 1, 7: 1 })], []]);
    expect(r.out.weaponRelease).toBe(false);
    expect(r.out.trigger).toBe(0);
  });
});

describe('generic joysticks, throttles and pedals (mapping "")', () => {
  function stickConfig(): BindingsConfig {
    let c = defaultBindingsConfig();
    const add = (id: Parameters<typeof applyBinding>[1], b: Parameters<typeof applyBinding>[2]) => {
      c = applyBinding(c, id, b, null).config;
    };
    add('pitch', {
      src: { type: 'hidAxis', device: STICK_REF, axis: 1 },
      cal: { ...HID_STICK_CAL, curve: 0 },
    });
    add('roll', {
      src: { type: 'hidAxis', device: STICK_REF, axis: 0 },
      cal: { ...HID_STICK_CAL, curve: 0 },
    });
    add('triggerFirst', { src: { type: 'hidButton', device: STICK_REF, button: 0 } });
    add('triggerSecond', { src: { type: 'hidButton', device: STICK_REF, button: 5 } });
    add('coolieUp', { src: { type: 'hidHat', device: STICK_REF, axis: 2, dir: 'up' } });
    add('coolieRight', { src: { type: 'hidHat', device: STICK_REF, axis: 2, dir: 'right' } });
    return c;
  }

  it('axes fly the stick with their own calibration', () => {
    const c = stickConfig();
    const { out } = run(c, [[stick(0.5, 1)]]);
    expect(out.pitch).toBe(1);
    expect(out.roll).toBeCloseTo((0.5 - 0.03) / 0.97, 6);
    expect(run(c, [[stick(0.02, -0.02)]]).out.pitch).toBe(0);
  });

  it('a two-stage trigger made of two buttons (Warthog style)', () => {
    const c = stickConfig();
    expect(run(c, [[stick()], [stick(0, 0, HAT_REST, [0])]]).out.trigger).toBe(1);
    expect(run(c, [[stick()], [stick(0, 0, HAT_REST, [0, 5])]]).out.trigger).toBe(2);
  });

  it('hat directions are presses, diagonals press both', () => {
    const c = stickConfig();
    const r = run(c, [[stick()], [stick(0, 0, -1 + 2 / 7)], [stick()]]);
    expect(r.presses.sort()).toEqual(['coolieRight', 'coolieUp']);
  });

  it('bindings follow the device: another stick or a gamepad does not drive them', () => {
    const c = stickConfig();
    const other = stick(0, 1, HAT_REST, [], 2, 'Other Stick (Vendor: 1234 Product: 5678)');
    expect(run(c, [[other]]).out.pitch).toBe(0);
    // the second identical stick has ordinal 1, not the bound 0
    const twin = stick(0, 1, HAT_REST, [], 4);
    const r = run(c, [[stick(0, 0, HAT_REST, [], 1), twin]]);
    expect(r.out.pitch).toBe(0);
  });

  it('a throttle axis resting at idle (-1) drives a lever once moved, inverted when bound so', () => {
    const throttleRef: DeviceRef = { key: '044f:0404', name: 'Warthog Throttle', ordinal: 0 };
    let c = defaultBindingsConfig();
    c = applyBinding(
      c,
      'throttleLeft',
      {
        src: { type: 'hidAxis', device: throttleRef, axis: 2 },
        cal: { invert: true, deadZone: 0, saturation: 1, curve: 0, centre: 0 },
      },
      null,
    ).config;
    const t = (v: number): PadLike => ({
      id: 'Throttle - HOTAS Warthog (Vendor: 044f Product: 0404)',
      index: 0,
      mapping: '',
      connected: true,
      axes: [0, 0, v],
      buttons: [],
    });
    const r = run(c, [[t(1)], [t(0.5)], [t(-1)]]);
    expect(r.out.throttle[0]).toBe(1);
    expect(r.out.throttle[1]).toBe(0.5);
  });

  it('an axis used as a button (a hat seen as two axes)', () => {
    let c = defaultBindingsConfig();
    c = applyBinding(
      c,
      'dmsLeft',
      { src: { type: 'hidAxis', device: STICK_REF, axis: 0, dir: -1 } },
      null,
    ).config;
    const r = run(c, [[stick()], [stick(-1, 0)], [stick(-0.45, 0)], [stick(0, 0)]]);
    expect(r.presses).toEqual(['dmsLeft']);
  });
});
