import { describe, expect, it } from 'vitest';
import {
  applyBinding,
  defaultBindingsConfig,
  type BindingsConfig,
} from '../../../src/a10/input/bindings';
import {
  InputEngine,
  MOUSE_STICK_RANGE_PX,
  TAKEOVER,
  createEngineOutput,
  type EngineOutput,
  type FrameContext,
  type Gate,
  type KeyMods,
} from '../../../src/a10/input/engine';
import { computeGate } from '../../../src/a10/input/gating';
import type { PadLike } from '../../../src/a10/input/devices';

const DT = 1 / 60;
const LIVE: Gate = { live: true, app: true };
const PAUSED: Gate = { live: false, app: true };
const MENU: Gate = { live: false, app: false };
const NONE: KeyMods = { ctrl: false, alt: false, shift: false, meta: false };
const CTRL: KeyMods = { ...NONE, ctrl: true };
const SHIFT: KeyMods = { ...NONE, shift: true };

function setup(config: BindingsConfig = defaultBindingsConfig()) {
  const engine = new InputEngine(config);
  const out = createEngineOutput();
  let ctx: FrameContext = {
    dt: DT,
    gate: LIVE,
    pads: [],
    twoStageTrigger: true,
    mouseStick: false,
    invertLook: false,
    speedBrakePosition: Number.NaN,
  };
  engine.resetLevers([0.5, 0.5]);
  // the runtime opens the gate at attach and on every store change, before any event
  engine.setGate(LIVE);
  const frame = (patch: Partial<FrameContext> = {}): EngineOutput => {
    ctx = { ...ctx, ...patch };
    return engine.update(ctx, out);
  };
  const run = (seconds: number, patch: Partial<FrameContext> = {}): EngineOutput => {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) frame(patch);
    return out;
  };
  const presses = () => out.presses.map((p) => `${p.id}${p.long ? ':long' : ''}`);
  return { engine, out, frame, run, presses };
}

describe('keyboard stick and pedals', () => {
  it('ramp toward full deflection over a fraction of a second, then back to centre', () => {
    const { engine, frame, run } = setup();
    engine.keyDown('ArrowDown', NONE);
    const first = frame();
    expect(first.pitch).toBeGreaterThan(0);
    expect(first.pitch).toBeLessThan(0.15);
    run(0.1);
    expect(frame().pitch).toBeLessThan(1);
    const out = run(0.3);
    expect(out.pitch).toBe(1); // + = stick back
    engine.keyUp('ArrowDown');
    run(0.06);
    expect(frame().pitch).toBeGreaterThan(0);
    expect(run(0.2).pitch).toBe(0);
  });

  it('arrow up pushes forward (nose down), Z/X are the pedals', () => {
    const { engine, run } = setup();
    engine.keyDown('ArrowUp', NONE);
    engine.keyDown('KeyX', NONE);
    const out = run(1);
    expect(out.pitch).toBe(-1);
    expect(out.rudder).toBe(1);
    expect(out.roll).toBe(0);
  });

  it('opposite keys cancel', () => {
    const { engine, run } = setup();
    engine.keyDown('ArrowLeft', NONE);
    engine.keyDown('ArrowRight', NONE);
    expect(run(0.5).roll).toBe(0);
  });

  it('the ramp time is an option (0 = instant)', () => {
    const config = defaultBindingsConfig();
    config.options.keyRampTime = 0;
    const { engine, frame } = setup(config);
    engine.keyDown('ArrowRight', NONE);
    expect(frame().roll).toBe(1);
  });

  it('the stick ramp starts gently: a short tap moves the stick a little (review FC-5)', () => {
    const { engine, frame, run } = setup();
    // A 50 ms tap (3 frames at 60 fps): the linear ramp reached 0.167, the eased one 0.028.
    engine.keyDown('ArrowDown', NONE);
    let peak = 0;
    for (let i = 0; i < 3; i++) peak = Math.max(peak, frame().pitch);
    engine.keyUp('ArrowDown');
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(0.04);
    expect(run(0.3).pitch).toBe(0);
    // Held, it still reaches full deflection in the ramp time.
    engine.keyDown('ArrowDown', NONE);
    expect(run(0.32).pitch).toBe(1);
  });

  it('pitch keys deflect the stick only as far as the frame context allows; analogue input is not scaled', () => {
    const { engine, run } = setup();
    engine.keyDown('ArrowDown', NONE);
    expect(run(0.5, { keyPitchPull: 0.4, keyPitchPush: 0.3 }).pitch).toBeCloseTo(0.4, 9);
    engine.keyUp('ArrowDown');
    engine.keyDown('ArrowUp', NONE);
    expect(run(0.5).pitch).toBeCloseTo(-0.3, 9);
    engine.keyUp('ArrowUp');
    // Roll keys are not scaled; invalid values mean full authority.
    engine.keyDown('ArrowRight', NONE);
    expect(run(0.5).roll).toBe(1);
    engine.keyUp('ArrowRight');
    engine.keyDown('ArrowDown', NONE);
    expect(run(0.5, { keyPitchPull: Number.NaN }).pitch).toBe(1);
  });
});

