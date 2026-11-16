/**
 * Sound in the world: propagation delay, air absorption and spreading loss, the arrival of a
 * sound at a moving listener, Doppler, and the bookkeeping that keeps all of it in SIMULATION
 * time (so pausing the game pauses the sound in flight). Pure TypeScript, no Web Audio:
 * unit-tested in tests/unit/a10/audioPropagation.test.ts.
 *
 * Every world sound arrives late by distance / c, where c is the speed of sound at the mean
 * height of the path (with the ISA's linear lapse rate that equals the path average), and
 * loses its high frequencies with range. That is what puts the flash before the boom, and the
 * impacts before the gun's growl at the target (the rounds are supersonic, the growl is not).
 */
import { clamp } from '../../engine';
import { speedOfSoundAt } from '../core/world';

function finite(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** A point and its velocity (m, m/s), world frame. */
export interface MovingPoint extends Point3 {
  vx: number;
  vy: number;
  vz: number;
}

/** Speed of sound along a path between two heights, m/s (ISA at the mean height). */
export function soundSpeed(heightA: number, heightB: number): number {
  const h = clamp((finite(heightA) + finite(heightB)) / 2, -500, 20000);
  return speedOfSoundAt(h);
}

/** Time for sound to cover `distance` at `c`, s. */
export function propagationDelay(distance: number, c: number): number {
  return Math.max(0, finite(distance)) / Math.max(1, finite(c, 340));
}

/**
 * Low-pass cut-off for air absorption over `distance`, Hz. Atmospheric absorption at about
 * 15 °C and 70 % humidity (ISO 9613-1) is close to α(f) ≈ 5·(f / 1 kHz)^1.3 dB/km
 * (1 kHz: 5, 2 kHz: 12, 4 kHz: 30, 8 kHz: 74 dB/km). The cut-off is where the loss reaches
 * 6 dB: 6.8 kHz at 100 m, 1.2 kHz at 1 km, 330 Hz at 5 km. It keeps darkening with range
 * (no floor before 120 Hz), so a far explosion is a dull boom and a near one a crack.
 */
export function absorptionCutoff(distance: number): number {
  const d = Math.max(1, finite(distance));
  return clamp(1000 * Math.pow(1200 / d, 1 / 1.3), 120, 18000);
}

/**
 * Spreading loss: 1 at or inside `refDistance`, then refDistance / d (−6 dB per doubling,
 * spherical spreading). `rolloff` < 1 softens it for game play (0.85 ≈ −5.1 dB per doubling).
 */
export function distanceGain(distance: number, refDistance: number, rolloff = 1): number {
  const d = Math.max(0, finite(distance));
  const r = Math.max(1e-3, finite(refDistance, 1));
  if (d <= r) return 1;
  return Math.pow(r / d, clamp(finite(rolloff, 1), 0.1, 2));
}

/** Fastest listener speed the prediction trusts; faster means a camera cut, not motion. */
const MAX_LISTENER_SPEED = 400;

/**
 * Sim time at which a sound emitted at `emitT` from `e` reaches a listener who is at `L` at
 * `now` and moves in a straight line with L's velocity: the root of |L + V·Δ − e| = c·(now + Δ − emitT).
 * Returns a time ≤ now when the wavefront has already passed the listener's position.
 * The prediction is refreshed every frame, so a turning listener stays accurate.
 */
export function arrivalTime(
  emitT: number,
  e: Point3,
  now: number,
  L: MovingPoint,
  c: number,
): number {
  const px = L.x - e.x;
  const py = L.y - e.y;
  const pz = L.z - e.z;
  const d0 = Math.hypot(px, py, pz);
  const cc = Math.max(1, finite(c, 340));
  const r0 = cc * (now - emitT);
  if (!(d0 > r0)) return emitT + d0 / cc;
  let vx = finite(L.vx);
  let vy = finite(L.vy);
  let vz = finite(L.vz);
  let v2 = vx * vx + vy * vy + vz * vz;
  if (v2 > MAX_LISTENER_SPEED * MAX_LISTENER_SPEED) {
    vx = vy = vz = 0;
    v2 = 0;
  } else if (v2 > 0.81 * cc * cc) {
    // never let the listener outrun the sound
    const k = (0.9 * cc) / Math.sqrt(v2);
    vx *= k;
    vy *= k;
    vz *= k;
    v2 = vx * vx + vy * vy + vz * vz;
  }
  const a = v2 - cc * cc; // < 0
  const b = 2 * (px * vx + py * vy + pz * vz - r0 * cc);
  const k0 = d0 * d0 - r0 * r0; // > 0
  const disc = Math.sqrt(Math.max(0, b * b - 4 * a * k0));
  const delta = Math.max((-b + disc) / (2 * a), (-b - disc) / (2 * a));
  return now + Math.max(0, delta);
}

/**
 * Doppler factor for a source moving with `src` velocity heard by a listener moving with
 * `lis` velocity: f_heard / f_emitted = (c − v_L·u) / (c − v_S·u), u the unit vector from source
 * to listener. Clamped to 0.5..2 (camera cuts must not produce absurd pitches).
 */
export function dopplerFactor(
  src: MovingPoint,
  lis: MovingPoint,
  c: number,
  maxSpeed = MAX_LISTENER_SPEED,
): number {
  const ux = lis.x - src.x;
  const uy = lis.y - src.y;
  const uz = lis.z - src.z;
  const d = Math.hypot(ux, uy, uz);
  if (!(d > 1e-3)) return 1;
  const cc = Math.max(1, finite(c, 340));
  const vs = clamp(finite((src.vx * ux + src.vy * uy + src.vz * uz) / d), -maxSpeed, maxSpeed);
  const vl = clamp(finite((lis.vx * ux + lis.vy * uy + lis.vz * uz) / d), -maxSpeed, maxSpeed);
  return clamp((cc - vl) / Math.max(1, cc - vs), 0.5, 2);
}

// ---- sim time → audio time -------------------------------------------------------------------

/**
 * Maps simulation time to AudioContext time. Each frame the sim advances `simDt` and its events
 * carry times inside (simTime − simDt, simTime]; the start of that interval is mapped to
 * `audioNow + lookahead`, so every event of the frame lands in the future at its exact spacing
 * (the scheduling formula of the reuse analysis). The offset is smoothed against frame jitter
 * and re-synchronised after pauses, stalls and drifts larger than `resyncAfter`.
 */
export class SimAudioClock {
  /** audioTime − simTime, s (NaN until the first advancing frame). */
  offset = NaN;
  private stalled = true;

  constructor(
    readonly lookahead = 0.03,
    readonly resyncAfter = 0.05,
    readonly smoothing = 0.2,
  ) {}

  /** Call once per frame. A frame that did not advance the sim leaves the clock stalled. */
  update(simTime: number, simDt: number, audioNow: number): void {
    if (!(simDt > 0) || !Number.isFinite(simTime) || !Number.isFinite(audioNow)) {
      this.stalled = true;
      return;
    }
    const target = audioNow + this.lookahead - (simTime - simDt);
    if (
      this.stalled ||
      !Number.isFinite(this.offset) ||
      Math.abs(target - this.offset) > this.resyncAfter
    ) {
      this.offset = target;
    } else {
      this.offset += (target - this.offset) * this.smoothing;
    }
    this.stalled = false;
  }

  /** Audio time for a sim time, never earlier than `audioNow`. */
  toAudio(simTime: number, audioNow: number): number {
    if (!Number.isFinite(this.offset)) return audioNow + this.lookahead;
    const t = simTime + this.offset;
    return Number.isFinite(t) && t > audioNow ? t : audioNow;
  }

  reset(): void {
    this.offset = NaN;
    this.stalled = true;
  }
}

// ---- delayed sounds, queued in sim time ------------------------------------------------------

export interface QueuedSound<T> extends Point3 {
  /** Sim time the sound was made. */
  emitT: number;
  payload: T;
}

/**
 * World sounds on their way to the listener. They wait here in SIM time (a pause stops them in
 * flight) and are handed to the audio clock only shortly before they arrive, once their
 * arrival time, re-predicted every frame for the moving listener, is within `horizon` seconds.
 * Sounds that would arrive more than `maxLate` seconds late (a camera cut moved the listener
 * past them) are dropped rather than played out of place. 1,024 sounds cover a burst heard
 * 10 km away (one impact group per frame for 30 s of travel); when full, new sounds are
 * refused, so the ones about to arrive are never the ones lost.
 */
export class DelayQueue<T> {
  private items: QueuedSound<T>[] = [];
  /** Sounds refused because the queue was full. */
  refused = 0;

  constructor(
    readonly capacity = 1024,
    readonly maxLate = 0.5,
  ) {}

  get length(): number {
    return this.items.length;
  }

  /** Queue a sound. Returns the queued entry, or null when the queue is full. */
  push(emitT: number, x: number, y: number, z: number, payload: T): QueuedSound<T> | null {
    if (this.items.length >= this.capacity) {
      this.refused++;
      return null;
    }
    const item = { emitT, x, y, z, payload };
    this.items.push(item);
    return item;
  }

  /**
   * Hand over every sound whose predicted arrival is at or before `now + horizon` (sim time):
   * `due(item, arrival)` gets its arrival sim time. Each sound travels at the speed of sound of
   * its own path (the mean height of source and listener). Returns how many were released.
   */
  release(
    now: number,
    horizon: number,
    listener: MovingPoint,
    due: (item: QueuedSound<T>, arrival: number) => void,
  ): number {
    let released = 0;
    let keep = 0;
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const c = soundSpeed(item.y, listener.y);
      const arrival = arrivalTime(item.emitT, item, now, listener, c);
      if (arrival <= now + horizon) {
        if (arrival >= now - this.maxLate) {
          due(item, arrival);
          released++;
        }
      } else {
        this.items[keep++] = item;
      }
    }
    this.items.length = keep;
    return released;
  }

  clear(): void {
    this.items.length = 0;
  }
}

