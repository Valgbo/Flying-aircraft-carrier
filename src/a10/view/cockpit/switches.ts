/**
 * The clickable cockpit's switches: which controls can be clicked, where they are, and the
 * simulation Command each click queues. OWNED BY THE COCKPIT MODULE. Pure (no three.js scene, no
 * DOM), so the table is unit-tested (tests/unit/a10/cockpitSwitches.test.ts). The MFCDs' OSBs,
 * the UFC's other keys and the AHCP's decorative switches are in clickables.ts.
 *
 * The model is FlightGear's A-10A cockpit; the A-10C panel (PLAN_A10.md §7, decided at M6) is
 * built onto it in code (mfcd.ts, ahcp.ts, ufc.ts). Where each control is:
 *
 *   Master Arm, GUN/PAC,  the A-10C armament HUD control panel (AHCP), where the A-10A's armament
 *   LASER ARM, TGP,       control panel was
 *   ALT SCE
 *   Master mode           the master mode button on the stick grip (the A-10C has no panel
 *                         selector: the A-10A HUD panel's knob is under the left MFCD)
 *   Steerpoint ▲ / ▼      the UFC's STEER rocker
 *   Altitude alert        the UFC's ALT ALRT key (left up a step, right down)
 *   Flaps, gear           the flap lever and the landing-gear handle of the model
 *   g-meter reset         the accelerometer's push-to-set button (cockpit only, no command)
 *   Autopilot, its mode   the ENGAGE/DISENGAGE button and the PATH – ALT/HDG – ALT switch of the
 *                         model's LASTE panel, front of the left console (laste.ts)
 *
 * Clicks: the left button is the primary action (toggle / next position), the right button
 * the secondary one (the other way). Commands carry explicit values computed from the current
 * switch state (as the input layer does for its keys), so a click always does what it shows.
 * The audio module clicks on the `switch` events the avionics emit; the cockpit plays nothing.
 */
import type {
  AltSource,
  GunPacSwitch,
  LaserArm,
  MasterArm,
  MasterMode,
} from '../../core/avionics/types';
import type { Command } from '../../core/types';
import type { UfcKeyId } from './ufc';

export type CockpitControlId =
  | 'masterArm'
  | 'gunPac'
  | 'laserArm'
  | 'tgpPower'
  | 'altSource'
  | 'masterMode'
  | 'flaps'
  | 'gear'
  | 'autopilot'
  | 'autopilotMode'
  | 'altitudeAlert'
  | 'steerNext'
  | 'steerPrevious'
  | 'gMeterReset';

/** Where a control is clicked. */
export type ControlTarget =
  /** A FlightGear pick target: its box in meta.pick (by node name). */
  | { kind: 'pick'; node: string }
  /** The bounds of a mesh of the model (a moving part FlightGear made no pick for). */
  | { kind: 'mesh'; node: string }
  /**
   * The top `height` metres (along the part's own up axis) of a moving part's bounds: a button
   * on top of a grip.
   */
  | { kind: 'meshTop'; node: string; height: number }
  /** The autopilot's button or mode switch on the model's LASTE panel (laste.ts), by control id. */
  | { kind: 'laste' }
  /** A toggle switch on the A-10C armament HUD control panel (ahcp.ts), by control id. */
  | { kind: 'ahcp' }
  /** A key of the A-10C up-front controller (ufc.ts). */
  | { kind: 'ufc'; key: UfcKeyId };

export interface CockpitControlDef {
  id: CockpitControlId;
  /** Name shown on the hover label. */
  label: string;
  target: ControlTarget;
}

