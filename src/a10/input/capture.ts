/**
 * Capturing an input for rebinding. Pure state machine fed by the controls panel; OWNED BY THE
 * INPUT MODULE.
 *
 * - Keys: the key with the modifiers held (Ctrl + ↑). A modifier pressed and released alone
 *   binds the modifier itself (Left Shift). Esc cancels. Meta chords are ignored.
 * - Mouse buttons and wheel notches (on the panel's capture area).
 * - Gamepads and joysticks: a button newly pressed; an axis that moves more than 0.5 from where
 *   it rested when the capture started (its direction sets "invert" for axis controls); a hat
 *   that leaves its centre. A device that appears during the capture only sets its rest values.
 * What a control accepts depends on its kind (bindings.ts `sourceAllowed`): the analogue trigger
 * takes only analogue inputs, presses and holds only on/off inputs.
 */
import {
  defaultCalFor,
  isAnalogBinding,
  sourceAllowed,
  type Binding,
  type Source,
} from './bindings';
import { CONTROL_DEFS, type ControlId } from './controls';
import { buttonDown } from './curves';
import {
  axisValue,
  buttonValue,
  deviceOrdinal,
  deviceRef,
  hatDirOf,
  hatMask,
  identityOf,
  isHatRest,
  isStandard,
  type PadLike,
} from './devices';
import type { KeyMods } from './engine';

/** For axis and lever controls captured with keys or buttons: which direction is asked for. */
export type CaptureStep = 'positive' | 'negative';

export type CaptureOutcome = { kind: 'binding'; binding: Binding } | { kind: 'cancel' } | null;

/** How far an axis must move from rest to count. */
export const AXIS_CAPTURE_DELTA = 0.5;

const MODIFIERS = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
]);

interface DeviceRest {
  axes: number[];
  buttons: boolean[];
}

export class CaptureSession {
  readonly control: ControlId;
  readonly step: CaptureStep;
  private readonly rest = new Map<string, DeviceRest>();
  private pendingModifier: string | null = null;
  private done = false;

  constructor(control: ControlId, step: CaptureStep, pads: ArrayLike<PadLike | null | undefined>) {
    this.control = control;
    this.step = step;
    this.pollPads(pads, true);
  }

  get finished(): boolean {
    return this.done;
  }

  private get kind() {
    return CONTROL_DEFS[this.control].kind;
  }

  /** Finish with a binding if the control accepts it (otherwise keep waiting). */
  private offer(src: Source, layer?: 'shift', cal?: Binding['cal']): CaptureOutcome {
    const b: Binding = { src };
    if (layer) b.layer = layer;
    const kind = this.kind;
    const analog = isAnalogBinding(b, kind);
    if (!sourceAllowed(src, kind, analog)) return null;
    if ((kind === 'axis' || kind === 'lever') && !analog) b.dir = this.step === 'negative' ? -1 : 1;
    if (analog) b.cal = cal ?? defaultCalFor(src, kind);
    this.done = true;
    return { kind: 'binding', binding: b };
  }

  keyDown(code: string, mods: KeyMods): CaptureOutcome {
    if (this.done) return null;
    if (code === 'Escape') {
      this.done = true;
      return { kind: 'cancel' };
    }
    if (MODIFIERS.has(code)) {
      this.pendingModifier = code;
      return null;
    }
    if (mods.meta || code.startsWith('Meta')) return null;
    this.pendingModifier = null;
    const src: Source = { type: 'key', code };
    if (mods.ctrl) src.ctrl = true;
    if (mods.alt) src.alt = true;
    if (mods.shift) src.shift = true;
    return this.offer(src);
  }

  keyUp(code: string): CaptureOutcome {
    if (this.done) return null;
    if (this.pendingModifier === code) {
      this.pendingModifier = null;
      return this.offer({ type: 'key', code });
    }
    return null;
  }

  mouseDown(button: number): CaptureOutcome {
    if (this.done || !Number.isInteger(button) || button < 0 || button > 15) return null;
    return this.offer({ type: 'mouse', button });
  }