describe('modifier layers', () => {
  it('Ctrl + arrows move the trim hat and not the stick', () => {
    const { engine, run } = setup();
    engine.keyDown('ControlLeft', CTRL);
    engine.keyDown('ArrowDown', CTRL);
    engine.keyDown('ArrowLeft', CTRL);
    const out = run(0.2);
    expect(out.trimPitch).toBe(1); // nose up
    expect(out.trimRoll).toBe(-1);
    expect(out.pitch).toBe(0);
    expect(out.roll).toBe(0);
  });

  it('the layer is fixed at the press: letting go of Ctrl keeps trimming until the key is up', () => {
    const { engine, run } = setup();
    engine.keyDown('ControlLeft', CTRL);
    engine.keyDown('ArrowUp', CTRL);
    engine.keyUp('ControlLeft');
    let out = run(0.2);
    expect(out.trimPitch).toBe(-1);
    expect(out.pitch).toBe(0);
    engine.keyUp('ArrowUp');
    engine.keyDown('ArrowUp', NONE);
    out = run(0.5);
    expect(out.trimPitch).toBe(0);
    expect(out.pitch).toBe(-1);
  });

  it('Ctrl + Shift + arrows trim too (macOS keeps Ctrl + arrows for itself, review FC-6)', () => {
    const { engine, run } = setup();
    const CTRL_SHIFT: KeyMods = { ...NONE, ctrl: true, shift: true };
    // Right Shift: the left one is the trigger's first detent.
    engine.keyDown('ControlLeft', CTRL);
    engine.keyDown('ShiftRight', CTRL_SHIFT);
    engine.keyDown('ArrowUp', CTRL_SHIFT);
    engine.keyDown('ArrowRight', CTRL_SHIFT);
    const out = run(0.2);
    expect(out.trimPitch).toBe(-1); // nose down
    expect(out.trimRoll).toBe(1);
    expect(out.pitch).toBe(0);
    expect(out.roll).toBe(0);
    expect(out.trigger).toBe(0);
  });

  it('Ctrl chords that are not bound do nothing (browser shortcuts)', () => {
    const { engine } = setup();
    expect(engine.keyDown('KeyR', CTRL).bound).toBe(false);
    expect(engine.keyDown('KeyW', CTRL).bound).toBe(false);
  });

  it('Shift held (trigger first detent) does not block other keys', () => {
    const { engine, run } = setup();
    engine.keyDown('ShiftLeft', SHIFT);
    engine.keyDown('Space', SHIFT);
    engine.keyDown('ArrowDown', SHIFT);
    const out = run(0.5);
    expect(out.trigger).toBe(2);
    expect(out.pitch).toBe(1);
  });

  it('a binding that asks for Shift wins over the plain one while Shift is held', () => {
    let config = defaultBindingsConfig();
    config = applyBinding(
      config,
      'gear',
      { src: { type: 'key', code: 'KeyG', shift: true } },
      0,
    ).config;
    config = applyBinding(config, 'flaps', { src: { type: 'key', code: 'KeyG' } }, 0).config;
    const { engine, frame, presses } = setup(config);
    engine.keyDown('KeyG', SHIFT);
    frame();
    expect(presses()).toEqual(['gear']);
    engine.keyUp('KeyG');
    engine.keyDown('KeyG', NONE);
    frame();
    expect(presses()).toEqual(['flaps']);
  });

  it('⌘ chords never fly', () => {
    const { engine } = setup();
    expect(engine.keyDown('ArrowUp', { ...NONE, meta: true }).bound).toBe(false);
  });
});

