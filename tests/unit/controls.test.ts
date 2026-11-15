import { describe, expect, it } from 'vitest';
import {
  GamepadButtonEdges,
  mapGamepadAxes,
  pickGamepad,
  STICK_DEADZONE,
  type GamepadSnapshot,
} from '../../src/controls/gamepad';
import { actionAllowed, pilotInputLive } from '../../src/controls/gating';
import type { InputAxes } from '../../src/controls/input';
import { KeyboardCore, type KeyAxes } from '../../src/controls/keyboard';
import { responseCurve } from '../../src/controls/response';
import {
  SLIDER_DETENT_PX,
  sliderValue,
  STICK_RADIUS,
  stickVector,
  type SliderResult,
  type StickResult,
} from '../../src/controls/touchMath';
import { ACTION_NAMES } from '../../src/state/actions';
import { DEFAULT_KEY_BINDINGS, type KeyBindings } from '../../src/state/bindings';

function axes(core: KeyboardCore): KeyAxes {
  return core.readAxes({ collective: 0, tilt: 0, yaw: 0, strafe: 0 });
}

describe('keyboard core', () => {
  it('maps the default bindings to the four axes with the contract signs', () => {
    const core = new KeyboardCore(DEFAULT_KEY_BINDINGS);
    expect(axes(core)).toEqual({ collective: 0, tilt: 0, yaw: 0, strafe: 0 });
    core.keyDown('KeyW');
    core.keyDown('ArrowUp');
    core.keyDown('KeyD');
    core.keyDown('KeyE');
    expect(axes(core)).toEqual({ collective: 1, tilt: 1, yaw: 1, strafe: 1 });
    core.clear();
    core.keyDown('KeyS');
    core.keyDown('ArrowDown');
    core.keyDown('KeyA');
    core.keyDown('KeyQ');
    expect(axes(core)).toEqual({ collective: -1, tilt: -1, yaw: -1, strafe: -1 });
  });

  it('cancels opposite keys and restores the other when one is released', () => {
    const core = new KeyboardCore(DEFAULT_KEY_BINDINGS);
    core.keyDown('KeyW');
    core.keyDown('KeyS');
    expect(axes(core).collective).toBe(0);
    core.keyUp('KeyW');
    expect(axes(core).collective).toBe(-1);
    core.keyDown('KeyW');
    core.keyUp('KeyS');
    expect(axes(core).collective).toBe(1);
    core.keyUp('KeyW');
    expect(axes(core).collective).toBe(0);
  });

  it('fires each action on key-down only, never on auto-repeat or key-up', () => {
    const core = new KeyboardCore(DEFAULT_KEY_BINDINGS);
    for (const action of ACTION_NAMES) {
      const code = DEFAULT_KEY_BINDINGS[action];
      expect(core.keyDown(code)).toEqual([action]);
      expect(core.keyDown(code, true)).toEqual([]);
      expect(core.keyDown(code, true)).toEqual([]);
      core.keyUp(code);
      expect(core.keyDown(code)).toEqual([action]);
      core.keyUp(code);
    }
    // axis keys and unbound keys fire nothing
    expect(core.keyDown('KeyW')).toEqual([]);
    expect(core.keyDown('KeyZ')).toEqual([]);
    expect(core.keyDown('')).toEqual([]);
  });

  it('holds an axis through auto-repeat events', () => {
    const core = new KeyboardCore(DEFAULT_KEY_BINDINGS);
    core.keyDown('KeyW');
    core.keyDown('KeyW', true);
    expect(axes(core).collective).toBe(1);
    core.keyUp('KeyW');
    expect(axes(core).collective).toBe(0);
  });

  it('follows a rebinding at once and never leaves an axis stuck', () => {
    const core = new KeyboardCore(DEFAULT_KEY_BINDINGS);
    core.keyDown('KeyW');
    expect(axes(core).collective).toBe(1);

    const rebound: KeyBindings = {
      ...DEFAULT_KEY_BINDINGS,
      throttleUp: 'KeyI',
      cycleCamera: 'KeyV',
    };
    core.setBindings(rebound);
    // the old key is still physically held but no longer means anything
    expect(axes(core).collective).toBe(0);
    expect(core.isBound('KeyW')).toBe(false);
    expect(core.isBound('KeyI')).toBe(true);

    core.keyDown('KeyI');
    expect(axes(core).collective).toBe(1);
    core.keyUp('KeyW');
    expect(axes(core).collective).toBe(1);
    core.keyUp('KeyI');
    expect(axes(core).collective).toBe(0);

    expect(core.keyDown('KeyC')).toEqual([]);
    expect(core.keyDown('KeyV')).toEqual(['cycleCamera']);
  });

  it('fires every action that shares a key and ignores unbound (empty) bindings', () => {
    const core = new KeyboardCore({
      ...DEFAULT_KEY_BINDINGS,
      cycleCamera: 'KeyF',
      resetFlight: '',
      throttleDown: '',
    });
    expect(core.keyDown('KeyF')).toEqual(['toggleAssist', 'cycleCamera']);
    expect(core.isBound('')).toBe(false);
    core.keyDown('KeyW');
    expect(axes(core).collective).toBe(1);
  });

  it('clear() releases everything', () => {
    const core = new KeyboardCore(DEFAULT_KEY_BINDINGS);
    core.keyDown('KeyW');
    core.keyDown('ArrowDown');
    core.keyDown('KeyA');
    core.keyDown('KeyE');
    core.clear();
    expect(axes(core)).toEqual({ collective: 0, tilt: 0, yaw: 0, strafe: 0 });
    expect(core.isHeld('KeyW')).toBe(false);
  });
});

