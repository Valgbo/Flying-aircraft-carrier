/**
 * Bindings: which key, mouse button, wheel, gamepad or joystick input drives each control, with
 * the PLAN_A10.md §12 defaults, field-by-field sanitising of what was saved, and the rebinding
 * rules. Pure (no DOM); OWNED BY THE INPUT MODULE. Persisted under localStorage
 * 'a10-bindings-v1' by ./bindingsStore.ts.
 *
 * Rebinding conflicts (one physical input drives one control):
 *  - CHANGING an existing binding to an input another control already uses SWAPS the two (the
 *    other control receives the input you replaced), when both are the same sort of input
 *    (keys/buttons with keys/buttons, axes with axes); otherwise the other use is CLEARED.
 *  - ADDING a binding with an input another control uses CLEARS it from the other control.
 *  - An input already bound to the same control is not added twice.
 */
import { CONTROL_DEFS, CONTROL_IDS, type ControlId, type ControlKind } from './controls';

export type HatDir = 'up' | 'down' | 'left' | 'right';

/** A physical non-standard device (joystick, throttle, pedals) as the Gamepad API reports it. */
export interface DeviceRef {
  /** Stable identity from Gamepad.id: "vvvv:pppp" (vendor:product) when the id carries them. */
  key: string;
  /** Readable name for the binding list. */
  name: string;
  /** 0 for the first connected device with this key, 1 for the second identical one … */
  ordinal: number;
}

export type Source =
  /** A key with modifiers (Ctrl and Alt must match exactly; Shift is required when set). */
  | { type: 'key'; code: string; ctrl?: true; alt?: true; shift?: true }
  /** MouseEvent.button: 0 left, 1 middle, 2 right, 3 back, 4 forward. */
  | { type: 'mouse'; button: number }
  /** One wheel notch: +1 away from you (up), -1 toward you (down). */
  | { type: 'wheel'; dir: 1 | -1 }
  /** Any gamepad with the browser's 'standard' mapping. */
  | { type: 'padButton'; button: number }
  /** Standard gamepad axis; with `dir` it is used as a button pushed that way. */
  | { type: 'padAxis'; axis: number; dir?: 1 | -1 }
  | { type: 'hidButton'; device: DeviceRef; button: number }
  /** Joystick/throttle/pedal axis; with `dir` it is used as a button pushed that way. */
  | { type: 'hidAxis'; device: DeviceRef; axis: number; dir?: 1 | -1 }
  /** A point-of-view hat reported as one axis with eight positions. */
  | { type: 'hidHat'; device: DeviceRef; axis: number; dir: HatDir };

/** Per-binding calibration of an analogue source. */
export interface AxisCal {
  invert: boolean;
  /** Centred controls: dead zone around the centre. Levers: dead zone at the idle end. 0..0.5 */
  deadZone: number;
  /** Fraction of the travel at which the output is full (end dead zone). 0.5..1 */
  saturation: number;
  /** Response curve softness (0 linear .. 1 soft centre), centred controls only. */
  curve: number;
  /** Raw value at rest for centred controls (recorded at capture). -0.5..0.5 */
  centre: number;
}

export interface Binding {
  src: Source;
  /** Gamepad / joystick inputs only: acts only while the gamepad shift (LT) is held. */
  layer?: 'shift';
  /** Digital inputs on axis and lever controls: the direction they push (-1 or +1). */
  dir?: 1 | -1;
  /** Analogue inputs: calibration. */
  cal?: AxisCal;
}

export interface InputOptions {
  /** Mouse look speed multiplier. */
  mouseLookSpeed: number;
  /** Mouse-stick speed multiplier (full deflection after 400 px at 1). */
  mouseStickSpeed: number;
  /** Mouse-stick centring spring, 0 (stays) .. 1 (snaps back quickly). */
  mouseStickSpring: number;
  /** Seconds for keys to take the stick from centre to full deflection. */
  keyRampTime: number;
  /** Seconds for the throttle keys to move the levers from IDLE to MAX. */
  throttleKeyTime: number;
  /** Gamepad rumble while the gun fires. */
  rumble: boolean;
}

export interface BindingsConfig {
  controls: Record<ControlId, Binding[]>;
  options: InputOptions;
}

