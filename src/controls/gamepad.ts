/**
 * Gamepad core — pure mapping from a standard-mapping gamepad snapshot to the input axes and
 * to edge-triggered actions. No DOM access, so it can be unit-tested with plain objects.
 *
 * Standard mapping (https://w3c.github.io/gamepad/#remapping):
 *   axes 0/1 = left stick X/Y, axes 2/3 = right stick X/Y (Y is -1 when pushed up)
 *   buttons 4/5 = LB/RB, 6/7 = LT/RT (analog), 0 = A, 2 = X, 3 = Y, 8 = Back, 9 = Start
 */
import type { ActionName } from '../state/actions';
import { clamp, deadzone } from '../utils/math';
import type { InputAxes } from './input';
import { responseCurve } from './response';

export interface GamepadButtonSnapshot {
  readonly pressed: boolean;
  readonly value: number;
}

export interface GamepadSnapshot {
  readonly axes: readonly number[];
  readonly buttons: readonly GamepadButtonSnapshot[];
}

/** What `pickGamepad` needs to know about a pad. The DOM `Gamepad` satisfies it. */
export interface GamepadCandidate {
  readonly connected: boolean;
  readonly mapping: string;
}

export const STICK_DEADZONE = 0.12;
/** Worn triggers rest slightly above zero. */
export const TRIGGER_DEADZONE = 0.06;

const BUTTON = { a: 0, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9 } as const;

/** Buttons that fire an action on the press edge. */
export const GAMEPAD_ACTIONS: readonly (readonly [button: number, action: ActionName])[] = [
  [BUTTON.y, 'toggleAssist'],
  [BUTTON.back, 'cycleCamera'],
  [BUTTON.a, 'launchJet'],
  [BUTTON.x, 'toggleTurbinePanel'],
  [BUTTON.start, 'togglePause'],
];

/** The first connected pad that reports the standard mapping; others are ignored. */
export function pickGamepad<T extends GamepadCandidate>(
  pads: ArrayLike<T | null | undefined>,
): T | null {
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (pad && pad.connected && pad.mapping === 'standard') return pad;
  }
  return null;
}

function axisValue(pad: GamepadSnapshot, index: number): number {
  const v = pad.axes[index];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 0..1. Digital-only buttons report `pressed` without an analog value. */
function buttonValue(pad: GamepadSnapshot, index: number): number {
  const b = pad.buttons[index];
  if (!b) return 0;
  return b.value > 0 ? clamp(b.value, 0, 1) : b.pressed ? 1 : 0;
}

function trigger(pad: GamepadSnapshot, index: number): number {
  return deadzone(buttonValue(pad, index), TRIGGER_DEADZONE);
}

// Result of the last shapeStick() call (module scratch: the poll loop must not allocate).
let stickX = 0;
let stickY = 0;

/**
 * Radial dead zone + response curve for one stick. Working on the magnitude (not per axis)
 * keeps diagonals smooth and the direction of the push unchanged.
 */
function shapeStick(pad: GamepadSnapshot, xIndex: number, yIndex: number): void {
  const x = axisValue(pad, xIndex);
  const y = axisValue(pad, yIndex);
  const magnitude = Math.hypot(x, y);
  if (magnitude <= STICK_DEADZONE) {
    stickX = 0;
    stickY = 0;
    return;
  }
  const shaped = responseCurve(deadzone(Math.min(magnitude, 1), STICK_DEADZONE));
  const scale = shaped / magnitude;
  stickX = x * scale;
  stickY = y * scale;
}

/**
 * Write the six axes for this snapshot into `out`.
 * Left stick: X = yaw, Y = look up/down. Right stick: Y = tilt (up = toward the bow),
 * X = look left/right. Triggers: collective. Bumpers: strafe. `invertY` flips both Y axes.
 */
export function mapGamepadAxes<T extends InputAxes>(
  pad: GamepadSnapshot,
  invertY: boolean,
  out: T,
): T {
  // a stick pushed up reads -1, and "up" must come out as +1 ("+ 0" avoids a negative zero)
  const ySign = invertY ? 1 : -1;
  shapeStick(pad, 0, 1);
  out.yaw = stickX;
  out.lookY = stickY * ySign + 0;
  shapeStick(pad, 2, 3);
  out.lookX = stickX;
  out.tilt = stickY * ySign + 0;
  out.collective = trigger(pad, BUTTON.rt) - trigger(pad, BUTTON.lt);
  out.strafe = buttonValue(pad, BUTTON.rb) - buttonValue(pad, BUTTON.lb);
  return out;
}

/**
 * Turns held buttons into one action per press. The first snapshot after `reset()` only
 * primes the detector: browsers reveal a pad when one of its buttons is pressed, and that
 * press must not launch a jet.
 */
export class GamepadButtonEdges {
  private readonly previous: boolean[] = GAMEPAD_ACTIONS.map(() => false);
  private readonly fired: ActionName[] = [];
  private primed = false;

  reset(): void {
    this.previous.fill(false);
    this.fired.length = 0;
    this.primed = false;
  }

  /** Actions whose button went down since the last call. The array is reused between calls. */
  update(pad: GamepadSnapshot): readonly ActionName[] {
    this.fired.length = 0;
    for (let i = 0; i < GAMEPAD_ACTIONS.length; i++) {
      const pressed = buttonValue(pad, GAMEPAD_ACTIONS[i][0]) > 0.5;
      if (pressed && !this.previous[i] && this.primed) this.fired.push(GAMEPAD_ACTIONS[i][1]);
      this.previous[i] = pressed;
    }
    this.primed = true;
    return this.fired;
  }
}
