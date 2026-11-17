/**
 * Stores on the eleven stations (PLAN_A10.md §6.8): building a loadout, its mass and drag for
 * the flight model (totals.ts), station legality, rearm, jettison, and the release queue
 * (stepStores, ARCHITECTURE §12.1: avionics decides, this module executes — release.ts).
 */
import { GAU8 } from '../../data/gun';
import {
  LOADOUT_PRESETS,
  STATION_EXCLUSIVE,
  STATION_STORES,
  STORES,
  type LoadoutPreset,
} from '../../data/munitions';
import type { Sim } from '../types';
import { endBurst } from './gun';
import { executeRelease, jettisonStation } from './release';
import { registerStoreModels, syncModelAtmosphere } from './storeModels';
import { updateStoresTotals } from './totals';
import type { StationState, StoresState, StoreType } from './types';

export { updateStoresTotals } from './totals';

/** Loadout presets: station → stores (rack/launcher first). See data/munitions.ts. */
export const LOADOUTS: Record<string, LoadoutPreset> = LOADOUT_PRESETS;

export const STATION_COUNT = 11;

/** A rack or launcher (something that carries other stores). */
export function isRackType(type: string): boolean {
  return STORES[type as StoreType]?.kind === 'rack';
}

/**
 * The stores state for a preset id or a custom station map (rack first in each list). Whatever
 * is listed is loaded — check a free choice with loadoutIssues() first.
 */
export function createStoresState(
  loadoutId: string,
  custom?: Record<number, StoreType[]>,
): StoresState {
  const preset = custom ?? LOADOUTS[loadoutId]?.stations ?? {};
  const stations: StationState[] = [];
  for (let s = 1; s <= STATION_COUNT; s++) {
    const list = preset[s] ?? [];
    const rack = list.length > 0 && isRackType(list[0]) ? list[0] : null;
    const stores = rack ? list.slice(1) : [...list];
    const station: StationState = { station: s, rack, stores };
    // Rocket pods hang loaded: their rockets are counted down as they are fired (wave 2).
    const pod = stores.find((t) => STORES[t]?.rockets !== undefined);
    if (pod) station.rockets = STORES[pod].rockets;
    stations.push(station);
  }
  const state: StoresState = {
    stations,
    loadoutId,
    mass: 0,
    dragArea: 0,
    lateralMoment: 0,
    rollInertia: 0,
    dragMoment: 0,
    releaseQueue: [],
  };
  updateStoresTotals(state);
  // The fire-control computer has the stores' models before the first step (they are
  // registered at module load unless an import cycle delayed it; a test's own model is kept).
  registerStoreModels(false);
  return state;
}

/** Can `type` hang directly on `station` (as a rack/launcher or a single store)? */
export function stationAccepts(station: number, type: StoreType): boolean {
  return (STATION_STORES[station] ?? []).includes(type);
}

/** Why a station list (rack first) is not a legal load on `station`; null when it is. */
export function stationIssue(station: number, list: readonly StoreType[]): string | null {
  if (list.length === 0) return null;
  const first = list[0];
  if (!STORES[first]) return `unknown store ${first}`;
  if (!stationAccepts(station, first)) return `${first} cannot hang on station ${station}`;
  const data = STORES[first];
  if (data.kind !== 'rack') {
    return list.length > 1 ? `${first} carries nothing (station ${station})` : null;
  }
  const carried = list.slice(1);
  if (carried.length > (data.capacity ?? 0)) {
    return `${first} carries at most ${data.capacity} (station ${station})`;
  }
  for (const s of carried) {
    if (!data.carries?.includes(s)) return `${first} cannot carry ${s} (station ${station})`;
  }
  return null;
}

/** Every reason a station map is not a legal A-10 load (empty when it is). */
export function loadoutIssues(stations: Record<number, readonly StoreType[]>): string[] {
  const issues: string[] = [];
  for (const key of Object.keys(stations)) {
    const s = Number(key);
    if (!(s >= 1 && s <= STATION_COUNT) || Math.floor(s) !== s) issues.push(`no station ${key}`);
  }
  for (let s = 1; s <= STATION_COUNT; s++) {
    const issue = stationIssue(s, stations[s] ?? []);
    if (issue) issues.push(issue);
  }
  for (const [a, b] of STATION_EXCLUSIVE) {
    if ((stations[a]?.length ?? 0) > 0 && (stations[b]?.length ?? 0) > 0) {
      issues.push(`stations ${a} and ${b} cannot both be loaded`);
    }
  }
  return issues;
}

/**
 * Rearm (and reload) on the ground or from the pause menu: a full drum of the flight's
 * ammunition load and the flight's loadout back on the stations (rocket pods full again). An
 * open burst ends first; releases still queued are dropped. Stores already in flight fly on.
 */
export function rearm(sim: Sim): void {
  const gun = sim.gun;
  endBurst(sim, sim.time);
  gun.commanded = false;
  gun.commandTime = -1;
  gun.rounds = GAU8.typicalLoad;
  gun.roundsLoaded = GAU8.typicalLoad;
  gun.beltIndex = 0;
  const opts = sim.options;
  const fresh = createStoresState(opts.loadoutId, opts.customLoadout);
  const st = sim.stores;
  for (let i = 0; i < st.stations.length && i < fresh.stations.length; i++) {
    const to = st.stations[i];
    const from = fresh.stations[i];
    to.rack = from.rack;
    to.stores.length = 0;
    for (const s of from.stores) to.stores.push(s);
    if (from.rockets !== undefined) to.rockets = from.rockets;
    else delete to.rockets;
  }
  // Releases still waiting belong to the old load.
  st.releaseQueue.length = 0;
  st.loadoutId = fresh.loadoutId;
  updateStoresTotals(st);
}

/**
 * Jettison what hangs on the given stations, or on all of them, now: each station's rack or
 * launcher leaves with its stores (one body per station, release.ts jettisonStation), never
 * armed; pods and the AIM-9 rails stay. Each emits 'storeReleased' with its body id. Returns the
 * number of stations cleared.
 */
export function jettisonStores(sim: Sim, stations: readonly number[] | 'all'): number {
  const st = sim.stores;
  let cleared = 0;
  for (const station of st.stations) {
    if (stations !== 'all' && !stations.includes(station.station)) continue;
    // From the present state (f = 1 of the last flight step).
    cleared += jettisonStation(sim, station, sim.time, 1, 0);
  }
  if (cleared > 0) updateStoresTotals(st);
  return cleared;
}

/**
 * Releases (ARCHITECTURE §12.1), step 5: every request in `stores.releaseQueue` whose time falls
 * before the end of this step is executed at its exact time (an overdue one at the step start),
 * earliest first, and removed; later ones wait. The registered models' atmosphere follows the
 * world's.
 */
export function stepStores(sim: Sim, dt: number): void {
  syncModelAtmosphere(sim.world.isaDeviation);
  const queue = sim.stores.releaseQueue;
  if (queue.length === 0) return;
  const t0 = sim.time;
  const t1 = t0 + dt;
  for (;;) {
    let k = -1;
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].time < t1 && (k < 0 || queue[i].time < queue[k].time)) k = i;
    }
    if (k < 0) return;
    const req = queue[k];
    for (let i = k; i < queue.length - 1; i++) queue[i] = queue[i + 1];
    queue.length--;
    executeRelease(sim, req, t0, dt);
  }
}
