/**
 * Game store (Zustand): everything React UI needs to render — current screen, settings,
 * panel flags, the low-rate telemetry snapshot, flight-ops score and toast messages.
 *
 * High-frequency simulation state is NOT here; it lives in the mutable `sim` singleton.
 * Outside React use `useGameStore.getState()` / `useGameStore.setState()` / `.subscribe()`.
 */
import { create } from 'zustand';
import { createJSONStorage, persist, subscribeWithSelector } from 'zustand/middleware';
import type { HotspotId } from '../config/layout';
import { DEFAULT_KEY_BINDINGS, type BindingId, type KeyBindings } from './bindings';
import { HOVER_THROTTLE } from '../config/physicsConfig';
import { QUALITY_ORDER } from '../config/quality';
import { clamp } from '../utils/math';
import { resetSimForScreen } from './sim';
import { buildTelemetry } from './telemetrySnapshot';
import type {
  CameraMode,
  GameMessage,
  MessageLevel,
  OpsState,
  QualityLevel,
  Screen,
  Telemetry,
  TouchControlsSetting,
  TurbineIndex,
} from './types';

export interface Settings {
  quality: QualityLevel;
  /** Automatically drop to a lower preset when the frame rate stays low. */
  adaptiveQuality: boolean;
  masterVolume: number;
  engineVolume: number;
  effectsVolume: number;
  muted: boolean;
  /** Invert the vertical axis of stick-style tilt and camera look inputs. */
  invertY: boolean;
  cameraShake: boolean;
  /** Time of day in hours, 0..24. */
  timeOfDay: number;
  touchControls: TouchControlsSetting;
  showFps: boolean;
  keyBindings: KeyBindings;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'medium',
  adaptiveQuality: true,
  masterVolume: 0.8,
  engineVolume: 0.8,
  effectsVolume: 0.8,
  muted: false,
  invertY: false,
  cameraShake: true,
  timeOfDay: 16.5,
  touchControls: 'auto',
  showFps: false,
  keyBindings: { ...DEFAULT_KEY_BINDINGS },
};

const TOUCH_CONTROLS: readonly TouchControlsSetting[] = ['auto', 'on', 'off'];

/**
 * Settings read back from storage, field by field: whatever is missing, of the wrong type or
 * no longer a known option falls back to its default, so stale or damaged data cannot reach
 * the scene, the audio or the key handling.
 */
export function sanitizeSettings(stored: unknown): Settings {
  const raw: Record<string, unknown> =
    typeof stored === 'object' && stored !== null ? { ...stored } : {};
  const d = DEFAULT_SETTINGS;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const num = (v: unknown, fallback: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, max) : fallback;
  const option = <T extends string>(v: unknown, options: readonly T[], fallback: T) =>
    options.find((o) => o === v) ?? fallback;

  const keyBindings = { ...DEFAULT_KEY_BINDINGS };
  if (typeof raw.keyBindings === 'object' && raw.keyBindings !== null) {
    const codes: Record<string, unknown> = { ...raw.keyBindings };
    for (const id of Object.keys(DEFAULT_KEY_BINDINGS) as BindingId[]) {
      const code = codes[id];
      if (typeof code === 'string' && code !== '') keyBindings[id] = code;
    }
  }

  return {
    quality: option(raw.quality, QUALITY_ORDER, d.quality),
    adaptiveQuality: bool(raw.adaptiveQuality, d.adaptiveQuality),
    masterVolume: num(raw.masterVolume, d.masterVolume, 1),
    engineVolume: num(raw.engineVolume, d.engineVolume, 1),
    effectsVolume: num(raw.effectsVolume, d.effectsVolume, 1),
    muted: bool(raw.muted, d.muted),
    invertY: bool(raw.invertY, d.invertY),
    cameraShake: bool(raw.cameraShake, d.cameraShake),
    timeOfDay: num(raw.timeOfDay, d.timeOfDay, 24),
    touchControls: option(raw.touchControls, TOUCH_CONTROLS, d.touchControls),
    showFps: bool(raw.showFps, d.showFps),
    keyBindings,
  };
}

/**
 * Settings a URL debug flag overrides for this session, each with the value it had before.
 * That earlier value is the one kept in storage; the override ends as soon as the player
 * changes the setting in the app (see `overrideSettings`).
 */
const overridden: Partial<Settings> = {};

function endOverrides(keys: readonly string[]): void {
  for (const key of keys) delete overridden[key as keyof Settings];
}

export interface HangarState {
  selectedHotspot: HotspotId | null;
  /** Demo throttle 0..1 applied to all turbines in the hangar scene. */
  demoThrottle: number;
  /** Demo tilt in degrees applied to all turbines in the hangar scene. */
  demoTiltDeg: number;
}

/** Cameras the C key cycles through while flying. */
export const CAMERA_CYCLE: readonly CameraMode[] = ['chase', 'orbit', 'deck', 'bridge', 'turbine'];