describe('input gating', () => {
  const flying = { screen: 'flight', paused: false, settingsOpen: false } as const;

  it('is live only on a flying screen, unpaused, with the settings closed', () => {
    expect(pilotInputLive(flying)).toBe(true);
    expect(pilotInputLive({ ...flying, screen: 'ops' })).toBe(true);
    expect(pilotInputLive({ ...flying, screen: 'menu' })).toBe(false);
    expect(pilotInputLive({ ...flying, screen: 'hangar' })).toBe(false);
    expect(pilotInputLive({ ...flying, paused: true })).toBe(false);
    expect(pilotInputLive({ ...flying, settingsOpen: true })).toBe(false);
  });

  it('always lets togglePause through and gates every other action', () => {
    const paused = { ...flying, paused: true };
    for (const action of ACTION_NAMES) {
      expect(actionAllowed(action, flying)).toBe(true);
      expect(actionAllowed(action, paused)).toBe(action === 'togglePause');
      expect(actionAllowed(action, { ...flying, screen: 'menu' })).toBe(action === 'togglePause');
    }
  });
});

function pad(
  stickAxes: readonly number[] = [0, 0, 0, 0],
  buttons: Record<number, number> = {},
): GamepadSnapshot {
  return {
    axes: stickAxes,
    buttons: Array.from({ length: 17 }, (_, i) => {
      const value = buttons[i] ?? 0;
      return { pressed: value > 0, value };
    }),
  };
}

function zeroAxes(): InputAxes {
  return { collective: 0, tilt: 0, yaw: 0, strafe: 0, lookX: 0, lookY: 0 };
}