describe('throttle levers', () => {
  it('keys move both levers at the set rate and the levers stay where they are left', () => {
    const { engine, run } = setup();
    engine.keyDown('PageUp', NONE);
    let out = run(0.5);
    expect(out.throttle[0]).toBeCloseTo(0.5 + 0.5 / 2.5, 2);
    out = run(3);
    expect(out.throttle).toEqual([1, 1]);
    engine.keyUp('PageUp');
    engine.keyDown('PageDown', NONE);
    out = run(1);
    expect(out.throttle[0]).toBeCloseTo(0.6, 2);
    engine.keyUp('PageDown');
    out = run(2);
    expect(out.throttle[0]).toBeCloseTo(0.6, 2);
    expect(out.throttle[1]).toBeCloseTo(0.6, 2);
  });

  it('pausing freezes the levers (never drops them to idle) and stops the keys moving them', () => {
    const { engine, run } = setup();
    engine.keyDown('PageUp', NONE);
    run(0.5, { gate: PAUSED });
    expect(engine.getLevers()).toEqual([0.5, 0.5]);
    const out = run(0.5, { gate: LIVE });
    expect(out.throttle[0]).toBeCloseTo(0.7, 2);
  });

  it('a new flight starts the levers where the simulation put them', () => {
    const { engine, frame } = setup();
    engine.resetLevers([0.85, 0.85]);
    expect(frame().throttle).toEqual([0.85, 0.85]);
  });
});

describe('trigger', () => {
  it('Left Shift is the first detent, Space the second (and implies the first)', () => {
    const { engine, frame } = setup();
    expect(frame().trigger).toBe(0);
    engine.keyDown('ShiftLeft', SHIFT);
    expect(frame().trigger).toBe(1);
    engine.keyDown('Space', SHIFT);
    expect(frame().trigger).toBe(2);
    engine.keyUp('ShiftLeft');
    expect(frame().trigger).toBe(2);
    engine.keyUp('Space');
    expect(frame().trigger).toBe(0);
    engine.keyDown('Space', NONE);
    expect(frame().trigger).toBe(2);
  });

  it('with the one-stage trigger (relaxed realism) any press fires', () => {
    const { engine, frame } = setup();
    engine.keyDown('ShiftLeft', SHIFT);
    const out = frame({ twoStageTrigger: false });
    expect(out.trigger).toBe(2);
    expect(out.triggerRaw).toBe(1);
  });
});

