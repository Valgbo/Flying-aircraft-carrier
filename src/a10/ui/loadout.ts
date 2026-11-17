/**
 * Loadout screen data (PLAN_A10.md §6.8): presets, what hangs on each of the eleven stations,
 * and the totals. Everything is read through the weapons module's exports — LOADOUTS for the
 * presets and createStoresState() for rack/store split, mass and drag — so the screen shows
 * exactly what a flight will carry, and copes with presets or data that are not there yet.
 * Covered by tests/unit/a10/ui-loadout.test.ts.
 */
import { createStoresState, LOADOUTS } from '../core/weapons';
import type { StoreType, StoresState } from '../core/weapons/types';

export type StoreCategory = 'missile' | 'guided' | 'bomb' | 'rocket' | 'pod' | 'rack' | 'airToAir';

export interface StoreLabel {
  /** Full name, e.g. 'AGM-65D Maverick (infrared)'. */
  name: string;
  /** Short name for summaries, e.g. 'AGM-65D'. */
  short: string;
  /** Family used to group a summary ('AGM-65' for every Maverick). */
  family: string;
  category: StoreCategory;
}

/** Display names. Unknown types fall back to their id (see storeLabel). */
const LABELS: Partial<Record<StoreType, StoreLabel>> = {
  'AGM-65D': {
    name: 'AGM-65D Maverick, infrared',
    short: 'AGM-65D',
    family: 'AGM-65',
    category: 'missile',
  },
  'AGM-65H': {
    name: 'AGM-65H Maverick, television',
    short: 'AGM-65H',
    family: 'AGM-65',
    category: 'missile',
  },
  'AGM-65G': {
    name: 'AGM-65G Maverick, infrared, heavy warhead',
    short: 'AGM-65G',
    family: 'AGM-65',
    category: 'missile',
  },
  'AGM-65K': {
    name: 'AGM-65K Maverick, television, heavy warhead',
    short: 'AGM-65K',
    family: 'AGM-65',
    category: 'missile',
  },
  'MK-82': {
    name: 'Mk-82 500 lb bomb, low drag',
    short: 'Mk-82',
    family: 'Mk-82',
    category: 'bomb',
  },
  'MK-82AIR': {
    name: 'Mk-82 AIR 500 lb bomb, high drag',
    short: 'Mk-82 AIR',
    family: 'Mk-82 AIR',
    category: 'bomb',
  },
  'GBU-12': {
    name: 'GBU-12 Paveway II laser-guided bomb',
    short: 'GBU-12',
    family: 'GBU-12',
    category: 'guided',
  },
  'LAU-131-M151': {
    name: 'LAU-131 pod, 7 × Hydra 70 M151 high explosive',
    short: 'LAU-131 HE',
    family: 'Rocket pod',
    category: 'rocket',
  },
  'LAU-131-M156': {
    name: 'LAU-131 pod, 7 × Hydra 70 M156 white phosphorus (smoke)',
    short: 'LAU-131 WP',
    family: 'Rocket pod',
    category: 'rocket',
  },
  'LAU-68-M151': {
    name: 'LAU-68 pod, 7 × Hydra 70 M151 high explosive',
    short: 'LAU-68 HE',
    family: 'Rocket pod',
    category: 'rocket',
  },
  'LAU-68-M156': {
    name: 'LAU-68 pod, 7 × Hydra 70 M156 white phosphorus (smoke)',
    short: 'LAU-68 WP',
    family: 'Rocket pod',
    category: 'rocket',
  },
  'CBU-97': {
    name: 'CBU-97 sensor-fuzed weapon',
    short: 'CBU-97',
    family: 'CBU-97',
    category: 'bomb',
  },
  'AN/AAQ-28': {
    name: 'AN/AAQ-28 Litening targeting pod',
    short: 'Targeting pod',
    family: 'Targeting pod',
    category: 'pod',
  },
  'AN/ALQ-184': {
    name: 'AN/ALQ-184 jamming pod',
    short: 'ECM pod',
    family: 'ECM pod',
    category: 'pod',
  },
  'AIM-9M': {
    name: 'AIM-9M Sidewinder',
    short: 'AIM-9M',
    family: 'AIM-9M',
    category: 'airToAir',
  },
  'TER-9A': { name: 'TER-9/A triple ejector rack', short: 'TER', family: 'TER', category: 'rack' },
  'LAU-117': {
    name: 'LAU-117 single Maverick launcher',
    short: 'LAU-117',
    family: 'LAU-117',
    category: 'rack',
  },
  'LAU-88': {
    name: 'LAU-88 triple Maverick launcher',
    short: 'LAU-88',
    family: 'LAU-88',
    category: 'rack',
  },
  'LAU-114': {
    name: 'Dual-rail AIM-9 adapter (2 × LAU-114/A)',
    short: 'DRA',
    family: 'DRA',
    category: 'rack',
  },
};

export function storeLabel(type: string): StoreLabel {
  return LABELS[type as StoreType] ?? { name: type, short: type, family: type, category: 'pod' };
}