// ---- impacts, aggregated per frame and area ----------------------------------------------------

export type ImpactKind = 'armour' | 'hei' | 'ground' | 'water' | 'ricochet';

export interface ImpactGroup extends Point3 {
  kind: ImpactKind;
  /** Earliest impact of the group, sim s. */
  t: number;
  count: number;
  /** Sum of the impacts' strengths (≈ energy, 1 per round). */
  strength: number;
}

/**
 * Collects the frame's 30 mm impacts into groups of the same kind within `cellSize` metres, so
 * 65 impacts per second become a handful of sounds per frame, each one voice. Groups are pooled:
 * no allocation per frame.
 */
export class ImpactAggregator {
  private groups: ImpactGroup[] = [];
  private used = 0;

  constructor(
    readonly cellSize = 30,
    readonly maxGroups = 8,
  ) {
    for (let i = 0; i < maxGroups; i++) {
      this.groups.push({ kind: 'ground', t: 0, x: 0, y: 0, z: 0, count: 0, strength: 0 });
    }
  }

  get size(): number {
    return this.used;
  }

  add(kind: ImpactKind, t: number, x: number, y: number, z: number, strength = 1): void {
    let best: ImpactGroup | null = null;
    let bestD = Infinity;
    for (let i = 0; i < this.used; i++) {
      const g = this.groups[i];
      if (g.kind !== kind) continue;
      const d = Math.hypot(g.x - x, g.y - y, g.z - z);
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    if (!best || (bestD > this.cellSize && this.used < this.maxGroups)) {
      if (this.used < this.maxGroups) {
        const g = this.groups[this.used++];
        g.kind = kind;
        g.t = t;
        g.x = x;
        g.y = y;
        g.z = z;
        g.count = 1;
        g.strength = strength;
        return;
      }
      // full and no group of this kind: merge into the nearest group of any kind
      for (let i = 0; i < this.used; i++) {
        const g = this.groups[i];
        const d = Math.hypot(g.x - x, g.y - y, g.z - z);
        if (d < bestD) {
          bestD = d;
          best = g;
        }
      }
    }
    if (!best) return;
    const n = best.count + 1;
    best.x += (x - best.x) / n;
    best.y += (y - best.y) / n;
    best.z += (z - best.z) / n;
    best.t = Math.min(best.t, t);
    best.count = n;
    best.strength += strength;
  }

  /** Emit every group (then forget them). */
  flush(out: (group: ImpactGroup) => void): void {
    for (let i = 0; i < this.used; i++) out(this.groups[i]);
    this.used = 0;
  }
}

// ---- the aircraft's recent past, for retarded-time evaluation ---------------------------------

/** What continuous outside sources need of the aircraft at a moment. */
export interface SourceSample extends MovingPoint {
  t: number;
  gunRate: number;
  gunSpin: number;
  n1a: number;
  n1b: number;
  n2a: number;
  n2b: number;
}

export function createSourceSample(): SourceSample {
  return {
    t: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    gunRate: 0,
    gunSpin: 0,
    n1a: 0,
    n1b: 0,
    n2a: 0,
    n2b: 0,
  };
}

const FIELDS = 13;

/**
 * A ring buffer of the aircraft's state, one sample per frame, so a listener outside hears the
 * gun and the engines as they were when the sound left them: at the retarded time t − τ with
 * τ = |source(t − τ) − listener(t)| / c. That gives the propagation delay and, from the way τ
 * changes, the Doppler shift of a fly-by, all in sim time.
 */
export class SourceHistory {
  private readonly data: Float64Array;
  private count = 0;
  private head = 0;

