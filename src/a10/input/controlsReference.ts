/**
 * The controls reference the UI shows (pause menu, help overlay, checklist strip), generated
 * from the CURRENT bindings in the aircraft's terms. OWNED BY THE INPUT MODULE.
 *
 * `getControlsReference()` returns every row; rows for HOTAS functions with nothing bound (DMS,
 * coolie hat …) are left out. `useControlsReference()` re-renders when bindings change.
 * `controlKeys(id)` gives the keys of one control for a hint such as "Master Arm to ARM (1)".
 */
import { useMemo } from 'react';
import { useA10Store } from '../state/store';
import { isAnalogBinding, type Binding, type BindingsConfig } from './bindings';
import { getBindingsConfig, useBindings } from './bindingsStore';
import { CONTROL_DEFS, type ControlId } from './controls';
import { bindingName, isKeyboardSource } from './labels';

export interface ControlsReferenceRow {
  /** What it does, in the aircraft's terms (e.g. 'Trigger: first detent (PAC-1)'). */
  action: string;
  /** Group heading (e.g. 'Stick', 'Throttle', 'Armament panel', 'Views'). */
  group: string;
  keyboard: string;
  gamepad: string;
  /** Stable row id ('masterArm', 'trigger1', 'views' …), e.g. for the checklist strip. */
  id?: string;
  /** The controls the row describes. */
  controls?: readonly ControlId[];
}

interface RowSpec {
  id: string;
  group: string;
  action: string;
  controls: ControlId[];
  /** Shown even when nothing is bound. */
  always?: boolean;
  /** The analogue trigger's part of a detent row. */
  triggerPart?: 'half' | 'full';
}

