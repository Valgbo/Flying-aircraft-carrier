/**
 * Where the vehicle and effects views read the simulation from: the live flight
 * (`state/runtime.getSim`) by default. Sandboxes point it at a scripted sim of their own (flat
 * ground, every vehicle kind, hand-made events) without touching the runtime.
 */
import type { Sim } from '../../core/types';
import { getSim } from '../../state/runtime';

let source: () => Sim | null = getSim;

/** The simulation the vehicle and effects views draw. */
export function viewSim(): Sim | null {
  return source();
}

/** Sandboxes only: draw this sim instead of the live flight (null restores the default). */
export function setViewSimSource(fn: (() => Sim | null) | null): void {
  source = fn ?? getSim;
}
