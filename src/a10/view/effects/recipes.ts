/**
 * Effect recipes: what each kind of event looks like, built from particles, decals and pressure
 * rings. Sizes are physical (metres, seconds); counts scale with the quality preset (`detail`)
 * and thin out with distance, while every particle keeps a minimum on-screen size so a burst seen
 * from 1–2 km still reads as separate spurts and flashes.
 *
 * Reference picture (PLAN_A10.md §6.2, §6.3, §13): a 30 mm round in dirt throws a spurt a few
 * metres tall that lingers 1–3 s; rounds land ≈2.4 m apart, so a burst walks through the target
 * as a line of spurts. API on armour is a white incendiary sparkle (the depleted-uranium core
 * burns); HEI is a small flash and a grey-black puff. Explosions scale with the cube root of the
 * charge (blast scaling).
 */
import { Vector3 } from 'three';
import type { RoundOutcome } from '../../core/targets/types';
import type { SurfaceKind } from '../../core/world/types';
import { DECAL, type DecalPool } from './decals';
import { fxRandom } from './noise';
import { PK } from './particleKinds';
import type { ParticleSystem } from './ParticleSystem';
import type { RingPool } from './rings';
import { surfaceFx } from './surfaces';

export interface FxContext {
  ps: ParticleSystem;
  decals: DecalPool;
  rings: RingPool;
  /** World camera position (level of detail by distance). */
  camera: Vector3;
  /** Particle count multiplier from the quality preset (≈0.45 low … 1.3 high). */
  detail: number;
  /** Ground height under a point (the terrain's heightAt). */
  groundAt(x: number, z: number): number;
}

export type ImpactOutcome = RoundOutcome | 'ground' | 'skip' | 'water';

const R = fxRandom;
const _dir = new Vector3();
const _t = new Vector3();
const _b = new Vector3();
const _ringColor = new Vector3();

/** Random unit vector within `spread` rad of the unit axis (ax, ay, az). */
function cone(ax: number, ay: number, az: number, spread: number, out: Vector3): Vector3 {
  const cosT = 1 - R.next() * (1 - Math.cos(spread));
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = R.next() * Math.PI * 2;
  if (Math.abs(ay) < 0.98) _t.set(az, 0, -ax).normalize();
  else _t.set(1, 0, 0);
  _b.set(ay * _t.z - az * _t.y, az * _t.x - ax * _t.z, ax * _t.y - ay * _t.x);
  const c = Math.cos(phi) * sinT;
  const s = Math.sin(phi) * sinT;
  return out.set(
    ax * cosT + _t.x * c + _b.x * s,
    ay * cosT + _t.y * c + _b.y * s,
    az * cosT + _t.z * c + _b.z * s,
  );
}

/** Count after quality and distance scaling, at least `min`. */
function count(ctx: FxContext, n: number, lod: number, min = 1): number {
  const v = n * ctx.detail * lod;
  const whole = Math.floor(v);
  return Math.max(min, whole + (R.next() < v - whole ? 1 : 0));
}

/** Distance level of detail: 1 near, thinning out to 0.3 far away. */
function lodAt(ctx: FxContext, x: number, y: number, z: number): number {
  const d = Math.hypot(x - ctx.camera.x, y - ctx.camera.y, z - ctx.camera.z);
  return d < 700 ? 1 : d < 1800 ? 0.8 : d < 4000 ? 0.55 : 0.32;
}

function brighten(c: readonly [number, number, number], f: number): [number, number, number] {
  return [c[0] * f, c[1] * f, c[2] * f];
}

const _col: [number, number, number] = [0, 0, 0];
function mix3(a: readonly number[], b: readonly number[], t: number): [number, number, number] {
  _col[0] = a[0] + (b[0] - a[0]) * t;
  _col[1] = a[1] + (b[1] - a[1]) * t;
  _col[2] = a[2] + (b[2] - a[2]) * t;
  return _col;
}

const SOOT = [0.035, 0.032, 0.03] as const;
const GREY_SMOKE = [0.2, 0.19, 0.18] as const;