  constructor(readonly capacity = 1500) {
    this.data = new Float64Array(capacity * FIELDS);
  }

  get length(): number {
    return this.count;
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
  }

  /** Append a sample; samples must arrive in increasing time (older ones are ignored). */
  push(s: SourceSample): void {
    if (this.count > 0 && !(s.t > this.timeAt(this.count - 1))) {
      if (s.t === this.timeAt(this.count - 1)) this.write(this.indexOf(this.count - 1), s);
      return;
    }
    const slot = this.head;
    this.write(slot, s);
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Oldest and newest times held (NaN when empty). */
  get oldest(): number {
    return this.count ? this.timeAt(0) : NaN;
  }

  get newest(): number {
    return this.count ? this.timeAt(this.count - 1) : NaN;
  }

  /** The state at time `t`, linearly interpolated, clamped to the held range. */
  sample(t: number, out: SourceSample): SourceSample {
    if (this.count === 0) return out;
    if (!(t > this.timeAt(0))) return this.read(this.indexOf(0), out);
    if (t >= this.timeAt(this.count - 1)) return this.read(this.indexOf(this.count - 1), out);
    let lo = 0;
    let hi = this.count - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.timeAt(mid) <= t) lo = mid;
      else hi = mid;
    }
    const a = this.indexOf(lo) * FIELDS;
    const b = this.indexOf(hi) * FIELDS;
    const ta = this.data[a];
    const tb = this.data[b];
    const k = tb > ta ? (t - ta) / (tb - ta) : 0;
    const d = this.data;
    out.t = t;
    out.x = d[a + 1] + (d[b + 1] - d[a + 1]) * k;
    out.y = d[a + 2] + (d[b + 2] - d[a + 2]) * k;
    out.z = d[a + 3] + (d[b + 3] - d[a + 3]) * k;
    out.vx = d[a + 4] + (d[b + 4] - d[a + 4]) * k;
    out.vy = d[a + 5] + (d[b + 5] - d[a + 5]) * k;
    out.vz = d[a + 6] + (d[b + 6] - d[a + 6]) * k;
    out.gunRate = d[a + 7] + (d[b + 7] - d[a + 7]) * k;
    out.gunSpin = d[a + 8] + (d[b + 8] - d[a + 8]) * k;
    out.n1a = d[a + 9] + (d[b + 9] - d[a + 9]) * k;
    out.n1b = d[a + 10] + (d[b + 10] - d[a + 10]) * k;
    out.n2a = d[a + 11] + (d[b + 11] - d[a + 11]) * k;
    out.n2b = d[a + 12] + (d[b + 12] - d[a + 12]) * k;
    return out;
  }

