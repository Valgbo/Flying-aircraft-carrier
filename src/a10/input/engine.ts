/**
 * The input engine: key, mouse and wheel events plus one controller snapshot per frame in;
 * stick, pedals, levers, trigger, held switches, presses and view input out. Pure (no DOM, no
 * store): the DOM layer (./runtime.ts) feeds it and applies what comes out. OWNED BY THE INPUT
 * MODULE; tested in tests/unit/a10/input*.test.ts.
 *
 * Policies (docs/a10/ARCHITECTURE.md §8, PLAN_A10.md §12):
 *  - axis: keys and buttons ramp toward ±1 and back; analogue axes add; the sum is clamped.
 *  - lever: keys move the throttles at a set rate; an axis device sets them; the device moved
 *    last owns the lever (an axis takes over once it moves more than TAKEOVER from where it was
 *    when it lost the lever).
 *  - trigger: Left Shift = first detent, Space = second (implies the first), an analogue
 *    trigger reads detents with hysteresis; with the one-stage trigger any press fires.
 *  - holds are OR-ed; presses fire on the edge, short/long resolved at 0.4 s.
 *  - layers: Ctrl and Alt must match a key binding exactly, Shift only when the binding asks
 *    for it (the most specific binding of a key wins); the gamepad shift (LT) layer works the
 *    same for pad and joystick inputs. A button's layer is fixed when it is pressed.
 *  - gate: while not live, axes, trigger and holds read zero and the levers FREEZE.
 */
import { clamp, responseCurve } from '../../engine';
import {
  DEFAULT_OPTIONS,
  LEVER_CAL,
  bindingsOverlap,
  defaultBindingsConfig,
  isAnalogBinding,
  type Binding,
  type BindingsConfig,
  type InputOptions,
  type Source,
} from './bindings';
import {
  CONTROL_DEFS,
  CONTROL_IDS,
  CONTROL_INDEX,
  LONG_PRESS_S,
  type ControlDef,
  type ControlId,
  type ControlKind,
} from './controls';
import {
  buttonDown,
  effectiveStage,
  rampToward,
  shapeCentred,
  shapeLever,
  shapePressure,
  shapeStickAxis,
  triggerStage,
} from './curves';
import {
  HAT_DOWN,
  HAT_LEFT,
  HAT_RIGHT,
  HAT_UP,
  axisValue,
  buttonValue,
  deviceOrdinal,
  hatBit,
  hatMask,
  identityOf,
  isStandard,
  stickPartner,
  type PadLike,
} from './devices';

export interface KeyMods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/** live: the flight takes input. app: views and pause work (the flight screen, maybe paused). */
export interface Gate {
  live: boolean;
  app: boolean;
}

export type PressOrigin = 'key' | 'mouse' | 'wheel' | 'device';

export interface PressEvent {
  id: ControlId;
  long: boolean;
  origin: PressOrigin;
}

export interface FrameContext {
  /** Real seconds since the last frame. */
  dt: number;
  gate: Gate;
  pads: ArrayLike<PadLike | null | undefined>;
  /** sim.options.realism.twoStageTrigger */
  twoStageTrigger: boolean;
  /** settings.mouseStick: the mouse flies the stick. */
  mouseStick: boolean;
  /** settings.invertY: look up/down inverted (mouse and sticks). */
  invertLook: boolean;
  /** The aircraft's speed-brake position 0..1 (NaN when unknown), for the open/close key. */
  speedBrakePosition: number;
}

export interface EngineOutput {
  pitch: number;
  roll: number;
  rudder: number;
  trimPitch: number;
  trimRoll: number;
  trimYaw: number;
  slewX: number;
  slewY: number;
  throttle: [number, number];
  /** The detent the simulation sees (after the one-stage realism rule). */
  trigger: 0 | 1 | 2;
  /** The detent the controls are in. */
  triggerRaw: 0 | 1 | 2;
  weaponRelease: boolean;
  laser: boolean;
  speedBrake: -1 | 0 | 1;
  lookX: number;
  lookY: number;
  /** Mouse-look movement this frame, pixels scaled by the look speed (+ right, + down). */
  lookDeltaX: number;
  lookDeltaY: number;
  zoomHeld: boolean;
  lookAtSpi: boolean;
  mouseLookHeld: boolean;
  /** The mouse stick's position (-1..1, + right, + pulled back) and whether it flies now. */
  mouseStickX: number;
  mouseStickY: number;
  mouseStickActive: boolean;
  /** Discrete presses since the last frame (the array is reused). */
  presses: PressEvent[];
}