// ---------------------------------------------------------------------------------------------
// Sparks, flashes and streaks
// ---------------------------------------------------------------------------------------------

/** A burst of sparks in a cone around (nx, ny, nz). */
export function sparks(
  ctx: FxContext,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  n: number,
  spread: number,
  speedMin: number,
  speedMax: number,
  lifeMin = 0.25,
  lifeMax = 0.7,
  heat = 1,
): void {
  const { ps } = ctx;
  for (let k = 0; k < n; k++) {
    cone(nx, ny, nz, spread, _dir);
    const v = R.range(speedMin, speedMax);
    const i = ps.spawn(
      PK.spark,
      x,
      y,
      z,
      _dir.x * v,
      _dir.y * v,
      _dir.z * v,
      R.range(0.05, 0.11),
      0.04,
      R.range(lifeMin, lifeMax),
    );
    ps.emissive(i, heat * R.range(0.6, 1.2));
  }
}

/** A short bright flash (additive): size in metres, life in seconds. */
export function flash(ctx: FxContext, x: number, y: number, z: number, size: number, life: number, brightness = 1): void {
  const i = ctx.ps.spawn(PK.flash, x, y, z, 0, 0, 0, size * 0.55, size, life);
  ctx.ps.emissive(i, brightness);
}

// ---------------------------------------------------------------------------------------------
// 30 mm impacts
// ---------------------------------------------------------------------------------------------

/** A 30 mm round hitting the ground (or water). */
export function impactGround(
  ctx: FxContext,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  nx: number,
  ny: number,
  nz: number,
  surface: SurfaceKind,
  round: number,
  outcome: ImpactOutcome,
): void {
  const { ps } = ctx;
  const s = surfaceFx(surface);
  const lod = lodAt(ctx, x, y, z);
  const speed = Math.hypot(vx, vy, vz) || 1;
  const dx = vx / speed;
  const dy = vy / speed;
  const dz = vz / speed;
  // the round's path reflected off the ground: spray leans along it
  const dn = dx * nx + dy * ny + dz * nz;
  let rx = dx - 2 * dn * nx;
  let rz = dz - 2 * dn * nz;
  const rh = Math.hypot(rx, rz) || 1;
  rx /= rh;
  rz /= rh;
  const energy = Math.min(1.3, speed / 750);
  ps.groundY = ctx.groundAt(x, z);

  if (s.water || outcome === 'water') {
    splash(ctx, x, y, z, 1, lod);
    return;
  }

  const skip = outcome === 'skip';
  const k = skip ? 0.55 : 1;
  // the spurt: a dark core of soil shooting up, leaning along the reflected path
  const jets = count(ctx, (1.6 + 0.9 * s.ejecta) * k, lod, 1);
  const jetCol = mix3(s.dust, s.clod, 0.6);
  for (let j = 0; j < jets; j++) {
    cone(nx, ny, nz, 0.28, _dir);
    const v = R.range(21, 31) * energy * (0.85 + 0.3 * s.ejecta);
    const lean = R.range(2, 7);
    const i = ps.spawn(
      PK.dustJet,
      x + R.signed(0.3),
      y + 0.2,
      z + R.signed(0.3),
      _dir.x * v + rx * lean,
      _dir.y * v,
      _dir.z * v + rz * lean,
      R.range(0.7, 1.0),
      R.range(2.6, 3.6),
      R.range(1.5, 2.4),
    );
    ps.color(i, jetCol[0], jetCol[1], jetCol[2], 1);
  }
  // clods of soil
  const clods = count(ctx, 5 * s.ejecta * k, lod, 0);
  for (let j = 0; j < clods; j++) {
    cone(nx, ny, nz, 0.75, _dir);
    const v = R.range(7, 20) * energy;
    const i = ps.spawn(
      PK.clod,
      x,
      y + 0.1,
      z,
      _dir.x * v + rx * 3,
      _dir.y * v,
      _dir.z * v + rz * 3,
      R.range(0.18, 0.4),
      0.3,
      R.range(0.9, 1.8),
    );
    ps.color(i, s.clod[0], s.clod[1], s.clod[2]);
  }
  // the dust that lingers 1–3 s around the spurt and drifts off
  const puffs = count(ctx, (1.8 + 1.4 * s.dustiness) * k, lod);
  for (let j = 0; j < puffs; j++) {
    const a = R.next() * Math.PI * 2;
    const h = R.range(1.5, 4);
    const i = ps.spawn(
      PK.dust,
      x + R.signed(0.5),
      y + 0.5,
      z + R.signed(0.5),
      Math.cos(a) * h + rx * R.range(1, 4),
      R.range(2.5, 7) * energy,
      Math.sin(a) * h + rz * R.range(1, 4),
      R.range(1.3, 1.9),
      R.range(5, 7.5) * (0.8 + 0.25 * s.dustiness),
      R.range(2.4, 4.4),
    );
    ps.color(i, s.dust[0] * 0.85, s.dust[1] * 0.85, s.dust[2] * 0.85, 0.78);
  }
  if (s.fleck && lod > 0.5) {
    const n = count(ctx, 4, lod, 0);
    for (let j = 0; j < n; j++) {
      cone(nx, ny, nz, 0.9, _dir);
      const v = R.range(5, 14);
      const i = ps.spawn(PK.fleck, x, y + 0.2, z, _dir.x * v, _dir.y * v, _dir.z * v, R.range(0.15, 0.3), 0.25, R.range(1, 2));
      ps.color(i, s.fleck[0], s.fleck[1], s.fleck[2]);
    }
  }
  if (s.sparks > 0) {
    sparks(ctx, x, y + 0.05, z, rx * 0.6 + nx * 0.4, ny * 0.6, rz * 0.6 + nz * 0.4, count(ctx, 6 * s.sparks, lod), 0.9, 15, 55);
    flash(ctx, x, y + 0.2, z, 0.7, 0.04, 0.4);
  }
  if (round === 1) heiBurst(ctx, x, y + 0.3, z, nx, ny, nz, lod, false);
  if (skip) {
    // the round skips on: a streak of dust or, on hard ground, a spark along the new path
    const v = speed * 0.55;
    if (s.sparks > 0) {
      const i = ps.spawn(PK.streak, x, y + 0.1, z, rx * v, Math.abs(dn) * v * 0.5, rz * v, 0.12, 0.08, R.range(0.12, 0.25));
      ps.emissive(i, 0.8);
    }
  }
  if (!skip) ctx.decals.add(x, ps.groundY, z, nx, ny, nz, R.range(0.6, 0.9), DECAL.dirt, 150);
}

