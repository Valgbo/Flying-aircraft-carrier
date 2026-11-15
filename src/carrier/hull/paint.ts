/**
 * Paint colours of the ship as linear `Color`s for vertex colouring. Everything derives from
 * PALETTE so the hull, deck and island read as one design; the few extra tones are shades of
 * the palette greys for recesses, sensors and equipment.
 */
import { Color } from 'three';
import { PALETTE } from '../../config/palette';

const c = (hex: string): Color => new Color(hex);

export const PAINT = {
  hull: c(PALETTE.hull),
  hullDark: c(PALETTE.hullDark),
  bottom: c(PALETTE.hullBottom),
  /** Thin boot stripe between the anti-fouling and the topsides. */
  bootStripe: c('#b4bbbf'),
  /** Deck-coloured walking surfaces (bay floor, sponson tops, roofs). */
  walkway: c(PALETTE.deck),
  /** Unlit openings: hangar bay, boat bays, vents. */
  recess: c('#0b0e11'),
  machinery: c(PALETTE.machinery),
  machineryDark: c(PALETTE.machineryDark),
  /** Flat sensor faces and radar front. */
  sensor: c('#343c44'),
  /** Radomes and life-raft canisters. */
  offWhite: c('#c4c9c8'),
  /** Bare steel: arrestor cables, shuttles. */
  steel: c('#9aa2a8'),
  /** Inside of the navigation bridge. */
  interior: c('#2a3138'),
  net: c('#262b30'),
} as const;