describe('short and long presses (TMS, DMS, China hat, coolie)', () => {
  it('a short press fires on release, a long one when the hold reaches 0.4 s', () => {
    const { engine, frame, run, presses } = setup();
    engine.keyDown('KeyT', NONE);
    run(0.2);
    expect(presses()).toEqual([]);
    engine.keyUp('KeyT');
    frame();
    expect(presses()).toEqual(['tmsUp']);

    engine.keyDown('KeyT', NONE);
    run(0.38);
    expect(presses()).toEqual([]);
    const fired: string[] = [];
    for (let i = 0; i < 5; i++) {
      frame();
      fired.push(...presses());
    }
    expect(fired).toEqual(['tmsUp:long']);
    engine.keyUp('KeyT');
    frame();
    expect(presses()).toEqual([]);
  });

  it('switches act at once on the press', () => {
    const { engine, frame, presses } = setup();
    engine.keyDown('Digit1', NONE);
    frame();
    expect(presses()).toEqual(['masterArm']);
    engine.keyUp('Digit1');
    frame();
    expect(presses()).toEqual([]);
  });

  it('a guarded switch (jettison) fires only on a long hold', () => {
    let config = defaultBindingsConfig();
    config = applyBinding(config, 'jettison', { src: { type: 'key', code: 'KeyJ' } }, null).config;
    const { engine, frame, run, presses } = setup(config);
    engine.keyDown('KeyJ', NONE);
    run(0.1);
    engine.keyUp('KeyJ');
    frame();
    expect(presses()).toEqual([]);
    engine.keyDown('KeyJ', NONE);
    const fired: string[] = [];
    for (let i = 0; i < 40; i++) {
      frame();
      fired.push(...presses());
    }
    expect(fired).toEqual(['jettison:long']);
  });
});

describe('gating', () => {
  it('computes live and app gates from the screen, pause, dialog and capture', () => {
    const base = { screen: 'flight', paused: false, settingsOpen: false, capturing: false };
    expect(computeGate(base)).toEqual(LIVE);
    expect(computeGate({ ...base, paused: true })).toEqual(PAUSED);
    expect(computeGate({ ...base, settingsOpen: true })).toEqual(MENU);
    expect(computeGate({ ...base, capturing: true })).toEqual(MENU);
    expect(computeGate({ ...base, screen: 'menu' })).toEqual(MENU);
  });

  it('not live: momentary axes, trigger and held switches read zero; levers freeze', () => {
    const { engine, run } = setup();
    for (const code of ['ArrowDown', 'KeyX', 'Space', 'Enter', 'KeyL', 'KeyW', 'KeyN'])
      engine.keyDown(code, NONE);
    let out = run(0.5);
    expect(out).toMatchObject({
      pitch: 1,
      rudder: 1,
      trigger: 2,
      weaponRelease: true,
      laser: true,
      lookAtSpi: true,
    });
    expect(out.slewY).toBeGreaterThan(0);
    out = run(0.1, { gate: PAUSED });
    expect(out).toMatchObject({
      pitch: 0,
      rudder: 0,
      trigger: 0,
      weaponRelease: false,
      laser: false,
      lookAtSpi: false,
      slewY: 0,
    });
    expect(out.throttle).toEqual([0.5, 0.5]);
    // still held when the flight resumes: they act again
    out = run(0.5, { gate: LIVE });
    expect(out.trigger).toBe(2);
    expect(out.pitch).toBe(1);
  });

  it('presses made while not live never fire, not even on release', () => {
    const { engine, frame, run, presses } = setup();
    frame({ gate: PAUSED });
    engine.keyDown('Digit1', NONE);
    engine.keyDown('KeyT', NONE);
    frame();
    expect(presses()).toEqual([]);
    run(0.1, { gate: LIVE });
    engine.keyUp('KeyT');
    engine.keyUp('Digit1');
    frame();
    expect(presses()).toEqual([]);
  });

  it('a press that is held when the game pauses does not fire its short press', () => {
    const { engine, frame, presses } = setup();
    engine.keyDown('KeyT', NONE);
    frame();
    frame({ gate: PAUSED });
    frame({ gate: LIVE });
    engine.keyUp('KeyT');
    frame();
    expect(presses()).toEqual([]);
  });

  it('views and pause work while paused, not in a dialog', () => {
    const { engine, frame, presses } = setup();
    frame({ gate: PAUSED });
    expect(engine.keyDown('F2', NONE)).toMatchObject({ bound: true, open: true });
    expect(engine.keyDown('Escape', NONE)).toMatchObject({ pause: true });
    frame();
    expect(presses()).toEqual(['viewChase', 'pause']);
    engine.keyUp('F2');
    engine.keyUp('Escape');
    engine.setGate(MENU);
    expect(engine.keyDown('F3', NONE)).toMatchObject({ bound: true, open: false });
    expect(engine.keyDown('Escape', NONE)).toMatchObject({ pause: false });
    frame({ gate: MENU });
    expect(presses()).toEqual([]);
  });

  it('flight keys are reported as not live while paused (so the page keeps them)', () => {
    const { engine, frame } = setup();
    frame({ gate: PAUSED });
    expect(engine.keyDown('Space', NONE)).toMatchObject({ bound: true, open: false });
    expect(engine.keyDown('KeyQ', NONE).open).toBe(false);
  });

  it('releaseKeys (blur, hidden tab) lets go without firing', () => {
    const { engine, frame, run, presses } = setup();
    engine.keyDown('KeyT', NONE);
    engine.keyDown('Space', NONE);
    frame();
    engine.releaseKeys();
    const out = run(0.1);
    expect(out.trigger).toBe(0);
    expect(presses()).toEqual([]);
  });
});