/** A 30 mm round hitting a vehicle. */
export function impactVehicle(
  ctx: FxContext,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  nx: number,
  ny: number,
  nz: number,
  round: number,
  outcome: ImpactOutcome,
): void {
  const { ps } = ctx;
  const lod = lodAt(ctx, x, y, z);
  const speed = Math.hypot(vx, vy, vz) || 1;
  const dx = vx / speed;
  const dy = vy / speed;
  const dz = vz / speed;
  const dn = dx * nx + dy * ny + dz * nz;
  const rx = dx - 2 * dn * nx;
  const ry = dy - 2 * dn * ny;
  const rz = dz - 2 * dn * nz;
  ps.groundY = ctx.groundAt(x, z);
  // step the effect out of the plate so the sprites are not inside the hull
  const ox = x + nx * 0.15;
  const oy = y + ny * 0.15;
  const oz = z + nz * 0.15;

  if (round === 1 || outcome === 'burst') {
    heiBurst(ctx, ox, oy, oz, nx, ny, nz, lod, true);
    return;
  }
  if (outcome === 'ricochet') {
    ricochet(ctx, ox, oy, oz, rx, ry, rz, speed, lod);
    return;
  }
  const api = round === 0;
  const pen = outcome === 'penetrated' || outcome === 'passedThrough';
  if (api) {
    // depleted uranium burns: a white flash and a sparkle of burning fragments
    flash(ctx, ox, oy, oz, pen ? 1.5 : 2.1, pen ? 0.06 : 0.08, pen ? 0.9 : 1.2);
    const glints = count(ctx, pen ? 3 : 6, lod);
    for (let j = 0; j < glints; j++) {
      ps.delay = R.range(0.0, 0.3);
      const i = ps.spawn(
        PK.glint,
        ox + R.signed(0.7),
        oy + R.signed(0.5),
        oz + R.signed(0.7),
        0,
        R.range(0, 1),
        0,
        R.range(0.25, 0.5),
        0.15,
        R.range(0.05, 0.14),
      );
      ps.emissive(i, R.range(0.6, 1.1));
    }
    ps.delay = 0;
    // sparks: a fan off the plate when stopped, fewer and back along the path when through
    if (pen) {
      sparks(ctx, ox, oy, oz, nx * 0.6 - dx * 0.4, ny * 0.6 - dy * 0.4, nz * 0.6 - dz * 0.4, count(ctx, 6, lod), 0.8, 10, 40, 0.3, 0.9);
      // a moment later the round's flash inside vents out of the hole as smoke
      ps.delay = R.range(0.03, 0.09);
      flash(ctx, ox, oy, oz, 0.9, 0.05, 0.6);
      const i = ps.spawn(PK.smoke, ox, oy, oz, nx * 4, ny * 4 + 1, nz * 4, 0.3, 1.8, R.range(1.5, 2.5));
      ps.color(i, GREY_SMOKE[0] * 0.5, GREY_SMOKE[1] * 0.5, GREY_SMOKE[2] * 0.5, 0.7);
      ps.delay = 0;
    } else {
      sparks(ctx, ox, oy, oz, nx * 0.5 + rx * 0.5, ny * 0.5 + ry * 0.5, nz * 0.5 + rz * 0.5, count(ctx, 13, lod), 1.1, 18, 65, 0.3, 1.0);
    }
    const puffs = count(ctx, 1.5, lod);
    for (let j = 0; j < puffs; j++) {
      const i = ps.spawn(
        PK.smoke,
        ox,
        oy,
        oz,
        nx * R.range(1, 3) + R.signed(1),
        ny * R.range(1, 3) + 0.8,
        nz * R.range(1, 3) + R.signed(1),
        0.4,
        R.range(1.8, 2.8),
        R.range(1.4, 2.4),
      );
      ps.color(i, 0.42, 0.41, 0.4, 0.55);
    }
  } else {
    // practice round: a dull spark and a puff of paint and dust
    sparks(ctx, ox, oy, oz, nx, ny, nz, count(ctx, 5, lod), 1.0, 10, 35, 0.2, 0.5, 0.7);
    const i = ps.spawn(PK.dust, ox, oy, oz, nx * 2, ny * 2 + 1, nz * 2, 0.4, 1.8, 1.5);
    ps.color(i, 0.35, 0.33, 0.3, 0.6);
  }
}