export const BINDINGS_STORAGE_KEY = 'a10-bindings-v1';

export const DEFAULT_OPTIONS: InputOptions = {
  mouseLookSpeed: 1,
  mouseStickSpeed: 1,
  mouseStickSpring: 0.15,
  keyRampTime: 0.3,
  throttleKeyTime: 2.5,
  rumble: true,
};

const OPTION_RANGES: Record<Exclude<keyof InputOptions, 'rumble'>, [number, number]> = {
  mouseLookSpeed: [0.2, 3],
  mouseStickSpeed: [0.2, 3],
  mouseStickSpring: [0, 1],
  keyRampTime: [0, 1],
  throttleKeyTime: [0.5, 8],
};

export const DEFAULT_CAL: AxisCal = {
  invert: false,
  deadZone: 0.04,
  saturation: 1,
  curve: 0,
  centre: 0,
};

/** Standard gamepad sticks: radial dead zone and the carrier's response curve softness. */
export const PAD_STICK_CAL: AxisCal = { ...DEFAULT_CAL, deadZone: 0.12, curve: 0.4 };
/** Joystick axes: precise devices, small dead zone, a little softness. */
export const HID_STICK_CAL: AxisCal = { ...DEFAULT_CAL, deadZone: 0.03, curve: 0.2 };
/** Throttle levers and analogue triggers: small end dead zones. */
export const LEVER_CAL: AxisCal = { ...DEFAULT_CAL, deadZone: 0.02, saturation: 0.98 };

// ---------------------------------------------------------------------------------------------
// Defaults (PLAN_A10.md §12)
// ---------------------------------------------------------------------------------------------

/** Standard gamepad button numbers (https://w3c.github.io/gamepad/#remapping). */
export const PAD = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  back: 8,
  start: 9,
  ls: 10,
  rs: 11,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;

type Mods = { ctrl?: true; alt?: true; shift?: true };
const key = (code: string, dir?: 1 | -1, mods: Mods = {}): Binding =>
  dir === undefined
    ? { src: { type: 'key', code, ...mods } }
    : { src: { type: 'key', code, ...mods }, dir };
const ctrlKey = (code: string, dir: 1 | -1): Binding => key(code, dir, { ctrl: true });
const pad = (button: number, dir?: 1 | -1, layer?: 'shift'): Binding => {
  const b: Binding = { src: { type: 'padButton', button } };
  if (dir !== undefined) b.dir = dir;
  if (layer) b.layer = layer;
  return b;
};
const padAxis = (axis: number, cal: AxisCal, layer?: 'shift'): Binding => {
  const b: Binding = { src: { type: 'padAxis', axis }, cal: { ...cal } };
  if (layer) b.layer = layer;
  return b;
};
const mouse = (button: number): Binding => ({ src: { type: 'mouse', button } });
const wheel = (dir: 1 | -1): Binding => ({ src: { type: 'wheel', dir } });

