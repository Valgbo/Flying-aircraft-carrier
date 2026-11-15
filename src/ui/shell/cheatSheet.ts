/**
 * Content of the compact controls reference shown in the main menu and the pause menu.
 * The keyboard rows are built from the live key bindings; gamepad and touch follow the
 * control scheme in PLAN.md §6. Pure data — covered by tests/unit/shell.test.ts.
 */
import { keyLabel, type BindingId, type KeyBindings } from '../../state/bindings';

export interface CheatRow {
  /** Key caps / control names, shown side by side (e.g. ["W", "S"]). */
  keys: readonly string[];
  label: string;
}

export type CheatDevice = 'keyboard' | 'gamepad' | 'touch';

export const CHEAT_DEVICES: readonly { id: CheatDevice; label: string }[] = [
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'gamepad', label: 'Gamepad' },
  { id: 'touch', label: 'Touch' },
];

/**
 * Keyboard rows: opposite directions of one axis share a row. Every binding of
 * BINDING_ORDER appears exactly once (enforced by a unit test), so a binding added later
 * cannot silently go missing from the reference.
 */
export const KEYBOARD_CHEAT_ROWS: readonly { ids: readonly BindingId[]; label: string }[] = [
  { ids: ['throttleUp', 'throttleDown'], label: 'Climb / descend' },
  { ids: ['tiltForward', 'tiltBack'], label: 'Tilt forward / back' },
  { ids: ['yawLeft', 'yawRight'], label: 'Yaw left / right' },
  { ids: ['strafeLeft', 'strafeRight'], label: 'Strafe left / right' },
  { ids: ['toggleAssist'], label: 'Flight assist' },
  { ids: ['cycleCamera'], label: 'Camera' },
  { ids: ['launchJet'], label: 'Launch jet' },
  { ids: ['toggleTurbinePanel'], label: 'Turbine panel' },
  { ids: ['togglePause'], label: 'Pause' },
  { ids: ['resetFlight'], label: 'Reset flight' },
];

/** Bindings that do nothing outside flight ops: left out of the reference in free flight. */
export const OPS_ONLY_BINDINGS: readonly BindingId[] = ['launchJet'];

/**
 * The keyboard reference for the given bindings, with human-readable key names.
 * Rows of the bindings in `omit` are left out.
 */
export function keyboardCheatSheet(
  bindings: KeyBindings,
  omit: readonly BindingId[] = [],
): CheatRow[] {
  return KEYBOARD_CHEAT_ROWS.filter((row) => !row.ids.some((id) => omit.includes(id))).map(
    (row) => ({
      keys: row.ids.map((id) => keyLabel(bindings[id])),
      label: row.label,
    }),
  );
}

export const GAMEPAD_CHEAT_SHEET: readonly CheatRow[] = [
  { keys: ['RT', 'LT'], label: 'Climb / descend' },
  { keys: ['R stick ↕'], label: 'Tilt forward / back' },
  { keys: ['L stick ↔'], label: 'Yaw left / right' },
  { keys: ['LB', 'RB'], label: 'Strafe left / right' },
  { keys: ['Y'], label: 'Flight assist' },
  { keys: ['Select'], label: 'Camera' },
  { keys: ['A'], label: 'Launch jet' },
  { keys: ['X'], label: 'Turbine panel' },
  { keys: ['Start'], label: 'Pause' },
];

export const TOUCH_CHEAT_SHEET: readonly CheatRow[] = [
  { keys: ['Slider'], label: 'Climb / descend' },
  { keys: ['Stick ↕'], label: 'Tilt forward / back' },
  { keys: ['Stick ↔'], label: 'Yaw left / right' },
  { keys: ['PORT', 'STBD'], label: 'Strafe left / right (hold)' },
  { keys: ['Buttons'], label: 'Assist, camera, launch, turbines' },
  { keys: ['HUD button'], label: 'Pause' },
  { keys: ['Drag'], label: 'Look around' },
  { keys: ['Pinch'], label: 'Zoom' },
];

export function cheatSheetFor(device: CheatDevice, bindings: KeyBindings): readonly CheatRow[] {
  if (device === 'gamepad') return GAMEPAD_CHEAT_SHEET;
  if (device === 'touch') return TOUCH_CHEAT_SHEET;
  return keyboardCheatSheet(bindings);
}
