/**
 * The A-10 app's UI store (Zustand). FOUNDATION-OWNED; see docs/a10/ARCHITECTURE.md §7.
 * The live simulation is NOT in here (it lives in state/runtime.ts and is read per frame); the
 * store holds what React needs: screen, pause, settings, a 10 Hz telemetry snapshot, messages.
 */
import { create } from 'zustand';
import type { RealismPreset, ScenarioKind } from '../core/types';
import type { AmmoLoad } from '../core/weapons/types';

export type A10Screen = 'menu' | 'loadout' | 'loading' | 'flight' | 'debrief' | 'credits';
export type QualityLevel = 'low' | 'medium' | 'high';
export type ViewMode = 'cockpit' | 'chase' | 'flyby' | 'orbit' | 'weapon' | 'target';

export interface A10Settings {
  quality: QualityLevel;
  adaptiveQuality: boolean;
  /** Master volume 0..1. */
  volume: number;
  muted: boolean;
  realism: RealismPreset;
  invertY: boolean;
  /** The mouse flies the stick (otherwise it looks around). */
  mouseStick: boolean;
  /** Cockpit vertical field of view, degrees. */
  fov: number;
  /** Local time of day, hours. */
  timeOfDay: number;
  /** Show the next-step checklist strip. */
  checklist: boolean;
  showFps: boolean;
  /** Seed of the generated world. */
  worldSeed: number;
}

export const DEFAULT_SETTINGS: A10Settings = {
  quality: 'medium',
  adaptiveQuality: true,
  volume: 0.8,
  muted: false,
  realism: 'authentic',
  invertY: false,
  mouseStick: false,
  fov: 62,
  timeOfDay: 10.5,
  checklist: true,
  showFps: false,
  worldSeed: 1977,
};

const SETTINGS_KEY = 'a10-settings-v1';

/** Validate stored settings field by field; anything wrong falls back to its default. */
export function sanitizeSettings(raw: unknown): A10Settings {
  const s: A10Settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  const num = (k: keyof A10Settings, min: number, max: number) => {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max)
      (s as unknown as Record<string, unknown>)[k] = v;
  };
  const bool = (k: keyof A10Settings) => {
    if (typeof r[k] === 'boolean') (s as unknown as Record<string, unknown>)[k] = r[k];
  };
  const oneOf = (k: keyof A10Settings, options: readonly string[]) => {
    if (typeof r[k] === 'string' && options.includes(r[k] as string))
      (s as unknown as Record<string, unknown>)[k] = r[k];
  };
  oneOf('quality', ['low', 'medium', 'high']);
  bool('adaptiveQuality');
  num('volume', 0, 1);
  bool('muted');
  oneOf('realism', ['authentic', 'standard', 'relaxed']);
  bool('invertY');
  bool('mouseStick');
  num('fov', 30, 100);
  num('timeOfDay', 0, 24);
  bool('checklist');
  bool('showFps');
  num('worldSeed', 0, 2 ** 31);
  return s;
}