const DEFAULT_TABLE: Record<ControlId, Binding[]> = {
  // Standard axis 1 is +1 when the stick is pulled back, and PilotInput.pitch is + when pulled
  // back: pitch = +axis 1. Arrow up pushes the stick forward (nose down).
  pitch: [key('ArrowUp', -1), key('ArrowDown', 1), padAxis(1, PAD_STICK_CAL)],
  roll: [key('ArrowLeft', -1), key('ArrowRight', 1), padAxis(0, PAD_STICK_CAL)],
  rudder: [key('KeyZ', -1), key('KeyX', 1), pad(PAD.lb, -1), pad(PAD.rb, 1)],
  trimPitch: [
    ctrlKey('ArrowUp', -1),
    ctrlKey('ArrowDown', 1),
    pad(PAD.up, -1, 'shift'),
    pad(PAD.down, 1, 'shift'),
  ],
  trimRoll: [
    ctrlKey('ArrowLeft', -1),
    ctrlKey('ArrowRight', 1),
    pad(PAD.left, -1, 'shift'),
    pad(PAD.right, 1, 'shift'),
  ],
  trimYaw: [
    ctrlKey('KeyZ', -1),
    ctrlKey('KeyX', 1),
    pad(PAD.lb, -1, 'shift'),
    pad(PAD.rb, 1, 'shift'),
  ],
  triggerFirst: [key('ShiftLeft')],
  triggerSecond: [key('Space')],
  triggerAxis: [{ src: { type: 'padButton', button: PAD.rt }, cal: { ...LEVER_CAL } }],
  weaponRelease: [key('Enter'), pad(PAD.a)],
  tmsUp: [key('KeyT'), pad(PAD.a, undefined, 'shift')],
  tmsDown: [key('KeyR'), pad(PAD.b, undefined, 'shift')],
  tmsLeft: [],
  tmsRight: [],
  dmsUp: [],
  dmsDown: [],
  dmsLeft: [],
  dmsRight: [],
  coolieUp: [],
  coolieDown: [],
  coolieLeft: [],
  coolieRight: [],
  throttleBoth: [key('PageUp', 1), key('PageDown', -1), pad(PAD.up, 1), pad(PAD.down, -1)],
  throttleLeft: [],
  throttleRight: [],
  speedBrakeToggle: [key('KeyB'), pad(PAD.b)],
  speedBrakeExtend: [],
  speedBrakeRetract: [],
  chinaFwd: [key('KeyV'), pad(PAD.x, undefined, 'shift')],
  chinaAft: [],
  // Standard axis 3 is -1 when the right stick is pushed up; slew and look are + up.
  slewX: [key('KeyA', -1), key('KeyD', 1), padAxis(2, PAD_STICK_CAL, 'shift')],
  slewY: [key('KeyS', -1), key('KeyW', 1), padAxis(3, { ...PAD_STICK_CAL, invert: true }, 'shift')],
  masterArm: [key('Digit1')],
  gunPac: [key('Digit2')],
  laserArm: [key('Digit3')],
  tgpPower: [key('Digit4')],
  altSource: [key('Digit5')],
  masterMode: [key('KeyM'), pad(PAD.x)],
  profilePrev: [key('BracketLeft')],
  profileNext: [key('BracketRight'), pad(PAD.y)],
  soiHud: [key('KeyH')],
  soiLeft: [key('Comma')],
  soiRight: [key('Period')],
  soiStepLeft: [pad(PAD.left)],
  soiStepRight: [pad(PAD.right)],
  steerpointPrev: [],
  steerpointNext: [],
  sensorPicture: [key('KeyC')],
  sensorZoomIn: [key('KeyE')],
  sensorZoomOut: [key('KeyQ')],
  laser: [key('KeyL'), pad(PAD.y, undefined, 'shift')],
  flaps: [key('KeyF')],
  flapsUp: [],
  flapsDown: [],
  gear: [key('KeyG')],
  autopilot: [key('KeyP')],
  autopilotMode: [key('KeyO')],
  altitudeAlert: [key('KeyK')],
  jettison: [],
  viewCockpit: [key('F1')],
  viewChase: [key('F2')],
  viewFlyby: [key('F3')],
  viewOrbit: [key('F4')],
  viewWeapon: [key('F5')],
  viewCycle: [pad(PAD.back)],
  lookX: [key('Numpad4', -1), key('Numpad6', 1), padAxis(2, PAD_STICK_CAL)],
  lookY: [key('Numpad2', -1), key('Numpad8', 1), padAxis(3, { ...PAD_STICK_CAL, invert: true })],
  centerView: [key('Numpad5'), pad(PAD.rs, undefined, 'shift')],
  zoomHold: [mouse(1), pad(PAD.rs)],
  zoomIn: [wheel(1)],
  zoomOut: [wheel(-1)],
  lookAtSpi: [key('KeyN')],
  cursorFree: [key('AltLeft')],
  mouseLook: [mouse(2)],
  pause: [key('Escape'), pad(PAD.start)],
  help: [],
  padShift: [pad(PAD.lt)],
};

function cloneBinding(b: Binding): Binding {
  const out: Binding = { src: cloneSource(b.src) };
  if (b.layer) out.layer = b.layer;
  if (b.dir !== undefined) out.dir = b.dir;
  if (b.cal) out.cal = { ...b.cal };
  return out;
}