const ROWS: RowSpec[] = [
  {
    id: 'stick',
    group: 'Stick',
    action: 'Stick: pitch and roll',
    controls: ['pitch', 'roll'],
    always: true,
  },
  { id: 'rudder', group: 'Stick', action: 'Rudder', controls: ['rudder'], always: true },
  { id: 'trim', group: 'Stick', action: 'Trim', controls: ['trimPitch', 'trimRoll'], always: true },
  { id: 'rudderTrim', group: 'Stick', action: 'Rudder trim', controls: ['trimYaw'] },
  {
    id: 'trigger1',
    group: 'Stick',
    action: 'Trigger: first detent (PAC-1)',
    controls: ['triggerFirst', 'triggerAxis'],
    always: true,
    triggerPart: 'half',
  },
  {
    id: 'trigger2',
    group: 'Stick',
    action: 'Trigger: second detent (fire)',
    controls: ['triggerSecond', 'triggerAxis'],
    always: true,
    triggerPart: 'full',
  },
  {
    id: 'weaponRelease',
    group: 'Stick',
    action: 'Weapon release',
    controls: ['weaponRelease'],
    always: true,
  },
  {
    id: 'tmsUp',
    group: 'Stick',
    action: 'Target management up: track; hold to set the SPI',
    controls: ['tmsUp'],
    always: true,
  },
  {
    id: 'tmsDown',
    group: 'Stick',
    action: 'Target management down: break track; hold to reset the SPI',
    controls: ['tmsDown'],
    always: true,
  },
  { id: 'tmsLeft', group: 'Stick', action: 'Target management left', controls: ['tmsLeft'] },
  { id: 'tmsRight', group: 'Stick', action: 'Target management right', controls: ['tmsRight'] },
  {
    id: 'dms',
    group: 'Stick',
    action: 'Data management switch: up, down, left, right',
    controls: ['dmsUp', 'dmsDown', 'dmsLeft', 'dmsRight'],
  },
  {
    id: 'coolie',
    group: 'Stick',
    action: 'Coolie hat: up, down, left, right',
    controls: ['coolieUp', 'coolieDown', 'coolieLeft', 'coolieRight'],
  },
  {
    id: 'throttles',
    group: 'Throttle',
    action: 'Throttles',
    controls: ['throttleBoth', 'throttleLeft', 'throttleRight'],
    always: true,
  },
  {
    id: 'speedBrake',
    group: 'Throttle',
    action: 'Speed brake',
    controls: ['speedBrakeToggle', 'speedBrakeExtend', 'speedBrakeRetract'],
    always: true,
  },
  {
    id: 'chinaFwd',
    group: 'Throttle',
    action: 'Field of view; hold to slave all sensors to the SPI',
    controls: ['chinaFwd'],
    always: true,
  },
  { id: 'chinaAft', group: 'Throttle', action: 'China hat aft', controls: ['chinaAft'] },
  {
    id: 'slew',
    group: 'Throttle',
    action: 'Slew the sensor or cursor',
    controls: ['slewX', 'slewY'],
    always: true,
  },
  {
    id: 'masterArm',
    group: 'Armament panel',
    action: 'Master Arm',
    controls: ['masterArm'],
    always: true,
  },
  { id: 'gunPac', group: 'Armament panel', action: 'GUN/PAC', controls: ['gunPac'], always: true },
  {
    id: 'laserArm',
    group: 'Armament panel',
    action: 'Laser arm',
    controls: ['laserArm'],
    always: true,
  },
  {
    id: 'tgpPower',
    group: 'Armament panel',
    action: 'Targeting pod power',
    controls: ['tgpPower'],
    always: true,
  },
  {
    id: 'altSource',
    group: 'Armament panel',
    action: 'Altitude source',
    controls: ['altSource'],
    always: true,
  },
  {
    id: 'masterMode',
    group: 'HUD and displays',
    action: 'Master mode: NAV, GUNS, CCIP, CCRP',
    controls: ['masterMode'],
    always: true,
  },
  {
    id: 'profile',
    group: 'HUD and displays',
    action: 'Previous / next weapon profile',
    controls: ['profilePrev', 'profileNext'],
    always: true,
  },
  {
    id: 'soi',
    group: 'HUD and displays',
    action: 'Sensor of interest: HUD, left display, right display',
    controls: ['soiHud', 'soiLeft', 'soiRight', 'soiStepLeft', 'soiStepRight'],
    always: true,
  },
  {
    id: 'steerpoint',
    group: 'HUD and displays',
    action: 'Previous / next steerpoint',
    controls: ['steerpointPrev', 'steerpointNext'],
  },
  {
    id: 'picture',
    group: 'Sensors',
    action: 'Picture: white-hot, black-hot, television',
    controls: ['sensorPicture'],
    always: true,
  },
  {
    id: 'sensorZoom',
    group: 'Sensors',
    action: 'Sensor zoom in / out',
    controls: ['sensorZoomIn', 'sensorZoomOut'],
    always: true,
  },
  { id: 'laser', group: 'Sensors', action: 'Fire the laser', controls: ['laser'], always: true },
  {
    id: 'flaps',
    group: 'Systems',
    action: 'Flaps',
    controls: ['flaps', 'flapsUp', 'flapsDown'],
    always: true,
  },
  { id: 'gear', group: 'Systems', action: 'Landing gear', controls: ['gear'], always: true },
  {
    id: 'autopilot',
    group: 'Systems',
    action: 'Autopilot engage / mode',
    controls: ['autopilot', 'autopilotMode'],
    always: true,
  },
  {
    id: 'altitudeAlert',
    group: 'Systems',
    action: 'Altitude alert',
    controls: ['altitudeAlert'],
    always: true,
  },
  { id: 'jettison', group: 'Systems', action: 'Emergency jettison (hold)', controls: ['jettison'] },
  {
    id: 'views',
    group: 'Views',
    action: 'Views: cockpit, chase, fly-by, orbit, weapon',
    controls: ['viewCockpit', 'viewChase', 'viewFlyby', 'viewOrbit', 'viewWeapon', 'viewCycle'],
    always: true,
  },
  { id: 'look', group: 'Views', action: 'Look around', controls: ['lookX', 'lookY'], always: true },
  {
    id: 'zoom',
    group: 'Views',
    action: 'Zoom the view',
    controls: ['zoomHold', 'zoomIn', 'zoomOut'],
    always: true,
  },
  { id: 'centerView', group: 'Views', action: 'Centre the view', controls: ['centerView'] },
  {
    id: 'lookAtSpi',
    group: 'Views',
    action: 'Look at the SPI',
    controls: ['lookAtSpi'],
    always: true,
  },
  {
    id: 'cursorFree',
    group: 'Views',
    action: 'Free the cursor to click the cockpit',
    controls: ['cursorFree'],
    always: true,
  },
  {
    id: 'mouseLook',
    group: 'Views',
    action: 'Mouse look in mouse-stick mode',
    controls: ['mouseLook'],
  },
  { id: 'pause', group: 'General', action: 'Pause', controls: ['pause'], always: true },
  { id: 'help', group: 'General', action: 'Help', controls: ['help'] },
  { id: 'padShift', group: 'General', action: 'Gamepad shift layer', controls: ['padShift'] },
];

