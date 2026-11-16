/**
 * Which sound a simulation event makes: pure, unit-tested (tests/unit/a10/audio.test.ts).
 */
import type { SimEvent } from '../core/types';
import { RoundType } from '../core/weapons/types';
import type { ImpactKind } from './propagation';
import type { BlastSize } from './synth';

export type RoundImpact = Extract<SimEvent, { type: 'roundImpact' }>;
export type Detonation = Extract<SimEvent, { type: 'detonation' }>;

/** Which impact sound a 30 mm round makes. */
export function impactKindOf(e: RoundImpact): ImpactKind {
  const water =
    e.outcome === 'water' || (e.target.kind === 'ground' && e.target.surface === 'water');
  if (water) return 'water';
  if (e.round === RoundType.HEI) return 'hei';
  if (e.outcome === 'ricochet' || e.outcome === 'skip') return 'ricochet';
  return e.target.kind === 'vehicle' ? 'armour' : 'ground';
}

/** The blast a detonation makes (null: an HEI shell, already heard as its round's impact, or a dud). */
export function blastOf(e: Detonation): { size: BlastSize; scale: number } | null {
  const c = Math.max(0.01, Number.isFinite(e.charge) ? e.charge : 1);
  const scale = (ref: number) => Math.max(0.4, Math.min(1.8, Math.cbrt(c / ref)));
  switch (e.kind) {
    case 'hei':
    case 'dud':
      return null;
    case 'rocket':
      return { size: 'medium', scale: scale(4) };
    case 'whitePhosphorus':
      return { size: 'medium', scale: 0.6 };
    case 'secondary':
      return { size: 'huge', scale: scale(150) };
    case 'bomb':
    case 'missile':
    default:
      return { size: c < 15 ? 'medium' : 'large', scale: c < 15 ? scale(4) : scale(80) };
  }
}