export function createEngineOutput(): EngineOutput {
  return {
    pitch: 0,
    roll: 0,
    rudder: 0,
    trimPitch: 0,
    trimRoll: 0,
    trimYaw: 0,
    slewX: 0,
    slewY: 0,
    throttle: [0.85, 0.85],
    trigger: 0,
    triggerRaw: 0,
    weaponRelease: false,
    laser: false,
    speedBrake: 0,
    lookX: 0,
    lookY: 0,
    lookDeltaX: 0,
    lookDeltaY: 0,
    zoomHeld: false,
    lookAtSpi: false,
    mouseLookHeld: false,
    mouseStickX: 0,
    mouseStickY: 0,
    mouseStickActive: false,
    presses: [],
  };
}

export interface KeyResult {
  /** The key drives at least one control. */
  bound: boolean;
  /** At least one of those controls is live now (the DOM layer then prevents the default). */
  open: boolean;
  /** The key is the pause key and pausing is possible now (the flight screen, no dialog). */
  pause: boolean;
}

const NO_KEY: KeyResult = { bound: false, open: false, pause: false };

/** An axis device takes a lever over once it moved this far from where it lost it. */
export const TAKEOVER = 0.03;
/** Mouse travel for full mouse-stick deflection at speed 1, pixels. */
export const MOUSE_STICK_RANGE_PX = 400;
/** Max mouse-look movement handed out in one frame, pixels. */
const LOOK_DELTA_LIMIT = 4000;
const MAX_PENDING = 64;

const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

interface BindingRef {
  control: ControlId;
  ci: number;
  def: ControlDef;
  kind: ControlKind;
  binding: Binding;
  analog: boolean;
  /** A shift-layer binding uses the same physical input (this one then rests while shifted). */
  hasShiftTwin: boolean;
}

interface Activation {
  ref: BindingRef;
  /** Direction for axis/lever digital bindings, 1 otherwise. */
  dir: number;
  /** Pressure 0..1 (1 for keys). */
  value: number;
  start: number;
  longFired: boolean;
  /** Pressed while its gate was open: only armed presses fire. */
  armed: boolean;
  origin: PressOrigin;
}

interface AnalogState {
  /** Lever takeover: the reading when this input last lost (or first saw) the lever. */
  ref: number;
  last: number;
  /** Trigger detent with hysteresis. */
  stage: 0 | 1 | 2;
}

interface DeviceRefs {
  buttons: Map<number, BindingRef[]>;
  /** Axis used as a button: key = axis * 2 + (dir > 0 ? 1 : 0). */
  axisInputs: Map<number, BindingRef[]>;
  hatInputs: Map<number, BindingRef[]>;
  analog: BindingRef[];
}

interface DeviceState {
  id: string;
  key: string;
  ordinal: number;
  standard: boolean;
  primed: boolean;
  seen: number;
  version: number;
  refs: DeviceRefs;
  buttons: boolean[];
  buttonActs: (Activation[] | null)[];
  rest: number[];
  axisDown: Map<number, boolean>;
  axisActs: Map<number, Activation[]>;
  hats: Map<number, number>;
  hatActs: Map<number, Activation[]>;
  analog: Map<BindingRef, AnalogState>;
}

type LeverOwner = AnalogState | 'keys' | null;

const EMPTY_ACTS: Activation[] = [];
const HAT_BITS = [HAT_UP, HAT_RIGHT, HAT_DOWN, HAT_LEFT];

interface RampRates {
  rise: number;
  fall: number;
  jump: number;
}

/** Rise and fall rates (per second) of each ramp profile for these options. */
function rampRates(ramp: ControlDef['ramp'], opts: InputOptions): RampRates {
  const rate = (seconds: number) => (seconds > 0.001 ? 1 / seconds : Infinity);
  switch (ramp) {
    case 'stick':
      return { rise: rate(opts.keyRampTime), fall: rate(0.12), jump: 0 };
    case 'pedal':
      return { rise: rate(opts.keyRampTime * 1.3), fall: rate(0.2), jump: 0 };
    case 'slew':
      return { rise: rate(1.2), fall: Infinity, jump: 0.15 };
    case 'look':
      return { rise: rate(0.5), fall: Infinity, jump: 0.25 };
    default:
      return { rise: Infinity, fall: Infinity, jump: 0 };
  }
}

/** Mouse-stick shaping: a small dead zone and a soft centre. */
function shapeMouse(v: number): number {
  const m = Math.abs(v);
  return m < 0.02 ? 0 : Math.sign(v) * responseCurve((m - 0.02) / 0.98, 0.25);
}

