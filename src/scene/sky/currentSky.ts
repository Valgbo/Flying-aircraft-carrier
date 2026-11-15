/**
 * The sky state for the time of day that is set right now — one shared, cached evaluation of
 * the time-of-day model, so the world (dome, lights, fog) and the cloud layer always agree and
 * the model only runs when the setting actually changes.
 */
import { computeSkyState, createSkyState, type SkyState } from './timeOfDay';

const current = createSkyState();
let currentHours = Number.NaN;

/** Sky state for `hours` (0..24). The returned object is shared and reused: read it, do not keep or modify it. */
export function getSkyState(hours: number): SkyState {
  if (hours !== currentHours) {
    currentHours = hours;
    computeSkyState(hours, current);
  }
  return current;
}
