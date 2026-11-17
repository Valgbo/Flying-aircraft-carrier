/**
 * The loadout screen's free choice (PLAN_A10.md §6.8: "presets and free choice"): the player
 * picks what hangs on each of the eleven stations, from the loads the weapons module allows
 * there. Every choice is checked with the weapons module's own rules — `stationAccepts` and
 * `stationIssue` for one station, `loadoutIssues` for the whole aircraft (stations 5 and 7 cannot
 * be loaded together with the centreline station 6) — so a custom load is always one the
 * aircraft can carry.
 *
 * The custom load is remembered under 'a10-loadout-v1' (the 'a10-ui-v1' choices keep their
 * format; the store's `loadoutId` is 'custom' while it is the chosen load). A flight carries it
 * from its first step: flightSetup.ts puts it on the sim (SimOptions.customLoadout) until the
 * flow passes it to createSim itself.
 */
import { refreshStores } from '../core/avionics';
import { updateMassProperties } from '../core/flight';
import type { Sim } from '../core/types';
import { loadoutIssues, rearm, stationAccepts, stationIssue, STATION_COUNT } from '../core/weapons';
import type { StoreType } from '../core/weapons/types';
import { STATION_EXCLUSIVE, STORES } from '../data/munitions';
import { stationLabel, storeLabel } from './loadout';

/** The store's loadoutId while the free choice is the chosen load. */
export const CUSTOM_ID = 'custom';
export const CUSTOM_STORAGE_KEY = 'a10-loadout-v1';

/** Station number → what hangs there (rack or launcher first), as createStoresState takes it. */
export type CustomStations = Record<number, StoreType[]>;

/** One way to load a station. */
export interface StationOption {
  /** Stable key of the list ('' = empty). */
  key: string;
  list: StoreType[];
  /** 'LAU-88 · 2 × AGM-65D', 'Empty'. */
  label: string;
}

/** Store types in the order the choices are listed: weapons first, then pods. */
const ORDER: readonly StoreType[] = [
  'AGM-65D',
  'AGM-65H',
  'AGM-65G',
  'AGM-65K',
  'GBU-12',
  'MK-82',
  'MK-82AIR',
  'CBU-97',
  'LAU-131-M151',
  'LAU-131-M156',
  'LAU-68-M151',
  'LAU-68-M156',
  'AIM-9M',
  'AN/AAQ-28',
  'AN/ALQ-184',
];

function orderOf(t: StoreType): number {
  const i = ORDER.indexOf(t);
  return i < 0 ? ORDER.length : i;
}

export function keyOf(list: readonly StoreType[]): string {
  return list.join('+');
}

/**
 * Every load the weapons module allows on `station`, empty first: each store that hangs there
 * alone, and each rack or launcher with one to `capacity` of one store type it carries. Sorted by
 * what is carried (Mavericks, bombs, rockets…), then by count.
 */
export function stationOptions(station: number): StationOption[] {
  const found: { list: StoreType[]; sort: number }[] = [];
  for (const type of Object.keys(STORES) as StoreType[]) {
    if (!stationAccepts(station, type)) continue;
    const data = STORES[type];
    if (data.kind !== 'rack') {
      if (stationIssue(station, [type]) === null)
        found.push({ list: [type], sort: orderOf(type) * 100 });
      continue;
    }
    for (const carried of data.carries ?? []) {
      for (let n = 1; n <= (data.capacity ?? 0); n++) {
        const list: StoreType[] = [type, ...Array<StoreType>(n).fill(carried)];
        if (stationIssue(station, list) !== null) continue;
        // a rack sorts with what it carries, after the store hung alone, then by count
        found.push({ list, sort: orderOf(carried) * 100 + 10 + n + (data.capacity ?? 0) * 0.01 });
      }
    }
  }
  found.sort((a, b) => a.sort - b.sort || keyOf(a.list).localeCompare(keyOf(b.list)));
  const options: StationOption[] = [{ key: '', list: [], label: 'Empty' }];
  for (const f of found) {
    const rack = STORES[f.list[0]].kind === 'rack' ? f.list[0] : null;
    options.push({
      key: keyOf(f.list),
      list: f.list,
      label: stationLabel(rack, rack ? f.list.slice(1) : f.list),
    });
  }
  return options;
}