/** High-explosive incendiary burst: a small flash, a fireball flicker, a grey-black puff. */
function heiBurst(ctx: FxContext, x: number, y: number, z: number, nx: number, ny: number, nz: number, lod: number, onArmour: boolean): void {
  const { ps } = ctx;
  flash(ctx, x, y, z, 2.0, 0.06, 1.0);
  const fb = count(ctx, 2, lod);
  for (let j = 0; j < fb; j++) {
    cone(nx, ny, nz, 1.2, _dir);
    const i = ps.spawn(PK.fireball, x, y, z, _dir.x * 4, _dir.y * 4, _dir.z * 4, 0.5, R.range(1.4, 2.0), R.range(0.5, 0.8));
    ps.emissive(i, 0.7);
  }
  const puffs = count(ctx, 2.5, lod);
  for (let j = 0; j < puffs; j++) {
    cone(nx, ny, nz, 1.0, _dir);
    const v = R.range(1.5, 4);
    const i = ps.spawn(
      PK.smoke,
      x,
      y,
      z,
      _dir.x * v,
      _dir.y * v + 1,
      _dir.z * v,
      R.range(0.6, 0.9),
      R.range(2.6, 3.8),
      R.range(2.0, 3.4),
    );
    ps.color(i, 0.07, 0.065, 0.06, 0.85);
  }
  sparks(ctx, x, y, z, nx, ny, nz, count(ctx, onArmour ? 8 : 5, lod), 1.25, 15, 60, 0.15, 0.45);
}