function samePhysical(a: Source, b: Source): boolean {
  return bindingsOverlap({ src: a }, { src: b });
}

export class InputEngine {
  private config: BindingsConfig = defaultBindingsConfig();
  private options: InputOptions = { ...DEFAULT_OPTIONS };
  private version = 0;
  private refs: BindingRef[] = [];
  private keyIndex = new Map<string, BindingRef[]>();
  private mouseIndex = new Map<number, BindingRef[]>();
  private wheelIndex = new Map<number, BindingRef[]>();

  private gate: Gate = { live: false, app: false };
  private clock = 0;
  private frame = 0;

  /** Held keys and mouse buttons → what they activated (fixed at the press). */
  private held = new Map<string, Activation[]>();
  /** Every current activation (keys, mouse, devices, wheel pulses). */
  private active: Activation[] = [];
  private pulses: Activation[] = [];
  private pending: PressEvent[] = [];
  private devices = new Map<string, DeviceState>();
  /** Gamepad.index → the device id string last built for it (no string per frame). */
  private slots = new Map<number, { padId: string; ordinal: number; id: string }>();

  /** Ramp rates per control (from the options), rebuilt with the bindings. */
  private rates: RampRates[] = [];
  private ramp = new Float64Array(CONTROL_IDS.length);
  private digital = new Float64Array(CONTROL_IDS.length);
  private analog = new Float64Array(CONTROL_IDS.length);
  private holds = new Uint8Array(CONTROL_IDS.length);

  private levers: [number, number] = [0.85, 0.85];
  private leverOwner: [LeverOwner, LeverOwner] = [null, null];

  private wheelAccum = 0;
  private mouseDx = 0;
  private mouseDy = 0;
  private stickX = 0;
  private stickY = 0;

  private speedBrakeLatch: -1 | 0 | 1 = 0;
  private speedBrakeLastDir: -1 | 1 = -1;
  private speedBrakeToggle = false;

  constructor(config?: BindingsConfig) {
    if (config) this.setBindings(config);
    else this.setBindings(this.config);
  }

  // ------------------------------------------------------------------------------------------
  // Configuration and lifetime
  // ------------------------------------------------------------------------------------------

  setBindings(config: BindingsConfig): void {
    this.releaseEverything();
    this.config = config;
    this.options = config.options;
    this.rates = CONTROL_IDS.map((id) => rampRates(CONTROL_DEFS[id].ramp, config.options));
    this.version++;
    this.refs = [];
    this.keyIndex.clear();
    this.mouseIndex.clear();
    this.wheelIndex.clear();
    for (const control of CONTROL_IDS) {
      const def = CONTROL_DEFS[control];
      for (const binding of config.controls[control]) {
        this.refs.push({
          control,
          ci: CONTROL_INDEX[control],
          def,
          kind: def.kind,
          binding,
          analog: isAnalogBinding(binding, def.kind),
          hasShiftTwin: false,
        });
      }
    }
    for (const r of this.refs) {
      if (r.binding.layer === 'shift') continue;
      r.hasShiftTwin = this.refs.some(
        (o) => o.binding.layer === 'shift' && samePhysical(o.binding.src, r.binding.src),
      );
    }
    const push = <K>(map: Map<K, BindingRef[]>, k: K, r: BindingRef) => {
      const list = map.get(k);
      if (list) list.push(r);
      else map.set(k, [r]);
    };
    for (const r of this.refs) {
      const s = r.binding.src;
      if (s.type === 'key') push(this.keyIndex, s.code, r);
      else if (s.type === 'mouse') push(this.mouseIndex, s.button, r);
      else if (s.type === 'wheel') push(this.wheelIndex, s.dir, r);
    }
    for (const d of this.devices.values()) d.version = -1;
  }

  getBindings(): BindingsConfig {
    return this.config;
  }

  /** Open or close the gate (also done by update()). Closing disarms pending presses. */
  setGate(gate: Gate): void {
    const wasLive = this.gate.live;
    const wasApp = this.gate.app;
    this.gate.live = gate.live;
    this.gate.app = gate.app;
    if ((wasLive && !gate.live) || (wasApp && !gate.app)) {
      for (const a of this.active) if (!this.gateOpen(a.ref.def)) a.armed = false;
    }
    if (wasLive && !gate.live) {
      this.ramp.fill(0);
      this.stickX = 0;
      this.stickY = 0;
      this.mouseDx = 0;
      this.mouseDy = 0;
      this.wheelAccum = 0;
      for (const d of this.devices.values()) for (const st of d.analog.values()) st.stage = 0;
    }
  }