describe('mouse and wheel', () => {
  it('wheel notches are zoom steps; fractions (touchpads) add up', () => {
    const { engine, frame, presses } = setup();
    engine.wheel(1);
    frame();
    expect(presses()).toEqual(['zoomIn']);
    engine.wheel(-0.4);
    engine.wheel(-0.4);
    frame();
    expect(presses()).toEqual([]);
    engine.wheel(-0.4);
    frame();
    expect(presses()).toEqual(['zoomOut']);
  });

  it('mouse look: movement becomes look deltas, inverted on request', () => {
    const { engine, frame } = setup();
    engine.mouseMove(10, -4);
    expect(frame()).toMatchObject({ lookDeltaX: 10, lookDeltaY: -4 });
    engine.mouseMove(0, 5);
    expect(frame({ invertLook: true }).lookDeltaY).toBe(-5);
    expect(frame().lookDeltaX).toBe(0);
  });

  it('mouse stick: movement deflects a sprung stick (back = pull), the right button looks', () => {
    const config = defaultBindingsConfig();
    config.options.mouseStickSpring = 0;
    const { engine, frame, run } = setup(config);
    engine.mouseMove(MOUSE_STICK_RANGE_PX / 2, MOUSE_STICK_RANGE_PX);
    let out = frame({ mouseStick: true });
    expect(out.mouseStickActive).toBe(true);
    expect(out.pitch).toBeGreaterThan(0.6);
    expect(out.roll).toBeGreaterThan(0.2);
    expect(out.lookDeltaX).toBe(0);
    // without a spring it stays
    expect(run(1).pitch).toBeCloseTo(out.pitch, 6);
    // holding the right button looks instead
    engine.mouseDown(2);
    engine.mouseMove(30, 0);
    out = frame();
    expect(out.mouseLookHeld).toBe(true);
    expect(out.lookDeltaX).toBe(30);
    engine.mouseUp(2);
    // leaving mouse-stick mode centres it
    expect(frame({ mouseStick: false }).pitch).toBe(0);
  });

  it('the mouse-stick spring brings the stick back to the centre', () => {
    const { engine, frame, run } = setup();
    engine.mouseMove(0, MOUSE_STICK_RANGE_PX / 2);
    const start = frame({ mouseStick: true }).mouseStickY;
    const later = run(2).mouseStickY;
    expect(later).toBeGreaterThan(0);
    expect(later).toBeLessThan(start * 0.6);
  });

  it('mouse buttons can be bound (middle = zoom while held)', () => {
    const { engine, frame } = setup();
    engine.mouseDown(1);
    expect(frame().zoomHeld).toBe(true);
    engine.mouseUp(1);
    expect(frame().zoomHeld).toBe(false);
  });
});

