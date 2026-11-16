/**
 * Input: keyboard, mouse, gamepad and joystick → sim.input and commands. OWNED BY THE INPUT MODULE.
 * FOUNDATION STAND-IN: arrows fly, Page Up/Down throttle, Shift/Space trigger, Enter release,
 * 1 Master Arm, M master mode, Esc pause.
 */
import { useEffect } from 'react';
import { pushCommand } from '../core/sim';
import { getSim } from '../state/runtime';
import { useA10Store } from '../state/store';
import { applyTestInputOverride } from '../state/testHook';
import { onBeforeSimSteps } from '../view/frame';

const held = new Set<string>();
let throttle = 0.85;

export default function InputManager() {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      held.add(e.code);
      const sim = getSim();
      if (e.code === 'Escape') useA10Store.getState().togglePause();
      if (!sim) return;
      if (e.code === 'Digit1') pushCommand(sim, { type: 'masterArm', value: 'cycle' });
      if (e.code === 'KeyM') pushCommand(sim, { type: 'masterMode', value: 'next' });
    };
    const up = (e: KeyboardEvent) => held.delete(e.code);
    const blur = () => held.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    const off = onBeforeSimSteps((sim, dt) => {
      const i = sim.input;
      i.pitch = (held.has('ArrowDown') ? 1 : 0) - (held.has('ArrowUp') ? 1 : 0);
      i.roll = (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0);
      i.rudder = (held.has('KeyX') ? 1 : 0) - (held.has('KeyZ') ? 1 : 0);
      if (held.has('PageUp')) throttle = Math.min(1, throttle + dt * 0.5);
      if (held.has('PageDown')) throttle = Math.max(0, throttle - dt * 0.5);
      i.throttle[0] = throttle;
      i.throttle[1] = throttle;
      i.trigger = held.has('Space') ? 2 : held.has('ShiftLeft') ? 1 : 0;
      i.weaponRelease = held.has('Enter');
      i.speedBrake = held.has('KeyB') ? 1 : held.has('KeyN') ? -1 : 0;
      applyTestInputOverride(i);
    });
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      off();
    };
  }, []);
  return null;
}
