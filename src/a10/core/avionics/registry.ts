/**
 * The stores' ballistic models, registered by the weapons module (ARCHITECTURE §12.2: "weapons
 * registers every unguided store's model with avionics' registerStoreBallistics(key, model) at
 * module load"; key = the store type, or `${store}/HD` for the high-drag configuration).
 *
 * Import order matters here. core/avionics and core/weapons import each other (the gun sight
 * flies the weapons module's round integrator; the weapons module registers its store models
 * here at load time), so this file has NO runtime imports and is the FIRST import of
 * avionics/index.ts and avionics/release.ts: whichever side of the cycle loads first, the
 * registry is initialised before any module-level `registerStoreBallistics` call runs.
 */
import type { BallisticModel } from './predict';

/** A store as the computer flies it: its model and how it leaves the aircraft. */
export interface StoreBallistics extends BallisticModel {
  /** Ejection velocity relative to the aircraft at release, body frame, m/s (rack push). */
  ejection: { x: number; y: number; z: number };
  /** Predictor step, s (default: the live bodies' step, SIM_DT). */
  dt?: number;
}

const storeModels = new Map<string, StoreBallistics>();

/** Register (or with null remove) the ballistic model of a store type or `${store}/HD`. */
export function registerStoreBallistics(store: string, model: StoreBallistics | null): void {
  if (model) storeModels.set(store, model);
  else storeModels.delete(store);
}

/** The registered model of a key, or null. */
export function storeBallistics(store: string): StoreBallistics | null {
  return storeModels.get(store) ?? null;
}
