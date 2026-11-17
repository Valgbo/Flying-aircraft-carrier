/**
 * The live simulation's lifetime: the world (terrain) and the current flight. FOUNDATION-OWNED;
 * see docs/a10/ARCHITECTURE.md §7. Views read `getSim()` inside useFrame; nothing re-renders.
 */
import { realismFlags, createSim, type CreateSimOptions } from '../core/sim';
import type { Sim } from '../core/types';
import { createTerrain, generateTerrainData } from '../core/world';
import type { Terrain } from '../core/world/types';
import { useA10Store } from './store';

let terrain: Terrain | null = null;
let sim: Sim | null = null;
const terrainListeners = new Set<(t: Terrain) => void>();

/** The current flight, or null on the menu. */
export function getSim(): Sim | null {
  return sim;
}

/** The generated world, or null before it exists. */
export function getTerrain(): Terrain | null {
  return terrain;
}

/** Called once when the terrain becomes available (immediately if it already is). */
export function onTerrain(listener: (t: Terrain) => void): () => void {
  if (terrain) listener(terrain);
  terrainListeners.add(listener);
  return () => terrainListeners.delete(listener);
}

/**
 * Generate (or reuse) the world for a seed. The world module may move generation into a worker;
 * this function stays the single entry point.
 */
export async function prepareWorld(seed: number): Promise<Terrain> {
  if (terrain && terrain.seed === seed) return terrain;
  const data = generateTerrainData(seed);
  terrain = createTerrain(data);
  for (const l of terrainListeners) l(terrain);
  return terrain;
}

/** Start a new flight in the prepared world, replacing any current one. */
export function startFlight(opts: Partial<CreateSimOptions> = {}): Sim {
  if (!terrain) throw new Error('startFlight: prepareWorld() first');
  const store = useA10Store.getState();
  sim = createSim({
    terrain,
    seed: opts.seed ?? (store.settings.worldSeed ^ ((store.flightNonce + 1) * 2654435761)) >>> 0,
    scenario: opts.scenario ?? store.scenario,
    realism: opts.realism ?? realismFlags(store.settings.realism),
    loadoutId: opts.loadoutId ?? store.loadoutId,
    customLoadout:
      opts.customLoadout ??
      ((opts.loadoutId ?? store.loadoutId) === 'custom'
        ? (store.customLoadout ?? undefined)
        : undefined),
    ammoLoad: opts.ammoLoad ?? store.ammoLoad,
    range: opts.range ?? store.rangeConditions ?? undefined,
    start: opts.start,
  });
  sim.world.timeOfDay = store.settings.timeOfDay;
  store.bumpFlight();
  return sim;
}

/** Leave the flight (back to the menu or the debrief). */
export function endFlight(): void {
  sim = null;
}