/** A ricochet: sparks at the contact and a streak along the new path. */
export function ricochet(
  ctx: FxContext,
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number,
  speed: number,
  lod: number,
): void {
  const { ps } = ctx;
  const v = speed * R.range(0.4, 0.65);
  const i = ps.spawn(PK.streak, x, y, z, rx * v, ry * v, rz * v, 0.14, 0.1, R.range(0.15, 0.3));
  ps.emissive(i, 1);
  sparks(ctx, x, y, z, rx, ry, rz, count(ctx, 7, lod), 0.45, 30, 90, 0.15, 0.45);
  flash(ctx, x, y, z, 1.0, 0.04, 0.7);
}

/** Water: a white column of spray and mist. */
export function splash(ctx: FxContext, x: number, y: number, z: number, scale: number, lod: number): void {
  const { ps } = ctx;
  ps.groundY = y - 0.3;
  const jets = count(ctx, 5 * scale, lod);
  for (let j = 0; j < jets; j++) {
    cone(0, 1, 0, 0.35, _dir);
    const v = R.range(9, 16) * Math.sqrt(scale);
    ps.spawn(PK.splash, x, y, z, _dir.x * v, _dir.y * v, _dir.z * v, 0.4 * scale, 1.4 * scale, R.range(1.0, 1.7));
  }
  const mist = count(ctx, 3 * scale, lod);
  for (let j = 0; j < mist; j++) {
    ps.spawn(PK.mist, x + R.signed(0.5), y + 0.5, z + R.signed(0.5), R.signed(2), R.range(1, 3), R.signed(2), 0.8 * scale, 3.5 * scale, R.range(1.5, 2.8));
  }
}

// ---------------------------------------------------------------------------------------------
// Explosions
// ---------------------------------------------------------------------------------------------

export type DetonationKind = 'bomb' | 'rocket' | 'missile' | 'hei' | 'secondary' | 'whitePhosphorus' | 'dud';

export interface ExplosionOptions {
  /** Detonated on or against a vehicle (more metal, less soil). */
  onVehicle: boolean;
  /** Burning fuel (fuel truck): a rolling fireball and black smoke. */
  fuel: boolean;
  /** Ground normal at the point (decal). */
  nx: number;
  ny: number;
  nz: number;
}

const EXPLOSION_DEFAULTS: ExplosionOptions = { onVehicle: false, fuel: false, nx: 0, ny: 1, nz: 0 };

/**
 * An explosion of `charge` kg TNT equivalent: flash, fireball, rising smoke, dust skirt and
 * thrown soil for ground bursts, debris, sparks, the pressure ring and a crater or scorch decal.
 */