function cloneSource(s: Source): Source {
  if (s.type === 'hidButton' || s.type === 'hidAxis' || s.type === 'hidHat')
    return { ...s, device: { ...s.device } } as Source;
  return { ...s };
}

export function defaultBindingsFor(id: ControlId): Binding[] {
  return DEFAULT_TABLE[id].map(cloneBinding);
}

export function defaultBindingsConfig(): BindingsConfig {
  const controls = {} as Record<ControlId, Binding[]>;
  for (const id of CONTROL_IDS) controls[id] = defaultBindingsFor(id);
  return { controls, options: { ...DEFAULT_OPTIONS } };
}

// ---------------------------------------------------------------------------------------------
// Source classification
// ---------------------------------------------------------------------------------------------

export function isDeviceSource(s: Source): boolean {
  return s.type !== 'key' && s.type !== 'mouse' && s.type !== 'wheel';
}

/** An analogue reading (axis value, or the trigger's button pressure) rather than on/off. */
export function isAnalogBinding(b: Binding, kind: ControlKind): boolean {
  const s = b.src;
  if ((s.type === 'padAxis' || s.type === 'hidAxis') && s.dir === undefined)
    return kind === 'axis' || kind === 'lever' || kind === 'trigger';
  if (kind === 'trigger') return s.type === 'padButton' || s.type === 'hidButton';
  return false;
}

/** Which sorts of input a control accepts, for capture and sanitising. */
export function sourceAllowed(s: Source, kind: ControlKind, analog: boolean): boolean {
  switch (kind) {
    case 'trigger':
      // the analogue trigger reads pressure or an axis; keys belong on the detent controls
      return analog;
    case 'axis':
    case 'lever':
      return s.type !== 'wheel';
    case 'hold':
    case 'press':
      // an axis can only be a button when it says which way it is pushed
      if (s.type === 'padAxis' || s.type === 'hidAxis') return s.dir !== undefined;
      return !analog;
  }
}

function sameDevice(a: DeviceRef, b: DeviceRef): boolean {
  return a.key === b.key && a.ordinal === b.ordinal;
}

/**
 * Two bindings use the same physical input in the same layer (so pressing it would drive both).
 * An axis used as a button in one direction does not overlap the other direction.
 */
export function bindingsOverlap(a: Binding, b: Binding): boolean {
  if ((a.layer ?? '') !== (b.layer ?? '')) return false;
  const x = a.src;
  const y = b.src;
  switch (x.type) {
    case 'key':
      return (
        y.type === 'key' &&
        x.code === y.code &&
        !!x.ctrl === !!y.ctrl &&
        !!x.alt === !!y.alt &&
        !!x.shift === !!y.shift
      );
    case 'mouse':
      return y.type === 'mouse' && x.button === y.button;
    case 'wheel':
      return y.type === 'wheel' && x.dir === y.dir;
    case 'padButton':
      return y.type === 'padButton' && x.button === y.button;
    case 'padAxis':
      return (
        y.type === 'padAxis' &&
        x.axis === y.axis &&
        (x.dir === undefined || y.dir === undefined || x.dir === y.dir)
      );
    case 'hidButton':
      return y.type === 'hidButton' && sameDevice(x.device, y.device) && x.button === y.button;
    case 'hidAxis':
      return (
        y.type === 'hidAxis' &&
        sameDevice(x.device, y.device) &&
        x.axis === y.axis &&
        (x.dir === undefined || y.dir === undefined || x.dir === y.dir)
      );
    case 'hidHat':
      return (
        y.type === 'hidHat' &&
        sameDevice(x.device, y.device) &&
        x.axis === y.axis &&
        x.dir === y.dir
      );
  }
}

// ---------------------------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isDir = (v: unknown): v is 1 | -1 => v === 1 || v === -1;
const HAT_DIRS: readonly HatDir[] = ['up', 'down', 'left', 'right'];
/** KeyboardEvent.code values are letters and digits ('KeyA', 'ArrowUp', 'F5', 'Numpad8'). */
const CODE_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

