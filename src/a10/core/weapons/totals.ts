/**
 * What hangs on the stations, summed for the flight model (core/flight/mass.ts, aero.ts), with x
 * the body-x position of each station's pylon (A10_GEOMETRY.stations, + right wing):
 *     mass = Σ m,  dragArea = Σ CdA,  lateralMoment = Σ m·x,  rollInertia = Σ m·x²,
 *     dragMoment = Σ CdA·x.
 * A rocket pod weighs its empty mass plus the rockets still in it.
 */
import { A10_GEOMETRY } from '../../data/geometry';
import { STORES } from '../../data/munitions';
import type { StationState, StoresState, StoreType } from './types';

/** Mass of one item on a station, kg (a rocket pod with `rockets` rockets left). */
export function itemMass(type: StoreType, station: StationState): number {
  const d = STORES[type];
  if (!d) return 0;
  if (d.rockets !== undefined && d.rocketMass !== undefined) {
    const left = station.rockets ?? d.rockets;
    return d.mass - (d.rockets - left) * d.rocketMass;
  }
  return d.mass;
}

/** Mass of everything on a station now, kg. */
export function stationMass(station: StationState): number {
  let m = station.rack ? itemMass(station.rack, station) : 0;
  for (const type of station.stores) m += itemMass(type, station);
  return m;
}

/** Recompute mass, drag area and their moments from what hangs on the stations now. */
export function updateStoresTotals(state: StoresState): void {
  let mass = 0;
  let drag = 0;
  let lateral = 0;
  let roll = 0;
  let yaw = 0;
  for (const st of state.stations) {
    let cda = 0;
    if (st.rack) cda += STORES[st.rack]?.dragArea ?? 0;
    for (const type of st.stores) cda += STORES[type]?.dragArea ?? 0;
    const m = stationMass(st);
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
