/**
 * UI-only state of the A-10 overlay (OWNED BY THE UI MODULE): views inside a panel. The
 * app-wide state (screen, pause, settings, messages, the loadout) stays in state/store.ts;
 * this store never duplicates it.
 *
 * The two choices of the loadout screen live in the app store, which startFlight reads:
 * `store.loadoutId` (the preset) and `store.ammoLoad` (the gun load, SimOptions.ammoLoad). The
 * UI remembers them under `a10-ui-v1` ({ loadoutId, gunLoad }): persistLoadoutChoices()
 * restores them into the store when the app starts and saves every later change, whoever makes
 * it. A saved preset the weapons module no longer offers is ignored. The loadout screen's free
 * choice ('custom', customLoadout.ts) and the weapons-range options (rangeOptions.ts) are
 * remembered under keys of their own ('a10-loadout-v1', 'a10-range-v1'); 'custom' is restored as
 * the preset only while a legal custom load is saved. Both are handed to the app store too
 * (`customLoadout`, `rangeConditions`), from which startFlight passes them to createSim.
 */
import { create } from 'zustand';
import type { AmmoLoad } from '../core/weapons/types';
import { useA10Store } from '../state/store';
import {
  CUSTOM_ID,
  loadCustomStations,
  sanitizeCustomStations,
  saveCustomStations,
  type CustomStations,
} from './customLoadout';
import { loadoutPresets } from './loadout';
import {
  loadRangeOptions,
  saveRangeOptions,
  sanitizeRangeOptions,
  toRangeConditions,
  type RangeOptions,
} from './rangeOptions';

export const UI_STORAGE_KEY = 'a10-ui-v1';

export const GUN_LOADS: readonly { id: AmmoLoad; label: string; hint: string }[] = [
  {
    id: 'combatMix',
    label: 'Combat mix',
    hint: 'Five armour-piercing incendiary to one high-explosive incendiary: the standard load.',
  },
  {
    id: 'allHEI',
    label: 'All HEI',
    hint: 'High-explosive incendiary only. Bursts on contact: trucks and soft targets.',
  },
  {
    id: 'allAPI',
    label: 'All API',
    hint: 'Armour-piercing incendiary only: the most penetration per burst.',
  },
  {
    id: 'targetPractice',
    label: 'Target practice',
    hint: 'Inert practice rounds for the range.',
  },
];

const GUN_LOAD_IDS: readonly string[] = GUN_LOADS.map((g) => g.id);

export function isAmmoLoad(v: unknown): v is AmmoLoad {
  return typeof v === 'string' && GUN_LOAD_IDS.includes(v);
}

export interface LoadoutChoices {
  /** A preset the weapons module offers (LOADOUTS), or null. */
  loadoutId: string | null;
  gunLoad: AmmoLoad | null;
}

/**
 * The saved loadout choices; a field is null when nothing valid is saved for it. `presets` are
 * the preset ids on offer (default: the weapons module's LOADOUTS).
 */
export function loadLoadoutChoices(
  presets: readonly string[] = loadoutPresets().map((p) => p.id),
): LoadoutChoices {
  let raw: { loadoutId?: unknown; gunLoad?: unknown } | null = null;
  try {
    const text = localStorage.getItem(UI_STORAGE_KEY);
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (parsed && typeof parsed === 'object') raw = parsed;
  } catch {
    raw = null;
  }
  const id = raw?.loadoutId;
  return {
    loadoutId: typeof id === 'string' && presets.includes(id) ? id : null,
    gunLoad: isAmmoLoad(raw?.gunLoad) ? raw.gunLoad : null,
  };
}

function saveLoadoutChoices(loadoutId: string, gunLoad: AmmoLoad): void {
  try {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ loadoutId, gunLoad }));
  } catch {
    // storage unavailable (private mode): the choices last for this visit
  }
}

let choicesPersisted = false;

/**
 * Restore the saved preset and gun load into the app store and save every later change.
 * Called once when the overlay module loads (UIRoot), before any flight can start; later calls
 * do nothing.
 */
export function persistLoadoutChoices(): void {
  if (choicesPersisted) return;
  choicesPersisted = true;
  const offered = loadoutPresets().map((p) => p.id);
  if (loadCustomStations()) offered.push(CUSTOM_ID);
  const saved = loadLoadoutChoices(offered);
  const store = useA10Store.getState();
  if (saved.loadoutId && saved.loadoutId !== store.loadoutId) store.setLoadout(saved.loadoutId);
  if (saved.gunLoad && saved.gunLoad !== store.ammoLoad) store.setAmmoLoad(saved.gunLoad);
  // the free choice and the range options the next flight is created with
  const ui = useA10Ui.getState();
  store.setCustomLoadout(sanitizeCustomStations(ui.customStations));
  store.setRangeConditions(toRangeConditions(ui.rangeOptions));
  useA10Store.subscribe((s, prev) => {
    if (s.loadoutId !== prev.loadoutId || s.ammoLoad !== prev.ammoLoad)
      saveLoadoutChoices(s.loadoutId, s.ammoLoad);
  });
}

/** The pause menu's pages: the buttons, the controls reference, the debrief so far. */
export type PauseView = 'main' | 'controls' | 'debrief';

export interface A10UiState {
  /** Which page of the pause menu is showing. */
  pauseView: PauseView;
  /** Section the settings dialog scrolls to when it opens (its element id), or null. */
  settingsSection: string | null;
  /** The weapons-range options dialog of the main menu is open. */
  rangeOptionsOpen: boolean;
  /** Conditions of the next range flight (saved under 'a10-range-v1'). */
  rangeOptions: RangeOptions;
  /** The loadout screen's free choice (saved under 'a10-loadout-v1'; flown when loadoutId is 'custom'). */
  customStations: CustomStations;
  setPauseView(view: PauseView): void;
  setSettingsSection(id: string | null): void;
  setRangeOptionsOpen(open: boolean): void;
  setRangeOptions(patch: Partial<RangeOptions>): void;
  setCustomStations(stations: CustomStations): void;
}

export const useA10Ui = create<A10UiState>((set, get) => ({
  pauseView: 'main',
  settingsSection: null,
  rangeOptionsOpen: false,
  rangeOptions: loadRangeOptions(),
  customStations: loadCustomStations() ?? {},
  setPauseView: (pauseView) => set({ pauseView }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  setRangeOptionsOpen: (rangeOptionsOpen) => set({ rangeOptionsOpen }),
  setRangeOptions: (patch) => {
    const rangeOptions = sanitizeRangeOptions({ ...get().rangeOptions, ...patch });
    saveRangeOptions(rangeOptions);
    set({ rangeOptions });
    useA10Store.getState().setRangeConditions(toRangeConditions(rangeOptions));
  },
  setCustomStations: (customStations) => {
    saveCustomStations(customStations);
    set({ customStations });
    // only a load the aircraft can carry is flown (null: 'custom' flies the gun only)
    useA10Store.getState().setCustomLoadout(sanitizeCustomStations(customStations));
  },
}));
