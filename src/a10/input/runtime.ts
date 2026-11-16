/**
 * The input runtime: the DOM side of the input module. It listens to the keyboard, mouse,
 * wheel, pointer lock and gamepads, feeds the pure InputEngine, and once per frame (inside the
 * `onBeforeSimSteps` listener of InputManager) writes sim.input, queues commands, applies view
 * and pause actions and fills viewInput. OWNED BY THE INPUT MODULE.
 *
 * Keyboard hygiene (copied from the carrier's keyboard layer):
 *  - inert while a key is being captured (the carrier's keyCapture or the controls panel);
 *  - keys typed into an editable control are left alone;
 *  - ⌘ chords never fly (and let go of everything: macOS drops the other key-ups);
 *  - a key-up always releases; everything is released on blur and when the tab is hidden;
 *  - bound keys do not scroll the page or press a focused button while their control is live
 *    (F1–F5, Space, arrows, Page Up/Down …); Escape is never prevented, so the UI can tell
 *    whether it handled it.
 * Escape: pauses on the flight screen; when paused it resumes only if nothing else handled the
 * event (checked after the event has gone through every listener: `defaultPrevented`).
 * Pointer lock: a click on the view locks the pointer for mouse look or the mouse stick; pausing,
 * a dialog or the free cursor (Left Alt) releases it. Chromium swallows the Escape that leaves
 * pointer lock, so an unexpected unlock while flying pauses, as that Escape would have.
 */
import { clamp, isKeyCaptureActive } from '../../engine';
import { pushCommand } from '../core/sim';
import type { PilotInput, Sim } from '../core/types';
import { useA10Store } from '../state/store';
import { applyTestInputOverride } from '../state/testHook';
import {
  appActionForPress,
  commandForPress,
  nextView,
  weaponView,
  type SwitchState,
} from './actions';
import { getBindingsConfig, subscribeBindings } from './bindingsStore';
import {
  InputEngine,
  createEngineOutput,
  type EngineOutput,
  type FrameContext,
  type KeyMods,
} from './engine';
import { computeGate, isInputCaptureActive } from './gating';
import { shortDeviceName, deviceIdentity, type PadLike } from './devices';
import { viewInput } from './viewInput';

export interface RuntimeStatus {
  pointerLocked: boolean;
  cursorFree: boolean;
  /** Mouse-stick mode with the gate open (the indicator shows). */
  mouseStick: boolean;
  live: boolean;
}

export interface RuntimeOptions {
  /** The element the pointer locks to and clicks are measured on (default: the app canvas). */
  target?: () => HTMLElement | null;
  /** Every frame, after the engine ran (indicator drawing, sandbox display). */
  onFrame?: (out: EngineOutput, status: RuntimeStatus) => void;
}

export interface InputRuntime {
  readonly engine: InputEngine;
  readonly out: EngineOutput;
  /** One frame: poll devices, run the engine, apply the result to `sim` (if any). */
  frame(dt: number, sim: Sim | null): EngineOutput;
  status(): RuntimeStatus;
  detach(): void;
}

const LOOK_LIMIT = 5000;
const ESC_GHOST_MS = 500;
const RUMBLE_PERIOD_S = 0.09;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function modsOf(e: KeyboardEvent | MouseEvent): KeyMods {
  return { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
}

export function readPads(): ArrayLike<PadLike | null> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
    return navigator.getGamepads();
  } catch {
    // getGamepads() throws when a permissions policy forbids the Gamepad API
    return [];
  }
}

function defaultTarget(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.a10-app canvas');
}

/** The event happened on the view (the canvas, or inside the sandbox's stand-in). */
function onView(el: HTMLElement | null, target: EventTarget | null): el is HTMLElement {
  return !!el && target instanceof Node && el.contains(target);
}

function captureActive(): boolean {
  return isInputCaptureActive() || isKeyCaptureActive();
}

/** Write the engine's flight controls into the simulation's PilotInput. */
export function writePilotInput(out: EngineOutput, input: PilotInput): void {
  input.pitch = out.pitch;
  input.roll = out.roll;
  input.rudder = out.rudder;
  input.throttle[0] = out.throttle[0];
  input.throttle[1] = out.throttle[1];
  input.trigger = out.trigger;
  input.weaponRelease = out.weaponRelease;
  input.speedBrake = out.speedBrake;
  input.trimPitch = out.trimPitch;
  input.trimRoll = out.trimRoll;
  input.trimYaw = out.trimYaw;
  input.slewX = out.slewX;
  input.slewY = out.slewY;
  input.laser = out.laser;
}