export function isRack(type: string): boolean {
  return storeLabel(type).category === 'rack';
}

export interface LoadoutPreset {
  id: string;
  name: string;
  stations: Record<number, StoreType[]>;
}

/** Preferred order of the presets the plan names; any others follow alphabetically. */
const PREFERRED = ['tankHunter', 'gunOnly', 'rangeTraining', 'heavyBombs'];

/** All presets the weapons module offers, in display order. */
export function loadoutPresets(
  source: Record<string, { name?: string; stations?: Record<number, StoreType[]> }> = LOADOUTS,
): LoadoutPreset[] {
  const ids = Object.keys(source).filter((id) => source[id] && typeof source[id] === 'object');
  ids.sort((a, b) => {
    const ia = PREFERRED.indexOf(a);
    const ib = PREFERRED.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.localeCompare(b);
  });
  return ids.map((id) => ({
    id,
    name: source[id].name || humanizeId(id),
    stations: source[id].stations ?? {},
  }));
}

/** 'tankHunter' → 'Tank hunter'. */
export function humanizeId(id: string): string {
  const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface StationView {
  station: number;
  rack: string | null;
  stores: string[];
  /** One line: 'LAU-88 · 2 × AGM-65D', or '' for an empty station. */
  label: string;
  /** Mass and drag area of what hangs there (NaN when the weapons data has none). */
  mass: number;
  dragArea: number;
}

/** "2 × AGM-65D, AGM-65H" — consecutive identical stores are counted. */
function countList(types: readonly string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < types.length) {
    let n = 1;
    while (i + n < types.length && types[i + n] === types[i]) n++;
    const short = storeLabel(types[i]).short;
    out.push(n > 1 ? `${n} × ${short}` : short);
    i += n;
  }
  return out.join(', ');
}

export function stationLabel(rack: string | null, stores: readonly string[]): string {
  if (!rack && stores.length === 0) return '';
  const list = countList(stores);
  if (!rack) return list;
  return list ? `${storeLabel(rack).short} · ${list}` : `${storeLabel(rack).short} (empty)`;
}

function storesStateOf(stations: Record<number, StoreType[]>): StoresState | null {
  try {
    return createStoresState('custom', stations);
  } catch {
    return null;
  }
}

/** A number the weapons module filled in, or NaN while it is the stand-in's 0 for a real load. */
function measured(value: number | undefined, loaded: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NaN;
  return loaded && value === 0 ? NaN : value;
}

/** The eleven stations of a preset, with the rack split from the stores. */
export function stationViews(preset: LoadoutPreset): StationView[] {
  const state = storesStateOf(preset.stations);
  const views: StationView[] = [];
  for (let s = 1; s <= 11; s++) {
    const listed = preset.stations[s] ?? [];
    const fromState = state?.stations.find((st) => st.station === s);
    let rack: string | null = fromState?.rack ?? null;
    let stores: string[] = fromState ? [...fromState.stores] : [...listed];
    // the stand-in keeps the rack in the store list: split it here
    if (!rack && stores.length > 0 && isRack(stores[0])) {
      rack = stores[0];
      stores = stores.slice(1);
    }
    // what hangs on this station alone, as the weapons module weighs it
    const one = listed.length > 0 ? storesStateOf({ [s]: listed }) : null;
    const mass = listed.length > 0 ? measured(one?.mass, true) : 0;
    const dragArea = listed.length > 0 ? measured(one?.dragArea, true) : 0;
    views.push({ station: s, rack, stores, label: stationLabel(rack, stores), mass, dragArea });
  }
  return views;
}

export interface LoadoutTotals {
  /** Stores mass, kg (NaN when the weapons data has none yet). */
  mass: number;
  /** Stores drag area, m² (NaN when unknown). */
  dragArea: number;
  /** Number of weapons (racks, launchers and pods not counted). */
  weapons: number;
  /** Number of loaded stations. */
  stations: number;
}

export function loadoutTotals(preset: LoadoutPreset): LoadoutTotals {
  const loaded = Object.values(preset.stations).some((list) => list && list.length > 0);
  const state = storesStateOf(preset.stations);
  let weapons = 0;
  let stations = 0;
  for (const v of stationViews(preset)) {
    if (v.rack || v.stores.length > 0) stations++;
    for (const s of v.stores) if (storeLabel(s).category !== 'pod') weapons++;
  }
  return {
    mass: measured(state?.mass, loaded),
    dragArea: measured(state?.dragArea, loaded),
    weapons,
    stations,
  };
}

/** One line per preset: "4 × AGM-65 · 2 × GBU-12 · Rocket pod · Targeting pod"; none → "No stores". */
export function loadoutSummary(preset: LoadoutPreset): string {
  const counts = new Map<string, number>();
  for (const v of stationViews(preset)) {
    for (const s of v.stores) {
      const family = storeLabel(s).family;
      counts.set(family, (counts.get(family) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return 'No stores';
  return [...counts.entries()].map(([f, n]) => (n > 1 ? `${n} × ${f}` : f)).join(' · ');
}