describe('speed brake', () => {
  it('the open/close key drives the switch to the end, then lets it rest', () => {
    const { engine, frame } = setup();
    engine.keyDown('KeyB', NONE);
    engine.keyUp('KeyB');
    expect(frame({ speedBrakePosition: 0 }).speedBrake).toBe(1);
    expect(frame({ speedBrakePosition: 0.5 }).speedBrake).toBe(1);
    expect(frame({ speedBrakePosition: 1 }).speedBrake).toBe(0);
    engine.keyDown('KeyB', NONE);
    engine.keyUp('KeyB');
    expect(frame({ speedBrakePosition: 1 }).speedBrake).toBe(-1);
    // pressed again while moving: reverses
    engine.keyDown('KeyB', NONE);
    engine.keyUp('KeyB');
    expect(frame({ speedBrakePosition: 0.6 }).speedBrake).toBe(1);
  });

  it('held extend / retract switches override the latch', () => {
    let config = defaultBindingsConfig();
    config = applyBinding(
      config,
      'speedBrakeRetract',
      { src: { type: 'key', code: 'KeyU' } },
      null,
    ).config;
    const { engine, frame } = setup(config);
    engine.keyDown('KeyB', NONE);
    expect(frame({ speedBrakePosition: 0.2 }).speedBrake).toBe(1);
    engine.keyDown('KeyU', NONE);
    expect(frame().speedBrake).toBe(-1);
    engine.keyUp('KeyU');
    expect(frame().speedBrake).toBe(0);
  });
});

describe('controller takeover of the throttle', () => {
  const throttle = (value: number): PadLike => ({
    id: 'Thrustmaster Throttle (Vendor: 044f Product: 0404)',
    index: 0,
    mapping: '',
    connected: true,
    axes: [value],
    buttons: [{ pressed: false, value: 0 }],
  });

  function withThrottle() {
    let config = defaultBindingsConfig();
    config = applyBinding(
      config,
      'throttleBoth',
      {
        src: {
          type: 'hidAxis',
          device: { key: '044f:0404', name: 'Throttle', ordinal: 0 },
          axis: 0,
        },
        cal: { invert: false, deadZone: 0, saturation: 1, curve: 0, centre: 0 },
      },
      null,
    ).config;
    return setup(config);
  }

  it('an axis that has not moved does not take the lever; moving it does', () => {
    const { frame } = withThrottle();
    let out = frame({ pads: [throttle(-1)] });
    expect(out.throttle).toEqual([0.5, 0.5]);
    out = frame({ pads: [throttle(-1 + TAKEOVER)] });
    expect(out.throttle).toEqual([0.5, 0.5]);
    out = frame({ pads: [throttle(-0.9)] });
    expect(out.throttle[0]).toBeCloseTo(0.05, 6);
    out = frame({ pads: [throttle(0.6)] });
    expect(out.throttle).toEqual([0.8, 0.8]);
  });

  it('the keys take over; the axis must move again to get it back (last moved wins)', () => {
    const { engine, frame, run } = withThrottle();
    frame({ pads: [throttle(-1)] });
    frame({ pads: [throttle(0)] });
    expect(frame().throttle[0]).toBeCloseTo(0.5, 6);
    engine.keyDown('PageUp', NONE);
    let out = run(1, { pads: [throttle(0)] });
    expect(out.throttle[0]).toBeCloseTo(0.9, 2);
    engine.keyUp('PageUp');
    out = run(0.5, { pads: [throttle(0.01)] });
    expect(out.throttle[0]).toBeCloseTo(0.9, 2);
    out = frame({ pads: [throttle(0.2)] });
    expect(out.throttle[0]).toBeCloseTo(0.6, 6);
  });

  it('moving the axis while paused takes effect on resume (the physical lever is there)', () => {
    const { frame } = withThrottle();
    frame({ pads: [throttle(-1)] });
    frame({ pads: [throttle(-0.5)] });
    frame({ pads: [throttle(0.8)], gate: PAUSED });
    expect(frame().throttle[0]).toBeCloseTo(0.25, 6);
    expect(frame({ gate: LIVE }).throttle[0]).toBeCloseTo(0.9, 6);
  });
});
