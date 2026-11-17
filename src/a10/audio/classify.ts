/**
 * Which sound a simulation event makes: pure, unit-tested (tests/unit/a10/audio.test.ts).
 */
import type { SimEvent } from '../core/types';
import { RoundType, type StoreType } from '../core/weapons/types';
import { STORES } from '../data/munitions';
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

// ---- stores (wave 2) ---------------------------------------------------------------------------

export type Release = Extract<SimEvent, { type: 'storeReleased' }>;

/**
 * Whether a store leaving its station makes the ejector's clunk: bombs, guided bombs, dispensers
 * and jettisoned racks, pods and launchers are pushed off by the rack's cartridge-fired ejector
 * rams; a rocket leaving its tube or a Maverick its rail is carried off by its own motor, whose
 * ignition is its sound (`launched`: the frame has a motorIgnition for the same body).
 */
export function releaseClunks(store: StoreType, launched: boolean): boolean {
  if (launched) return false;
  return STORES[store]?.kind !== 'missile';
}

/** Which launch sound a motor lighting makes: a Hydra 70 or a Maverick. */
export type LaunchKind = 'rocket' | 'missile';

export function launchKindOf(bodyKind: string | null | undefined, store?: StoreType): LaunchKind {
  if (bodyKind === 'rocket') return 'rocket';
  if (bodyKind === 'missile') return 'missile';
  if (store && STORES[store]?.rockets !== undefined) return 'rocket';
  return 'missile';
}

/**
 * The quiet cockpit cues of the sensors (PLAN §13: subtle): a Maverick or pod track acquired or
 * lost, the laser firing or stopping. Null for anything else.
 */
export type CockpitCue = 'lockOn' | 'lockOff' | 'laserOn' | 'laserOff';

export function cueOf(e: SimEvent): CockpitCue | null {
  if (e.type === 'lock') return e.on ? 'lockOn' : 'lockOff';
  if (e.type === 'laser') return e.on ? 'laserOn' : 'laserOff';
  return null;
}

/** One explosion of a frame as it will be heard (see planBlasts). */
export interface PlannedBlast {
  t: number;
  x: number;
  y: number;
  z: number;
  size: BlastSize;
  scale: number;
  /** A dud: a thump of the ground, not a blast. */
  thump: boolean;
}

export function createPlannedBlast(): PlannedBlast {
  return { t: 0, x: 0, y: 0, z: 0, size: 'medium', scale: 1, thump: false };
}

const RANK: Record<BlastSize, number> = { small: 0, medium: 1, large: 2, huge: 3 };
/** A vehicle's secondary this close to a store's burst, in the same frame, is the same bang, m. */
export const SAME_BANG_DISTANCE = 25;
const MAX_STORE = 32;
const _sIdx = new Int32Array(MAX_STORE);
const _sBody = new Int32Array(MAX_STORE);
let _sCount = 0;

/** Within this distance of a store's burst a destroyed vehicle was destroyed by it, m. */
export function burstReach(charge: number): number {
  return 30 + 25 * Math.cbrt(Math.max(0.01, Number.isFinite(charge) ? charge : 1));
}

function isStoreBurst(e: SimEvent): e is Detonation {
  return (
    e.type === 'detonation' &&
    (e.kind === 'bomb' ||
      e.kind === 'rocket' ||
      e.kind === 'missile' ||
      e.kind === 'whitePhosphorus')
  );
}

/**
 * The explosions of one frame as they will be heard — every one exactly once (pure; fills
 * `out[0..n)` from its spare entries and returns n, allocation-free):
 * - each store detonation once (a repeated event of the same body is dropped);
 * - a vehicle's 'secondary' going up with a store's burst on it (the same vehicle, or within
 *   SAME_BANG_DISTANCE, in the same frame) is part of that bang: the larger of the two is heard;
 * - a vehicle destroyed by a store's burst in the same frame makes no boom of its own (it did not
 *   explode; the burst is its sound), nor one whose 'secondary' is heard in the frame;
 * - a 30 mm HEI shell's detonation is heard as its round's impact, not here;
 * - a dud is a thump of the ground.
 */
export function planBlasts(events: readonly SimEvent[], out: PlannedBlast[]): number {
  let n = 0;
  // store bursts, once each
  _sCount = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!isStoreBurst(e)) continue;
    const body = e.bodyId ?? 0;
    let dup = false;
    for (let k = 0; k < _sCount && body > 0; k++) if (_sBody[k] === body) dup = true;
    if (dup || _sCount >= MAX_STORE) continue;
    const b = blastOf(e);
    if (!b || n >= out.length) continue;
    const p = out[n++];
    p.t = e.t;
    p.x = e.position.x;
    p.y = e.position.y;
    p.z = e.position.z;
    p.size = b.size;
    p.scale = b.scale;
    p.thump = false;
    _sIdx[_sCount] = i;
    _sBody[_sCount] = body;
    _sCount++;
  }
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'detonation' && e.kind === 'secondary') {
      const b = blastOf(e);
      if (!b) continue;
      // the same bang as a store's burst on (or right by) this vehicle?
      let merged = false;
      for (let k = 0; k < _sCount; k++) {
        const s = events[_sIdx[k]] as Detonation;
        const near =
          (e.vehicleId > 0 && s.vehicleId === e.vehicleId) ||
          Math.hypot(
            s.position.x - e.position.x,
            s.position.y - e.position.y,
            s.position.z - e.position.z,
          ) <= SAME_BANG_DISTANCE;
        if (!near) continue;
        const p = out[k];
        if (RANK[b.size] > RANK[p.size] || (b.size === p.size && b.scale > p.scale)) {
          p.size = b.size;
          p.scale = b.scale;
        }
        merged = true;
        break;
      }
      if (merged) continue;
      if (n >= out.length) continue;
      const p = out[n++];
      p.t = e.t;
      p.x = e.position.x;
      p.y = e.position.y;
      p.z = e.position.z;
      p.size = b.size;
      p.scale = b.scale;
      p.thump = false;
    } else if (e.type === 'detonation' && e.kind === 'dud') {
      if (n >= out.length) continue;
      const p = out[n++];
      p.t = e.t;
      p.x = e.position.x;
      p.y = e.position.y;
      p.z = e.position.z;
      p.size = 'small';
      p.scale = 1;
      p.thump = true;
    } else if (e.type === 'vehicleDestroyed') {
      let quiet = false;
      for (let j = 0; j < events.length && !quiet; j++) {
        const o = events[j];
        if (o.type === 'detonation' && o.kind === 'secondary' && o.vehicleId === e.vehicleId)
          quiet = true;
      }
      for (let k = 0; k < _sCount && !quiet; k++) {
        const s = events[_sIdx[k]] as Detonation;
        const d = Math.hypot(
          s.position.x - e.position.x,
          s.position.y - e.position.y,
          s.position.z - e.position.z,
        );
        if (s.vehicleId === e.vehicleId || d <= burstReach(s.charge)) quiet = true;
      }
      if (quiet) continue;
      if (n >= out.length) continue;
      const p = out[n++];
      p.t = e.t;
      p.x = e.position.x;
      p.y = e.position.y + 1;
      p.z = e.position.z;
      p.size = e.catastrophic ? 'huge' : 'medium';
      p.scale = e.catastrophic ? 0.9 : 0.5;
      p.thump = false;
    }
  }
  return n;
}