  /**
   * Retarded time: the emission time t_e ≤ now whose sound reaches the listener (at `L`, now):
   * now − t_e = |source(t_e) − L| / c. Newton's method on g(τ) = |S(now − τ) − L| / c − τ with
   * the stored velocity for the slope (g' = −u·V / c − 1 < 0 for any subsonic source), so it
   * converges in a few steps even for a fast fly-by. Fills `out` with the source state at t_e
   * and returns the delay τ.
   */
  retarded(now: number, L: Point3, c: number, out: SourceSample): number {
    if (this.count === 0) return 0;
    const cc = Math.max(1, finite(c, 340));
    this.sample(now, out);
    let tau = Math.hypot(out.x - L.x, out.y - L.y, out.z - L.z) / cc;
    for (let i = 0; i < 8; i++) {
      this.sample(now - tau, out);
      const dx = out.x - L.x;
      const dy = out.y - L.y;
      const dz = out.z - L.z;
      const d = Math.hypot(dx, dy, dz);
      const g = d / cc - tau;
      if (Math.abs(g) < 1e-7) break;
      const uv = d > 1e-9 ? (dx * out.vx + dy * out.vy + dz * out.vz) / d : 0;
      const slope = Math.min(-0.05, -uv / cc - 1);
      tau = Math.max(0, tau - g / slope);
    }
    this.sample(now - tau, out);
    return tau;
  }

