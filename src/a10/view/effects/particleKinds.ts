/**
 * Particle kinds: how each family of particles moves, grows, fades and looks. A particle stores
 * only its kind, state and a few per-particle scales; everything else comes from here.
 *
 * Motion model (ParticleSystem.update): velocity relaxes toward the local air velocity (wind ×
 * `wind`, plus a buoyant rise `rise·exp(-age/riseTau)`) at rate `drag` (1/s), gravity pulls with
 * `gravity`·g, and the ground stops or bounces heavy bits. Size grows from s0 to s1 with
 * `1 - (1 - t)^grow` (fast early growth when grow < 1), or, for kinds with `growTau`, rushes to
 * 80 % of the way within a few `growTau` and creeps the rest over the life.
 */
import { TILE } from './atlas';

export interface ParticleKind {
  name: string;
  /** First atlas tile and how many variants follow it. */
  tile: number;
  tiles: number;
  /** 0 = unlit (emissive only) … 1 = lit by the sun and the sky like smoke or dust. */
  lit: number;
  drag: number;
  gravity: number;
  rise: number;
  riseTau: number;
  /** How much the particle follows the wind, 0..1. */
  wind: number;
  /** Ground: 0 passes through, 1 settles on it, 2 bounces then rests. */
  ground: 0 | 1 | 2;
  grow: number;
  /**
   * When > 0: size rushes toward s1 with this time constant (s) and creeps the rest of the way
   * over the life — explosions and impact puffs expand violently, then drift and dilute.
   */
  growTau: number;
  /** Alpha envelope: fade in over `fadeIn`, start fading out at `fadeOut` (fractions of life). */
  fadeIn: number;
  fadeOut: number;
  alpha: number;
  /** Emissive multiplier at birth (linear HDR) and the fraction of life it lasts. */
  emissive: number;
  emissiveLife: number;
  /** Emissive colour from the fire ramp (white → yellow → orange → red as it cools). */
  fireRamp: boolean;
  /** Where on the ramp it starts (1 white-hot … 0.5 orange). */
  rampHeat: number;
  /** Seconds of motion blur: the quad stretches along the screen-space velocity. */
  stretch: number;
  /** Maximum spin, rad/s. */
  spin: number;
  /** Minimum on-screen size, pixels (keeps distant effects from vanishing between pixels). */
  minPx: number;
  /** Emissive flicker amount 0..1. */
  flicker: number;
  /** Heat for the thermal picture at birth, 0..1 (decays like the emissive). */
  thermal: number;
  /** Trail: kind spawned behind the particle while it lives (-1 = none), puffs per second. */
  trail: number;
  trailRate: number;
  /** Trail puff start and end size (m) and life (s). */
  trailS0: number;
  trailS1: number;
  trailLife: number;
  /** Keep the sprite's up pointing at the world's up (flames). */
  upright: boolean;
  /** Default albedo (linear). */
  color: readonly [number, number, number];
}

const BASE: ParticleKind = {
  name: '',
  tile: TILE.smoke,
  tiles: 4,
  lit: 1,
  drag: 1,
  gravity: 0,
  rise: 0,
  riseTau: 5,
  wind: 1,
  ground: 1,
  grow: 0.5,
  growTau: 0,
  fadeIn: 0.05,
  fadeOut: 0.4,
  alpha: 1,
  emissive: 0,
  emissiveLife: 1,
  fireRamp: false,
  rampHeat: 1,
  stretch: 0,
  spin: 0.3,
  minPx: 1.2,
  flicker: 0,
  thermal: 0,
  trail: -1,
  trailRate: 0,
  trailS0: 0.6,
  trailS1: 3,
  trailLife: 3,
  upright: false,
  color: [0.3, 0.3, 0.3],
};

function kind(over: Partial<ParticleKind> & { name: string }): ParticleKind {
  return { ...BASE, ...over };
}

