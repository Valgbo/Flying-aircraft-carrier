/**
 * The control catalogue: every function the pilot can bind, in the aircraft's own terms, grouped
 * the way the cockpit is laid out (PLAN_A10.md §12). Pure data; OWNED BY THE INPUT MODULE.
 *
 * Kinds (how a control combines its bindings, docs/a10/ARCHITECTURE.md §8):
 *  - axis     momentary, centred (-1..1): sum of every source, clamped. Keys and buttons ramp.
 *  - lever    absolute (0..1) and stays where it is left: keys move it at a set rate, an axis
 *             device sets it; the device moved last owns it ("takeover").
 *  - trigger  the analogue gun trigger: a 0..1 value read as detent 0/1/2 with hysteresis.
 *  - hold     a held boolean; several sources are OR-ed.
 *  - press    a discrete action on the press edge, optionally short/long (hold >= 0.4 s).
 * Scope: 'flight' controls act only while the flight is live (flight screen, not paused, no
 * dialog, no capture); 'app' controls (views, pause) also work while paused.
 */

export const CONTROL_IDS = [
  // Stick and pedals
  'pitch',
  'roll',
  'rudder',
  'trimPitch',
  'trimRoll',
  'trimYaw',
  'triggerFirst',
  'triggerSecond',
  'triggerAxis',
  'weaponRelease',
  'tmsUp',
  'tmsDown',
  'tmsLeft',
  'tmsRight',
  'dmsUp',
  'dmsDown',
  'dmsLeft',
  'dmsRight',
  'coolieUp',
  'coolieDown',
  'coolieLeft',
  'coolieRight',
  // Throttle
  'throttleBoth',
  'throttleLeft',
  'throttleRight',
  'speedBrakeToggle',
  'speedBrakeExtend',
  'speedBrakeRetract',
  'chinaFwd',
  'chinaAft',
  'slewX',
  'slewY',
  // Armament panel
  'masterArm',
  'gunPac',
  'laserArm',
  'tgpPower',
  'altSource',
  // HUD and displays
  'masterMode',
  'profilePrev',
  'profileNext',
  'soiHud',
  'soiLeft',
  'soiRight',
  'soiStepLeft',
  'soiStepRight',
  'steerpointPrev',
  'steerpointNext',
  // Sensors
  'sensorPicture',
  'sensorZoomIn',
  'sensorZoomOut',
  'laser',
  // Systems
  'flaps',
  'flapsUp',
  'flapsDown',
  'gear',
  'autopilot',
  'autopilotMode',
  'altitudeAlert',
  'jettison',
  // Views
  'viewCockpit',
  'viewChase',
  'viewFlyby',
  'viewOrbit',
  'viewWeapon',
  'viewCycle',
  'lookX',
  'lookY',
  'centerView',
  'zoomHold',
  'zoomIn',
  'zoomOut',
  'lookAtSpi',
  'cursorFree',
  'mouseLook',
  // General
  'pause',
  'help',
  'padShift',
] as const;

export type ControlId = (typeof CONTROL_IDS)[number];
export type ControlKind = 'axis' | 'lever' | 'trigger' | 'hold' | 'press';
export type ControlGroup =
  'stick' | 'throttle' | 'armament' | 'displays' | 'sensors' | 'systems' | 'views' | 'general';

export const CONTROL_GROUPS: readonly { id: ControlGroup; title: string }[] = [
  { id: 'stick', title: 'Stick' },
  { id: 'throttle', title: 'Throttle' },
  { id: 'armament', title: 'Armament panel' },
  { id: 'displays', title: 'HUD and displays' },
  { id: 'sensors', title: 'Sensors' },
  { id: 'systems', title: 'Systems' },
  { id: 'views', title: 'Views' },
  { id: 'general', title: 'General' },
];

/** Keyboard/button ramp of an axis: seconds from 0 to full, from full back to 0, and the
 * fraction applied at once on the press (slew and look keys start gently, then accelerate). */
export interface RampProfile {
  rise: number;
  fall: number;
  jump: number;
}

export type PressMode = 'instant' | 'shortLong' | 'longOnly';

export interface ControlDef {
  id: ControlId;
  group: ControlGroup;
  /** What it does, in the aircraft's terms. */
  label: string;
  kind: ControlKind;
  scope: 'flight' | 'app';
  /** press: fire on the press edge ('instant'), or resolve short/long ('shortLong'), or only on
   * a long hold ('longOnly', for guarded switches). */
  press?: PressMode;
  /** axis: how keys and buttons move it ('stick' and 'pedal' use the keyboard ramp option). */
  ramp?: 'stick' | 'pedal' | 'slew' | 'look' | 'none';
  /** lever: which throttle levers it moves (0 left, 1 right). */
  levers?: readonly (0 | 1)[];
  /** axis and lever: what the negative and positive directions mean, for digital bindings. */
  dirWords?: readonly [neg: string, pos: string];
  /** Capture prompt for analogue sources (the positive direction). */
  movePrompt?: string;
}

