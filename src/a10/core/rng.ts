/**
 * Deterministic random numbers for the simulation core. The core never calls Math.random():
 * every random draw comes from one of the sim's seeded streams, so the same seed and the same
 * inputs give the same flight (docs/a10/ARCHITECTURE.md §3, determinism).
 */

/** Mix any number of integers / strings into a 32-bit seed (FNV-1a over the parts). */
export function hashSeed(...parts: Array<number | string>): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = typeof part === 'number' ? `${part}` : part;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2c; // separator
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded generator (mulberry32) with the helpers the simulation needs. */
export class Rng {
  private s: number;
  private spare = 0;
  private hasSpare = false;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] (both inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal deviate (Box–Muller; the second value of each pair is kept for the next call). */
  normal(): number {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    let u = 0;
    while (u <= 1e-12) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    this.hasSpare = true;
    return r * Math.cos(2 * Math.PI * v);
  }

  /** One element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** An independent stream derived from this one's current state and a salt. */
  fork(salt: number | string): Rng {
    return new Rng(hashSeed(this.s, salt));
  }
}

/**
 * The sim's random streams, one per subsystem, so adding draws in one system does not shift
 * the numbers another system sees.
 */
export interface RngStreams {
  /** Gun dispersion and round-to-round variation. */
  gun: Rng;
  /** Fuzes, duds, guidance noise, rocket dispersion. */
  weapons: Rng;
  /** Damage outcomes inside vehicles. */
  damage: Rng;
  /** Vehicle behaviour and scenario generation. */
  targets: Rng;
  /** Turbulence and gusts. */
  air: Rng;
  /** Anything else in the core. */
  misc: Rng;
}

export function createRngStreams(seed: number): RngStreams {
  return {
    gun: new Rng(hashSeed(seed, 'gun')),
    weapons: new Rng(hashSeed(seed, 'weapons')),
    damage: new Rng(hashSeed(seed, 'damage')),
    targets: new Rng(hashSeed(seed, 'targets')),
    air: new Rng(hashSeed(seed, 'air')),
    misc: new Rng(hashSeed(seed, 'misc')),
  };
}