export function explosion(
  ctx: FxContext,
  x: number,
  y: number,
  z: number,
  charge: number,
  kind: DetonationKind,
  surface: SurfaceKind,
  opts: Partial<ExplosionOptions> = EXPLOSION_DEFAULTS,
): void {
  const o = opts === EXPLOSION_DEFAULTS ? EXPLOSION_DEFAULTS : { ...EXPLOSION_DEFAULTS, ...opts };
  const { ps } = ctx;
  const baseDelay = ps.delay;
  const s = Math.cbrt(Math.max(0.02, charge));
  const sf = surfaceFx(surface);
  const lod = lodAt(ctx, x, y, z);
  const ground = ctx.groundAt(x, z);
  ps.groundY = ground;
  const nearGround = y - ground < 2 + 2 * s;
  const soil = nearGround && !o.onVehicle && !sf.water;
  const sq = Math.sqrt(s);
  const fuel = o.fuel;

  // flash and glow
  flash(ctx, x, y + 0.5 * s, z, 3.2 * s + 0.5, 0.05 + 0.025 * s, 1.2);
  if (s > 1) {
    const i = ps.spawn(PK.glint, x, y + s, z, 0, 0, 0, 5 * s, 7 * s, 0.14 + 0.03 * s);
    ps.emissive(i, 0.35);
    ps.color(i, 1, 0.7, 0.4);
  }

  // fireball
  const nFire = count(ctx, (fuel ? 14 : 5) + (fuel ? 8 : 5) * Math.min(s, 4), lod, 2);
  for (let j = 0; j < nFire; j++) {
    cone(0, 1, 0, fuel ? 1.0 : 1.4, _dir);
    const v = R.range(4, 11) * sq * (fuel ? 0.8 : 1);
    const r = R.next() * 0.45 * s;
    const i = ps.spawn(
      PK.fireball,
      x + _dir.x * r,
      y + 0.35 * s + _dir.y * r,
      z + _dir.z * r,
      _dir.x * v,
      _dir.y * v + (fuel ? 6 : 2) * sq,
      _dir.z * v,
      0.9 * s,
      R.range(2.0, 2.8) * s * (fuel ? 1.4 : 1),
      (0.7 + 0.28 * s) * R.range(0.75, 1.25) * (fuel ? 2.2 : 1),
    );
    ps.emissive(i, R.range(0.8, 1.2));
  }

  // smoke: dark, mixed with dust for a ground burst, rising
  const nSmoke = count(ctx, 6 + 6 * Math.min(s, 4.5), lod, 2);
  const smokeCol = soil ? mix3(sf.dust, SOOT, 0.62) : mix3(SOOT, GREY_SMOKE, 0.12);
  const sr = smokeCol[0];
  const sg = smokeCol[1];
  const sb = smokeCol[2];
  for (let j = 0; j < nSmoke; j++) {
    cone(0, 1, 0, 1.3, _dir);
    const v = R.range(3, 9) * sq;
    const i = ps.spawn(
      fuel ? PK.blackSmoke : PK.smoke,
      x + _dir.x * 0.5 * s,
      y + 0.4 * s + _dir.y * 0.5 * s,
      z + _dir.z * 0.5 * s,
      _dir.x * v,
      _dir.y * v + R.range(2, 5) * sq,
      _dir.z * v,
      1.1 * s,
      R.range(3.5, 5.2) * s,
      (7 + 3.5 * s) * R.range(0.7, 1.3) * (fuel ? 1.8 : 1),
    );
    if (fuel) ps.color(i, 0.03, 0.028, 0.026, 0.95);
    else ps.color(i, sr, sg, sb, 0.85);
  }

  if (sf.water && nearGround) splash(ctx, x, ground, z, Math.min(6, 1.2 * s), lod);

  if (soil) {
    // skirt of dust racing out along the ground
    const nSkirt = count(ctx, 10 + 6 * Math.min(s, 4), lod, 3);
    for (let j = 0; j < nSkirt; j++) {
      const a = (j / nSkirt) * Math.PI * 2 + R.signed(0.3);
      const v = R.range(16, 30) * sq;
      const i = ps.spawn(
        PK.dustRing,
        x + Math.cos(a) * 0.5 * s,
        ground + 0.25 * s,
        z + Math.sin(a) * 0.5 * s,
        Math.cos(a) * v,
        R.range(0.5, 2.5),
        Math.sin(a) * v,
        0.7 * s,
        R.range(2.4, 3.4) * s,
        R.range(4, 8) * (0.8 + 0.1 * s),
      );
      ps.color(i, sf.dust[0] * 0.8, sf.dust[1] * 0.8, sf.dust[2] * 0.8, 0.5);
    }
    // the dirt fountain: a dense cone of dark soil thrown up, falling back
    const nEj = count(ctx, 14 + 6 * Math.min(s, 4), lod, 3);
    const ec = mix3(sf.clod, sf.dust, 0.3);
    for (let j = 0; j < nEj; j++) {
      cone(o.nx, o.ny, o.nz, 0.36, _dir);
      const v = R.range(16, 34) * Math.pow(s, 0.42);
      ps.delay += R.range(0, 0.06);
      const i = ps.spawn(
        PK.ejecta,
        x + _dir.x * 0.3 * s,
        ground + 0.3 * s,
        z + _dir.z * 0.3 * s,
        _dir.x * v,
        _dir.y * v,
        _dir.z * v,
        0.6 * s,
        R.range(1.8, 2.5) * s,
        R.range(2.2, 3.6) * (0.8 + 0.08 * s),
      );
      ps.delay = baseDelay;
      ps.color(i, ec[0], ec[1], ec[2], 0.92);
    }
    // finer dirt streaks
    const nJet = count(ctx, 5 + 3 * Math.min(s, 4), lod, 1);
    const jc = mix3(sf.dust, sf.clod, 0.45);
    for (let j = 0; j < nJet; j++) {
      cone(o.nx, o.ny, o.nz, 0.7, _dir);
      const v = R.range(16, 30) * Math.pow(s, 0.45);
      const i = ps.spawn(
        PK.dustJet,
        x,
        ground + 0.3,
        z,
        _dir.x * v,
        _dir.y * v,
        _dir.z * v,
        0.35 * s,
        R.range(1.0, 1.5) * s,
        R.range(1.6, 2.6),
      );
      ps.color(i, jc[0], jc[1], jc[2], 0.95);
    }
    const nClod = count(ctx, 10 + 8 * Math.min(s, 4), lod, 1);
    for (let j = 0; j < nClod; j++) {
      cone(o.nx, o.ny, o.nz, 0.95, _dir);
      const v = R.range(12, 40) * Math.pow(s, 0.4);
      const i = ps.spawn(
        PK.clod,
        x,
        ground + 0.3,
        z,
        _dir.x * v,
        _dir.y * v,
        _dir.z * v,
        Math.min(1.4, R.range(0.25, 0.55) * sq),
        0.3,
        R.range(1.8, 3.6),
      );
      ps.color(i, sf.clod[0], sf.clod[1], sf.clod[2]);
    }
  }

  // debris: metal from a vehicle, stones and chunks otherwise
  const nDebris = count(ctx, (o.onVehicle ? 9 : 3) + 3 * Math.min(s, 4), lod, 0);
  for (let j = 0; j < nDebris; j++) {
    cone(0, 1, 0, 1.15, _dir);
    const v = R.range(12, 38) * Math.pow(s, 0.3);
    const burning = o.onVehicle && charge > 2 && R.next() < 0.35;
    const i = ps.spawn(
      burning ? PK.burningDebris : PK.debris,
      x,
      y + 0.4 * s,
      z,
      _dir.x * v,
      _dir.y * v,
      _dir.z * v,
      Math.min(1.4, R.range(0.2, 0.55) * Math.pow(s, 0.4)),
      0.3,
      R.range(2, 4.5),
    );
    if (burning) ps.trail(i, 14 * ctx.detail);
  }

  if (kind !== 'bomb' || o.onVehicle) {
    sparks(ctx, x, y + 0.3 * s, z, 0, 1, 0, count(ctx, 8 + 6 * Math.min(s, 4), lod), 1.5, 25, 75 * Math.pow(s, 0.25), 0.3, 1.1);
  }

  // the pressure ring
  _ringColor.set(0.85, 0.84, 0.82);
  ctx.rings.add(x, y + 0.3 * s, z, 9 * s + 2, 0.1 + 0.05 * s, s > 1.5 ? 0.55 : 0.3, _ringColor);

  // the mark on the ground
  if (nearGround && !sf.water) {
    const crater = kind === 'bomb' || kind === 'rocket' || kind === 'missile';
    if (crater && !o.onVehicle) {
      ctx.decals.add(x, ground, z, o.nx, o.ny, o.nz, Math.max(1.5, 2.6 * s), DECAL.blast, 900);
      ctx.decals.add(x, ground, z, o.nx, o.ny, o.nz, Math.max(0.8, 1.15 * s), DECAL.crater, 900);
    }
    else ctx.decals.add(x, ground, z, o.nx, o.ny, o.nz, Math.max(0.6, 1.4 * s), DECAL.scorch, 600);
  }
}