export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: 'Chase',
  orbit: 'Orbit',
  deck: 'Flight deck',
  bridge: 'Bridge',
  turbine: 'Turbine',
};

export function isFlyingScreen(screen: Screen): boolean {
  return screen === 'flight' || screen === 'ops';
}

function initialTelemetry(): Telemetry {
  return {
    time: 0,
    altitude: 0,
    keelClearance: 0,
    speedKts: 0,
    forwardSpeedKts: 0,
    verticalSpeed: 0,
    headingDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    gLoad: 1,
    afloat: false,
    throttle: [0, 0, 0, 0],
    throttleCmd: [0, 0, 0, 0],
    tiltDeg: [0, 0, 0, 0],
    tiltCmdDeg: [0, 0, 0, 0],
    thrustKN: [0, 0, 0, 0],
    enabled: [true, true, true, true],
    targetAltitude: 0,
  };
}

export function initialOps(): OpsState {
  return {
    score: 0,
    launches: 0,
    recoveries: 0,
    waveOffs: 0,
    status: '',
    deckStability: 1,
    lastRecovery: null,
    jets: [],
  };
}

function initialHangar(): HangarState {
  return { selectedHotspot: null, demoThrottle: HOVER_THROTTLE, demoTiltDeg: 0 };
}

export interface GameState {
  screen: Screen;
  paused: boolean;
  settingsOpen: boolean;
  turbinePanelOpen: boolean;
  helpOpen: boolean;
  cameraMode: CameraMode;
  /** Which turbine the 'turbine' camera frames. */
  cameraTurbine: TurbineIndex;
  /** Flight assist (stability + altitude hold). On by default. */
  assistEnabled: boolean;
  /** Bumped whenever the sim is reset (screen change or restart). Drivers key on it. */
  resetNonce: number;
  /** Preset actually in use (the chosen preset, possibly lowered by adaptive quality). */
  effectiveQuality: QualityLevel;
  /** True once the 3D scene has drawn its first frame. */
  sceneReady: boolean;
  /** True while the flight-physics chunk is being fetched / initialised. */
  physicsLoading: boolean;
  settings: Settings;
  telemetry: Telemetry;
  hangar: HangarState;
  ops: OpsState;
  messages: GameMessage[];

  /** Switch screen. Resets the sim to that screen's starting state and closes panels. */
  setScreen: (screen: Screen) => void;
  setPaused: (paused: boolean) => void;
  togglePause: () => void;
  setSettingsOpen: (open: boolean) => void;
  setTurbinePanelOpen: (open: boolean) => void;
  toggleTurbinePanel: () => void;
  setHelpOpen: (open: boolean) => void;
  setCameraMode: (mode: CameraMode) => void;
  setCameraTurbine: (index: TurbineIndex) => void;
  cycleCamera: () => void;
  setAssistEnabled: (enabled: boolean) => void;
  toggleAssist: () => void;
  /** Restart the current screen from its initial conditions. */
  resetFlight: () => void;
  updateSettings: (patch: Partial<Settings>) => void;
  setKeyBinding: (id: BindingId, code: string) => void;
  resetKeyBindings: () => void;
  resetSettings: () => void;
  setEffectiveQuality: (quality: QualityLevel) => void;
  setSceneReady: (ready: boolean) => void;
  setPhysicsLoading: (loading: boolean) => void;
  setTelemetry: (telemetry: Telemetry) => void;
  setHangar: (patch: Partial<HangarState>) => void;
  setOps: (patch: Partial<OpsState>) => void;
  pushMessage: (text: string, level?: MessageLevel, ttlMs?: number) => void;
  dismissMessage: (id: number) => void;
  /** Drop expired messages. `now` is a performance.now() timestamp. */
  pruneMessages: (now: number) => void;
}

let messageId = 0;

const hasLocalStorage = (() => {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
})();

const memoryStorage = (() => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
})();