function sanitizeDevice(v: unknown): DeviceRef | null {
  if (!isObj(v)) return null;
  if (typeof v.key !== 'string' || v.key.length === 0 || v.key.length > 200) return null;
  if (!isInt(v.ordinal, 0, 15)) return null;
  const name = typeof v.name === 'string' && v.name.length <= 200 ? v.name : v.key;
  return { key: v.key, name, ordinal: v.ordinal };
}

export function sanitizeSource(v: unknown): Source | null {
  if (!isObj(v)) return null;
  switch (v.type) {
    case 'key': {
      if (typeof v.code !== 'string' || !CODE_RE.test(v.code)) return null;
      const s: Source = { type: 'key', code: v.code };
      if (v.ctrl === true) s.ctrl = true;
      if (v.alt === true) s.alt = true;
      if (v.shift === true) s.shift = true;
      return s;
    }
    case 'mouse':
      return isInt(v.button, 0, 15) ? { type: 'mouse', button: v.button } : null;
    case 'wheel':
      return isDir(v.dir) ? { type: 'wheel', dir: v.dir } : null;
    case 'padButton':
      return isInt(v.button, 0, 63) ? { type: 'padButton', button: v.button } : null;
    case 'padAxis': {
      if (!isInt(v.axis, 0, 31)) return null;
      const s: Source = { type: 'padAxis', axis: v.axis };
      if (isDir(v.dir)) s.dir = v.dir;
      else if (v.dir !== undefined) return null;
      return s;
    }
    case 'hidButton': {
      const device = sanitizeDevice(v.device);
      return device && isInt(v.button, 0, 255)
        ? { type: 'hidButton', device, button: v.button }
        : null;
    }
    case 'hidAxis': {
      const device = sanitizeDevice(v.device);
      if (!device || !isInt(v.axis, 0, 63)) return null;
      const s: Source = { type: 'hidAxis', device, axis: v.axis };
      if (isDir(v.dir)) s.dir = v.dir;
      else if (v.dir !== undefined) return null;
      return s;
    }
    case 'hidHat': {
      const device = sanitizeDevice(v.device);
      if (!device || !isInt(v.axis, 0, 63)) return null;
      if (typeof v.dir !== 'string' || !HAT_DIRS.includes(v.dir as HatDir)) return null;
      return { type: 'hidHat', device, axis: v.axis, dir: v.dir as HatDir };
    }
    default:
      return null;
  }
}

/** Each calibration field validated on its own; a bad one takes `base`'s value. */
export function sanitizeCal(v: unknown, base: AxisCal = DEFAULT_CAL): AxisCal {
  const out = { ...base };
  if (!isObj(v)) return out;
  const num = (k: Exclude<keyof AxisCal, 'invert'>, min: number, max: number) => {
    const x = v[k];
    if (typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max) out[k] = x;
  };
  if (typeof v.invert === 'boolean') out.invert = v.invert;
  num('deadZone', 0, 0.5);
  num('saturation', 0.5, 1);
  num('curve', 0, 1);
  num('centre', -0.5, 0.5);
  if (out.saturation < out.deadZone + 0.05) out.saturation = Math.min(1, out.deadZone + 0.05);
  return out;
}

/** A binding valid for this control, or null. Unknown extra fields are dropped. */
export function sanitizeBinding(v: unknown, control: ControlId): Binding | null {
  if (!isObj(v)) return null;
  const src = sanitizeSource(v.src);
  if (!src) return null;
  const kind = CONTROL_DEFS[control].kind;
  const b: Binding = { src };
  if (v.layer === 'shift' && isDeviceSource(src)) b.layer = 'shift';
  const analog = isAnalogBinding(b, kind);
  if (!sourceAllowed(src, kind, analog)) return null;
  if ((kind === 'axis' || kind === 'lever') && !analog) {
    if (!isDir(v.dir)) return null;
    b.dir = v.dir;
  }
  if (analog) b.cal = sanitizeCal(v.cal, defaultCalFor(src, kind));
  return b;
}

/** The calibration a new analogue binding starts with. */
export function defaultCalFor(src: Source, kind: ControlKind): AxisCal {
  if (kind === 'lever' || kind === 'trigger') return { ...LEVER_CAL };
  return src.type === 'padAxis' ? { ...PAD_STICK_CAL } : { ...HID_STICK_CAL };
}

