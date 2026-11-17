/**
 * How each kind of ground looks when something hits it or drives over it: colours of the dust,
 * the clods and the flecks it throws up, and whether it sparks, splashes or stays put.
 * Colours are linear albedo. A sunlit dust cloud is brighter than the soil it came from (fine
 * particles scatter strongly), so dust is paler than the ground and stands out against fields and
 * grass from the air; the clods and the spurt's core stay dark.
 */
import type { SurfaceKind } from '../../core/world/types';

export interface SurfaceFx {
  /** Dust cloud colour. */
  dust: readonly [number, number, number];
  /** Clods and thrown soil. */
  clod: readonly [number, number, number];
  /** How much dust an impact raises (0..1.5). */
  dustiness: number;
  /** How much soil and clods it throws (0..1.5). */
  ejecta: number;
  /** Hard surface: sparks and chips. */
  sparks: number;
  /** Flecks (grass, stubble, leaves, splinters), -1 none, else a colour. */
  fleck: readonly [number, number, number] | null;
  /** Water: splashes instead of dust. */
  water: boolean;
  /** Dust raised behind a moving vehicle (0 = none … 1 = a dry track). */
  trail: number;
}

const SURFACES: Record<SurfaceKind, SurfaceFx> = {
  dirt: {
    dust: [0.52, 0.42, 0.29],
    clod: [0.11, 0.075, 0.045],
    dustiness: 1,
    ejecta: 1,
    sparks: 0,
    fleck: null,
    water: false,
    trail: 1,
  },
  field: {
    dust: [0.56, 0.46, 0.32],
    clod: [0.12, 0.085, 0.05],
    dustiness: 1.05,
    ejecta: 1,
    sparks: 0,
    fleck: [0.32, 0.27, 0.1],
    water: false,
    trail: 1,
  },
  grass: {
    dust: [0.48, 0.42, 0.3],
    clod: [0.09, 0.07, 0.04],
    dustiness: 0.75,
    ejecta: 0.85,
    sparks: 0,
    fleck: [0.1, 0.16, 0.04],
    water: false,
    trail: 0.55,
  },
  sand: {
    dust: [0.68, 0.58, 0.42],
    clod: [0.36, 0.29, 0.18],
    dustiness: 1.4,
    ejecta: 0.7,
    sparks: 0,
    fleck: null,
    water: false,
    trail: 1.2,
  },
  mud: {
    dust: [0.3, 0.24, 0.17],
    clod: [0.055, 0.04, 0.025],
    dustiness: 0.25,
    ejecta: 1.4,
    sparks: 0,
    fleck: null,
    water: false,
    trail: 0.1,
  },
  rock: {
    dust: [0.52, 0.5, 0.46],
    clod: [0.2, 0.19, 0.17],
    dustiness: 0.75,
    ejecta: 0.5,
    sparks: 1,
    fleck: null,
    water: false,
    trail: 0.35,
  },
  concrete: {
    dust: [0.6, 0.59, 0.56],
    clod: [0.3, 0.29, 0.27],
    dustiness: 0.7,
    ejecta: 0.35,
    sparks: 1,
    fleck: null,
    water: false,
    trail: 0.15,
  },
  road: {
    dust: [0.5, 0.46, 0.39],
    clod: [0.12, 0.11, 0.1],
    dustiness: 0.85,
    ejecta: 0.5,
    sparks: 0.6,
    fleck: null,
    water: false,
    trail: 0.6,
  },
  forest: {
    dust: [0.38, 0.34, 0.25],
    clod: [0.08, 0.06, 0.035],
    dustiness: 0.6,
    ejecta: 0.8,
    sparks: 0,
    fleck: [0.08, 0.12, 0.035],
    water: false,
    trail: 0.3,
  },
  water: {
    dust: [0.8, 0.84, 0.88],
    clod: [0.7, 0.75, 0.8],
    dustiness: 0,
    ejecta: 0,
    sparks: 0,
    fleck: null,
    water: true,
    trail: 0,
  },
};

export function surfaceFx(kind: SurfaceKind | undefined | null): SurfaceFx {
  return (kind && SURFACES[kind]) || SURFACES.dirt;
}