export const useGameStore = create<GameState>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        screen: 'menu',
        paused: false,
        settingsOpen: false,
        turbinePanelOpen: false,
        helpOpen: false,
        cameraMode: 'orbit',
        cameraTurbine: 1,
        assistEnabled: true,
        resetNonce: 0,
        effectiveQuality: DEFAULT_SETTINGS.quality,
        sceneReady: false,
        physicsLoading: false,
        settings: DEFAULT_SETTINGS,
        telemetry: initialTelemetry(),
        hangar: initialHangar(),
        ops: initialOps(),
        messages: [],

        setScreen: (screen) => {
          const prev = get().screen;
          if (prev === screen) return;
          const stayIdle = !isFlyingScreen(prev) && !isFlyingScreen(screen);
          if (!stayIdle) resetSimForScreen(screen);
          set((s) => ({
            screen,
            paused: false,
            turbinePanelOpen: false,
            helpOpen: false,
            cameraMode: isFlyingScreen(screen) ? 'chase' : 'orbit',
            assistEnabled: true,
            resetNonce: stayIdle ? s.resetNonce : s.resetNonce + 1,
            ops: initialOps(),
            hangar: initialHangar(),
            messages: [],
            // the instruments show the new starting state at once, not the last scene's values
            telemetry: stayIdle ? s.telemetry : buildTelemetry(),
          }));
        },

        setPaused: (paused) => set({ paused }),
        togglePause: () => set((s) => ({ paused: !s.paused })),
        setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
        setTurbinePanelOpen: (turbinePanelOpen) => set({ turbinePanelOpen }),
        toggleTurbinePanel: () => set((s) => ({ turbinePanelOpen: !s.turbinePanelOpen })),
        setHelpOpen: (helpOpen) => set({ helpOpen }),

        setCameraMode: (cameraMode) => set({ cameraMode }),
        setCameraTurbine: (cameraTurbine) => set({ cameraTurbine }),
        cycleCamera: () => {
          const { cameraMode, screen } = get();
          if (!isFlyingScreen(screen)) return;
          const i = CAMERA_CYCLE.indexOf(cameraMode);
          set({ cameraMode: CAMERA_CYCLE[(i + 1) % CAMERA_CYCLE.length] });
        },

        setAssistEnabled: (assistEnabled) => set({ assistEnabled }),
        toggleAssist: () => set((s) => ({ assistEnabled: !s.assistEnabled })),

        resetFlight: () => {
          resetSimForScreen(get().screen);
          set((s) => ({
            paused: false,
            assistEnabled: true,
            resetNonce: s.resetNonce + 1,
            ops: initialOps(),
            messages: [],
            telemetry: buildTelemetry(),
          }));
        },

        updateSettings: (patch) => {
          endOverrides(Object.keys(patch));
          set((s) => ({
            settings: { ...s.settings, ...patch },
            effectiveQuality: patch.quality ?? s.effectiveQuality,
          }));
        },
        setKeyBinding: (id, code) =>
          set((s) => ({
            settings: { ...s.settings, keyBindings: { ...s.settings.keyBindings, [id]: code } },
          })),
        resetKeyBindings: () =>
          set((s) => ({ settings: { ...s.settings, keyBindings: { ...DEFAULT_KEY_BINDINGS } } })),
        resetSettings: () => {
          endOverrides(Object.keys(overridden));
          set({
            settings: { ...DEFAULT_SETTINGS, keyBindings: { ...DEFAULT_KEY_BINDINGS } },
            effectiveQuality: DEFAULT_SETTINGS.quality,
          });
        },
        setEffectiveQuality: (effectiveQuality) => set({ effectiveQuality }),
        setSceneReady: (sceneReady) => set({ sceneReady }),
        setPhysicsLoading: (physicsLoading) => set({ physicsLoading }),
        setTelemetry: (telemetry) => set({ telemetry }),
        setHangar: (patch) => set((s) => ({ hangar: { ...s.hangar, ...patch } })),
        setOps: (patch) => set((s) => ({ ops: { ...s.ops, ...patch } })),

        pushMessage: (text, level = 'info', ttlMs = 3500) =>
          set((s) => {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const next: GameMessage = { id: ++messageId, text, level, expiresAt: now + ttlMs };
            // keep the list short and avoid stacking identical messages
            const kept = s.messages.filter((m) => m.text !== text).slice(-3);
            return { messages: [...kept, next] };
          }),
        dismissMessage: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
        pruneMessages: (now) =>
          set((s) => {
            const kept = s.messages.filter((m) => m.expiresAt > now);
            return kept.length === s.messages.length ? s : { messages: kept };
          }),
      }),
      {
        name: 'fac-settings-v1',
        version: 1,
        storage: createJSONStorage(() => (hasLocalStorage ? localStorage : memoryStorage)),
        partialize: (s) => ({ settings: { ...s.settings, ...overridden } }),
        // data written by another version of the app is read like any other: field by field
        migrate: (persisted) => persisted,
        merge: (persisted, current) => {
          const stored = (persisted as { settings?: unknown } | null | undefined)?.settings;
          if (stored === undefined) return current;
          const settings = sanitizeSettings(stored);
          return { ...current, settings, effectiveQuality: settings.quality };
        },
      },
    ),
  ),
);

/**
 * Apply settings for this session only (URL debug flags). Storage keeps the values the player
 * chose; a later change of the same setting in the app is saved as usual.
 */
export function overrideSettings(patch: Partial<Settings>): void {
  const { settings, effectiveQuality } = useGameStore.getState();
  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    if (!(key in overridden)) Object.assign(overridden, { [key]: settings[key] });
  }
  useGameStore.setState({
    settings: { ...settings, ...patch },
    effectiveQuality: patch.quality ?? effectiveQuality,
  });
}
