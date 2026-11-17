/**
 * DEBRIEF module public API (wave 2, ARCHITECTURE §12.6): the pass-by-pass record of a flight
 * and the weapons-range scores.
 *
 *   recorder.ts  passes (roll-in to pull-off), the impact log, the links of hits and releases
 *   scoring.ts   strafe pit, bombing circle and tactical lane scores
 *   layout.ts    where a range event's targets are
 *   geometry.ts  miss distance, clock direction, heading frames
 *
 * Other systems append `bursts`, `weapons`, `hits` and `kills`; `stepDebrief` (step 12, after
 * every other system) derives the rest. Its per-step work without events is a few comparisons.
 */
import type { Sim } from '../types';
import { createDebriefInternal, recordStep } from './recorder';
import { computeScores, createRangeScores, rangeNumbers } from './scoring';
import type { DebriefState } from './types';

export type * from './types';
export {
  groundDistance,
  headingOfOffset,
  mean,
  median,
  missClock,
  shortOfLine,
  toHeadingFrame,
  type FramePoint,
} from './geometry';
export { emptyLayout, findRangeLayout, rangeEventOf, rangeWind } from './layout';
export { burstOfRound, isIndirect, isRoundWeapon, recordOfBody, ROUND_NAMES } from './recorder';
export {
  burstHits,
  burstRecord,
  burstRounds,
  computeScores,
  directStrikes,
  passRounds,
  rangeNumbers,
  weaponFamily,
} from './scoring';

export function createDebriefState(): DebriefState {
  return {
    bursts: [],
    hits: [],
    weapons: [],
    kills: [],
    range: {},
    passes: [],
    impacts: [],
    hitLinks: [],
    weaponLinks: [],
    scores: createRangeScores(),
    internal: createDebriefInternal(),
  };
}

/** Step 12: take in what the step recorded, then rescore if anything changed. */
export function stepDebrief(sim: Sim, dt: number): void {
  recordStep(sim, dt);
  const d = sim.debrief;
  if (!d.internal.dirty) return;
  d.internal.dirty = false;
  d.scores = computeScores(sim);
  d.range = rangeNumbers(d, d.scores);
}