  /** A new flight: the levers start where the simulation put them; no device owns them. */
  resetLevers(throttle: readonly [number, number]): void {
    this.levers[0] = clamp(Number.isFinite(throttle[0]) ? throttle[0] : 0.85, 0, 1);
    this.levers[1] = clamp(Number.isFinite(throttle[1]) ? throttle[1] : 0.85, 0, 1);
    this.leverOwner[0] = null;
    this.leverOwner[1] = null;
    for (const d of this.devices.values()) d.analog.clear();
    this.speedBrakeLatch = 0;
    this.speedBrakeToggle = false;
  }

  getLevers(): readonly [number, number] {
    return this.levers;
  }

  /** Let go of every key and mouse button without firing anything (blur, hidden tab). */
  releaseKeys(): void {
    for (const list of this.held.values()) for (const a of list) this.deactivate(a, false);
    this.held.clear();
    for (const a of this.pulses) this.deactivate(a, false);
    this.pulses.length = 0;
  }

  private releaseEverything(): void {
    this.releaseKeys();
    for (const d of this.devices.values()) this.dropDevice(d);
    this.devices.clear();
    this.active.length = 0;
    this.pending.length = 0;
  }

  // ------------------------------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------------------------------

  keyDown(code: string, mods: KeyMods): KeyResult {
    const id = `k:${code}`;
    const existing = this.held.get(id);
    if (existing) return this.keyResult(existing);
    if (mods.meta && !MODIFIER_CODES.has(code)) return NO_KEY;
    const candidates = this.keyIndex.get(code);
    let matched: BindingRef[] = [];
    if (candidates) {
      if (MODIFIER_CODES.has(code)) {
        matched = candidates;
      } else {
        matched = candidates.filter((r) => {
          const s = r.binding.src as Extract<Source, { type: 'key' }>;
          return !!s.ctrl === mods.ctrl && !!s.alt === mods.alt && (!s.shift || mods.shift);
        });
        if (mods.shift && matched.some((r) => (r.binding.src as { shift?: true }).shift)) {
          matched = matched.filter((r) => (r.binding.src as { shift?: true }).shift);
        }
      }
    }
    const acts = matched.map((r) => this.activate(r, 'key', 1));
    this.held.set(id, acts);
    return this.keyResult(acts);
  }

  keyUp(code: string): KeyResult {
    const id = `k:${code}`;
    const acts = this.held.get(id);
    if (!acts) return NO_KEY;
    const result = this.keyResult(acts);
    this.held.delete(id);
    for (const a of acts) this.deactivate(a, true);
    return result;
  }

  mouseDown(button: number): boolean {
    const id = `m:${button}`;
    if (this.held.has(id)) return true;
    const refs = this.mouseIndex.get(button) ?? [];
    const acts = refs.map((r) => this.activate(r, 'mouse', 1));
    this.held.set(id, acts);
    return acts.length > 0;
  }

  mouseUp(button: number): void {
    const id = `m:${button}`;
    const acts = this.held.get(id);
    if (!acts) return;
    this.held.delete(id);
    for (const a of acts) this.deactivate(a, true);
  }

  /** Wheel movement in notches (+ = away from you / up). Fractions add up (touchpads). */
  wheel(notches: number): void {
    if (!Number.isFinite(notches) || !this.gate.app) return;
    this.wheelAccum = clamp(this.wheelAccum + notches, -8, 8);
    while (Math.abs(this.wheelAccum) >= 1) {
      const dir = this.wheelAccum > 0 ? 1 : -1;
      this.wheelAccum -= dir;
      for (const r of this.wheelIndex.get(dir) ?? [])
        this.pulses.push(this.activate(r, 'wheel', 1));
    }
  }

