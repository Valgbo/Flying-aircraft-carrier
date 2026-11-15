/**
 * ControlsManager — mounts the keyboard and gamepad layers. Renders nothing.
 *
 * Both layers are plain attach / detach functions, so the effect is symmetric and safe under
 * the StrictMode double mount: detaching removes every listener, stops the gamepad poll and
 * zeroes the keyboard and gamepad input slots. The on-screen touch controls are a separate
 * component (TouchControls) rendered by the UI overlay.
 */
import { useEffect } from 'react';
import { attachGamepad } from './gamepadLayer';
import { attachKeyboard } from './keyboardLayer';

export default function ControlsManager() {
  useEffect(() => {
    const detachKeyboard = attachKeyboard();
    const detachGamepad = attachGamepad();
    return () => {
      detachKeyboard();
      detachGamepad();
    };
  }, []);
  return null;
}
