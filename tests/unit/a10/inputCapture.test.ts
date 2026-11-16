import { describe, expect, it } from 'vitest';
import { CaptureSession, capturePrompt } from '../../../src/a10/input/capture';
import type { KeyMods } from '../../../src/a10/input/engine';
import type { PadLike } from '../../../src/a10/input/devices';

const NONE: KeyMods = { ctrl: false, alt: false, shift: false, meta: false };

function pad(axes: number[], buttons: number[] = [], opts: Partial<PadLike> = {}): PadLike {
  return {
    id: 'T.16000M (Vendor: 044f Product: b10a)',
    index: 0,
    mapping: '',
    connected: true,
    axes,
    buttons: Array.from({ length: 16 }, (_, i) => ({
      pressed: buttons.includes(i),
      value: buttons.includes(i) ? 1 : 0,
    })),
    ...opts,
  };
}

describe('capturing keys', () => {
  it('records the key with the modifiers held', () => {
    const s = new CaptureSession('trimPitch', 'positive', []);
    expect(s.keyDown('ControlLeft', { ...NONE, ctrl: true })).toBeNull();
    expect(s.keyDown('ArrowDown', { ...NONE, ctrl: true })).toEqual({
      kind: 'binding',
      binding: { src: { type: 'key', code: 'ArrowDown', ctrl: true }, dir: 1 },
    });
    expect(s.finished).toBe(true);
  });

  it('a modifier pressed and released alone binds the modifier itself', () => {
    const s = new CaptureSession('triggerFirst', 'positive', []);
    expect(s.keyDown('ShiftLeft', { ...NONE, shift: true })).toBeNull();
    expect(s.keyUp('ShiftLeft')).toEqual({
      kind: 'binding',
      binding: { src: { type: 'key', code: 'ShiftLeft' } },
    });
  });

  it('Escape cancels; Meta chords are ignored', () => {
    const s = new CaptureSession('gear', 'positive', []);
    expect(s.keyDown('KeyG', { ...NONE, meta: true })).toBeNull();
    expect(s.keyDown('Escape', NONE)).toEqual({ kind: 'cancel' });
  });

  it('keys on an axis carry the asked direction', () => {
    const s = new CaptureSession('rudder', 'negative', []);
    expect(s.keyDown('KeyJ', NONE)).toEqual({
      kind: 'binding',
      binding: { src: { type: 'key', code: 'KeyJ' }, dir: -1 },
    });
  });

  it('the analogue trigger accepts no keys, mouse or wheel', () => {
    const s = new CaptureSession('triggerAxis', 'positive', []);
    expect(s.keyDown('KeyJ', NONE)).toBeNull();
    expect(s.mouseDown(0)).toBeNull();
    expect(s.wheel(1)).toBeNull();
    expect(s.finished).toBe(false);
  });

  it('mouse buttons and wheel notches bind presses; the wheel cannot fly', () => {
    expect(new CaptureSession('zoomHold', 'positive', []).mouseDown(1)).toMatchObject({
      binding: { src: { type: 'mouse', button: 1 } },
    });
    expect(new CaptureSession('sensorZoomIn', 'positive', []).wheel(1)).toMatchObject({
      binding: { src: { type: 'wheel', dir: 1 } },
    });
    expect(new CaptureSession('pitch', 'positive', []).wheel(1)).toBeNull();
  });
});

describe('capturing devices', () => {
  it('an axis moved more than 0.5 from rest; moving it the other way sets invert', () => {
    const s = new CaptureSession('pitch', 'positive', [pad([0.02, 0.05, -1])]);
    expect(s.pads([pad([0.02, 0.45, -1])])).toBeNull();
    const out = s.pads([pad([0.02, -0.6, -1])]);
    expect(out).toMatchObject({
      kind: 'binding',
      binding: {
        src: {
          type: 'hidAxis',
          axis: 1,
          device: { key: '044f:b10a', name: 'T.16000M', ordinal: 0 },
        },
        cal: { invert: true, centre: 0.05 },
      },
    });
  });

  it('a throttle resting at idle, pushed forward, is a lever axis', () => {
    const s = new CaptureSession('throttleBoth', 'positive', [pad([0, 0, -1])]);
    expect(s.pads([pad([0, 0, 0.2])])).toMatchObject({
      binding: { src: { type: 'hidAxis', axis: 2 }, cal: { invert: false, deadZone: 0.02 } },
    });
  });

  it('a button newly pressed (one held at the start does not count)', () => {
    const s = new CaptureSession('weaponRelease', 'positive', [pad([0, 0, 0], [3])]);
    expect(s.pads([pad([0, 0, 0], [3])])).toBeNull();
    expect(s.pads([pad([0, 0, 0], [3, 7])])).toMatchObject({
      binding: { src: { type: 'hidButton', button: 7 } },
    });
  });

  it('a hat leaving its centre gives a hat direction', () => {
    const rest = 1.2857;
    const s = new CaptureSession('coolieUp', 'positive', [pad([0, 0, rest])]);
    expect(s.pads([pad([0, 0, -1])])).toMatchObject({
      binding: { src: { type: 'hidHat', axis: 2, dir: 'up' } },
    });
  });

  it('standard gamepads give gamepad inputs (any pad), triggers stay analogue', () => {
    const std = (axes: number[], rt = 0): PadLike => ({
      ...pad(axes),
      id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
      mapping: 'standard',
      buttons: Array.from({ length: 17 }, (_, i) => ({
        pressed: i === 7 && rt > 0.5,
        value: i === 7 ? rt : 0,
      })),
    });
    const t = new CaptureSession('triggerAxis', 'positive', [std([0, 0, 0, 0])]);
    expect(t.pads([std([0, 0, 0, 0], 0.9)])).toMatchObject({
      binding: { src: { type: 'padButton', button: 7 } },
    });
    const a = new CaptureSession('roll', 'positive', [std([0, 0, 0, 0])]);
    expect(a.pads([std([0.8, 0, 0, 0])])).toMatchObject({
      binding: {
        src: { type: 'padAxis', axis: 0 },
        cal: { invert: false, deadZone: 0.12, curve: 0.4 },
      },
    });
    // an axis used for a press becomes a direction
    const p = new CaptureSession('coolieLeft', 'positive', [std([0, 0, 0, 0])]);
    expect(p.pads([std([-0.9, 0, 0, 0])])).toMatchObject({
      binding: { src: { type: 'padAxis', axis: 0, dir: -1 } },
    });
  });

  it('a device that appears during the capture only records its rest position', () => {
    const s = new CaptureSession('gear', 'positive', []);
    expect(s.pads([pad([0, 0, 0], [2])])).toBeNull();
    expect(s.pads([pad([0, 0, 0], [2])])).toBeNull();
    expect(s.pads([pad([0, 0, 0], [2, 4])])).toMatchObject({ binding: { src: { button: 4 } } });
  });

  it('prompts in the aircraft terms', () => {
    expect(capturePrompt('pitch', 'positive')).toMatch(/Pull the stick back/);
    expect(capturePrompt('pitch', 'negative')).toMatch(/push \(nose down\)/);
    expect(capturePrompt('triggerAxis', 'positive')).toMatch(/Squeeze/);
  });
});