  private indexOf(i: number): number {
    // i = 0 is the oldest sample held
    const start = this.count < this.capacity ? 0 : this.head;
    return (start + i) % this.capacity;
  }

  private timeAt(i: number): number {
    return this.data[this.indexOf(i) * FIELDS];
  }

  private write(slot: number, s: SourceSample): void {
    const o = slot * FIELDS;
    const d = this.data;
    d[o] = s.t;
    d[o + 1] = s.x;
    d[o + 2] = s.y;
    d[o + 3] = s.z;
    d[o + 4] = s.vx;
    d[o + 5] = s.vy;
    d[o + 6] = s.vz;
    d[o + 7] = s.gunRate;
    d[o + 8] = s.gunSpin;
    d[o + 9] = s.n1a;
    d[o + 10] = s.n1b;
    d[o + 11] = s.n2a;
    d[o + 12] = s.n2b;
  }

  private read(slot: number, out: SourceSample): SourceSample {
    const o = slot * FIELDS;
    const d = this.data;
    out.t = d[o];
    out.x = d[o + 1];
    out.y = d[o + 2];
    out.z = d[o + 3];
    out.vx = d[o + 4];
    out.vy = d[o + 5];
    out.vz = d[o + 6];
    out.gunRate = d[o + 7];
    out.gunSpin = d[o + 8];
    out.n1a = d[o + 9];
    out.n1b = d[o + 10];
    out.n2a = d[o + 11];
    out.n2b = d[o + 12];
    return out;
  }
}

// ---- supersonic rounds passing the listener ----------------------------------------------------

/**
 * When the shock wave of a supersonic round passing at perpendicular distance `miss` reaches
 * the listener, after the moment the round is abeam (closest), s. The first sound to arrive is
 * the Mach wave: of all the points the round passed, the one b·tan μ before the abeam point
 * (sin μ = c / v) gets its sound there first, and the arrival works out at b·cos μ / c (between
 * 0 for a very slow-to-sonic round and b / c for a very fast one). NaN for a subsonic round:
 * no shock wave, no crack.
 */
export function crackDelay(miss: number, speed: number, c: number): number {
  const v = finite(speed);
  const cc = Math.max(1, finite(c, 340));
  if (!(v > cc)) return NaN;
  const b = Math.max(0, finite(miss));
  const sinMu = cc / v;
  return (b * Math.sqrt(1 - sinMu * sinMu)) / cc;
}

/** Shock-wave strength at perpendicular distance `miss` relative to 5 m (N-waves fall as b^−3/4). */
export function crackGain(miss: number): number {
  return Math.min(1.5, Math.pow(5 / Math.max(1, finite(miss, 1e6)), 0.75));
}