type Column = 'keyboard' | 'gamepad';

const inColumn = (b: Binding, column: Column) =>
  column === 'keyboard' ? isKeyboardSource(b.src) : !isKeyboardSource(b.src);

function uniq(list: string[]): string[] {
  return [...new Set(list.filter((s) => s.length > 0))];
}

/** The parts of one control in one column, e.g. pitch → ['↑ / ↓']. */
function controlParts(
  config: BindingsConfig,
  id: ControlId,
  column: Column,
  row: RowSpec,
): string[] {
  const def = CONTROL_DEFS[id];
  const list = config.controls[id].filter((b) => inColumn(b, column));
  if (list.length === 0) return [];
  if (def.kind === 'trigger') {
    if (!row.triggerPart) return [];
    return uniq(list.map((b) => `${bindingName(b, config)} ${row.triggerPart}`));
  }
  if (def.kind === 'axis' || def.kind === 'lever') {
    const neg = uniq(
      list
        .filter((b) => !isAnalogBinding(b, def.kind) && b.dir === -1)
        .map((b) => bindingName(b, config)),
    );
    const pos = uniq(
      list
        .filter((b) => !isAnalogBinding(b, def.kind) && b.dir === 1)
        .map((b) => bindingName(b, config)),
    );
    const analog = uniq(
      list.filter((b) => isAnalogBinding(b, def.kind)).map((b) => bindingName(b, config)),
    );
    const parts: string[] = [];
    if (neg.length || pos.length) {
      const first = def.kind === 'lever' ? pos : neg;
      const second = def.kind === 'lever' ? neg : pos;
      parts.push([first.join(', '), second.join(', ')].filter(Boolean).join(' / '));
    }
    return parts.concat(analog);
  }
  return uniq(list.map((b) => bindingName(b, config)));
}

const STICK_NAMES: Record<string, string> = {
  'Left stick ↕': 'Left stick',
  'Left stick ↔': 'Left stick',
  'Right stick ↕': 'Right stick',
  'Right stick ↔': 'Right stick',
};

/** Punctuation keys read better as words in a sentence-like list. */
const WORDS: Record<string, string> = { ',': 'comma', '.': 'full stop', '/': 'slash' };

