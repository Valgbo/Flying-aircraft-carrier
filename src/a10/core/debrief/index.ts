/**
 * DEBRIEF module public API (wave 2): records and scoring.
 * FOUNDATION STAND-IN: state constructor and a no-op step.
 */
import type { Sim } from '../types';
import type { DebriefState } from './types';

export type * from './types';

export function createDebriefState(): DebriefState {
  return { bursts: [], hits: [], weapons: [], kills: [], range: {} };
}

export function stepDebrief(_sim: Sim, _dt: number): void {}