function switchState(sim: Sim): SwitchState {
  const av = sim.avionics as Partial<Sim['avionics']> | undefined;
  const ac = sim.aircraft as Partial<Sim['aircraft']> | undefined;
  return {
    masterArm: av?.masterArm ?? 'SAFE',
    laserArm: av?.laserArm ?? 'SAFE',
    soi: av?.soi ?? 'HUD',
    flapHandle: ac?.flapHandle ?? 0,
    altitudeAlert: ac?.altitudeAlert ?? 0,
  };
}

export function attachInputRuntime(options: RuntimeOptions = {}): InputRuntime {
  const store = useA10Store;
  const engine = new InputEngine(getBindingsConfig());
  const out = createEngineOutput();
  /** Reused every frame. */
  const ctx: FrameContext = {
    dt: 0,
    gate: { live: false, app: false },
    pads: [],
    twoStageTrigger: true,
    mouseStick: false,
    invertLook: false,
    speedBrakePosition: Number.NaN,
  };
  const target = options.target ?? defaultTarget;
  let currentSim: Sim | null = null;
  let locked = false;
  let expectingUnlock = false;
  let ghostEscUntil = 0;
  /** When an unexpected unlock last paused (a scheduled Escape toggle must not undo it). */
  let unlockPausedAt = -Infinity;
  let centerPulse = false;
  let rumbleClock = 0;
  let wasLive = false;

  const gateNow = () => {
    const s = store.getState();
    return computeGate({
      screen: s.screen,
      paused: s.paused,
      settingsOpen: s.settingsOpen,
      capturing: captureActive(),
    });
  };

  const unsubscribeBindings = subscribeBindings((config) => engine.setBindings(config));
  const unsubscribeStore = store.subscribe(() => engine.setGate(gateNow()));
  engine.setGate(gateNow());

  const pauseOnEscape = () =>
    getBindingsConfig().controls.pause.some((b) => b.src.type === 'key' && b.src.code === 'Escape');

  // ---- pointer lock -------------------------------------------------------------------------

  const requestLock = () => {
    const el = target();
    if (!el || locked || typeof el.requestPointerLock !== 'function') return;
    try {
      const r = el.requestPointerLock() as unknown;
      if (r && typeof (r as Promise<void>).catch === 'function')
        (r as Promise<void>).catch(() => {});
    } catch {
      // not allowed now (no user gesture, or right after the user left the lock)
    }
  };

  const exitLock = () => {
    if (typeof document === 'undefined' || !document.pointerLockElement) return;
    expectingUnlock = true;
    try {
      document.exitPointerLock();
    } catch {
      expectingUnlock = false;
    }
  };

  const onPointerLockChange = () => {
    const el = target();
    const nowLocked = !!document.pointerLockElement && document.pointerLockElement === el;
    const lost = locked && !nowLocked;
    locked = nowLocked;
    if (!lost) return;
    engine.releaseKeys();
    for (const b of [0, 1, 2, 3, 4]) engine.mouseUp(b);
    if (expectingUnlock) {
      expectingUnlock = false;
      return;
    }
    // The browser let go: in Chromium that is the Escape key, which the page never sees.
    const s = store.getState();
    if (
      document.hasFocus() &&
      s.screen === 'flight' &&
      !s.paused &&
      !s.settingsOpen &&
      !viewInput.cursorFree &&
      pauseOnEscape()
    ) {
      s.setPaused(true);
      unlockPausedAt = performance.now();
      ghostEscUntil = unlockPausedAt + ESC_GHOST_MS;
    }
  };

  // ---- keyboard -----------------------------------------------------------------------------

  const schedulePause = (e: KeyboardEvent) => {
    // after every listener has seen the event: the UI's pause menu prevents its own Escape
    window.setTimeout(() => {
      if (e.defaultPrevented) return;
      // Firefox may deliver the Escape AND leave pointer lock: that pause already happened
      if (performance.now() - unlockPausedAt < ESC_GHOST_MS) return;
      const s = store.getState();
      if (s.screen !== 'flight' || s.settingsOpen || captureActive()) return;
      s.setPaused(!s.paused);
    }, 0);
  };

  /** Capture phase: swallow the Escape a browser may deliver right after it left pointer lock. */
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (e.code !== 'Escape' || performance.now() > ghostEscUntil) return;
    ghostEscUntil = 0;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (captureActive() || isEditableTarget(e.target)) return;
    if (e.metaKey) {
      engine.releaseKeys();
      return;
    }
    const r = engine.keyDown(e.code, modsOf(e));
    if (r.open && !r.pause) e.preventDefault();
    if (r.pause && !e.repeat) schedulePause(e);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const r = engine.keyUp(e.code);
    // a focused button would activate on the key-up of Space
    if (r.open && !r.pause && !isEditableTarget(e.target)) e.preventDefault();
  };

  const releaseAll = () => {
    engine.releaseKeys();
    for (const b of [0, 1, 2, 3, 4]) engine.mouseUp(b);
  };

  const onVisibility = () => {
    if (document.hidden) releaseAll();
  };

  // ---- mouse --------------------------------------------------------------------------------

  const ndc = (e: MouseEvent) => {
    const el = target();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      x: clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1),
      y: clamp(-(((e.clientY - r.top) / r.height) * 2 - 1), -1, 1),
    };
  };

  const onMouseDown = (e: MouseEvent) => {
    if (captureActive()) return;
    if (locked) {
      if (engine.mouseDown(e.button)) e.preventDefault();
      return;
    }
    const el = target();
    if (!onView(el, e.target)) return;
    const gate = gateNow();
    if (!gate.live) return;
    if (viewInput.cursorFree) {
      const p = ndc(e);
      if (p) viewInput.click = { x: p.x, y: p.y, button: e.button };
      return;
    }
    if (e.button === 0) requestLock();
  };

  const onMouseUp = (e: MouseEvent) => {
    engine.mouseUp(e.button);
  };

  const onMouseMove = (e: MouseEvent) => {
    if (locked) {
      engine.mouseMove(e.movementX, e.movementY);
      return;
    }
    if (viewInput.cursorFree) {
      const p = ndc(e);
      if (p) {
        viewInput.pointerX = p.x;
        viewInput.pointerY = p.y;
      }
    }
  };

  const onWheel = (e: WheelEvent) => {
    if (captureActive()) return;
    if (!locked && !onView(target(), e.target)) return;
    if (!gateNow().app) return;
    if (e.ctrlKey || locked) e.preventDefault(); // Ctrl + wheel would zoom the page
    const scale = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 1 : 1 / 100;
    engine.wheel(-e.deltaY * scale);
  };

  const onContextMenu = (e: MouseEvent) => {
    if (locked || (onView(target(), e.target) && gateNow().live)) e.preventDefault();
  };

  // ---- gamepads -----------------------------------------------------------------------------

  const onPadConnected = (e: GamepadEvent) => {
    const pad = e.gamepad;
    const name =
      pad.mapping === 'standard' ? 'GAMEPAD' : shortDeviceName(deviceIdentity(pad.id).name, 28);
    store.getState().pushMessage(`${name.toUpperCase()} CONNECTED`, 'info', 2500);
  };
  const onPadDisconnected = (e: GamepadEvent) => {
    const pad = e.gamepad;
    const name =
      pad.mapping === 'standard' ? 'GAMEPAD' : shortDeviceName(deviceIdentity(pad.id).name, 28);
    store.getState().pushMessage(`${name.toUpperCase()} DISCONNECTED`, 'warn', 2500);
  };

  const rumble = (pads: ArrayLike<PadLike | null>, sim: Sim, dt: number) => {
    const gun = sim.gun as Partial<Sim['gun']> | undefined;
    if (!getBindingsConfig().options.rumble || !gun?.firing) {
      rumbleClock = 0;
      return;
    }
    rumbleClock -= dt;
    if (rumbleClock > 0) return;
    rumbleClock = RUMBLE_PERIOD_S;
    const spin = clamp(gun.spin ?? 1, 0, 1);
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i] as
        (PadLike & { vibrationActuator?: GamepadHapticActuator | null }) | null;
      if (!pad || pad.mapping !== 'standard') continue;
      try {
        pad.vibrationActuator
          ?.playEffect('dual-rumble', {
            duration: 120,
            strongMagnitude: 0.35 + 0.45 * spin,
            weakMagnitude: 0.8 * spin,
          })
          .catch(() => {});
      } catch {
        // no haptics on this pad
      }
    }
  };

  // ---- the frame ----------------------------------------------------------------------------

  const status = (): RuntimeStatus => {
    const gate = gateNow();
    return {
      pointerLocked: locked,
      cursorFree: viewInput.cursorFree,
      mouseStick: gate.live && store.getState().settings.mouseStick,
      live: gate.live,
    };
  };

  const frame = (dt: number, sim: Sim | null): EngineOutput => {
    const state = store.getState();
    const gate = gateNow();
    if (sim !== currentSim) {
      currentSim = sim;
      if (sim) engine.resetLevers(sim.input.throttle);
    }
    const pads = readPads();
    const aircraft = sim?.aircraft as Partial<Sim['aircraft']> | undefined;
    ctx.dt = dt;
    ctx.gate = gate;
    ctx.pads = pads;
    ctx.twoStageTrigger = sim?.options.realism.twoStageTrigger ?? true;
    ctx.mouseStick = state.settings.mouseStick;
    ctx.invertLook = state.settings.invertY;
    ctx.speedBrakePosition = aircraft?.speedBrakeCmd ?? Number.NaN;
    engine.update(ctx, out);

    for (const p of out.presses) {
      const action = appActionForPress(p.id);
      if (action) {
        switch (action.type) {
          case 'view':
            store.getState().setView(action.view);
            break;
          case 'viewWeapon':
            store.getState().setView(weaponView(store.getState().view));
            break;
          case 'viewCycle':
            store.getState().setView(nextView(store.getState().view));
            break;
          case 'pause':
            // keys go through schedulePause (Escape rules); gamepad Start toggles here
            if (p.origin !== 'key') store.getState().setPaused(!store.getState().paused);
            break;
          case 'help':
            store.getState().setHelpOpen(!store.getState().helpOpen);
            break;
          case 'cursorFree':
            viewInput.cursorFree = !viewInput.cursorFree;
            if (viewInput.cursorFree) {
              exitLock();
            } else {
              viewInput.click = null;
              requestLock();
            }
            break;
          case 'centerView':
            centerPulse = true;
            break;
          case 'zoom':
            viewInput.zoomSteps = clamp(viewInput.zoomSteps + action.steps, -20, 20);
            break;
        }
        continue;
      }
      if (!sim) continue;
      const command = commandForPress(p.id, p.long, switchState(sim));
      if (command) pushCommand(sim, command);
    }

    // view input
    viewInput.lookX = out.lookX;
    viewInput.lookY = out.lookY;
    if (gate.live) {
      viewInput.lookDeltaX = clamp(viewInput.lookDeltaX + out.lookDeltaX, -LOOK_LIMIT, LOOK_LIMIT);
      viewInput.lookDeltaY = clamp(viewInput.lookDeltaY + out.lookDeltaY, -LOOK_LIMIT, LOOK_LIMIT);
    } else if (wasLive) {
      viewInput.lookDeltaX = 0;
      viewInput.lookDeltaY = 0;
    }
    viewInput.zoomHeld = out.zoomHeld;
    viewInput.lookAtSpi = out.lookAtSpi;
    viewInput.centerView = centerPulse;
    centerPulse = false;
    if (!viewInput.cursorFree) {
      viewInput.pointerX = 0;
      viewInput.pointerY = 0;
    }
    wasLive = gate.live;

    // the pointer is locked only while flying with the mouse
    if (locked && (!gate.live || viewInput.cursorFree)) exitLock();

    if (sim) {
      writePilotInput(out, sim.input);
      rumble(pads, sim, dt);
      applyTestInputOverride(sim.input);
    }
    options.onFrame?.(out, status());
    return out;
  };

  window.addEventListener('keydown', onKeyDownCapture, { capture: true });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  window.addEventListener('gamepadconnected', onPadConnected);
  window.addEventListener('gamepaddisconnected', onPadDisconnected);

  return {
    engine,
    out,
    frame,
    status,
    detach() {
      window.removeEventListener('keydown', onKeyDownCapture, { capture: true });
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      window.removeEventListener('gamepadconnected', onPadConnected);
      window.removeEventListener('gamepaddisconnected', onPadDisconnected);
      unsubscribeBindings();
      unsubscribeStore();
      exitLock();
      releaseAll();
      viewInput.cursorFree = false;
      viewInput.click = null;
    },
  };
}