/** Kind ids (indices into PARTICLE_KINDS). */
export const PK = {
  smoke: 0,
  blackSmoke: 1,
  column: 2,
  dust: 3,
  dustJet: 4,
  clod: 5,
  debris: 6,
  spark: 7,
  flash: 8,
  fireball: 9,
  flame: 10,
  muzzle: 11,
  gunSmoke: 12,
  splash: 13,
  mist: 14,
  wpSmoke: 15,
  wpFragment: 16,
  wpTrail: 17,
  trailSmoke: 18,
  ember: 19,
  exhaust: 20,
  fleck: 21,
  dustRing: 22,
  glint: 23,
  burningDebris: 24,
  streak: 25,
  dustTrail: 26,
  ejecta: 27,
  fuelball: 28,
} as const;
export type PK = (typeof PK)[keyof typeof PK];

export const PARTICLE_KINDS: ParticleKind[] = [];

function define(id: number, k: ParticleKind): void {
  PARTICLE_KINDS[id] = k;
}

define(
  PK.smoke,
  kind({ name: 'smoke', drag: 1.4, rise: 1.4, riseTau: 6, grow: 0.45, growTau: 0.9, fadeOut: 0.3 }),
);
define(
  PK.blackSmoke,
  kind({
    name: 'blackSmoke',
    growTau: 3.5,
    drag: 0.9,
    rise: 6,
    riseTau: 12,
    grow: 0.55,
    fadeIn: 0.03,
    fadeOut: 0.35,
    alpha: 0.95,
    color: [0.035, 0.032, 0.03],
    minPx: 1.4,
    thermal: 0.35,
  }),
);
define(
  PK.column,
  kind({
    name: 'column',
    growTau: 18,
    drag: 0.35,
    rise: 9,
    riseTau: 60,
    grow: 0.62,
    fadeIn: 0.015,
    fadeOut: 0.55,
    alpha: 0.85,
    spin: 0.05,
    color: [0.045, 0.042, 0.04],
    minPx: 4,
    thermal: 0.12,
  }),
);
define(
  PK.dust,
  kind({
    name: 'dust',
    growTau: 0.45,
    tile: TILE.dust,
    tiles: 1,
    drag: 2.6,
    gravity: 0.03,
    rise: 0.35,
    riseTau: 3,
    grow: 0.38,
    fadeIn: 0.02,
    fadeOut: 0.42,
    alpha: 0.9,
    color: [0.3, 0.24, 0.16],
    minPx: 2.2,
  }),
);
define(
  PK.dustJet,
  kind({
    name: 'dustJet',
    growTau: 0.35,
    tile: TILE.dust,
    tiles: 1,
    drag: 3.2,
    gravity: 0.55,
    rise: 0,
    wind: 0.6,
    grow: 0.55,
    fadeIn: 0,
    fadeOut: 0.5,
    alpha: 1,
    stretch: 0.075,
    spin: 0,
    color: [0.28, 0.22, 0.15],
    minPx: 2.6,
  }),
);
define(
  PK.clod,
  kind({
    name: 'clod',
    tile: TILE.clods,
    tiles: 1,
    drag: 0.35,
    gravity: 1,
    wind: 0.1,
    ground: 2,
    grow: 1,
    fadeIn: 0,
    fadeOut: 0.8,
    stretch: 0.012,
    spin: 7,
    color: [0.12, 0.09, 0.06],
    minPx: 1,
  }),
);
define(
  PK.debris,
  kind({
    name: 'debris',
    tile: TILE.debris,
    tiles: 2,
    drag: 0.12,
    gravity: 1,
    wind: 0.05,
    ground: 2,
    grow: 1,
    fadeIn: 0,
    fadeOut: 0.9,
    spin: 11,
    color: [0.07, 0.065, 0.06],
    minPx: 1.4,
  }),
);
define(
  PK.spark,
  kind({
    name: 'spark',
    tile: TILE.spark,
    tiles: 1,
    lit: 0,
    drag: 0.9,
    gravity: 0.7,
    wind: 0.1,
    ground: 2,
    grow: 1,
    fadeIn: 0,
    fadeOut: 0.6,
    alpha: 0,
    emissive: 26,
    emissiveLife: 1,
    fireRamp: true,
    stretch: 0.025,
    spin: 0,
    minPx: 2.1,
    flicker: 0.45,
    thermal: 1,
  }),
);
define(
  PK.flash,
  kind({
    name: 'flash',
    tile: TILE.star,
    tiles: 1,
    lit: 0,
    drag: 0,
    wind: 0,
    ground: 0,
    grow: 0.4,
    fadeIn: 0,
    fadeOut: 0.7,
    alpha: 0,
    emissive: 30,
    emissiveLife: 1,
    fireRamp: true,
    spin: 0,
    minPx: 3,
    thermal: 1,
  }),
);
define(
  PK.fireball,
  kind({
    name: 'fireball',
    rampHeat: 0.85,
    growTau: 0.22,
    drag: 2.4,
    rise: 7,
    riseTau: 2.5,
    grow: 0.4,
    fadeIn: 0,
    fadeOut: 0.4,
    alpha: 0.95,
    emissive: 3.2,
    emissiveLife: 0.32,
    fireRamp: true,
    spin: 1.2,
    color: [0.05, 0.045, 0.04],
    minPx: 2,
    flicker: 0.15,
    thermal: 1,
  }),
);
define(
  PK.flame,
  kind({
    name: 'flame',
    rampHeat: 0.68,
    growTau: 0.25,
    tile: TILE.flame,
    tiles: 2,
    upright: true,
    lit: 0,
    drag: 3,
    rise: 4.5,
    riseTau: 0.8,
    wind: 0.7,
    ground: 0,
    grow: 0.7,
    fadeIn: 0.12,
    fadeOut: 0.45,
    alpha: 0.14,
    emissive: 1.7,
    emissiveLife: 1,
    fireRamp: true,
    spin: 0,
    minPx: 1.6,
    flicker: 0.55,
    thermal: 1,
    color: [0.05, 0.03, 0.02],
  }),
);
define(
  PK.muzzle,
  kind({
    name: 'muzzle',
    tile: TILE.star,
    tiles: 1,
    lit: 0,
    drag: 0,
    wind: 0,
    ground: 0,
    grow: 0.3,
    fadeIn: 0,
    fadeOut: 0.3,
    alpha: 0,
    emissive: 22,
    fireRamp: true,
    spin: 0,
    minPx: 2,
    flicker: 0.6,
    thermal: 1,
  }),
);
define(
  PK.gunSmoke,
  kind({
    name: 'gunSmoke',
    growTau: 0.2,
    drag: 11,
    rise: 0.4,
    riseTau: 4,
    grow: 0.3,
    fadeIn: 0.01,
    fadeOut: 0.15,
    alpha: 0.7,
    spin: 0.6,
    color: [0.62, 0.61, 0.59],
    minPx: 1.2,
    thermal: 0.2,
  }),
);
define(
  PK.splash,
  kind({
    name: 'splash',
    growTau: 0.3,
    tile: TILE.splash,
    tiles: 1,
    drag: 0.8,
    gravity: 1,
    wind: 0.3,
    ground: 1,
    grow: 0.6,
    fadeIn: 0,
    fadeOut: 0.45,
    stretch: 0.05,
    spin: 0,
    color: [0.85, 0.88, 0.9],
    minPx: 1.4,
  }),
);
define(
  PK.mist,
  kind({
    name: 'mist',
    growTau: 0.5,
    drag: 2.2,
    rise: 0.3,
    grow: 0.45,
    fadeOut: 0.2,
    alpha: 0.55,
    color: [0.82, 0.85, 0.88],
  }),
);
define(
  PK.wpSmoke,
  kind({
    name: 'wpSmoke',
    growTau: 1.6,
    drag: 1.6,
    rise: 1.4,
    riseTau: 25,
    grow: 0.5,
    fadeIn: 0.01,
    fadeOut: 0.5,
    alpha: 0.97,
    emissive: 2.5,
    emissiveLife: 0.04,
    color: [0.93, 0.93, 0.92],
    minPx: 1.8,
    thermal: 0.5,
  }),
);
define(
  PK.wpFragment,
  kind({
    name: 'wpFragment',
    tile: TILE.spark,
    tiles: 1,
    lit: 0,
    drag: 0.3,
    gravity: 1,
    wind: 0.1,
    ground: 1,
    grow: 1,
    fadeIn: 0,
    fadeOut: 0.85,
    alpha: 0,
    emissive: 16,
    emissiveLife: 1,
    spin: 0,
    minPx: 2,
    flicker: 0.4,
    thermal: 1,
    color: [1, 1, 1],
    trail: PK.wpTrail,
    trailRate: 40,
    trailS0: 0.7,
    trailS1: 4.5,
    trailLife: 7,
  }),
);
define(
  PK.wpTrail,
  kind({
    name: 'wpTrail',
    growTau: 0.9,
    drag: 2.5,
    rise: 0.6,
    riseTau: 15,
    grow: 0.45,
    fadeIn: 0.02,
    fadeOut: 0.35,
    alpha: 0.9,
    color: [0.92, 0.92, 0.91],
    minPx: 1.4,
  }),
);
define(
  PK.trailSmoke,
  kind({
    name: 'trailSmoke',
    growTau: 0.6,
    drag: 2.2,
    rise: 1.2,
    riseTau: 6,
    grow: 0.45,
    fadeIn: 0.02,
    fadeOut: 0.3,
    alpha: 0.85,
    color: [0.06, 0.055, 0.05],
    minPx: 1.3,
  }),
);
define(
  PK.ember,
  kind({
    name: 'ember',
    rampHeat: 0.7,
    tile: TILE.spark,
    tiles: 1,
    lit: 0,
    drag: 1.6,
    gravity: 0.08,
    rise: 3,
    riseTau: 3,
    wind: 1,
    ground: 1,
    grow: 1,
    fadeIn: 0,
    fadeOut: 0.5,
    alpha: 0,
    emissive: 7,
    fireRamp: true,
    spin: 0,
    minPx: 1,
    flicker: 0.8,
    thermal: 1,
  }),
);
define(
  PK.exhaust,
  kind({
    name: 'exhaust',
    growTau: 0.7,
    drag: 2.2,
    rise: 0.8,
    riseTau: 3,
    grow: 0.5,
    fadeIn: 0.05,
    fadeOut: 0.25,
    alpha: 0.26,
    color: [0.12, 0.12, 0.13],
    minPx: 0.8,
    thermal: 0.5,
  }),
);
define(
  PK.fleck,
  kind({
    name: 'fleck',
    tile: TILE.flecks,
    tiles: 1,
    drag: 1.8,
    gravity: 0.55,
    wind: 0.5,
    ground: 1,
    grow: 1,
    fadeIn: 0,
    fadeOut: 0.7,
    spin: 9,
    color: [0.16, 0.2, 0.07],
    minPx: 0.8,
  }),
);
define(
  PK.dustRing,
  kind({
    name: 'dustRing',
    growTau: 0.6,
    tile: TILE.dust,
    tiles: 1,
    drag: 2.4,
    gravity: 0,
    rise: 0.6,
    riseTau: 4,
    grow: 0.35,
    fadeIn: 0.01,
    fadeOut: 0.3,
    alpha: 0.8,
    color: [0.3, 0.25, 0.18],
    minPx: 1.3,
  }),
);
define(
  PK.glint,
  kind({
    name: 'glint',
    tile: TILE.glow,
    tiles: 1,
    lit: 0,
    drag: 0,
    wind: 0,
    ground: 0,
    grow: 0.2,
    fadeIn: 0,
    fadeOut: 0.2,
    alpha: 0,
    emissive: 22,
    emissiveLife: 1,
    spin: 0,
    minPx: 2.8,
    flicker: 0.5,
    thermal: 1,
    color: [1, 1, 1],
  }),
);
define(
  PK.burningDebris,
  kind({
    name: 'burningDebris',
    rampHeat: 0.7,
    tile: TILE.debris,
    tiles: 2,
    lit: 1,
    drag: 0.15,
    gravity: 1,
    wind: 0.05,
    ground: 2,
    grow: 1,
    fadeIn: 0,
    fadeOut: 0.9,
    emissive: 1.6,
    emissiveLife: 1,
    fireRamp: true,
    spin: 8,
    minPx: 1.6,
    flicker: 0.6,
    thermal: 1,
    color: [0.05, 0.045, 0.04],
    trail: PK.trailSmoke,
    trailRate: 14,
    trailS0: 0.6,
    trailS1: 3.2,
    trailLife: 3.5,
  }),
);
define(
  PK.streak,
  kind({
    name: 'streak',
    tile: TILE.spark,
    tiles: 1,
    lit: 0,
    drag: 0.4,
    gravity: 0.3,
    wind: 0,
    ground: 0,
    grow: 1,
    fadeIn: 0,
    fadeOut: 0.5,
    alpha: 0,
    emissive: 14,
    emissiveLife: 1,
    fireRamp: true,
    stretch: 0.045,
    spin: 0,
    minPx: 1.8,
    thermal: 1,
  }),
);
define(
  PK.dustTrail,
  kind({
    name: 'dustTrail',
    growTau: 1.5,
    tile: TILE.dust,
    tiles: 1,
    drag: 1.3,
    gravity: 0,
    rise: 1.1,
    riseTau: 6,
    grow: 0.5,
    fadeIn: 0.04,
    fadeOut: 0.35,
    alpha: 0.85,
    color: [0.36, 0.3, 0.21],
    minPx: 2,
  }),
);