export function sanitizeOptions(v: unknown): InputOptions {
  const out = { ...DEFAULT_OPTIONS };
  if (!isObj(v)) return out;
  for (const k of Object.keys(OPTION_RANGES) as (keyof typeof OPTION_RANGES)[]) {
    const x = v[k];
    const [min, max] = OPTION_RANGES[k];
    if (typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max) out[k] = x;
  }
  if (typeof v.rumble === 'boolean') out.rumble = v.rumble;
  return out;
}

/**
 * Validate a stored configuration field by field. A control whose entry is missing or is not a
 * list gets its defaults; a list whose every entry is broken gets its defaults; broken entries
 * in an otherwise good list are dropped; an empty list (the pilot cleared it) stays empty.
 * Unknown controls are ignored.
 */
export function sanitizeBindings(raw: unknown): BindingsConfig {
  const config = defaultBindingsConfig();
  if (!isObj(raw)) return config;
  const controls = isObj(raw.controls) ? raw.controls : {};
  for (const id of CONTROL_IDS) {
    const list = controls[id];
    if (!Array.isArray(list)) continue;
    const kept: Binding[] = [];
    for (const item of list) {
      const b = sanitizeBinding(item, id);
      if (b && !kept.some((k) => bindingsOverlap(k, b))) kept.push(b);
    }
    if (list.length > 0 && kept.length === 0) continue;
    config.controls[id] = kept.slice(0, 12);
  }
  config.options = sanitizeOptions(raw.options);
  return config;
}

export function loadBindings(storage: Pick<Storage, 'getItem'> | null): BindingsConfig {
  try {
    const text = storage?.getItem(BINDINGS_STORAGE_KEY);
    return sanitizeBindings(text ? JSON.parse(text) : null);
  } catch {
    return defaultBindingsConfig();
  }
}

export function saveBindings(
  storage: Pick<Storage, 'setItem'> | null,
  config: BindingsConfig,
): void {
  try {
    storage?.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // storage unavailable (private mode): the bindings live for this visit only
  }
}

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

export interface RebindResult {
  config: BindingsConfig;
  changed: boolean;
  /** The input was already bound to this control. */
  duplicate: boolean;
  /** Another control that used the input: it now has the replaced input, or lost it. */
  conflict: { control: ControlId; action: 'swapped' | 'cleared' } | null;
}

function withControls(
  config: BindingsConfig,
  patch: Partial<Record<ControlId, Binding[]>>,
): BindingsConfig {
  return { options: config.options, controls: { ...config.controls, ...patch } };
}

/** Sources that a swap may trade: both on/off inputs that are not axes, or both analogue. */
function swappable(a: Binding, aKind: ControlKind, b: Binding, bKind: ControlKind): boolean {
  const aAnalog = isAnalogBinding(a, aKind);
  const bAnalog = isAnalogBinding(b, bKind);
  if (aAnalog !== bAnalog) return false;
  if (aAnalog) return true;
  const axisLike = (s: Source) => s.type === 'padAxis' || s.type === 'hidAxis';
  return !axisLike(a.src) && !axisLike(b.src);
}

/**
 * Put `binding` on `control`, replacing its binding number `replaceIndex` (or adding it when
 * null). Resolves conflicts as described at the top of this file. Never mutates `config`.
 */
