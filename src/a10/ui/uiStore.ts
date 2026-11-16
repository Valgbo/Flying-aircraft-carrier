/**
 * UI-only state of the A-10 overlay (OWNED BY THE UI MODULE): choices that are not simulation
 * settings and views inside a panel. The app-wide state (screen, pause, settings, messages)
 * stays in state/store.ts; this store never duplicates it.
 *
 * The gun load chosen on the loadout screen is kept here (persisted under `a10-ui-v1`) because
 * SimOptions has no field for it yet; see applyGunLoad() for how it reaches a flight.
 */
import { create } from 'zustand';
import type { AmmoLoad } from '../core/weapons/types';

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

export type PauseView = 'main' | 'controls';

export interface A10UiState {
  /** Gun load for the next flight. */
  gunLoad: AmmoLoad;
  /** Which page of the pause menu is showing. */
  pauseView: PauseView;
  /** Section the settings dialog scrolls to when it opens (its element id), or null. */
  settingsSection: string | null;
  setGunLoad(load: AmmoLoad): void;
  setPauseView(view: PauseView): void;
  setSettingsSection(id: string | null): void;
}

function loadGunLoad(): AmmoLoad {
  try {
    const text = localStorage.getItem(UI_STORAGE_KEY);
    const raw = text ? (JSON.parse(text) as { gunLoad?: unknown }) : null;
    return isAmmoLoad(raw?.gunLoad) ? raw.gunLoad : 'combatMix';
  } catch {
    return 'combatMix';
  }
}

function saveGunLoad(gunLoad: AmmoLoad): void {
  try {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ gunLoad }));
  } catch {
    // storage unavailable (private mode): the choice lasts for this visit
  }
}

export const useA10Ui = create<A10UiState>((set) => ({
  gunLoad: loadGunLoad(),
  pauseView: 'main',
  settingsSection: null,
  setGunLoad: (gunLoad) => {
    set({ gunLoad });
    saveGunLoad(gunLoad);
  },
  setPauseView: (pauseView) => set({ pauseView }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
}));