define(
  PK.ejecta,
  kind({
    name: 'ejecta',
    growTau: 0.5,
    drag: 1.4,
    gravity: 1,
    rise: 0,
    wind: 0.4,
    ground: 1,
    fadeIn: 0,
    fadeOut: 0.55,
    alpha: 1,
    stretch: 0.05,
    spin: 0.5,
    color: [0.09, 0.07, 0.05],
    minPx: 1.6,
  }),
);

define(
  PK.fuelball,
  kind({
    name: 'fuelball',
    rampHeat: 0.8,
    growTau: 0.45,
    drag: 1.6,
    rise: 9,
    riseTau: 3,
    grow: 0.4,
    fadeIn: 0,
    fadeOut: 0.45,
    alpha: 0.95,
    emissive: 2.8,
    // burning fuel keeps glowing for seconds while it rolls up
    emissiveLife: 0.6,
    fireRamp: true,
    spin: 0.8,
    color: [0.04, 0.035, 0.03],
    minPx: 2,
    flicker: 0.2,
    thermal: 1,
  }),
);

/** Fire colour ramp (linear HDR, before the emissive multiplier): heat 1 = white-hot … 0 = dull red. */
export function fireRampColor(heat: number, out: Float32Array, o: number): void {
  const h = heat < 0 ? 0 : heat > 1 ? 1 : heat;
  // dull red → orange → yellow → white
  let r: number;
  let g: number;
  let b: number;
  if (h < 0.35) {
    const t = h / 0.35;
    r = 0.55 + 0.45 * t;
    g = 0.08 + 0.22 * t;
    b = 0.02 + 0.02 * t;
  } else if (h < 0.75) {
    const t = (h - 0.35) / 0.4;
    r = 1;
    g = 0.3 + 0.45 * t;
    b = 0.04 + 0.16 * t;
  } else {
    const t = (h - 0.75) / 0.25;
    r = 1;
    g = 0.75 + 0.2 * t;
    b = 0.2 + 0.65 * t;
  }
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}
