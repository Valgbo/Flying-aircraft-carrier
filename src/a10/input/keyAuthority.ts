/**
 * Keyboard pitch authority (review FC-5): how far a held pitch key deflects the stick.
 *
 * The A-10's controls are mechanical, so the load factor per unit of stick grows with dynamic
 * pressure: a full deflection gives about 4 g at 200 kn but 17 g at 400 kn. A key can only be up
 * or down, so a key that always meant full deflection over-stressed the aircraft at speed and
 * made every tap a large one. A held key now takes the stick to the deflection that reaches about
 * the g limit at the present flight condition (and full deflection where the wing cannot reach
 * it), the way a pilot's arm does with stick force per g; analogue sticks and the mouse stick are
 * left alone. Pure: the runtime calls it every frame with the live sim.
 */
import { stickPerG } from '../core/flight';
import type { Sim } from '../core/types';

/** Fraction of the g-limit increment a held key pulls to (allows for the response overshoot). */
export const KEY_G_FRACTION = 0.92;
/** Least authority: a key always moves the stick a useful amount. */
export const KEY_MIN_AUTHORITY = 0.1;

export interface KeyAuthority {
  /** Stick deflection of a held pull (nose-up) key, 0..1. */
  pull: number;
  /** Stick deflection of a held push (nose-down) key, 0..1. */
  push: number;
}

/** Fill `out` for the present flight condition (full authority without a flying aircraft). */
export function keyPitchAuthority(sim: Sim | null, out: KeyAuthority): KeyAuthority {
  out.pull = 1;
  out.push = 1;
  const ac = sim?.aircraft;
  if (!sim || !ac || ac.crashed) return out;
  const perG = stickPerG(sim);
  if (!Number.isFinite(perG)) return out;
  const clampA = (v: number) => Math.min(1, Math.max(KEY_MIN_AUTHORITY, v));
  // From 1 g: up to the positive limit when pulling, down to the negative limit when pushing.
  out.pull = clampA((ac.gLimitPositive - 1) * KEY_G_FRACTION * perG);
  out.push = clampA((1 - ac.gLimitNegative) * KEY_G_FRACTION * perG);
  return out;
}