/** Every clickable control, in the order the hover label prefers them when boxes overlap. */
export const COCKPIT_CONTROLS: readonly CockpitControlDef[] = [
  { id: 'masterArm', label: 'MASTER ARM', target: { kind: 'ahcp' } },
  { id: 'gunPac', label: 'GUN/PAC', target: { kind: 'ahcp' } },
  {
    id: 'masterMode',
    label: 'MASTER MODE',
    target: { kind: 'meshTop', node: 'stick-upper__aileron', height: 0.075 },
  },
  { id: 'flaps', label: 'FLAPS', target: { kind: 'mesh', node: 'flaps-lever__current-setting' } },
  {
    id: 'gear',
    label: 'LANDING GEAR',
    target: { kind: 'mesh', node: 'ld-gear-handle__ld-gear-handle-anim' },
  },
  {
    id: 'gMeterReset',
    label: 'G-METER RESET',
    target: { kind: 'pick', node: 'A-10-accel-button' },
  },
  { id: 'laserArm', label: 'LASER ARM', target: { kind: 'ahcp' } },
  { id: 'tgpPower', label: 'TGP POWER', target: { kind: 'ahcp' } },
  { id: 'altSource', label: 'ALT SOURCE', target: { kind: 'ahcp' } },
  { id: 'autopilot', label: 'AUTOPILOT', target: { kind: 'laste' } },
  { id: 'autopilotMode', label: 'AUTOPILOT MODE', target: { kind: 'laste' } },
  { id: 'altitudeAlert', label: 'ALT ALRT', target: { kind: 'ufc', key: 'ALT_ALRT' } },
  { id: 'steerNext', label: 'STEER ▲', target: { kind: 'ufc', key: 'STEER_UP' } },
  { id: 'steerPrevious', label: 'STEER ▼', target: { kind: 'ufc', key: 'STEER_DN' } },
];

/** The switch positions a click needs to know. */
export interface CockpitSwitchState {
  masterArm: MasterArm;
  gunPac: GunPacSwitch;
  laserArm: LaserArm;
  tgpPower: boolean;
  altSource: AltSource;
  masterMode: MasterMode;
  /** 0 UP, 1 MVR, 2 DN. */
  flapHandle: number;
  gearDown: boolean;
  autopilotEngaged: boolean;
  autopilotMode: string;
  /** Altitude alert setting, m above ground (0 = off). */
  altitudeAlert: number;
  /** Name of the active steerpoint ('' when none). */
  steerpoint: string;
}

export const GUN_PAC_ORDER: readonly GunPacSwitch[] = ['SAFE', 'GUNARM', 'ARM'];
export const ALT_SOURCE_ORDER: readonly AltSource[] = ['BARO', 'DELTA', 'RADAR'];
export const MASTER_MODE_ORDER: readonly MasterMode[] = ['NAV', 'GUNS', 'CCIP', 'CCRP'];

const FT = 0.3048;
/** Altitude alert settings, feet above the ground (0 = off) — docs/a10/ARCHITECTURE.md §3. */
export const ALTITUDE_ALERT_STEPS_FT: readonly number[] = [0, 200, 500, 1000, 1500, 2000];

/** The next altitude-alert step above (dir +1) or below (dir −1) the current one, metres. */
export function stepAltitudeAlert(currentM: number, dir: 1 | -1): number {
  const cur = Number.isFinite(currentM) ? currentM : 0;
  const steps = ALTITUDE_ALERT_STEPS_FT;
  if (dir > 0) {
    for (const ft of steps) if (ft * FT > cur + 1) return ft * FT;
    return 0; // past 2,000 ft: back to off
  }
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i] * FT < cur - 1) return steps[i] * FT;
  return steps[steps.length - 1] * FT; // below off: wrap to the top
}

function step<T>(list: readonly T[], current: T, dir: 1 | -1, wrap: boolean): T {
  const i = Math.max(0, list.indexOf(current));
  const j = i + dir;
  if (wrap) return list[(j + list.length) % list.length];
  return list[Math.max(0, Math.min(list.length - 1, j))];
}

/** A three-position arm switch: left click ARM ↔ SAFE, right click TRAIN ↔ SAFE. */
function armSwitch<T extends 'SAFE' | 'TRAIN' | 'ARM'>(current: T, button: number): T {
  if (button === 2) return (current === 'TRAIN' ? 'SAFE' : 'TRAIN') as T;
  return (current === 'ARM' ? 'SAFE' : 'ARM') as T;
}

/**
 * The command a click on a control queues (null: nothing to queue — the g-meter reset is
 * handled by the cockpit itself). `button` is the mouse button (0 left, 2 right).
 */