/**
 * White phosphorus: a brilliant white flash, dense white smoke that billows out and lingers as a
 * marker, and burning fragments arcing out with smoke trails. Returns nothing; the lingering
 * burn on the ground is a persistent emitter the director adds.
 */
export function whitePhosphorus(ctx: FxContext, x: number, y: number, z: number, surface: SurfaceKind): void {
  const { ps } = ctx;
  const lod = lodAt(ctx, x, y, z);
  ps.groundY = ctx.groundAt(x, z);
  flash(ctx, x, y + 1, z, 7, 0.08, 1.4);
  const nSmoke = count(ctx, 22, lod, 4);
  for (let j = 0; j < nSmoke; j++) {
    cone(0, 1, 0, 1.35, _dir);
    const v = R.range(5, 16);
    ps.spawn(
      PK.wpSmoke,
      x,
      y + 1.2,
      z,
      _dir.x * v,
      _dir.y * v * 0.7 + 1,
      _dir.z * v,
      R.range(1.6, 2.4),
      R.range(9, 14),
      R.range(30, 60),
    );
  }
  const nFrag = count(ctx, 16, lod, 4);
  for (let j = 0; j < nFrag; j++) {
    cone(0, 1, 0, 1.15, _dir);
    const v = R.range(14, 32);
    const i = ps.spawn(PK.wpFragment, x, y + 1, z, _dir.x * v, _dir.y * v, _dir.z * v, R.range(0.25, 0.4), 0.2, R.range(1.4, 2.6));
    ps.trail(i, 32 * ctx.detail);
  }
  const sf = surfaceFx(surface);
  if (!sf.water) ctx.decals.add(x, ps.groundY, z, 0, 1, 0, 3, DECAL.scorch, 300);
}