const STICK: Pick<ControlDef, 'group' | 'scope'> = { group: 'stick', scope: 'flight' };
const THROTTLE: Pick<ControlDef, 'group' | 'scope'> = { group: 'throttle', scope: 'flight' };
const ARMAMENT: Pick<ControlDef, 'group' | 'scope'> = { group: 'armament', scope: 'flight' };
const DISPLAYS: Pick<ControlDef, 'group' | 'scope'> = { group: 'displays', scope: 'flight' };
const SENSORS: Pick<ControlDef, 'group' | 'scope'> = { group: 'sensors', scope: 'flight' };
const SYSTEMS: Pick<ControlDef, 'group' | 'scope'> = { group: 'systems', scope: 'flight' };
const VIEWS: Pick<ControlDef, 'group' | 'scope'> = { group: 'views', scope: 'flight' };
const VIEWS_APP: Pick<ControlDef, 'group' | 'scope'> = { group: 'views', scope: 'app' };

function hat(
  base: Pick<ControlDef, 'group' | 'scope'>,
  id: ControlId,
  label: string,
): [ControlId, Omit<ControlDef, 'id'>] {
  return [id, { ...base, label, kind: 'press', press: 'shortLong' }];
}

const DEFS: [ControlId, Omit<ControlDef, 'id'>][] = [
  [
    'pitch',
    {
      ...STICK,
      label: 'Stick: pitch',
      kind: 'axis',
      ramp: 'stick',
      dirWords: ['push (nose down)', 'pull (nose up)'],
      movePrompt: 'Pull the stick back',
    },
  ],
  [
    'roll',
    {
      ...STICK,
      label: 'Stick: roll',
      kind: 'axis',
      ramp: 'stick',
      dirWords: ['left', 'right'],
      movePrompt: 'Move the stick to the right',
    },
  ],
  [
    'rudder',
    {
      ...STICK,
      label: 'Rudder pedals',
      kind: 'axis',
      ramp: 'pedal',
      dirWords: ['left', 'right'],
      movePrompt: 'Push the right pedal',
    },
  ],
  [
    'trimPitch',
    {
      ...STICK,
      label: 'Trim hat: pitch',
      kind: 'axis',
      ramp: 'none',
      dirWords: ['nose down', 'nose up'],
      movePrompt: 'Move it toward nose up',
    },
  ],
  [
    'trimRoll',
    {
      ...STICK,
      label: 'Trim hat: roll',
      kind: 'axis',
      ramp: 'none',
      dirWords: ['left wing down', 'right wing down'],
      movePrompt: 'Move it toward right wing down',
    },
  ],
  [
    'trimYaw',
    {
      ...STICK,
      label: 'Rudder trim',
      kind: 'axis',
      ramp: 'none',
      dirWords: ['nose left', 'nose right'],
      movePrompt: 'Move it toward nose right',
    },
  ],
  ['triggerFirst', { ...STICK, label: 'Trigger: first detent (PAC-1)', kind: 'hold' }],
  ['triggerSecond', { ...STICK, label: 'Trigger: second detent (fire)', kind: 'hold' }],
  [
    'triggerAxis',
    {
      ...STICK,
      label: 'Trigger: analogue, both detents',
      kind: 'trigger',
      movePrompt: 'Squeeze the trigger all the way',
    },
  ],
  ['weaponRelease', { ...STICK, label: 'Weapon release', kind: 'hold' }],
  hat(STICK, 'tmsUp', 'TMS up: track; hold to set the SPI'),
  hat(STICK, 'tmsDown', 'TMS down: break track; hold to reset the SPI'),
  hat(STICK, 'tmsLeft', 'TMS left'),
  hat(STICK, 'tmsRight', 'TMS right'),
  hat(STICK, 'dmsUp', 'DMS up'),
  hat(STICK, 'dmsDown', 'DMS down'),
  hat(STICK, 'dmsLeft', 'DMS left'),
  hat(STICK, 'dmsRight', 'DMS right'),
  hat(STICK, 'coolieUp', 'Coolie hat up'),
  hat(STICK, 'coolieDown', 'Coolie hat down'),
  hat(STICK, 'coolieLeft', 'Coolie hat left'),
  hat(STICK, 'coolieRight', 'Coolie hat right'),

  [
    'throttleBoth',
    {
      ...THROTTLE,
      label: 'Throttles (both levers)',
      kind: 'lever',
      levers: [0, 1],
      dirWords: ['back (idle)', 'forward (max)'],
      movePrompt: 'Push the throttle forward',
    },
  ],
  [
    'throttleLeft',
    {
      ...THROTTLE,
      label: 'Throttle: left engine',
      kind: 'lever',
      levers: [0],
      dirWords: ['back (idle)', 'forward (max)'],
      movePrompt: 'Push the left throttle forward',
    },
  ],
  [
    'throttleRight',
    {
      ...THROTTLE,
      label: 'Throttle: right engine',
      kind: 'lever',
      levers: [1],
      dirWords: ['back (idle)', 'forward (max)'],
      movePrompt: 'Push the right throttle forward',
    },
  ],
  [
    'speedBrakeToggle',
    { ...THROTTLE, label: 'Speed brake: open / close', kind: 'press', press: 'instant' },
  ],
  ['speedBrakeExtend', { ...THROTTLE, label: 'Speed brake switch: extend (hold)', kind: 'hold' }],
  ['speedBrakeRetract', { ...THROTTLE, label: 'Speed brake switch: retract (hold)', kind: 'hold' }],
  hat(
    THROTTLE,
    'chinaFwd',
    'China hat forward: field of view; hold to slave all sensors to the SPI',
  ),
  hat(THROTTLE, 'chinaAft', 'China hat aft'),
  [
    'slewX',
    {
      ...THROTTLE,
      label: 'Slew: left / right',
      kind: 'axis',
      ramp: 'slew',
      dirWords: ['left', 'right'],
      movePrompt: 'Push the slew control to the right',
    },
  ],
  [
    'slewY',
    {
      ...THROTTLE,
      label: 'Slew: down / up',
      kind: 'axis',
      ramp: 'slew',
      dirWords: ['down', 'up'],
      movePrompt: 'Push the slew control up',
    },
  ],

  ['masterArm', { ...ARMAMENT, label: 'Master Arm: ARM / SAFE', kind: 'press', press: 'instant' }],
  ['gunPac', { ...ARMAMENT, label: 'GUN/PAC switch', kind: 'press', press: 'instant' }],
  ['laserArm', { ...ARMAMENT, label: 'Laser arm: ARM / SAFE', kind: 'press', press: 'instant' }],
  ['tgpPower', { ...ARMAMENT, label: 'Targeting pod power', kind: 'press', press: 'instant' }],
  [
    'altSource',
    {
      ...ARMAMENT,
      label: 'Altitude source: BARO, DELTA, RADAR',
      kind: 'press',
      press: 'instant',
    },
  ],

  [
    'masterMode',
    { ...DISPLAYS, label: 'Master mode: NAV, GUNS, CCIP, CCRP', kind: 'press', press: 'instant' },
  ],
  [
    'profilePrev',
    { ...DISPLAYS, label: 'Previous weapon profile', kind: 'press', press: 'instant' },
  ],
  ['profileNext', { ...DISPLAYS, label: 'Next weapon profile', kind: 'press', press: 'instant' }],
  ['soiHud', { ...DISPLAYS, label: 'Sensor of interest: HUD', kind: 'press', press: 'instant' }],
  [
    'soiLeft',
    { ...DISPLAYS, label: 'Sensor of interest: left display', kind: 'press', press: 'instant' },
  ],
  [
    'soiRight',
    { ...DISPLAYS, label: 'Sensor of interest: right display', kind: 'press', press: 'instant' },
  ],
  [
    'soiStepLeft',
    { ...DISPLAYS, label: 'Sensor of interest: one to the left', kind: 'press', press: 'instant' },
  ],
  [
    'soiStepRight',
    { ...DISPLAYS, label: 'Sensor of interest: one to the right', kind: 'press', press: 'instant' },
  ],
  [
    'steerpointPrev',
    { ...DISPLAYS, label: 'Previous steerpoint', kind: 'press', press: 'instant' },
  ],
  ['steerpointNext', { ...DISPLAYS, label: 'Next steerpoint', kind: 'press', press: 'instant' }],

  [
    'sensorPicture',
    {
      ...SENSORS,
      label: 'Picture: white-hot, black-hot, television',
      kind: 'press',
      press: 'instant',
    },
  ],
  ['sensorZoomIn', { ...SENSORS, label: 'Sensor zoom in', kind: 'press', press: 'instant' }],
  ['sensorZoomOut', { ...SENSORS, label: 'Sensor zoom out', kind: 'press', press: 'instant' }],
  ['laser', { ...SENSORS, label: 'Fire the laser', kind: 'hold' }],

  ['flaps', { ...SYSTEMS, label: 'Flaps: UP, MVR, DN in turn', kind: 'press', press: 'instant' }],
  ['flapsUp', { ...SYSTEMS, label: 'Flaps: one step up', kind: 'press', press: 'instant' }],
  ['flapsDown', { ...SYSTEMS, label: 'Flaps: one step down', kind: 'press', press: 'instant' }],
  ['gear', { ...SYSTEMS, label: 'Landing gear', kind: 'press', press: 'instant' }],
  [
    'autopilot',
    { ...SYSTEMS, label: 'Autopilot: engage / disengage', kind: 'press', press: 'instant' },
  ],
  [
    'autopilotMode',
    { ...SYSTEMS, label: 'Autopilot mode: PATH, ALT/HDG, ALT', kind: 'press', press: 'instant' },
  ],
  [
    'altitudeAlert',
    {
      ...SYSTEMS,
      label: 'Altitude alert: next setting (off, 200 … 2,000 ft)',
      kind: 'press',
      press: 'instant',
    },
  ],
  [
    'jettison',
    { ...SYSTEMS, label: 'Emergency jettison (hold 0.4 s)', kind: 'press', press: 'longOnly' },
  ],

  ['viewCockpit', { ...VIEWS_APP, label: 'Cockpit view', kind: 'press', press: 'instant' }],
  ['viewChase', { ...VIEWS_APP, label: 'Chase view', kind: 'press', press: 'instant' }],
  ['viewFlyby', { ...VIEWS_APP, label: 'Fly-by view', kind: 'press', press: 'instant' }],
  ['viewOrbit', { ...VIEWS_APP, label: 'Orbit view', kind: 'press', press: 'instant' }],
  [
    'viewWeapon',
    { ...VIEWS_APP, label: 'Weapon and target views', kind: 'press', press: 'instant' },
  ],
  ['viewCycle', { ...VIEWS_APP, label: 'Next view', kind: 'press', press: 'instant' }],
  [
    'lookX',
    {
      ...VIEWS,
      label: 'Look left / right',
      kind: 'axis',
      ramp: 'look',
      dirWords: ['left', 'right'],
      movePrompt: 'Move it to the right',
    },
  ],
  [
    'lookY',
    {
      ...VIEWS,
      label: 'Look down / up',
      kind: 'axis',
      ramp: 'look',
      dirWords: ['down', 'up'],
      movePrompt: 'Move it up',
    },
  ],
  ['centerView', { ...VIEWS, label: 'Centre the view', kind: 'press', press: 'instant' }],
  ['zoomHold', { ...VIEWS, label: 'Zoom the view (hold)', kind: 'hold' }],
  ['zoomIn', { ...VIEWS, label: 'Zoom the view in one step', kind: 'press', press: 'instant' }],
  ['zoomOut', { ...VIEWS, label: 'Zoom the view out one step', kind: 'press', press: 'instant' }],
  ['lookAtSpi', { ...VIEWS, label: 'Look at the SPI (hold)', kind: 'hold' }],
  [
    'cursorFree',
    {
      ...VIEWS,
      label: 'Free the cursor to click the cockpit',
      kind: 'press',
      press: 'instant',
    },
  ],
  ['mouseLook', { ...VIEWS, label: 'Mouse look in mouse-stick mode (hold)', kind: 'hold' }],

  ['pause', { group: 'general', scope: 'app', label: 'Pause', kind: 'press', press: 'instant' }],
  [
    'help',
    { group: 'general', scope: 'app', label: 'Help: controls', kind: 'press', press: 'instant' },
  ],
  [
    'padShift',
    {
      group: 'general',
      scope: 'flight',
      label: 'Gamepad shift layer (hold)',
      kind: 'hold',
    },
  ],
];

export const CONTROL_DEFS: Readonly<Record<ControlId, ControlDef>> = Object.fromEntries(
  DEFS.map(([id, def]) => [id, { id, ...def }]),
) as Record<ControlId, ControlDef>;

/** Index of each control in CONTROL_IDS (for typed-array state). */
export const CONTROL_INDEX: Readonly<Record<ControlId, number>> = Object.fromEntries(
  CONTROL_IDS.map((id, i) => [id, i]),
) as Record<ControlId, number>;

export function isControlId(v: unknown): v is ControlId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(CONTROL_DEFS, v);
}

/** Controls of a group, in catalogue order. */
export function controlsInGroup(group: ControlGroup): ControlDef[] {
  return CONTROL_IDS.map((id) => CONTROL_DEFS[id]).filter((d) => d.group === group);
}

/** A short press resolves on release, a long one when the hold reaches this (seconds). */
export const LONG_PRESS_S = 0.4;
