/**
 * Game controllers as the Gamepad API reports them: identity, duplicates, button and axis
 * reading, point-of-view hats and names. Pure (works on plain objects); OWNED BY THE INPUT MODULE.
 *
 * - mapping 'standard': the browser recognised a gamepad and remapped it (buttons 0-16, axes
 *   0-3, stick Y = -1 when pushed up). Bound as `padButton` / `padAxis`, any such pad works.
 * - mapping '' (most sticks, throttles and pedals): HID order, no names, rest values not always
 *   0 (a throttle rests at an end). Each physical device is bound separately (`hid*` sources)
 *   by a key from Gamepad.id plus its ordinal among identical devices.
 */
import type { DeviceRef, HatDir } from './bindings';

export interface PadButtonLike {
  readonly pressed: boolean;
  readonly value: number;
}

/** What the input layer needs from a Gamepad (the DOM object satisfies it). */
export interface PadLike {
  readonly id: string;
  readonly index: number;
  readonly mapping: string;
  readonly connected: boolean;
  readonly axes: readonly number[];
  readonly buttons: readonly PadButtonLike[];
}

export interface DeviceIdentity {
  /** "vvvv:pppp" when the id carries vendor and product numbers, else the id itself. */
  key: string;
  /** The id without the vendor/product decoration. */
  name: string;
}

const CHROME_ID = /^(.*?)\s*\((?:.*?)Vendor:\s*([0-9a-f]{1,4})\s+Product:\s*([0-9a-f]{1,4})\)\s*$/i;
const FIREFOX_ID = /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-(.+)$/i;
const hex4 = (s: string) => s.toLowerCase().padStart(4, '0');

/**
 * Identity of a device from its Gamepad.id. Chromium: "Name (Vendor: 044f Product: 0402)";
 * Firefox: "44f-402-Name". Both give the key "044f:0402", so a binding survives a browser
 * change where the browser keeps the axis order.
 */
export function deviceIdentity(id: string): DeviceIdentity {
  const raw = (id ?? '').trim();
  let m = CHROME_ID.exec(raw);
  if (m) return { key: `${hex4(m[2])}:${hex4(m[3])}`, name: m[1] || raw };
  m = FIREFOX_ID.exec(raw);
  if (m) return { key: `${hex4(m[1])}:${hex4(m[2])}`, name: m[3].trim() || raw };
  const name = raw.replace(/\s*\((?:STANDARD GAMEPAD|XInput STANDARD GAMEPAD)[^)]*\)\s*$/i, '');
  return { key: raw || 'unknown', name: name || 'Unknown device' };
}

const identityCache = new Map<string, DeviceIdentity>();

/** Cached deviceIdentity (called every frame). */
export function identityOf(id: string): DeviceIdentity {
  let v = identityCache.get(id);
  if (!v) {
    v = deviceIdentity(id);
    if (identityCache.size > 64) identityCache.clear();
    identityCache.set(id, v);
  }
  return v;
}

/** Ordinal of pads[i] among the connected devices with the same key (index order). */
export function deviceOrdinal(pads: ArrayLike<PadLike | null | undefined>, i: number): number {
  const self = pads[i];
  if (!self) return 0;
  const key = identityOf(self.id).key;
  let n = 0;
  for (let j = 0; j < pads.length; j++) {
    const p = pads[j];
    if (!p || !p.connected || p === self) continue;
    if (p.index < self.index && identityOf(p.id).key === key) n++;
  }
  return n;
}

export function deviceRef(pad: PadLike, ordinal: number): DeviceRef {
  const ident = identityOf(pad.id);
  return { key: ident.key, name: ident.name, ordinal };
}

export function matchesDevice(ref: DeviceRef, key: string, ordinal: number): boolean {
  return ref.key === key && ref.ordinal === ordinal;
}

export function isStandard(pad: PadLike): boolean {
  return pad.mapping === 'standard';
}

/** Axis value, 0 when missing or not finite. */
export function axisValue(pad: PadLike, index: number): number {
  const v = pad.axes[index];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Button pressure 0..1; digital-only buttons report `pressed` without a value. */
export function buttonValue(pad: PadLike, index: number): number {
  const b = pad.buttons[index];
  if (!b) return 0;
  const v = b.value;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v > 1 ? 1 : v;
  return b.pressed ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Point-of-view hats
// ---------------------------------------------------------------------------------------------

export const HAT_UP = 1;
export const HAT_RIGHT = 2;
export const HAT_DOWN = 4;
export const HAT_LEFT = 8;

const HAT_POSITIONS = [
  HAT_UP,
  HAT_UP | HAT_RIGHT,
  HAT_RIGHT,
  HAT_RIGHT | HAT_DOWN,
  HAT_DOWN,
  HAT_DOWN | HAT_LEFT,
  HAT_LEFT,
  HAT_LEFT | HAT_UP,
];

/**
 * A hat reported as one axis: eight positions at -1 + k·2/7 (k = 0 up, clockwise) and a rest
 * value outside -1..1 (about 1.29). Returns a bit mask of the directions held (0 = centred).
 */
export function hatMask(value: number): number {
  if (!Number.isFinite(value) || value < -1.05 || value > 1.05) return 0;
  const pos = ((value + 1) * 7) / 2;
  const k = Math.round(pos);
  if (Math.abs(pos - k) > 0.3 || k < 0 || k > 7) return 0;
  return HAT_POSITIONS[k];
}

/** A rest value that marks an axis as a hat (outside the normal -1..1 range). */
export function isHatRest(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) > 1.05;
}

export function hatBit(dir: HatDir): number {
  return dir === 'up' ? HAT_UP : dir === 'right' ? HAT_RIGHT : dir === 'down' ? HAT_DOWN : HAT_LEFT;
}

/** The first direction in a mask (up, right, down, left), for capture. */
export function hatDirOf(mask: number): HatDir | null {
  if (mask & HAT_UP) return 'up';
  if (mask & HAT_RIGHT) return 'right';
  if (mask & HAT_DOWN) return 'down';
  if (mask & HAT_LEFT) return 'left';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

export const PAD_BUTTON_NAMES: readonly string[] = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'Back',
  'Start',
  'Left stick click',
  'Right stick click',
  'D-pad ↑',
  'D-pad ↓',
  'D-pad ←',
  'D-pad →',
  'Guide',
];

export const PAD_AXIS_NAMES: readonly string[] = [
  'Left stick ↔',
  'Left stick ↕',
  'Right stick ↔',
  'Right stick ↕',
];

/** The other axis of the same standard stick (0↔1, 2↔3), or -1. */
export function stickPartner(axis: number): number {
  return axis >= 0 && axis < 4 ? axis ^ 1 : -1;
}

/** A device name short enough for a binding chip. */
export function shortDeviceName(name: string, max = 22): string {
  const clean = name
    .replace(/\b(Thrustmaster|Logitech|Saitek|VKB|Virpil|CH Products|Microsoft|Sony)\b\s*/i, '')
    .trim();
  const n = clean || name;
  return n.length > max ? `${n.slice(0, max - 1)}…` : n;
}
