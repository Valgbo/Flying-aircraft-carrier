/**
 * Human-readable names for keys, mouse buttons, gamepad and joystick inputs and whole bindings.
 * Pure; OWNED BY THE INPUT MODULE. Wraps the carrier's keyLabel (src/engine) without changing it.
 */
import { keyLabel } from '../../engine';
import type { Binding, BindingsConfig, HatDir, Source } from './bindings';
import { CONTROL_DEFS, type ControlId } from './controls';
import { PAD_AXIS_NAMES, PAD_BUTTON_NAMES, shortDeviceName } from './devices';

const KEY_NAMES: Record<string, string> = {
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  IntlBackslash: '<',
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num −',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  MetaLeft: 'Left ⌘',
  MetaRight: 'Right ⌘',
  Escape: 'Esc',
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  CapsLock: 'Caps Lock',
  ContextMenu: 'Menu',
};

/** "KeyW" → "W", "PageUp" → "Page Up", "ArrowUp" → "↑", "ShiftLeft" → "Left Shift". */
export function keyName(code: string): string {
  return KEY_NAMES[code] ?? keyLabel(code);
}

export function mouseName(button: number): string {
  return (
    ['Mouse left', 'Mouse middle', 'Mouse right', 'Mouse back', 'Mouse forward'][button] ??
    `Mouse ${button + 1}`
  );
}

const ARROWS: Record<HatDir, string> = { up: '↑', down: '↓', left: '←', right: '→' };

function padAxisName(axis: number, dir?: 1 | -1): string {
  if (dir === undefined) return PAD_AXIS_NAMES[axis] ?? `Axis ${axis + 1}`;
  if (axis < 4) {
    const stick = axis < 2 ? 'Left stick' : 'Right stick';
    const horizontal = axis % 2 === 0;
    const arrow = horizontal ? (dir > 0 ? '→' : '←') : dir > 0 ? '↓' : '↑';
    return `${stick} ${arrow}`;
  }
  return `Axis ${axis + 1} ${dir > 0 ? '+' : '−'}`;
}

/** The name of an input, e.g. "Ctrl + ↑", "Mouse middle", "RT", "Warthog Joystick: Button 3". */
export function sourceName(s: Source): string {
  switch (s.type) {
    case 'key': {
      const mods = `${s.ctrl ? 'Ctrl + ' : ''}${s.alt ? 'Alt + ' : ''}${s.shift ? 'Shift + ' : ''}`;
      return mods + keyName(s.code);
    }
    case 'mouse':
      return mouseName(s.button);
    case 'wheel':
      return s.dir > 0 ? 'Wheel up' : 'Wheel down';
    case 'padButton':
      return PAD_BUTTON_NAMES[s.button] ?? `Button ${s.button + 1}`;
    case 'padAxis':
      return padAxisName(s.axis, s.dir);
    case 'hidButton':
      return `${shortDeviceName(s.device.name)}: Button ${s.button + 1}`;
    case 'hidAxis':
      return `${shortDeviceName(s.device.name)}: Axis ${s.axis + 1}${
        s.dir === undefined ? '' : s.dir > 0 ? ' +' : ' −'
      }`;
    case 'hidHat':
      return `${shortDeviceName(s.device.name)}: Hat ${ARROWS[s.dir]}`;
  }
}

/** The name of the gamepad shift layer: the input bound to "Gamepad shift layer", e.g. "LT". */
export function shiftName(config: BindingsConfig): string {
  const b = config.controls.padShift[0];
  return b ? sourceName(b.src) : 'Shift';
}

/** A binding with its layer, e.g. "LT + A". */
export function bindingName(b: Binding, config: BindingsConfig): string {
  const base = sourceName(b.src);
  return b.layer === 'shift' ? `${shiftName(config)} + ${base}` : base;
}

/** What a digital binding of an axis or lever does, e.g. "pull (nose up)". */
export function directionWord(control: ControlId, dir: 1 | -1 | undefined): string {
  const words = CONTROL_DEFS[control].dirWords;
  if (!words || dir === undefined) return '';
  return dir > 0 ? words[1] : words[0];
}

export function isKeyboardSource(s: Source): boolean {
  return s.type === 'key' || s.type === 'mouse' || s.type === 'wheel';
}