export function commandForControl(
  id: CockpitControlId,
  button: number,
  s: CockpitSwitchState,
): Command | null {
  const secondary = button === 2;
  switch (id) {
    case 'masterArm':
      return { type: 'masterArm', value: armSwitch(s.masterArm, button) };
    case 'gunPac':
      return {
        type: 'gunPac',
        value: step(GUN_PAC_ORDER, s.gunPac, secondary ? -1 : 1, true),
      };
    case 'laserArm':
      return { type: 'laserArm', value: armSwitch(s.laserArm, button) };
    case 'tgpPower':
      return { type: 'tgpPower', value: !s.tgpPower };
    case 'altSource':
      return {
        type: 'altSource',
        value: step(ALT_SOURCE_ORDER, s.altSource, secondary ? -1 : 1, true),
      };
    case 'masterMode':
      // the avionics skip modes that are not available, both ways
      return { type: 'masterMode', value: secondary ? 'previous' : 'next' };
    case 'flaps': {
      const h = Math.max(
        0,
        Math.min(2, Math.round(Number.isFinite(s.flapHandle) ? s.flapHandle : 0)),
      );
      // left: one notch down, from DN back to UP (as the F key); right: one notch up
      if (secondary) return { type: 'flaps', value: 'up' };
      return { type: 'flaps', value: ((h + 1) % 3) as 0 | 1 | 2 };
    }
    case 'gear':
      return { type: 'gear', value: 'toggle' };
    case 'autopilot':
      return { type: 'autopilot', action: secondary ? 'disengage' : 'toggle' };
    case 'autopilotMode':
      return { type: 'autopilot', action: 'mode' };
    case 'altitudeAlert':
      return {
        type: 'altitudeAlert',
        value: stepAltitudeAlert(s.altitudeAlert, secondary ? -1 : 1),
      };
    case 'steerNext':
      return { type: 'steerpoint', dir: 1 };
    case 'steerPrevious':
      return { type: 'steerpoint', dir: -1 };
    case 'gMeterReset':
      return null;
  }
}

/** The state shown on the hover label ("MASTER ARM  ARM"). */
export function controlStateText(id: CockpitControlId, s: CockpitSwitchState): string {
  switch (id) {
    case 'masterArm':
      return s.masterArm;
    case 'gunPac':
      return s.gunPac;
    case 'laserArm':
      return s.laserArm;
    case 'tgpPower':
      return s.tgpPower ? 'ON' : 'OFF';
    case 'altSource':
      return s.altSource;
    case 'masterMode':
      return s.masterMode;
    case 'flaps':
      return ['UP', 'MVR', 'DN'][Math.max(0, Math.min(2, Math.round(s.flapHandle)))] ?? 'UP';
    case 'gear':
      return s.gearDown ? 'DOWN' : 'UP';
    case 'autopilot':
      return s.autopilotEngaged ? 'ENGAGED' : 'OFF';
    case 'autopilotMode':
      return s.autopilotMode.replace('_', '/');
    case 'altitudeAlert':
      return s.altitudeAlert > 1 ? `${Math.round(s.altitudeAlert / FT / 10) * 10} FT` : 'OFF';
    case 'steerNext':
    case 'steerPrevious':
      return s.steerpoint;
    case 'gMeterReset':
      return '';
  }
}

/** Read the switch state from the simulation's avionics and aircraft (allocation-free). */
export function readSwitchState(
  sim: {
    avionics: {
      masterArm: MasterArm;
      gunPac: GunPacSwitch;
      laserArm: LaserArm;
      tgpPower: boolean;
      altSource: AltSource;
      masterMode: MasterMode;
      steerpoints?: readonly { name: string }[];
      activeSteerpoint?: number;
    };
    aircraft: {
      flapHandle: number;
      gearDown: boolean;
      autopilot: { engaged: boolean; mode: string };
      altitudeAlert: number;
    };
  },
  out: CockpitSwitchState,
): CockpitSwitchState {
  const av = sim.avionics;
  const ac = sim.aircraft;
  out.masterArm = av.masterArm;
  out.gunPac = av.gunPac;
  out.laserArm = av.laserArm;
  out.tgpPower = av.tgpPower;
  out.altSource = av.altSource;
  out.masterMode = av.masterMode;
  out.flapHandle = ac.flapHandle;
  out.gearDown = ac.gearDown;
  out.autopilotEngaged = ac.autopilot.engaged;
  out.autopilotMode = ac.autopilot.mode;
  out.altitudeAlert = ac.altitudeAlert;
  const sp = av.steerpoints?.[av.activeSteerpoint ?? -1];
  out.steerpoint = sp ? sp.name : '';
  return out;
}

export function createSwitchState(): CockpitSwitchState {
  return {
    masterArm: 'SAFE',
    gunPac: 'SAFE',
    laserArm: 'SAFE',
    tgpPower: false,
    altSource: 'DELTA',
    masterMode: 'NAV',
    flapHandle: 0,
    gearDown: false,
    autopilotEngaged: false,
    autopilotMode: 'PATH',
    altitudeAlert: 0,
    steerpoint: '',
  };
}