/** Stations that cannot be loaded while `station` is (STATION_EXCLUSIVE, both ways). */
export function exclusiveWith(station: number): number[] {
  const out: number[] = [];
  for (const [a, b] of STATION_EXCLUSIVE) {
    if (a === station) out.push(b);
    else if (b === station) out.push(a);
  }
  return out;
}

/**
 * The custom load with `station` set to `list` (removed when empty); the stations that cannot be
 * loaded together with it are emptied. Returns the new load and the stations emptied.
 */
export function setStationLoad(
  stations: CustomStations,
  station: number,
  list: readonly StoreType[],
): { stations: CustomStations; cleared: number[] } {
  const next: CustomStations = {};
  for (const [k, v] of Object.entries(stations)) if (v.length > 0) next[Number(k)] = [...v];
  const cleared: number[] = [];
  if (list.length === 0) delete next[station];
  else {
    next[station] = [...list];
    for (const other of exclusiveWith(station)) {
      if ((next[other]?.length ?? 0) > 0) {
        delete next[other];
        cleared.push(other);
      }
    }
  }
  return { stations: next, cleared };
}

/** A copy of a station map without empty stations. */
export function copyStations(stations: Record<number, readonly StoreType[]>): CustomStations {
  const out: CustomStations = {};
  for (const [k, v] of Object.entries(stations)) if (v && v.length > 0) out[Number(k)] = [...v];
  return out;
}

/** A legal custom load from anything (saved data): null when it is not one. */
export function sanitizeCustomStations(raw: unknown): CustomStations | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: CustomStations = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = Number(k);
    if (!Number.isInteger(s) || s < 1 || s > STATION_COUNT) return null;
    if (!Array.isArray(v) || !v.every((t) => typeof t === 'string' && t in STORES)) return null;
    if (v.length > 0) out[s] = [...(v as StoreType[])];
  }
  return loadoutIssues(out).length === 0 ? out : null;
}

/** The saved custom load, or null (nothing saved, not legal, storage unavailable). */
export function loadCustomStations(): CustomStations | null {
  try {
    const text = localStorage.getItem(CUSTOM_STORAGE_KEY);
    return text ? sanitizeCustomStations(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

export function saveCustomStations(stations: CustomStations): void {
  try {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(stations));
  } catch {
    // storage unavailable (private mode): the load lasts for this visit
  }
}

/** What the free choice is called on the menu chip and the loadout screen. */
export const CUSTOM_NAME = 'Custom';

/** One line for the custom choice: '2 × AGM-65D · Targeting pod', or 'Gun only'. */
export function customSummary(stations: CustomStations): string {
  const counts = new Map<string, number>();
  for (const list of Object.values(stations)) {
    const carried = list.length > 0 && STORES[list[0]]?.kind === 'rack' ? list.slice(1) : list;
    for (const t of carried) {
      const family = storeLabel(t).family;
      counts.set(family, (counts.get(family) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return 'Gun only: pick a load for each station';
  return [...counts.entries()].map(([f, n]) => (n > 1 ? `${n} × ${f}` : f)).join(' · ');
}

/**
 * Put a custom load on a flight before its first step: the sim's options name it (a rearm
 * restores it), the stations take it (weapons' rearm refills them from the options; the gun is
 * full at the start anyway), the fire-control computer builds its weapon profiles for it, and
 * the flight model weighs it. Refused (false) for a load the aircraft cannot carry.
 */
export function applyCustomLoadout(sim: Sim, stations: CustomStations): boolean {
  if (loadoutIssues(stations).length > 0) return false;
  sim.options.customLoadout = copyStations(stations);
  rearm(sim);
  refreshStores(sim);
  updateMassProperties(sim);
  return true;
}
