/**
 * What the overlay sets up on each new flight before its first step: the loadout screen's free
 * choice (customLoadout.ts) and the weapons-range options (rangeOptions.ts).
 *
 * The flow (state/flow.ts beginFlight → runtime.startFlight) creates the sim from the store's
 * loadoutId and scenario only, then bumps `flightNonce`; this module's store subscription runs
 * synchronously inside that bump, while the new sim has not taken a step. A custom load the sim
 * already carries (SimOptions.customLoadout passed to createSim) is left alone, so the hook
 * steps aside once the flow passes the custom load itself. Installed once at start-up (UIRoot
 * module load, also with ?ui=0).
 */
import type { Sim } from '../core/types';
import { getSim } from '../state/runtime';
import { useA10Store } from '../state/store';
import { applyCustomLoadout, CUSTOM_ID, type CustomStations } from './customLoadout';
import { applyRangeOptions, type RangeOptions } from './rangeOptions';
import { useA10Ui } from './uiStore';

/** Set up a flight that has not stepped yet. Returns what was applied (tests, the debrief). */
export function setUpFlight(
  sim: Sim,
  loadoutId: string,
  custom: CustomStations,
  range: RangeOptions,
): { custom: boolean; range: boolean } {
  const out = { custom: false, range: false };
  if (sim.stepCount > 0) return out;
  if (loadoutId === CUSTOM_ID && !sim.options.customLoadout)
    out.custom = applyCustomLoadout(sim, custom);
  out.range = applyRangeOptions(sim, range);
  return out;
}

let installed = false;

/** Subscribe to the store's flight counter (once): every new flight is set up before it steps. */
export function installFlightSetup(): void {
  if (installed) return;
  installed = true;
  useA10Store.subscribe((s, prev) => {
    if (s.flightNonce === prev.flightNonce) return;
    const sim = getSim();
    if (!sim) return;
    const ui = useA10Ui.getState();
    try {
      setUpFlight(sim, s.loadoutId, ui.customStations, ui.rangeOptions);
    } catch (err) {
      // a fault here must not stop the flight from starting: it flies with the flow's set-up
      console.warn('[a10 ui] the flight set-up failed:', err);
    }
  });
}
