/**
 * Which station a release comes from (PLAN_A10.md §6.8; ARCHITECTURE §12.1 "release order across
 * stations"). The DSMS alternates wings for symmetry; within that, the load is kept balanced:
 *
 *   1. Candidates: the stations that still hold the store (not counting stores already queued
 *      for release, nor — under Master Arm TRAIN — those this run has already "released").
 *   2. Alternate wings: after a release from one wing, the candidates on the other wing, if it
 *      has any (a centreline store counts for neither); otherwise all candidates.
 *   3. Balance: among those, the station whose release leaves the smallest rolling moment
 *      |Σ m·x| of everything still hanging (sim.stores.lateralMoment with the pending releases
 *      taken off). The first release of a flight therefore comes from the heavier wing.
 *   4. Ties (within TIE_MOMENT): the wing opposite the last release, then the lower station.
 *   5. Pairs: the second store of a pulse comes from the best station on the other wing; with
 *      none there, from the best other station; with none at all the pulse is a single.
 *
 * Rocket pods count rockets (StationState.rockets): one rocket leaves per request, the pod stays.
 */
import { A10_GEOMETRY } from '../../data/geometry';
import { STORES } from '../../data/munitions';
import type { Sim } from '../types';
import type { StationState, StoreType } from '../weapons/types';

/** Moments closer than this count as equal (kg·m): about one Hydra rocket 10 cm off-centre. */
const TIE_MOMENT = 1;

/** The store type is a rocket pod (one rocket per release; the pod stays). */
export function isRocketPod(store: string): boolean {
  return STORES[store as StoreType]?.kind === 'rocketPod';
}

/** Mass that leaves the aircraft with one release of `store`, kg. */
export function releasedMass(store: string): number {
  const d = STORES[store as StoreType];
  if (!d) return 0;
  return d.kind === 'rocketPod' ? (d.rocketMass ?? 0) : d.mass;
}

/** Body x of a station's pylon, m (+ right wing). */
export function stationX(station: number): number {
  return A10_GEOMETRY.stations[station]?.x ?? 0;
}

/** −1 left wing, +1 right wing, 0 centreline. */
export function stationSide(station: number): number {
  const x = stationX(station);
  return x < -0.1 ? -1 : x > 0.1 ? 1 : 0;
}

/** Stores of `store` on a station now (rocket pods: rockets left in the pod). */
export function onStation(st: StationState, store: string): number {
  const list = st.stores;
  if (isRocketPod(store)) {
    for (let j = 0; j < list.length; j++) {
      if (list[j] === store) return st.rockets ?? STORES[store as StoreType].rockets ?? 0;
    }
    return 0;
  }
  let n = 0;
  for (let j = 0; j < list.length; j++) if (list[j] === store) n++;
  return n;
}

/** Releases of `store` from `station` waiting in the weapons module's queue. */
export function queuedOn(sim: Sim, station: number, store: string): number {
  const q = sim.stores.releaseQueue;
  let n = 0;
  for (let i = 0; i < q.length; i++) if (q[i].station === station && q[i].store === store) n++;
  return n;
}

/**
 * Stores of `store` still available on a station for a new release: on the station, minus the
 * queued releases, minus `used[station]` (TRAIN accounting of the run; null = none).
 */
export function availableOn(
  sim: Sim,
  st: StationState,
  store: string,
  used: readonly number[] | null,
): number {
  const n = onStation(st, store) - queuedOn(sim, st.station, store) - (used ? used[st.station] : 0);
  return n > 0 ? n : 0;
}

/** Stores (rockets for pods) of a type left on all stations, without pending releases. */
export function storeRemaining(sim: Sim, store: string): number {
  const stations = sim.stores.stations;
  let n = 0;
  for (let i = 0; i < stations.length; i++) n += onStation(stations[i], store);
  return n;
}

/** The rolling moment of the load with the pending releases taken off, kg·m. */
function effectiveMoment(sim: Sim, store: string, used: readonly number[] | null): number {
  let m = sim.stores.lateralMoment;
  const q = sim.stores.releaseQueue;
  for (let i = 0; i < q.length; i++) m -= releasedMass(q[i].store) * stationX(q[i].station);
  if (used) {
    const unit = releasedMass(store);
    for (let s = 1; s < used.length; s++) if (used[s] > 0) m -= used[s] * unit * stationX(s);
  }
  return m;
}

/**
 * The station the next release of `store` comes from (rule above), or 0 when none holds one.
 * `side` restricts the choice to one wing (−1 / +1; 0 any); `exclude` skips one station;
 * `extraMoment` adds the moment of a release decided in the same pulse (pairs).
 */
export function nextStation(
  sim: Sim,
  store: string,
  used: readonly number[] | null,
  lastSide: number,
  side = 0,
  exclude = 0,
  extraMoment = 0,
): number {
  // Alternate wings: the other wing when it has the store.
  if (side === 0 && lastSide !== 0) {
    const other = bestStation(sim, store, used, lastSide, -lastSide, exclude, extraMoment);
    if (other !== 0) return other;
  }
  return bestStation(sim, store, used, lastSide, side, exclude, extraMoment);
}

/** The balance rule (3, 4) among the candidates on `side` (0 = any). */
function bestStation(
  sim: Sim,
  store: string,
  used: readonly number[] | null,
  lastSide: number,
  side: number,
  exclude: number,
  extraMoment: number,
): number {
  const unit = releasedMass(store);
  const moment = effectiveMoment(sim, store, used) - extraMoment;
  const stations = sim.stores.stations;
  let best = 0;
  let bestScore = Infinity;
  let bestSide = 0;
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const s = st.station;
    if (s === exclude) continue;
    const sd = stationSide(s);
    if (side !== 0 && sd !== side) continue;
    if (availableOn(sim, st, store, used) <= 0) continue;
    const score = Math.abs(moment - unit * stationX(s));
    let better = score < bestScore - TIE_MOMENT;
    if (!better && Math.abs(score - bestScore) <= TIE_MOMENT) {
      // A tie: the wing opposite the last release, then the lower station number.
      const prefer = lastSide !== 0 ? -lastSide : -1;
      better = sd === prefer && bestSide !== prefer;
    }
    if (better) {
      best = s;
      bestScore = score;
      bestSide = sd;
    }
  }
  return best;
}

/**
 * The stations of one release pulse: `out[0]` the first (0 = none), `out[1]` the pair's second
 * (0 = a single). Returns the number of stores in the pulse.
 */
export function pulseStations(
  sim: Sim,
  store: string,
  pairs: boolean,
  used: readonly number[] | null,
  lastSide: number,
  out: number[],
): number {
  out[0] = nextStation(sim, store, used, lastSide);
  out[1] = 0;
  if (out[0] === 0) return 0;
  if (!pairs) return 1;
  const first = out[0];
  const extra = releasedMass(store) * stationX(first);
  const other = -stationSide(first);
  let second = 0;
  if (other !== 0) second = nextStation(sim, store, used, stationSide(first), other, first, extra);
  // No partner on the other wing: the best other station; none at all: the pulse is a single
  // (one ejector fires once per pulse).
  if (second === 0) second = nextStation(sim, store, used, stationSide(first), 0, first, extra);
  out[1] = second;
  return second === 0 ? 1 : 2;
}
