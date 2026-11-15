/** Keyboard bindings. Values are KeyboardEvent.code strings (layout independent). */

export type BindingId =
  | 'throttleUp'
  | 'throttleDown'
  | 'tiltForward'
  | 'tiltBack'
  | 'yawLeft'
  | 'yawRight'
  | 'strafeLeft'
  | 'strafeRight'
  | 'toggleAssist'
  | 'cycleCamera'
  | 'launchJet'
  | 'toggleTurbinePanel'
  | 'togglePause'
  | 'resetFlight';

export type KeyBindings = Record<BindingId, string>;

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  throttleUp: 'KeyW',
  throttleDown: 'KeyS',
  tiltForward: 'ArrowUp',
  tiltBack: 'ArrowDown',
  yawLeft: 'KeyA',
  yawRight: 'KeyD',
  strafeLeft: 'KeyQ',
  strafeRight: 'KeyE',
  toggleAssist: 'KeyF',
  cycleCamera: 'KeyC',
  launchJet: 'Space',
  toggleTurbinePanel: 'KeyT',
  togglePause: 'Escape',
  resetFlight: 'KeyR',
};

export const BINDING_LABELS: Record<BindingId, string> = {
  throttleUp: 'Throttle up / climb',
  throttleDown: 'Throttle down / descend',
  tiltForward: 'Tilt turbines forward',
  tiltBack: 'Tilt turbines back',
  yawLeft: 'Yaw left',
  yawRight: 'Yaw right',
  strafeLeft: 'Strafe / roll left',
  strafeRight: 'Strafe / roll right',
  toggleAssist: 'Toggle flight assist',
  cycleCamera: 'Cycle camera',
  launchJet: 'Launch jet',
  toggleTurbinePanel: 'Turbine panel',
  togglePause: 'Pause',
  resetFlight: 'Reset flight',
};

export const BINDING_ORDER: readonly BindingId[] = [
  'throttleUp',
  'throttleDown',
  'tiltForward',
  'tiltBack',
  'yawLeft',
  'yawRight',
  'strafeLeft',
  'strafeRight',
  'toggleAssist',
  'cycleCamera',
  'launchJet',
  'toggleTurbinePanel',
  'togglePause',
  'resetFlight',
];

/** Human-readable name for a KeyboardEvent.code, e.g. "KeyW" → "W", "ArrowUp" → "↑". */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  switch (code) {
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    case 'Space':
      return 'Space';
    case 'Escape':
      return 'Esc';
    case 'ShiftLeft':
      return 'L-Shift';
    case 'ShiftRight':
      return 'R-Shift';
    case 'ControlLeft':
      return 'L-Ctrl';
    case 'ControlRight':
      return 'R-Ctrl';
    default:
      return code;
  }
}
