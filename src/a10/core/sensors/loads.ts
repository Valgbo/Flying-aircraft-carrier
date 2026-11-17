/**
 * What is left of each station's load since it was last filled (the air start or a rearm): the
 * weapons module releases a station's first store first and keeps the rest in order, and the
 * aircraft model draws the `i`-th store of a fill on the rack's mount i (triple racks fill left,
 * right, then centre: data/sensors.ts MASK_RACKS, MAVERICK_RAILS). So a store keeps its mount when
 * the ones before it leave: the mask drops the launched missile's body and the next seeker stays
 * where its missile hangs. Allocation-free; run once per step before the pod and the seekers.
 */
import type { Sim } from '../types';
import type { StationState, StoreType } from '../weapons/types';

/** Every store type, for a numeric code of a station's load (index + 1; 0 = nothing). */
const TYPES: readonly StoreType[] = [
  'AGM-65D',
  'AGM-65H',
  'AGM-65G',
  'AGM-65K',
  'MK-82',
  'MK-82AIR',
  'GBU-12',
  'LAU-131-M151',
  'LAU-131-M156',
  'LAU-68-M151',
  'LAU-68-M156',
  'CBU-97',
  'AN/AAQ-28',
  'AN/ALQ-184',
  'AIM-9M',
  'TER-9A',
  'LAU-117',
  'LAU-88',
  'LAU-114',
];

function typeCode(t: StoreType | null | undefined): number {
  return t ? TYPES.indexOf(t) + 1 : 0;
}

/** What hangs on a station as one number: rack, the first store's type and the count. */
function loadCode(st: StationState): number {
  return (typeCode(st.rack) * 32 + typeCode(st.stores[0])) * 64 + Math.min(63, st.stores.length);
}

/**
 * Follow every station: more stores than before, or a different rack or store type, is a new fill
 * (it starts at mount 0); fewer stores of the same kind is a release from the front.
 */
export function syncLoads(sim: Sim): void {
  const internal = sim.sensors.internal;
  const stations = sim.stores.stations;
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const s = st.station;
    if (s <= 0 || s >= internal.loadCount.length) continue;
    const n = st.stores.length;
    const kind = (typeCode(st.rack) * 32 + typeCode(st.stores[0])) * 64;
    const before = internal.loadCode[s];
    const sameKind = before - (before % 64) === kind || n === 0;
    if (n > internal.loadCount[s] || !sameKind) internal.loadInitial[s] = n;
    internal.loadCount[s] = n;
    internal.loadCode[s] = loadCode(st);
  }
}

/** Mount index (in fill order) of the first store still on `station`; 0 before any release. */
export function firstMount(sim: Sim, station: number): number {
  const internal = sim.sensors.internal;
  if (!(station > 0 && station < internal.loadCount.length)) return 0;
  return Math.max(0, internal.loadInitial[station] - internal.loadCount[station]);
}

/** The load code of a station as last synced (the mask compares it to rebuild). */
export function stationLoadCode(sim: Sim, station: number): number {
  const internal = sim.sensors.internal;
  return station > 0 && station < internal.loadCode.length ? internal.loadCode[station] : 0;
}