describe('gamepad mapping', () => {
  it('is all zero at rest and inside the dead zone', () => {
    expect(mapGamepadAxes(pad(), false, zeroAxes())).toEqual(zeroAxes());
    const drift = pad([0.08, -0.08, 0.05, 0.1], { 6: 0.04, 7: 0.05 });
    expect(mapGamepadAxes(drift, false, zeroAxes())).toEqual(zeroAxes());
  });

  it('uses a radial dead zone and reaches full deflection', () => {
    // each component is inside the zone but the magnitude is not
    const diagonal = mapGamepadAxes(pad([0.1, 0.1, 0, 0]), false, zeroAxes());
    expect(diagonal.yaw).toBeGreaterThan(0);
    expect(diagonal.lookY).toBeLessThan(0);
    expect(Math.abs(diagonal.yaw)).toBeCloseTo(Math.abs(diagonal.lookY));

    const full = mapGamepadAxes(pad([1, 0, 0, -1]), false, zeroAxes());
    expect(full.yaw).toBeCloseTo(1);
    expect(full.tilt).toBeCloseTo(1);

    const half = mapGamepadAxes(pad([0.5, 0, 0, 0]), false, zeroAxes());
    const linear = (0.5 - STICK_DEADZONE) / (1 - STICK_DEADZONE);
    expect(half.yaw).toBeGreaterThan(0);
    expect(half.yaw).toBeLessThan(linear);
    expect(half.yaw).toBeCloseTo(responseCurve(linear));

    // a corner of a square-gated stick is not more than full
    const corner = mapGamepadAxes(pad([1, 1, 0, 0]), false, zeroAxes());
    expect(Math.hypot(corner.yaw, corner.lookY)).toBeLessThanOrEqual(Math.SQRT2 + 1e-9);
    expect(corner.yaw).toBeLessThanOrEqual(1);
  });

  it('maps sticks, triggers and bumpers to the contract axes', () => {
    const out = mapGamepadAxes(pad([1, -1, -1, 1]), false, zeroAxes());
    expect(out.yaw).toBeGreaterThan(0.6); // left stick right = turn to starboard
    expect(out.lookY).toBeGreaterThan(0.6); // left stick up = look up
    expect(out.lookX).toBeLessThan(-0.6); // right stick left = look left
    expect(out.tilt).toBeLessThan(-0.6); // right stick down = tilt back

    expect(mapGamepadAxes(pad([], { 7: 1 }), false, zeroAxes()).collective).toBeCloseTo(1);
    expect(mapGamepadAxes(pad([], { 6: 1 }), false, zeroAxes()).collective).toBeCloseTo(-1);
    expect(mapGamepadAxes(pad([], { 6: 1, 7: 1 }), false, zeroAxes()).collective).toBeCloseTo(0);
    const partial = mapGamepadAxes(pad([], { 7: 0.5 }), false, zeroAxes()).collective;
    expect(partial).toBeGreaterThan(0.4);
    expect(partial).toBeLessThan(0.5);

    expect(mapGamepadAxes(pad([], { 5: 1 }), false, zeroAxes()).strafe).toBe(1);
    expect(mapGamepadAxes(pad([], { 4: 1 }), false, zeroAxes()).strafe).toBe(-1);
    expect(mapGamepadAxes(pad([], { 4: 1, 5: 1 }), false, zeroAxes()).strafe).toBe(0);
  });

  it('treats a digital trigger (pressed, no analog value) as fully pulled', () => {
    const digital: GamepadSnapshot = {
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 7, value: 0 })),
    };
    expect(mapGamepadAxes(digital, false, zeroAxes()).collective).toBeCloseTo(1);
  });

  it('invertY flips tilt and lookY and nothing else', () => {
    const snapshot = pad([0.8, -0.9, 0.7, -0.9], { 7: 1, 5: 1 });
    const normal = mapGamepadAxes(snapshot, false, zeroAxes());
    const inverted = mapGamepadAxes(snapshot, true, zeroAxes());
    expect(normal.tilt).toBeGreaterThan(0);
    expect(normal.lookY).toBeGreaterThan(0);
    expect(inverted.tilt).toBeCloseTo(-normal.tilt);
    expect(inverted.lookY).toBeCloseTo(-normal.lookY);
    expect(inverted.yaw).toBeCloseTo(normal.yaw);
    expect(inverted.lookX).toBeCloseTo(normal.lookX);
    expect(inverted.collective).toBeCloseTo(normal.collective);
    expect(inverted.strafe).toBe(normal.strafe);
  });

  it('survives short or malformed snapshots', () => {
    const out = mapGamepadAxes({ axes: [NaN], buttons: [] }, false, zeroAxes());
    expect(out).toEqual(zeroAxes());
  });

  it('fires each button action exactly once per press', () => {
    const cases: readonly (readonly [number, string])[] = [
      [3, 'toggleAssist'],
      [8, 'cycleCamera'],
      [0, 'launchJet'],
      [2, 'toggleTurbinePanel'],
      [9, 'togglePause'],
    ];
    const edges = new GamepadButtonEdges();
    expect(edges.update(pad())).toEqual([]);
    for (const [button, action] of cases) {
      expect(edges.update(pad([], { [button]: 1 }))).toEqual([action]);
      expect(edges.update(pad([], { [button]: 1 }))).toEqual([]);
      expect(edges.update(pad([], { [button]: 1 }))).toEqual([]);
      expect(edges.update(pad())).toEqual([]);
    }
    // two buttons going down in the same frame both fire
    expect(edges.update(pad([], { 0: 1, 3: 1 }))).toEqual(['toggleAssist', 'launchJet']);
    // buttons that are not mapped to an action fire nothing
    expect(edges.update(pad([], { 1: 1, 4: 1, 5: 1, 6: 1, 7: 1 }))).toEqual([]);
  });

  it('does not fire for a button that is already down when the pad appears', () => {
    const edges = new GamepadButtonEdges();
    expect(edges.update(pad([], { 0: 1 }))).toEqual([]);
    expect(edges.update(pad([], { 0: 1 }))).toEqual([]);
    expect(edges.update(pad())).toEqual([]);
    expect(edges.update(pad([], { 0: 1 }))).toEqual(['launchJet']);
    edges.reset();
    expect(edges.update(pad([], { 9: 1 }))).toEqual([]);
  });

  it('picks the first connected standard-mapping pad', () => {
    const odd = { connected: true, mapping: '', id: 'odd' };
    const gone = { connected: false, mapping: 'standard', id: 'gone' };
    const first = { connected: true, mapping: 'standard', id: 'first' };
    const second = { connected: true, mapping: 'standard', id: 'second' };
    expect(pickGamepad([null, odd, gone, first, second])).toBe(first);
    expect(pickGamepad([null, odd, gone])).toBeNull();
    expect(pickGamepad([])).toBeNull();
  });
});

