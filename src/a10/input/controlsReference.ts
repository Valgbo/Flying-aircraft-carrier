/**
 * The controls reference the UI shows (help overlay, pause menu). OWNED BY THE INPUT MODULE,
 * which generates it from the current bindings. FOUNDATION STAND-IN: the stand-in keys.
 */
export interface ControlsReferenceRow {
  /** What it does, in the aircraft's terms (e.g. 'Trigger: first detent (PAC-1)'). */
  action: string;
  /** Group heading (e.g. 'Stick', 'Throttle', 'Armament panel', 'Views'). */
  group: string;
  keyboard: string;
  gamepad: string;
}

export function getControlsReference(): ControlsReferenceRow[] {
  return [
    { group: 'Stick', action: 'Pitch and roll', keyboard: 'Arrow keys', gamepad: '' },
    { group: 'Stick', action: 'Trigger: fire (second detent)', keyboard: 'Space', gamepad: '' },
    {
      group: 'Stick',
      action: 'Trigger: first detent (PAC-1)',
      keyboard: 'Left Shift',
      gamepad: '',
    },
    { group: 'Stick', action: 'Weapon release', keyboard: 'Enter', gamepad: '' },
    { group: 'Throttle', action: 'Throttles', keyboard: 'Page Up / Page Down', gamepad: '' },
    { group: 'Armament panel', action: 'Master Arm', keyboard: '1', gamepad: '' },
    { group: 'HUD', action: 'Master mode', keyboard: 'M', gamepad: '' },
    { group: 'General', action: 'Pause', keyboard: 'Esc', gamepad: '' },
  ];
}
