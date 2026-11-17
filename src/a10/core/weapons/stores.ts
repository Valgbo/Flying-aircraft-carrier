/**
 * Stores on the eleven stations (PLAN_A10.md §6.8): building a loadout, its mass and drag for
 * the flight model, station legality, rearm and jettison. Release of bombs, rockets and missiles
 * is wave 2 (stepStores).
 *
 * The totals the flight model reads (core/flight/mass.ts, aero.ts), with x the body-x position
 * of each station's pylon (A10_GEOMETRY.stations, + right wing):
 *     mass = Σ m,  dragArea = Σ CdA,  lateralMoment = Σ m·x,  rollInertia = Σ m·x²,
 *     dragMoment = Σ CdA·x.
 */
import { A10_GEOMETRY } from '../../data/geometry';
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
import type { StationState, StoresState, StoreType } from './types';

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
    stations.push({ station: s, rack, stores: rack ? list.slice(1) : [...list] });
  }
  const state: StoresState = {
    stations,
    loadoutId,
    mass: 0,
    dragArea: 0,
    lateralMoment: 0,
    rollInertia: 0,
    dragMoment: 0,
  };
  updateStoresTotals(state);
  return state;
}

/** Recompute mass, drag area and their moments from what hangs on the stations now. */
export function updateStoresTotals(state: StoresState): void {
  let mass = 0;
  let drag = 0;
  let lateral = 0;
  let roll = 0;
  let yaw = 0;
  for (const st of state.stations) {
    let m = 0;
    let cda = 0;
    if (st.rack) {
      m += STORES[st.rack]?.mass ?? 0;
      cda += STORES[st.rack]?.dragArea ?? 0;
    }
    for (const type of st.stores) {
      m += STORES[type]?.mass ?? 0;
      cda += STORES[type]?.dragArea ?? 0;
    }
    const x = A10_GEOMETRY.stations[st.station]?.x ?? 0;
    mass += m;
    drag += cda;
    lateral += m * x;
    roll += m * x * x;
    yaw += cda * x;
  }
  state.mass = mass;
  state.dragArea = drag;
  state.lateralMoment = lateral;
  state.rollInertia = roll;
  state.dragMoment = yaw;
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
 * ammunition load and the flight's loadout back on the stations. An open burst ends first.
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
  }
  st.loadoutId = fresh.loadoutId;
  updateStoresTotals(st);
}

/**
 * Jettison what hangs on the given stations, or on all of them: racks and launchers go with
 * their stores; pods and the AIM-9 rails stay. No store bodies yet (wave 2): each jettisoned
 * item emits 'storeReleased' with bodyId 0. Returns the number of stations cleared.
 */
export function jettisonStores(sim: Sim, stations: readonly number[] | 'all'): number {
  const st = sim.stores;
  let cleared = 0;
  for (const station of st.stations) {
    if (stations !== 'all' && !stations.includes(station.station)) continue;
    const first = station.rack ?? station.stores[0];
    if (!first || !STORES[first]?.jettisonable) continue;
    if (station.stores.some((s) => !STORES[s]?.jettisonable)) continue;
    sim.events.push({
      type: 'storeReleased',
      t: sim.time,
      station: station.station,
      store: first,
      bodyId: 0,
    });
    station.rack = null;
    station.stores.length = 0;
    cleared++;
  }
  if (cleared > 0) updateStoresTotals(st);
  return cleared;
}

/** Store release logic (bombs, rockets, missiles): wave 2. */
export function stepStores(_sim: Sim, _dt: number): void {}