function loadSettings(): A10Settings {
  try {
    const text = localStorage.getItem(SETTINGS_KEY);
    return sanitizeSettings(text ? JSON.parse(text) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Settings fields overridden for this visit by URL flags: shown and used, never saved. */
const overridden = new Set<keyof A10Settings>();

function saveSettings(s: A10Settings): void {
  try {
    const stored = loadSettings();
    const out: Record<string, unknown> = { ...s };
    for (const k of overridden) out[k] = stored[k];
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
  } catch {
    // Storage unavailable (private mode): settings live for this visit only.
  }
}

/** A ≈10 Hz snapshot of the simulation in display units, for React UI and tests. */
export interface Telemetry {
  time: number;
  /** Indicated airspeed, knots. */
  ias: number;
  /** Altitude above sea level, feet. */
  altitude: number;
  /** Radar altitude, feet. */
  agl: number;
  /** Heading, degrees 0..360. */
  heading: number;
  /** Vertical speed, feet per minute. */
  vs: number;
  g: number;
  mach: number;
  /** Angle of attack, degrees. */
  aoa: number;
  throttle: number;
  rounds: number;
  masterArm: string;
  gunPac: string;
  masterMode: string;
  crashed: boolean;
  vehiclesAlive: number;
  vehiclesKilled: number;
}

export const EMPTY_TELEMETRY: Telemetry = {
  time: 0,
  ias: 0,
  altitude: 0,
  agl: 0,
  heading: 0,
  vs: 0,
  g: 1,
  mach: 0,
  aoa: 0,
  throttle: 0,
  rounds: 0,
  masterArm: 'SAFE',
  gunPac: 'SAFE',
  masterMode: 'NAV',
  crashed: false,
  vehiclesAlive: 0,
  vehiclesKilled: 0,
};

export interface UiMessage {
  id: number;
  text: string;
  level: 'info' | 'warn' | 'alert';
  until: number;
}

export interface A10Store {
  screen: A10Screen;
  paused: boolean;
  settings: A10Settings;
  telemetry: Telemetry;
  view: ViewMode;
  scenario: ScenarioKind;
  loadoutId: string;
  /** The gun's ammunition load for the next flight (the loadout screen sets it). */
  ammoLoad: AmmoLoad;
  /** Bumped on every (re)start of a flight; components key on it. */
  flightNonce: number;
  loading: { progress: number; label: string };
  messages: UiMessage[];
  /** UI panels. */
  settingsOpen: boolean;
  helpOpen: boolean;

  setScreen(screen: A10Screen): void;
  setPaused(paused: boolean): void;
  togglePause(): void;
  updateSettings(patch: Partial<A10Settings>): void;
  /** Apply a per-visit override (URL flag): used now, not saved, until the player changes it. */
  overrideSettings(patch: Partial<A10Settings>): void;
  setTelemetry(t: Telemetry): void;
  setView(view: ViewMode): void;
  setScenario(scenario: ScenarioKind): void;
  setLoadout(id: string): void;
  setAmmoLoad(load: AmmoLoad): void;
  bumpFlight(): void;
  setLoading(progress: number, label: string): void;
  pushMessage(text: string, level?: UiMessage['level'], ttlMs?: number): void;
  setSettingsOpen(open: boolean): void;
  setHelpOpen(open: boolean): void;
}

let messageId = 1;

export const useA10Store = create<A10Store>((set, get) => ({
  screen: 'menu',
  paused: false,
  settings: loadSettings(),
  telemetry: EMPTY_TELEMETRY,
  view: 'cockpit',
  scenario: 'freeHunt',
  loadoutId: 'tankHunter',
  ammoLoad: 'combatMix',
  flightNonce: 0,
  loading: { progress: 0, label: '' },
  messages: [],
  settingsOpen: false,
  helpOpen: false,

  setScreen: (screen) => set({ screen, paused: false }),
  setPaused: (paused) => set({ paused }),
  togglePause: () => set({ paused: !get().paused }),
  updateSettings: (patch) => {
    for (const k of Object.keys(patch) as (keyof A10Settings)[]) overridden.delete(k);
    const settings = sanitizeSettings({ ...get().settings, ...patch });
    set({ settings });
    saveSettings(settings);
  },
  overrideSettings: (patch) => {
    for (const k of Object.keys(patch) as (keyof A10Settings)[]) overridden.add(k);
    set({ settings: sanitizeSettings({ ...get().settings, ...patch }) });
  },
  setTelemetry: (telemetry) => set({ telemetry }),
  setView: (view) => set({ view }),
  setScenario: (scenario) => set({ scenario }),
  setLoadout: (loadoutId) => set({ loadoutId }),
  setAmmoLoad: (ammoLoad) => set({ ammoLoad }),
  bumpFlight: () => set({ flightNonce: get().flightNonce + 1 }),
  setLoading: (progress, label) => set({ loading: { progress, label } }),
  pushMessage: (text, level = 'info', ttlMs = 3500) => {
    const now = performance.now();
    const messages = get()
      .messages.filter((m) => m.until > now)
      .concat({ id: messageId++, text, level, until: now + ttlMs });
    set({ messages: messages.slice(-5) });
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
}));