  /** Mouse movement while the pointer is locked, pixels. */
  mouseMove(dx: number, dy: number): void {
    if (!this.gate.live || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.mouseDx += dx;
    this.mouseDy += dy;
  }

  // ------------------------------------------------------------------------------------------
  // The frame
  // ------------------------------------------------------------------------------------------

  update(ctx: FrameContext, out: EngineOutput): EngineOutput {
    const dt = Number.isFinite(ctx.dt) ? clamp(ctx.dt, 0, 0.25) : 0;
    this.setGate(ctx.gate);
    this.clock += dt;
    this.frame++;
    const live = this.gate.live;
    const opts = this.options;

    // devices: button edges, hats, axes used as buttons, then analogue values
    this.analog.fill(0);
    let analogStage: 0 | 1 | 2 = 0;
    const shift = this.shiftDown(ctx.pads);
    for (let i = 0; i < ctx.pads.length; i++) {
      const pad = ctx.pads[i];
      if (!pad || !pad.connected) continue;
      const ds = this.deviceState(pad, deviceOrdinal(ctx.pads, i));
      ds.seen = this.frame;
      this.deviceEdges(pad, ds, shift);
      const s = this.deviceAnalog(pad, ds, shift, live);
      if (s > analogStage) analogStage = s;
    }
    for (const [k, d] of this.devices) {
      if (d.seen !== this.frame) {
        this.dropDevice(d);
        this.devices.delete(k);
      }
    }

    // long presses
    for (const a of this.active) {
      const def = a.ref.def;
      if (def.kind !== 'press' || !a.armed || a.longFired) continue;
      if (def.press !== 'shortLong' && def.press !== 'longOnly') continue;
      if (this.clock - a.start >= LONG_PRESS_S - 1e-9) {
        a.longFired = true;
        this.emit(def.id, true, a.origin);
      }
    }

    // digital sums and holds
    this.digital.fill(0);
    this.holds.fill(0);
    for (const a of this.active) {
      if (!this.gateOpen(a.ref.def)) continue;
      this.digital[a.ref.ci] += a.dir * a.value;
      this.holds[a.ref.ci] = 1;
    }
    const hold = (id: ControlId) => this.holds[CONTROL_INDEX[id]] === 1;
    const axis = (id: ControlId, extra = 0) => this.axisValue(id, extra, live, dt);

    // mouse: stick or look
    const mouseLookHeld = live && hold('mouseLook');
    const stickActive = live && ctx.mouseStick && !mouseLookHeld;
    out.lookDeltaX = 0;
    out.lookDeltaY = 0;
    if (live) {
      if (stickActive) {
        const range = MOUSE_STICK_RANGE_PX / clamp(opts.mouseStickSpeed, 0.05, 10);
        this.stickX += this.mouseDx / range;
        this.stickY += this.mouseDy / range;
      } else {
        const ySign = ctx.invertLook ? -1 : 1;
        const speed = opts.mouseLookSpeed;
        out.lookDeltaX = clamp(this.mouseDx * speed, -LOOK_DELTA_LIMIT, LOOK_DELTA_LIMIT);
        out.lookDeltaY =
          clamp(this.mouseDy * speed * ySign, -LOOK_DELTA_LIMIT, LOOK_DELTA_LIMIT) + 0;
      }
      if (ctx.mouseStick) {
        const mag = Math.hypot(this.stickX, this.stickY);
        if (mag > 1) {
          this.stickX /= mag;
          this.stickY /= mag;
        }
        const k = clamp(opts.mouseStickSpring, 0, 1) * 3;
        const decay = Math.exp(-k * dt);
        this.stickX *= decay;
        this.stickY *= decay;
      } else {
        this.stickX = 0;
        this.stickY = 0;
      }
    }
    this.mouseDx = 0;
    this.mouseDy = 0;
    const msx = ctx.mouseStick && live ? shapeMouse(this.stickX) : 0;
    const msy = ctx.mouseStick && live ? shapeMouse(this.stickY) : 0;

    out.pitch = axis('pitch', msy);
    out.roll = axis('roll', msx);
    out.rudder = axis('rudder');
    out.trimPitch = axis('trimPitch');
    out.trimRoll = axis('trimRoll');
    out.trimYaw = axis('trimYaw');
    out.slewX = axis('slewX');
    out.slewY = axis('slewY');
    out.lookX = axis('lookX');
    const lookY = axis('lookY');
    out.lookY = (ctx.invertLook ? -lookY : lookY) + 0;
    out.mouseStickX = ctx.mouseStick && live ? this.stickX : 0;
    out.mouseStickY = ctx.mouseStick && live ? this.stickY : 0;
    out.mouseStickActive = stickActive;

    // levers: keys move them at a rate (after the devices, so keys win a tie)
    if (live) {
      const rate = 1 / clamp(opts.throttleKeyTime, 0.1, 30);
      for (const id of ['throttleBoth', 'throttleLeft', 'throttleRight'] as const) {
        const d = this.digital[CONTROL_INDEX[id]];
        if (d === 0) continue;
        for (const l of CONTROL_DEFS[id].levers ?? []) {
          this.takeLever(l, 'keys');
          this.levers[l] = clamp(this.levers[l] + clamp(d, -1, 1) * rate * dt, 0, 1);
        }
      }
    }
    out.throttle[0] = this.levers[0];
    out.throttle[1] = this.levers[1];

    // trigger
    let stage: 0 | 1 | 2 = live ? analogStage : 0;
    if (live && hold('triggerFirst') && stage < 1) stage = 1;
    if (live && hold('triggerSecond')) stage = 2;
    out.triggerRaw = stage;
    out.trigger = effectiveStage(stage, ctx.twoStageTrigger);

    // held switches
    out.weaponRelease = live && hold('weaponRelease');
    out.laser = live && hold('laser');
    out.zoomHeld = live && hold('zoomHold');
    out.lookAtSpi = live && hold('lookAtSpi');
    out.mouseLookHeld = mouseLookHeld;

    // speed brake: held extend/retract, or the open/close key latching the switch
    const extend = live && hold('speedBrakeExtend');
    const retract = live && hold('speedBrakeRetract');
    const pos = ctx.speedBrakePosition;
    if (this.speedBrakeToggle && live) {
      let dir: -1 | 1;
      if (this.speedBrakeLatch !== 0) dir = this.speedBrakeLatch > 0 ? -1 : 1;
      else if (Number.isFinite(pos)) dir = pos > 0.5 ? -1 : 1;
      else dir = this.speedBrakeLastDir > 0 ? -1 : 1;
      this.speedBrakeLatch = dir;
      this.speedBrakeLastDir = dir;
    }
    this.speedBrakeToggle = false;
    if (extend || retract) {
      this.speedBrakeLatch = 0;
      out.speedBrake = extend && !retract ? 1 : retract && !extend ? -1 : 0;
    } else {
      if (
        this.speedBrakeLatch !== 0 &&
        Number.isFinite(pos) &&
        ((this.speedBrakeLatch > 0 && pos >= 0.999) || (this.speedBrakeLatch < 0 && pos <= 0.001))
      ) {
        this.speedBrakeLatch = 0;
      }
      out.speedBrake = live ? this.speedBrakeLatch : 0;
    }

    // presses since the last frame; wheel pulses end now
    out.presses.length = 0;
    for (const p of this.pending) out.presses.push(p);
    this.pending.length = 0;
    for (const a of this.pulses) this.deactivate(a, true);
    this.pulses.length = 0;
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------------------------

  /** One momentary axis: keys and buttons ramped, analogue inputs and `extra` added. */
  private axisValue(id: ControlId, extra: number, live: boolean, dt: number): number {
    const ci = CONTROL_INDEX[id];
    if (!live) {
      this.ramp[ci] = 0;
      return 0;
    }
    const r = this.rates[ci];
    const target = clamp(this.digital[ci], -1, 1);
    this.ramp[ci] = rampToward(this.ramp[ci], target, r.rise, r.fall, dt, r.jump);
    return clamp(this.ramp[ci] + this.analog[ci] + extra, -1, 1);
  }

  private gateOpen(def: ControlDef): boolean {
    return def.scope === 'app' ? this.gate.app : this.gate.live;
  }

  private keyResult(acts: readonly Activation[]): KeyResult {
    if (acts.length === 0) return NO_KEY;
    let open = false;
    let pause = false;
    for (const a of acts) {
      if (!this.gateOpen(a.ref.def)) continue;
      open = true;
      if (a.ref.control === 'pause') pause = true;
    }
    return { bound: true, open, pause };
  }

  private emit(id: ControlId, long: boolean, origin: PressOrigin): void {
    if (id === 'speedBrakeToggle') {
      this.speedBrakeToggle = true;
      return;
    }
    if (this.pending.length < MAX_PENDING) this.pending.push({ id, long, origin });
  }

  private activate(ref: BindingRef, origin: PressOrigin, value: number): Activation {
    const def = ref.def;
    const a: Activation = {
      ref,
      dir: ref.binding.dir ?? 1,
      value,
      start: this.clock,
      longFired: false,
      armed: this.gateOpen(def),
      origin,
    };
    this.active.push(a);
    if (a.armed && def.kind === 'press' && (def.press ?? 'instant') === 'instant') {
      this.emit(def.id, false, origin);
    }
    return a;
  }

  private deactivate(a: Activation, fire: boolean): void {
    const i = this.active.indexOf(a);
    if (i >= 0) this.active.splice(i, 1);
    const def = a.ref.def;
    if (
      fire &&
      a.armed &&
      !a.longFired &&
      def.kind === 'press' &&
      def.press === 'shortLong' &&
      this.gateOpen(def)
    ) {
      this.emit(def.id, false, a.origin);
    }
  }

  private press(refs: BindingRef[] | undefined, shift: boolean, value: number): Activation[] {
    if (!refs || refs.length === 0) return EMPTY_ACTS;
    const shifted = shift && refs.some((r) => r.binding.layer === 'shift');
    const out: Activation[] = [];
    for (const r of refs) {
      if (r.analog) continue;
      if ((r.binding.layer === 'shift') !== shifted) continue;
      out.push(this.activate(r, 'device', value));
    }
    return out;
  }

  private release(acts: Activation[] | null | undefined): void {
    if (!acts) return;
    for (const a of acts) this.deactivate(a, true);
  }

  /** The gamepad shift layer is held: its activation exists, or its input is down right now. */
  private shiftDown(pads: ArrayLike<PadLike | null | undefined>): boolean {
    for (const a of this.active) if (a.ref.control === 'padShift') return this.gate.live;
    if (!this.gate.live) return false;
    for (const b of this.config.controls.padShift) {
      const s = b.src;
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        if (!pad || !pad.connected) continue;
        if (s.type === 'padButton' && isStandard(pad) && buttonValue(pad, s.button) > 0.55)
          return true;
        if (s.type === 'hidButton') {
          const ident = identityOf(pad.id);
          if (ident.key === s.device.key && deviceOrdinal(pads, i) === s.device.ordinal)
            if (buttonValue(pad, s.button) > 0.55) return true;
        }
      }
    }
    return false;
  }

  private deviceState(pad: PadLike, ordinal: number): DeviceState {
    const ident = identityOf(pad.id);
    let slot = this.slots.get(pad.index);
    if (!slot || slot.padId !== pad.id || slot.ordinal !== ordinal) {
      slot = { padId: pad.id, ordinal, id: `${ident.key}#${ordinal}` };
      this.slots.set(pad.index, slot);
    }
    const id = slot.id;
    let ds = this.devices.get(id);
    if (!ds) {
      ds = {
        id,
        key: ident.key,
        ordinal,
        standard: isStandard(pad),
        primed: false,
        seen: this.frame,
        version: -1,
        refs: { buttons: new Map(), axisInputs: new Map(), hatInputs: new Map(), analog: [] },
        buttons: [],
        buttonActs: [],
        rest: [],
        axisDown: new Map(),
        axisActs: new Map(),
        hats: new Map(),
        hatActs: new Map(),
        analog: new Map(),
      };
      this.devices.set(id, ds);
    }
    if (ds.version !== this.version) {
      ds.refs = this.deviceRefs(ds);
      ds.analog.clear();
      ds.version = this.version;
    }
    return ds;
  }

  private deviceRefs(ds: DeviceState): DeviceRefs {
    const refs: DeviceRefs = {
      buttons: new Map(),
      axisInputs: new Map(),
      hatInputs: new Map(),
      analog: [],
    };
    const push = (map: Map<number, BindingRef[]>, k: number, r: BindingRef) => {
      const list = map.get(k);
      if (list) list.push(r);
      else map.set(k, [r]);
    };
    for (const r of this.refs) {
      const s = r.binding.src;
      let mine = false;
      if (s.type === 'padButton' || s.type === 'padAxis') mine = ds.standard;
      else if (s.type === 'hidButton' || s.type === 'hidAxis' || s.type === 'hidHat')
        mine = s.device.key === ds.key && s.device.ordinal === ds.ordinal;
      if (!mine) continue;
      if (r.analog) refs.analog.push(r);
      else if (s.type === 'padButton' || s.type === 'hidButton') push(refs.buttons, s.button, r);
      else if ((s.type === 'padAxis' || s.type === 'hidAxis') && s.dir !== undefined)
        push(refs.axisInputs, s.axis * 2 + (s.dir > 0 ? 1 : 0), r);
      else if (s.type === 'hidHat') push(refs.hatInputs, s.axis, r);
    }
    return refs;
  }

  private dropDevice(d: DeviceState): void {
    for (const acts of d.buttonActs) if (acts) for (const a of acts) this.deactivate(a, false);
    for (const acts of d.axisActs.values()) for (const a of acts) this.deactivate(a, false);
    for (const acts of d.hatActs.values()) for (const a of acts) this.deactivate(a, false);
    d.buttonActs.length = 0;
    d.axisActs.clear();
    d.hatActs.clear();
  }

  private deviceEdges(pad: PadLike, ds: DeviceState, shift: boolean): void {
    const first = !ds.primed;
    if (first) {
      for (let a = 0; a < pad.axes.length; a++) {
        const v = axisValue(pad, a);
        ds.rest[a] = Math.abs(v) < 0.3 ? 0 : v;
      }
    }
    // buttons (the first snapshot only primes: browsers reveal a pad when it is pressed)
    for (let b = 0; b < pad.buttons.length; b++) {
      const v = buttonValue(pad, b);
      const was = ds.buttons[b] === true;
      const now = buttonDown(was, v);
      ds.buttons[b] = now;
      if (first || now === was) {
        if (now) {
          const acts = ds.buttonActs[b];
          if (acts) for (const a of acts) a.value = v;
        }
        continue;
      }
      if (now) {
        const acts = this.press(ds.refs.buttons.get(b), shift, v);
        ds.buttonActs[b] = acts.length ? acts : null;
      } else {
        this.release(ds.buttonActs[b]);
        ds.buttonActs[b] = null;
      }
    }
    // axes used as buttons
    for (const [k, refs] of ds.refs.axisInputs) {
      const axis = k >> 1;
      const dir = k & 1 ? 1 : -1;
      const rest = ds.rest[axis] ?? 0;
      const delta = (axisValue(pad, axis) - rest) * dir;
      const was = ds.axisDown.get(k) === true;
      const now = was ? delta > 0.4 : delta > 0.5;
      ds.axisDown.set(k, now);
      if (first || now === was) continue;
      if (now) ds.axisActs.set(k, this.press(refs, shift, 1));
      else {
        this.release(ds.axisActs.get(k));
        ds.axisActs.delete(k);
      }
    }
    // point-of-view hats
    for (const [axis, refs] of ds.refs.hatInputs) {
      const mask = hatMask(axisValue(pad, axis));
      const prev = ds.hats.get(axis) ?? 0;
      ds.hats.set(axis, mask);
      if (first || mask === prev) continue;
      for (const bit of HAT_BITS) {
        const was = (prev & bit) !== 0;
        const now = (mask & bit) !== 0;
        if (was === now) continue;
        const key = axis * 16 + bit;
        if (now) {
          const forDir = refs.filter(
            (r) => r.binding.src.type === 'hidHat' && hatBit(r.binding.src.dir) === bit,
          );
          ds.hatActs.set(key, this.press(forDir, shift, 1));
        } else {
          this.release(ds.hatActs.get(key));
          ds.hatActs.delete(key);
        }
      }
    }
    ds.primed = true;
  }

  /** Analogue inputs of one device; returns the highest trigger detent it reads. */
  private deviceAnalog(pad: PadLike, ds: DeviceState, shift: boolean, live: boolean): 0 | 1 | 2 {
    let stage: 0 | 1 | 2 = 0;
    if (!live) return 0;
    for (const r of ds.refs.analog) {
      const layered = r.binding.layer === 'shift';
      if (layered ? !shift : shift && r.hasShiftTwin) continue;
      const s = r.binding.src;
      const cal = r.binding.cal ?? LEVER_CAL;
      if (r.kind === 'axis') {
        if (s.type !== 'padAxis' && s.type !== 'hidAxis') continue;
        const raw = axisValue(pad, s.axis);
        const partner = stickPartner(s.axis);
        this.analog[r.ci] +=
          s.type === 'padAxis' && partner >= 0
            ? shapeStickAxis(raw, axisValue(pad, partner), cal)
            : shapeCentred(raw, cal);
        continue;
      }
      const v =
        s.type === 'padButton' || s.type === 'hidButton'
          ? shapePressure(buttonValue(pad, s.button), cal)
          : s.type === 'padAxis' || s.type === 'hidAxis'
            ? shapeLever(axisValue(pad, s.axis), cal)
            : 0;
      let st = ds.analog.get(r);
      if (!st) {
        st = { ref: Number.NaN, last: Number.NaN, stage: 0 };
        ds.analog.set(r, st);
      }
      if (r.kind === 'trigger') {
        st.stage = triggerStage(st.stage, v);
        if (st.stage > stage) stage = st.stage;
      } else if (r.kind === 'lever') {
        this.leverInput(r, st, v);
      }
    }
    return stage;
  }

  private leverInput(r: BindingRef, st: AnalogState, v: number): void {
    const levers = r.def.levers ?? [];
    if (Number.isNaN(st.ref)) {
      st.ref = v;
      st.last = v;
      return;
    }
    st.last = v;
    let owns = false;
    for (const l of levers) {
      if (this.leverOwner[l] === st) {
        this.levers[l] = v;
        owns = true;
      }
    }
    if (owns || Math.abs(v - st.ref) <= TAKEOVER) return;
    for (const l of levers) {
      this.takeLever(l, st);
      this.levers[l] = v;
    }
  }

  private takeLever(l: 0 | 1, owner: AnalogState | 'keys'): void {
    const prev = this.leverOwner[l];
    if (prev === owner) return;
    if (prev && prev !== 'keys') prev.ref = prev.last;
    this.leverOwner[l] = owner;
  }
}