export function applyBinding(
  config: BindingsConfig,
  control: ControlId,
  binding: Binding,
  replaceIndex: number | null,
): RebindResult {
  const own = config.controls[control];
  const replacing = replaceIndex !== null && replaceIndex >= 0 && replaceIndex < own.length;
  const dupIndex = own.findIndex(
    (b, i) => (!replacing || i !== replaceIndex) && bindingsOverlap(b, binding),
  );
  if (dupIndex >= 0) return { config, changed: false, duplicate: true, conflict: null };
  if (replacing && bindingEquals(own[replaceIndex], binding))
    return { config, changed: false, duplicate: false, conflict: null };

  const kind = CONTROL_DEFS[control].kind;
  const nextOwn = own.map(cloneBinding);
  const old = replacing ? own[replaceIndex] : null;
  if (replacing) nextOwn[replaceIndex] = cloneBinding(binding);
  else nextOwn.push(cloneBinding(binding));
  const patch: Partial<Record<ControlId, Binding[]>> = { [control]: nextOwn };

  let conflict: RebindResult['conflict'] = null;
  for (const other of CONTROL_IDS) {
    if (other === control) continue;
    const list = config.controls[other];
    if (!list.some((b) => bindingsOverlap(b, binding))) continue;
    const otherKind = CONTROL_DEFS[other].kind;
    const next: Binding[] = [];
    let action: 'swapped' | 'cleared' = 'cleared';
    for (const theirs of list) {
      if (!bindingsOverlap(theirs, binding)) {
        next.push(cloneBinding(theirs));
        continue;
      }
      // the first control in conflict receives the replaced input, keeping its own direction
      if (
        conflict === null &&
        action === 'cleared' &&
        old !== null &&
        swappable(old, kind, theirs, otherKind) &&
        !list.some((b) => b !== theirs && bindingsOverlap(b, old))
      ) {
        const swapped: Binding = cloneBinding(old);
        delete swapped.dir;
        if (theirs.dir !== undefined) swapped.dir = theirs.dir;
        const valid = sanitizeBinding(swapped, other);
        if (valid) {
          next.push(valid);
          action = 'swapped';
        }
      }
    }
    patch[other] = next;
    if (conflict === null) conflict = { control: other, action };
  }
  return { config: withControls(config, patch), changed: true, duplicate: false, conflict };
}

function deviceEquals(a: DeviceRef, b: DeviceRef): boolean {
  return a.key === b.key && a.ordinal === b.ordinal && a.name === b.name;
}

function calEquals(a: AxisCal | undefined, b: AxisCal | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.invert === b.invert &&
    a.deadZone === b.deadZone &&
    a.saturation === b.saturation &&
    a.curve === b.curve &&
    a.centre === b.centre
  );
}

/** Field-by-field equality of two bindings (input, layer, direction and calibration). */
export function bindingEquals(a: Binding, b: Binding): boolean {
  if ((a.layer ?? '') !== (b.layer ?? '') || a.dir !== b.dir || !calEquals(a.cal, b.cal))
    return false;
  const x = a.src as Record<string, unknown>;
  const y = b.src as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) {
    if (k === 'device') {
      if (!x.device || !y.device || !deviceEquals(x.device as DeviceRef, y.device as DeviceRef))
        return false;
    } else if (x[k] !== y[k]) return false;
  }
  return true;
}

export function removeBinding(
  config: BindingsConfig,
  control: ControlId,
  index: number,
): BindingsConfig {
  const list = config.controls[control];
  if (index < 0 || index >= list.length) return config;
  return withControls(config, { [control]: list.filter((_, i) => i !== index).map(cloneBinding) });
}

/** Replace the calibration of an analogue binding. */
export function updateCal(
  config: BindingsConfig,
  control: ControlId,
  index: number,
  cal: AxisCal,
): BindingsConfig {
  const list = config.controls[control];
  if (index < 0 || index >= list.length || !list[index].cal) return config;
  const next = list.map(cloneBinding);
  next[index].cal = sanitizeCal(cal, list[index].cal);
  return withControls(config, { [control]: next });
}

export function resetControl(config: BindingsConfig, control: ControlId): BindingsConfig {
  return withControls(config, { [control]: defaultBindingsFor(control) });
}

export function isDefaultControl(config: BindingsConfig, control: ControlId): boolean {
  const list = config.controls[control];
  const defaults = DEFAULT_TABLE[control];
  return list.length === defaults.length && list.every((b, i) => bindingEquals(b, defaults[i]));
}

/** Controls that share an input with another control (settings saved by an older build). */
export function findConflicts(config: BindingsConfig): Set<ControlId> {
  const out = new Set<ControlId>();
  for (let i = 0; i < CONTROL_IDS.length; i++) {
    const a = CONTROL_IDS[i];
    for (let j = i + 1; j < CONTROL_IDS.length; j++) {
      const b = CONTROL_IDS[j];
      for (const x of config.controls[a]) {
        if (config.controls[b].some((y) => bindingsOverlap(x, y))) {
          out.add(a);
          out.add(b);
        }
      }
    }
  }
  return out;
}