  wheel(dir: 1 | -1): CaptureOutcome {
    if (this.done) return null;
    return this.offer({ type: 'wheel', dir });
  }

  /** Poll the controllers (call every frame while capturing). */
  pads(pads: ArrayLike<PadLike | null | undefined>): CaptureOutcome {
    if (this.done) return null;
    return this.pollPads(pads, false);
  }

  private pollPads(pads: ArrayLike<PadLike | null | undefined>, initial: boolean): CaptureOutcome {
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad || !pad.connected) continue;
      const ordinal = deviceOrdinal(pads, i);
      const id = `${identityOf(pad.id).key}#${ordinal}`;
      let rest = this.rest.get(id);
      if (!rest || initial) {
        rest = { axes: [], buttons: [] };
        for (let a = 0; a < pad.axes.length; a++) rest.axes[a] = axisValue(pad, a);
        for (let b = 0; b < pad.buttons.length; b++) rest.buttons[b] = buttonValue(pad, b) > 0.3;
        this.rest.set(id, rest);
        continue;
      }
      const outcome = this.checkPad(pad, ordinal, rest);
      if (outcome) return outcome;
    }
    return null;
  }

  private checkPad(pad: PadLike, ordinal: number, rest: DeviceRest): CaptureOutcome {
    const standard = isStandard(pad);
    // buttons
    for (let b = 0; b < pad.buttons.length; b++) {
      const down = buttonDown(false, buttonValue(pad, b));
      if (!down) {
        rest.buttons[b] = false;
        continue;
      }
      if (rest.buttons[b]) continue;
      const src: Source = standard
        ? { type: 'padButton', button: b }
        : { type: 'hidButton', device: deviceRef(pad, ordinal), button: b };
      const out = this.offer(src);
      if (out) return out;
      rest.buttons[b] = true;
    }
    // axes and hats
    for (let a = 0; a < pad.axes.length; a++) {
      const v = axisValue(pad, a);
      const r = rest.axes[a] ?? 0;
      if (!standard && isHatRest(r)) {
        const dir = hatDirOf(hatMask(v));
        if (dir) {
          const out = this.offer({ type: 'hidHat', device: deviceRef(pad, ordinal), axis: a, dir });
          if (out) return out;
        }
        continue;
      }
      const delta = v - r;
      if (Math.abs(delta) <= AXIS_CAPTURE_DELTA) continue;
      const moved: 1 | -1 = delta > 0 ? 1 : -1;
      const kind = this.kind;
      if (kind === 'axis' || kind === 'lever' || kind === 'trigger') {
        const src: Source = standard
          ? { type: 'padAxis', axis: a }
          : { type: 'hidAxis', device: deviceRef(pad, ordinal), axis: a };
        const cal = { ...defaultCalFor(src, kind) };
        // the panel asks for the positive direction; moving the other way means inverted
        cal.invert = moved < 0;
        if (kind === 'axis' && !standard && Math.abs(r) < 0.25)
          cal.centre = Math.round(r * 100) / 100;
        const out = this.offer(src, undefined, cal);
        if (out) return out;
      } else {
        const src: Source = standard
          ? { type: 'padAxis', axis: a, dir: moved }
          : { type: 'hidAxis', device: deviceRef(pad, ordinal), axis: a, dir: moved };
        const out = this.offer(src);
        if (out) return out;
      }
    }
    return null;
  }
}

/** The capture prompt for a control and step, in the aircraft's terms. */
export function capturePrompt(control: ControlId, step: CaptureStep): string {
  const def = CONTROL_DEFS[control];
  if (def.kind === 'trigger') return `${def.movePrompt ?? 'Move the axis'} on the device.`;
  if (def.kind === 'axis' || def.kind === 'lever') {
    const words = def.dirWords ?? ['negative', 'positive'];
    const word = step === 'negative' ? words[0] : words[1];
    return step === 'negative'
      ? `Now press the key or button for “${word}”. Esc skips.`
      : `${def.movePrompt ?? 'Move the axis'} on the device, or press the key or button for “${word}”.`;
  }
  return 'Press a key, click a mouse button or turn the wheel here, or press a button on the device.';
}