describe('touch maths', () => {
  const stick = (dx: number, dy: number): StickResult =>
    stickVector(dx, dy, { x: 0, y: 0, knobX: 0, knobY: 0 });
  const slider = (offsetUp: number, travel = 80): SliderResult =>
    sliderValue(offsetUp, travel, { value: 0, thumb: 0 });

  it('stick: zero at the origin and inside the dead zone, knob still follows', () => {
    expect(stick(0, 0)).toEqual({ x: 0, y: 0, knobX: 0, knobY: 0 });
    const resting = stick(3, -4);
    expect(resting.x).toBe(0);
    expect(resting.y).toBe(0);
    expect(resting.knobX).toBeCloseTo(3);
    expect(resting.knobY).toBeCloseTo(-4);
  });

  it('stick: right = +x, up on screen = +y, full deflection at the clamp radius', () => {
    expect(stick(STICK_RADIUS, 0).x).toBeCloseTo(1);
    expect(stick(STICK_RADIUS, 0).y).toBe(0);
    expect(stick(-STICK_RADIUS, 0).x).toBeCloseTo(-1);
    expect(stick(0, -STICK_RADIUS).y).toBeCloseTo(1);
    expect(stick(0, STICK_RADIUS).y).toBeCloseTo(-1);
    expect(stick(0, -STICK_RADIUS).x).toBe(0);
  });

  it('stick: clamps the knob and the value when the thumb slides far away', () => {
    const far = stick(300, -400);
    expect(Math.hypot(far.knobX, far.knobY)).toBeCloseTo(STICK_RADIUS);
    expect(far.knobX).toBeCloseTo(STICK_RADIUS * 0.6);
    expect(far.knobY).toBeCloseTo(-STICK_RADIUS * 0.8);
    expect(far.x).toBeGreaterThan(0);
    expect(far.y).toBeGreaterThan(far.x);
    expect(Math.hypot(far.x, far.y)).toBeLessThanOrEqual(1);
    expect(stick(1000, 0).x).toBeCloseTo(1);
  });

  it('stick: response is monotonic and softer than linear at half travel', () => {
    let previous = 0;
    for (let px = 0; px <= STICK_RADIUS; px += 2) {
      const x = stick(px, 0).x;
      expect(x).toBeGreaterThanOrEqual(previous);
      previous = x;
    }
    expect(stick(STICK_RADIUS / 2, 0).x).toBeGreaterThan(0.15);
    expect(stick(STICK_RADIUS / 2, 0).x).toBeLessThan(0.5);
  });

  it('stick: a nearly sideways push does not creep the other axis', () => {
    const sideways = stick(STICK_RADIUS, -5);
    expect(sideways.x).toBeGreaterThan(0.9);
    expect(sideways.y).toBe(0);
    const upward = stick(4, -STICK_RADIUS);
    expect(upward.y).toBeGreaterThan(0.9);
    expect(upward.x).toBe(0);
    const diagonal = stick(40, -40);
    expect(diagonal.x).toBeGreaterThan(0.3);
    expect(diagonal.y).toBeCloseTo(diagonal.x);
  });

  it('slider: centre detent, linear ramp, clamped ends, up = +1', () => {
    expect(slider(0)).toEqual({ value: 0, thumb: 0 });
    expect(slider(SLIDER_DETENT_PX)).toEqual({ value: 0, thumb: 0 });
    expect(slider(-SLIDER_DETENT_PX)).toEqual({ value: 0, thumb: 0 });

    const justOut = slider(SLIDER_DETENT_PX + 1);
    expect(justOut.value).toBeGreaterThan(0);
    expect(justOut.value).toBeLessThan(0.05);
    expect(justOut.thumb).toBe(SLIDER_DETENT_PX + 1);

    expect(slider(80)).toEqual({ value: 1, thumb: 80 });
    expect(slider(-80)).toEqual({ value: -1, thumb: -80 });
    expect(slider(500)).toEqual({ value: 1, thumb: 80 });
    expect(slider(-500)).toEqual({ value: -1, thumb: -80 });

    const mid = slider(45);
    expect(mid.value).toBeCloseTo((45 - SLIDER_DETENT_PX) / (80 - SLIDER_DETENT_PX));
    expect(slider(-45).value).toBeCloseTo(-mid.value);
  });

  it('slider: a degenerate track gives no input', () => {
    expect(slider(40, 0)).toEqual({ value: 0, thumb: 0 });
    expect(slider(40, SLIDER_DETENT_PX)).toEqual({ value: 0, thumb: 0 });
  });

  it('response curve is odd, monotonic and keeps the end points', () => {
    expect(responseCurve(0)).toBe(0);
    expect(responseCurve(1)).toBeCloseTo(1);
    expect(responseCurve(-1)).toBeCloseTo(-1);
    expect(responseCurve(-0.5)).toBeCloseTo(-responseCurve(0.5));
    expect(responseCurve(0.5)).toBeLessThan(0.5);
    expect(responseCurve(0.6)).toBeGreaterThan(responseCurve(0.5));
  });
});
