/**
 * What a press does: a simulation Command (core/types.ts) or an app action (view, pause, help,
 * cursor). Pure; OWNED BY THE INPUT MODULE. Toggles that the Command type expresses as an
 * explicit value (Master Arm, laser arm, flaps, altitude alert, sensor-of-interest steps) are
 * computed from the aircraft's current state, so one key is a two-way switch.
 */
import type { Command, HatDir } from '../core/types';
import type { ViewMode } from '../state/store';
import type { ControlId } from './controls';

/** The bits of the simulation a press needs to decide its command. */
export interface SwitchState {
  masterArm: string;
  laserArm: string;
  soi: string;
  flapHandle: number;
  /** Altitude alert setting, m above ground. */
  altitudeAlert: number;
}

export type AppAction =
  | { type: 'view'; view: ViewMode }
  | { type: 'viewWeapon' }
  | { type: 'viewCycle' }
  | { type: 'pause' }
  | { type: 'help' }
  | { type: 'cursorFree' }
  | { type: 'centerView' }
  | { type: 'zoom'; steps: number };

const FT = 0.3048;
/** Altitude alert settings the key steps through, feet above ground (0 = off). */
export const ALTITUDE_ALERT_STEPS_FT = [0, 200, 500, 1000, 1500, 2000] as const;

export function nextAltitudeAlert(currentM: number): number {
  const cur = Number.isFinite(currentM) ? currentM : 0;
  for (const ft of ALTITUDE_ALERT_STEPS_FT) {
    const m = ft * FT;
    if (m > cur + 1) return m;
  }
  return 0;
}

/** Displays from left to right: the sensor-of-interest steps move along this row. */
const SOI_ROW = ['LMFD', 'HUD', 'RMFD'] as const;

export function stepSoi(current: string, dir: 1 | -1): 'LMFD' | 'HUD' | 'RMFD' {
  const i = SOI_ROW.indexOf(current as (typeof SOI_ROW)[number]);
  const from = i < 0 ? 1 : i;
  return SOI_ROW[Math.max(0, Math.min(SOI_ROW.length - 1, from + dir))];
}

const hatCommand = (type: 'tms' | 'dms' | 'coolie', dir: HatDir, long: boolean): Command => ({
  type,
  dir,
  long,
});

/** The simulation command for a press, or null when the press is not a simulation command. */
export function commandForPress(id: ControlId, long: boolean, s: SwitchState): Command | null {
  switch (id) {
    case 'masterArm':
      return { type: 'masterArm', value: s.masterArm === 'ARM' ? 'SAFE' : 'ARM' };
    case 'gunPac':
      return { type: 'gunPac', value: 'cycle' };
    case 'laserArm':
      return { type: 'laserArm', value: s.laserArm === 'ARM' ? 'SAFE' : 'ARM' };
    case 'tgpPower':
      return { type: 'tgpPower', value: 'toggle' };
    case 'altSource':
      return { type: 'altSource', value: 'cycle' };
    case 'masterMode':
      return { type: 'masterMode', value: 'next' };
    case 'profilePrev':
      return { type: 'profile', dir: -1 };
    case 'profileNext':
      return { type: 'profile', dir: 1 };
    case 'soiHud':
      return { type: 'soi', value: 'HUD' };
    case 'soiLeft':
      return { type: 'soi', value: 'LMFD' };
    case 'soiRight':
      return { type: 'soi', value: 'RMFD' };
    case 'soiStepLeft':
      return { type: 'soi', value: stepSoi(s.soi, -1) };
    case 'soiStepRight':
      return { type: 'soi', value: stepSoi(s.soi, 1) };
    case 'steerpointPrev':
      return { type: 'steerpoint', dir: -1 };
    case 'steerpointNext':
      return { type: 'steerpoint', dir: 1 };
    case 'tmsUp':
      return hatCommand('tms', 'up', long);
    case 'tmsDown':
      return hatCommand('tms', 'down', long);
    case 'tmsLeft':
      return hatCommand('tms', 'left', long);
    case 'tmsRight':
      return hatCommand('tms', 'right', long);
    case 'dmsUp':
      return hatCommand('dms', 'up', long);
    case 'dmsDown':
      return hatCommand('dms', 'down', long);
    case 'dmsLeft':
      return hatCommand('dms', 'left', long);
    case 'dmsRight':
      return hatCommand('dms', 'right', long);
    case 'coolieUp':
      return hatCommand('coolie', 'up', long);
    case 'coolieDown':
      return hatCommand('coolie', 'down', long);
    case 'coolieLeft':
      return hatCommand('coolie', 'left', long);
    case 'coolieRight':
      return hatCommand('coolie', 'right', long);
    case 'chinaFwd':
      return { type: 'chinaHat', dir: 'fwd', long };
    case 'chinaAft':
      return { type: 'chinaHat', dir: 'aft', long };
    case 'sensorPicture':
      return { type: 'sensorPicture', value: 'cycle' };
    case 'sensorZoomIn':
      return { type: 'sensorZoom', dir: 1 };
    case 'sensorZoomOut':
      return { type: 'sensorZoom', dir: -1 };
    case 'flaps': {
      const h = Number.isFinite(s.flapHandle) ? Math.round(s.flapHandle) : 0;
      return { type: 'flaps', value: (((h % 3) + 4) % 3) as 0 | 1 | 2 };
    }
    case 'flapsUp':
      return { type: 'flaps', value: 'up' };
    case 'flapsDown':
      return { type: 'flaps', value: 'down' };
    case 'gear':
      return { type: 'gear', value: 'toggle' };
    case 'autopilot':
      return { type: 'autopilot', action: 'toggle' };
    case 'autopilotMode':
      return { type: 'autopilot', action: 'mode' };
    case 'altitudeAlert':
      return { type: 'altitudeAlert', value: nextAltitudeAlert(s.altitudeAlert) };
    case 'jettison':
      return long ? { type: 'jettison', stations: 'all' } : null;
    default:
      return null;
  }
}

/** The app action for a press, or null. */
export function appActionForPress(id: ControlId): AppAction | null {
  switch (id) {
    case 'viewCockpit':
      return { type: 'view', view: 'cockpit' };
    case 'viewChase':
      return { type: 'view', view: 'chase' };
    case 'viewFlyby':
      return { type: 'view', view: 'flyby' };
    case 'viewOrbit':
      return { type: 'view', view: 'orbit' };
    case 'viewWeapon':
      return { type: 'viewWeapon' };
    case 'viewCycle':
      return { type: 'viewCycle' };
    case 'pause':
      return { type: 'pause' };
    case 'help':
      return { type: 'help' };
    case 'cursorFree':
      return { type: 'cursorFree' };
    case 'centerView':
      return { type: 'centerView' };
    case 'zoomIn':
      return { type: 'zoom', steps: 1 };
    case 'zoomOut':
      return { type: 'zoom', steps: -1 };
    default:
      return null;
  }
}

const VIEW_ORDER: readonly ViewMode[] = ['cockpit', 'chase', 'flyby', 'orbit', 'weapon', 'target'];

export function nextView(current: ViewMode): ViewMode {
  const i = VIEW_ORDER.indexOf(current);
  return VIEW_ORDER[(i + 1) % VIEW_ORDER.length];
}

/** F5: the weapon camera, then the camera at the target, then the weapon again. */
export function weaponView(current: ViewMode): ViewMode {
  return current === 'weapon' ? 'target' : 'weapon';
}