/** Shorter forms for common layouts: arrow keys, W A S D, F1 to F5, sticks, the D-pad. */
function simplify(input: string[]): string[] {
  let out = uniq(
    input.map((p) => {
      for (const [long, short] of Object.entries(STICK_NAMES)) {
        if (p === long) return short;
        if (p.endsWith(` + ${long}`)) return p.replace(long, short.toLowerCase());
      }
      return WORDS[p] ?? p;
    }),
  );
  const join = out.join(' | ');
  if (join === '↑ / ↓ | ← / →') return ['Arrow keys'];
  if (join === 'Ctrl + ↑ / Ctrl + ↓ | Ctrl + ← / Ctrl + →') return ['Ctrl + arrow keys'];
  if (join === 'A / D | S / W') return ['W A S D'];
  if (join === 'Num 4 / Num 6 | Num 2 / Num 8') return ['Num 2 4 6 8'];
  if (out.length >= 5 && out.slice(0, 5).join(' ') === 'F1 F2 F3 F4 F5')
    out = ['F1 to F5', ...out.slice(5)];
  if (out.includes('Wheel up') && out.includes('Wheel down'))
    out = ['Wheel', ...out.filter((p) => p !== 'Wheel up' && p !== 'Wheel down')];
  out = out.map((p) => p.replace(/^(.*D-pad) (.) \/ \1 (.)$/, '$1 $2 / $3'));
  const dpad = /^(.*)D-pad ↑ \/ ↓ \| \1D-pad ← \/ →$/.exec(out.join(' | '));
  if (dpad) return [`${dpad[1]}D-pad`];
  return out;
}

function columnText(config: BindingsConfig, row: RowSpec, column: Column): string {
  const parts: string[] = [];
  for (const id of row.controls) parts.push(...controlParts(config, id, column, row));
  const axes = row.controls.some((id) => {
    const kind = CONTROL_DEFS[id].kind;
    return kind === 'axis' || kind === 'lever';
  });
  const text = simplify(uniq(parts)).join(axes ? ', ' : ' / ');
  // "D-pad ← / D-pad →" → "D-pad ← / →"
  return text.replace(/(D-pad) (.) \/ \1 (.)/g, '$1 $2 / $3');
}

function mouseNotes(
  row: RowSpec,
  keyboard: string,
  config: BindingsConfig,
  mouseStick: boolean,
): string {
  if (row.id === 'stick' && mouseStick) return keyboard ? `${keyboard}, mouse` : 'Mouse';
  if (row.id === 'look') {
    const hold = config.controls.mouseLook[0];
    const mouse = !mouseStick
      ? 'Mouse'
      : hold
        ? `Mouse with ${bindingName(hold, config)} held`
        : '';
    return [mouse, keyboard].filter(Boolean).join(', ');
  }
  return keyboard;
}

/**
 * Build the reference from a bindings configuration. `mouseStick` (settings.mouseStick) adds
 * the mouse to the stick row and says how to look around in mouse-stick mode.
 */
export function buildControlsReference(
  config: BindingsConfig,
  mouseStick = useA10Store.getState().settings.mouseStick,
): ControlsReferenceRow[] {
  const rows: ControlsReferenceRow[] = [];
  for (const spec of ROWS) {
    const keyboard = mouseNotes(spec, columnText(config, spec, 'keyboard'), config, mouseStick);
    const gamepad = columnText(config, spec, 'gamepad');
    if (!spec.always && !keyboard && !gamepad) continue;
    rows.push({
      id: spec.id,
      group: spec.group,
      action: spec.action,
      keyboard: keyboard || '—',
      gamepad: gamepad || '—',
      controls: spec.controls,
    });
  }
  return rows;
}

export function getControlsReference(): ControlsReferenceRow[] {
  return buildControlsReference(getBindingsConfig());
}

/** The reference, re-computed when bindings or the mouse-stick setting change. */
export function useControlsReference(): ControlsReferenceRow[] {
  const config = useBindings((s) => s.config);
  const mouseStick = useA10Store((s) => s.settings.mouseStick);
  return useMemo(() => buildControlsReference(config, mouseStick), [config, mouseStick]);
}

/** The keyboard (or gamepad) inputs of one control, e.g. controlKeys('masterArm') → '1'. */
export function controlKeys(id: ControlId, column: Column = 'keyboard'): string {
  const config = getBindingsConfig();
  return config.controls[id]
    .filter((b) => inColumn(b, column))
    .map((b) => bindingName(b, config))
    .join(' / ');
}