/** A dud: a thump of dust and soil, no flash, no smoke. */
export function dud(ctx: FxContext, x: number, y: number, z: number, surface: SurfaceKind, size = 1): void {
  const { ps } = ctx;
  const sf = surfaceFx(surface);
  const lod = lodAt(ctx, x, y, z);
  ps.groundY = ctx.groundAt(x, z);
  if (sf.water) {
    splash(ctx, x, y, z, 1.5 * size, lod);
    return;
  }
  const n = count(ctx, 5, lod, 2);
  for (let j = 0; j < n; j++) {
    const a = R.next() * Math.PI * 2;
    const i = ps.spawn(
      PK.dust,
      x,
      y + 0.5,
      z,
      Math.cos(a) * R.range(2, 5),
      R.range(2, 6),
      Math.sin(a) * R.range(2, 5),
      1.2 * size,
      R.range(4, 6) * size,
      R.range(3, 5),
    );
    ps.color(i, sf.dust[0], sf.dust[1], sf.dust[2], 0.85);
  }
  const c = count(ctx, 7, lod, 1);
  for (let j = 0; j < c; j++) {
    cone(0, 1, 0, 0.7, _dir);
    const v = R.range(6, 14);
    const i = ps.spawn(PK.clod, x, y + 0.2, z, _dir.x * v, _dir.y * v, _dir.z * v, R.range(0.2, 0.4) * size, 0.3, R.range(1, 2));
    ps.color(i, sf.clod[0], sf.clod[1], sf.clod[2]);
  }
  ctx.decals.add(x, ps.groundY, z, 0, 1, 0, 1.0 * size, DECAL.dirt, 300);
}

/** Small cook-off pop from a burning wreck: sparks, a flash and a dark puff. */
export function cookOffPop(ctx: FxContext, x: number, y: number, z: number, strength: number): void {
  const { ps } = ctx;
  const lod = lodAt(ctx, x, y, z);
  ps.groundY = ctx.groundAt(x, z);
  flash(ctx, x, y, z, 1.6 + 1.6 * strength, 0.06, 1);
  sparks(ctx, x, y, z, 0, 1, 0, count(ctx, 6 + 10 * strength, lod), 1.0, 12, 45, 0.4, 1.4);
  const i = ps.spawn(PK.fireball, x, y, z, 0, 3, 0, 0.6, 1.6 + 1.5 * strength, 0.7);
  ps.emissive(i, 0.8);
  const j = ps.spawn(PK.smoke, x, y, z, R.signed(1), 3, R.signed(1), 0.8, 3 + 2 * strength, 3);
  ps.color(j, 0.05, 0.045, 0.04, 0.85);
}

export { brighten };
