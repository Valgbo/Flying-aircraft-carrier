/**
 * WEAPONS module public API. FOUNDATION STAND-IN: state constructors and no-op steps, so the
 * app runs before the real gun, ballistics and stores land. The weapons module owner replaces
 * the implementations and keeps these exports and their meaning.
 */
import { GAU8 } from '../../data/gun';
import type { Sim } from '../types';
import type {
  AmmoLoad,
  GunState,
  ProjectileState,
  RoundPool,
  StoresState,
  StoreType,
} from './types';
import { RoundType } from './types';

export * from './ballistics';
export * from './penetration';
export { RoundType } from './types';
export type * from './types';

export function createGunState(
  load: AmmoLoad = 'combatMix',
  rounds: number = GAU8.typicalLoad,
): GunState {
  return {
    rounds,
    roundsLoaded: rounds,
    load,
    beltIndex: 0,
    spin: 0,
    barrelAngle: 0,
    rate: 0,
    firing: false,
    phase: 0,
    burstStart: -1,
    burstRounds: 0,
    totalFired: 0,
    recoil: 0,
  };
}

/** Type of the n-th round of a belt load. Combat mix: 5 API then 1 HEI, repeating. */
export function roundTypeAt(load: AmmoLoad, n: number): RoundType {
  switch (load) {
    case 'allHEI':
      return RoundType.HEI;
    case 'allAPI':
      return RoundType.API;
    case 'targetPractice':
      return RoundType.TP;
    default:
      return n % (GAU8.combatMixApiPerHei + 1) === GAU8.combatMixApiPerHei
        ? RoundType.HEI
        : RoundType.API;
  }
}

export function createRoundPool(capacity = 1024): RoundPool {
  return {
    capacity,
    alive: new Uint8Array(capacity),
    type: new Uint8Array(capacity),
    px: new Float64Array(capacity),
    py: new Float64Array(capacity),
    pz: new Float64Array(capacity),
    vx: new Float64Array(capacity),
    vy: new Float64Array(capacity),
    vz: new Float64Array(capacity),
    fireTime: new Float64Array(capacity),
    id: new Uint32Array(capacity),
    burst: new Uint32Array(capacity),
    bounces: new Uint8Array(capacity),
    live: 0,
    nextId: 1,
  };
}

export function createProjectileState(): ProjectileState {
  return { rounds: createRoundPool(), bodies: [], nextBodyId: 1 };
}

/** Loadout presets: station → stores (rack/launcher first). Stand-in: the gun only. */
export const LOADOUTS: Record<string, { name: string; stations: Record<number, StoreType[]> }> = {
  gunOnly: { name: 'Gun only', stations: {} },
};

export function createStoresState(
  loadoutId: string,
  custom?: Record<number, StoreType[]>,
): StoresState {
  const preset = custom ?? LOADOUTS[loadoutId]?.stations ?? {};
  const stations = [];
  for (let s = 1; s <= 11; s++) {
    const list = preset[s] ?? [];
    stations.push({ station: s, rack: null, stores: [...list] });
  }
  return { stations, loadoutId, mass: 0, dragArea: 0, lateralMoment: 0 };
}

/** Gun mechanics: spin, round emission between the previous and new aircraft state, recoil. */
export function stepGun(_sim: Sim, _dt: number): void {}

/** Store release logic (bombs, rockets, missiles). */
export function stepStores(_sim: Sim, _dt: number): void {}

/** Integrate rounds and store bodies; detect and resolve impacts. */
export function stepProjectiles(_sim: Sim, _dt: number): void {}
