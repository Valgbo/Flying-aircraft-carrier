/**
 * The effects director: turns the simulation's events and state into effects.
 *
 * - Events (`onSimFrame`, docs/a10/ARCHITECTURE.md §6): roundImpact, detonation, vehicleDestroyed,
 *   crash. Each effect is born at its event's exact time inside the frame (negative age), so a
 *   burst of 65 rounds a second lands as a walking line even at a low frame rate.
 * - State, every frame: the gun (smoke pouring back from the muzzle along the airflow, the muzzle
 *   flash, the 65 Hz vibration), burning vehicles (flames, thick black smoke, a smoke column that
 *   leans with the wind and lasts as long as the fire, embers, cook-off pops), thrown turrets
 *   (fire and smoke trail), smouldering wrecks.
 * - Persistent emitters (white-phosphorus burn, ground fires) and scheduled pops (ammunition
 *   trucks cooking off) live in fixed pools; camera shakes arrive late by distance / speed of sound.
 *
 * Purely cosmetic randomness (Math.random-like) never feeds back into the simulation.
 */
import { Vector3 } from 'three';
import { AMMO_EFFECTS, SECONDARY_CHARGE, VEHICLE_SHAPES } from '../../data/vehicles';
import { A10_GEOMETRY } from '../../data/geometry';
import { GAU8 } from '../../data/gun';
import type { Sim, SimEvent } from '../../core/types';
import type { Vehicle, VehicleKind } from '../../core/targets/types';
import type { SurfaceKind } from '../../core/world/types';
import type { FrameInfo } from '../frame';
import { addShake, setVibration } from '../shake';
import { WP_MARK } from '../stores/look';
import { DECAL } from './decals';
import { fxRandom as R } from './noise';
import { PK } from './particleKinds';
import {
  bombCloud,
  cookOffPop,
  detonationRecipe,
  dud,
  explosion,
  flash,
  impactGround,
  impactVehicle,
  sparks,
  whitePhosphorus,
  type DetonationKind,
  type FxContext,
} from './recipes';
import { surfaceFx } from './surfaces';

const SPEED_OF_SOUND = 343;

const EMIT = { none: 0, wp: 1, groundFire: 2, crashFire: 3, dustCloud: 4 } as const;

/** The dust and smoke a bomb raises keeps coming off the crater for this long, s. */
const DUST_CLOUD_LIFE = 40;

interface FireState {
  id: number;
  stamp: number;
  flameAcc: number;
  smokeAcc: number;
  columnAcc: number;
  emberAcc: number;
  smoulderAcc: number;
  trailAcc: number;
  popTimer: number;
  /** The simulation reports this wreck's cook-offs as 'secondary' detonations: invent none. */
  simPops: boolean;
  burnSince: number;
  scorched: boolean;
  turret: Vector3;
  turretValid: boolean;
}

/**
 * Kinds that carry ammunition (they cook off with pops); a fuel truck burns instead. Taken from
 * the targets data, like the catastrophic charges (SECONDARY_CHARGE), so the two cannot drift.
 */
const hasAmmo = (k: VehicleKind): boolean => AMMO_EFFECTS[k] !== null && k !== 'truckFuel';

const _muzzle = new Vector3();
const _gunDir = new Vector3();
const _wash = new Vector3();
const _p = new Vector3();
const _n = new Vector3();
const _src = new Vector3();

export class EffectsDirector {
  readonly ctx: FxContext;
  private sim: Sim | null = null;
  private frame = 0;
  private time = 0;

  // gun
  private readonly lastMuzzle = new Vector3();
  private muzzleValid = false;
  private lastFired = 0;
  private gunAcc = 0;
  private washSide = 1;

  // burning and wrecked vehicles
  private readonly fires = new Map<number, FireState>();
  private cleanupClock = 0;

  // persistent emitters (fixed pool)
  private static readonly EMITTERS = 64;
  private readonly eKind = new Uint8Array(EffectsDirector.EMITTERS);
  private readonly eX = new Float64Array(EffectsDirector.EMITTERS);
  private readonly eY = new Float64Array(EffectsDirector.EMITTERS);
  private readonly eZ = new Float64Array(EffectsDirector.EMITTERS);
  private readonly eAge = new Float32Array(EffectsDirector.EMITTERS);
  private readonly eLife = new Float32Array(EffectsDirector.EMITTERS);
  private readonly eStrength = new Float32Array(EffectsDirector.EMITTERS);
  private readonly eAcc = new Float32Array(EffectsDirector.EMITTERS);
  /** Colour of what the emitter gives off (dust clouds: the soil's dust). */
  private readonly eColour = new Float32Array(EffectsDirector.EMITTERS * 3);

  // scheduled pops (fixed pool)
  private static readonly POPS = 48;
  private readonly popT = new Float32Array(EffectsDirector.POPS).fill(-1);
  private readonly popX = new Float64Array(EffectsDirector.POPS);
  private readonly popY = new Float64Array(EffectsDirector.POPS);
  private readonly popZ = new Float64Array(EffectsDirector.POPS);
  private readonly popS = new Float32Array(EffectsDirector.POPS);
  private readonly popV = new Int32Array(EffectsDirector.POPS);

  // delayed camera shakes (blast arrives at the speed of sound)
  private static readonly SHAKES = 32;
  private readonly shakeT = new Float32Array(EffectsDirector.SHAKES).fill(-1);
  private readonly shakeA = new Float32Array(EffectsDirector.SHAKES);

  // big explosions per vehicle, to avoid drawing the same blast twice
  private readonly bigBlast = new Map<number, number>();

  constructor(ctx: FxContext) {
    this.ctx = ctx;
  }

  /** Forget everything (new flight). */
  reset(): void {
    this.ctx.ps.clear();
    this.ctx.decals.clear();
    this.ctx.rings.clear();
    this.fires.clear();
    this.bigBlast.clear();
    this.eKind.fill(EMIT.none);
    this.popT.fill(-1);
    this.shakeT.fill(-1);
    this.muzzleValid = false;
    this.gunAcc = 0;
  }

  private bind(sim: Sim): void {
    if (sim === this.sim) return;
    this.reset();
    this.sim = sim;
    this.lastFired = sim.gun.totalFired;
    this.time = sim.time;
  }

  private groundAt = (x: number, z: number): number =>
    this.sim ? this.sim.world.terrain.heightAt(x, z) : 0;

  /** Wire this to `onSimFrame`. */
  onSimFrame = (events: readonly SimEvent[], sim: Sim, info: FrameInfo): void => {
    this.bind(sim);
    this.ctx.groundAt = this.groundAt;
    const frameStart = sim.time - info.simDt;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const delay = Math.max(0, Math.min(info.simDt, e.t - frameStart));
      this.ctx.ps.delay = delay;
      this.handle(e, sim, events, delay);
    }
    this.ctx.ps.delay = 0;
  };

  private handle(e: SimEvent, sim: Sim, events: readonly SimEvent[], delay: number): void {
    const ctx = this.ctx;
    switch (e.type) {
      case 'roundImpact': {
        const p = e.position;
        const v = e.velocity;
        const n = e.normal;
        if (e.target.kind === 'vehicle') {
          impactVehicle(ctx, p.x, p.y, p.z, v.x, v.y, v.z, n.x, n.y, n.z, e.round, e.outcome);
        } else {
          impactGround(
            ctx,
            p.x,
            p.y,
            p.z,
            v.x,
            v.y,
            v.z,
            n.x,
            n.y,
            n.z,
            e.target.surface,
            e.round,
            e.outcome,
          );
        }
        break;
      }
      case 'detonation': {
        // a 30 mm HEI burst is drawn from its roundImpact (docs/a10/ARCHITECTURE.md §4); its
        // detonation event must not draw a second one
        if (e.kind === 'hei') break;
        const p = e.position;
        this.detonation(p.x, p.y, p.z, e.charge, e.kind, e.surface, e.vehicleId, sim, e.t, delay);
        break;
      }
      case 'vehicleDestroyed': {
        const v = findVehicle(sim, e.vehicleId);
        const p = e.position;
        if (e.catastrophic) {
          // the targets module may also report the secondary as a detonation: draw it once
          let reported = false;
          for (let i = 0; i < events.length; i++) {
            const o = events[i];
            if (o.type === 'detonation' && o.kind === 'secondary' && o.vehicleId === e.vehicleId)
              reported = true;
          }
          const last = this.bigBlast.get(e.vehicleId);
          if (!reported && (last === undefined || Math.abs(e.t - last) > 1.5)) {
            this.secondary(e.vehicleKind, p.x, p.y, p.z, sim, e.vehicleId, e.t, delay);
          }
          this.debrisFire(p.x, p.y + 1.5, p.z, e.vehicleKind);
        } else {
          this.internalBlast(p.x, p.y, p.z, v);
        }
        break;
      }
      case 'crash': {
        const p = e.position;
        const surface = sim.world.terrain.surfaceAt(p.x, p.z);
        explosion(ctx, p.x, p.y, p.z, 400, 'secondary', surface, { fuel: true });
        this.addEmitter(EMIT.crashFire, p.x, this.groundAt(p.x, p.z), p.z, 240, 1);
        this.queueShake(p.x, p.y, p.z, 400, delay);
        break;
      }
      default:
        break;
    }
  }

  private detonation(
    x: number,
    y: number,
    z: number,
    charge: number,
    kind: DetonationKind,
    surface: SurfaceKind,
    vehicleId: number,
    sim: Sim,
    t: number,
    delay: number,
  ): void {
    const ctx = this.ctx;
    const terrain = sim.world.terrain;
    terrain.normalAt(x, z, _n);
    const recipe = detonationRecipe(kind, charge);
    if (recipe === 'none') return;
    if (recipe === 'whitePhosphorus') {
      whitePhosphorus(ctx, x, y, z, surface);
      // the mark: burning phosphorus on the ground feeding a white cloud for minutes, the main
      // splash and a few smaller ones around it
      const g = this.groundAt(x, z);
      this.addEmitter(EMIT.wp, x, g, z, WP_MARK.duration, 1);
      for (let i = 0; i < 3; i++) {
        const a = R.next() * Math.PI * 2;
        const r = R.range(5, 14);
        const gx = x + Math.cos(a) * r;
        const gz = z + Math.sin(a) * r;
        this.addEmitter(
          EMIT.wp,
          gx,
          this.groundAt(gx, gz),
          gz,
          WP_MARK.duration * R.range(0.25, 0.5),
          0.3,
        );
      }
      this.queueShake(x, y, z, 2, delay);
      return;
    }
    if (recipe === 'dud') {
      dud(ctx, x, y, z, surface, Math.min(2, 0.6 + 0.15 * Math.cbrt(Math.max(1, charge))));
      return;
    }
    const v = vehicleId > 0 ? findVehicle(sim, vehicleId) : null;
    if (recipe === 'missileHit' && v) this.shapedChargeJet(x, y, z, v);
    if (kind === 'secondary' && v) {
      const last = this.bigBlast.get(vehicleId);
      if (last !== undefined && Math.abs(t - last) < 1.5) {
        // already drawn from vehicleDestroyed: a smaller follow-up burst
        cookOffPop(ctx, x, y + 1, z, 1);
        return;
      }
      const wreckedBefore =
        (v.condition === 'destroyed' || v.condition === 'catastrophic') &&
        t - v.conditionTime > 0.5;
      if (wreckedBefore && charge < 5) {
        // a cook-off the simulation reports (and audio plays): draw it, and invent no more pops
        // for this wreck
        this.fireState(v, t).simPops = true;
        cookOffPop(
          ctx,
          x,
          y + 0.5,
          z,
          Math.min(1, 0.25 + 0.45 * Math.cbrt(Math.max(0.01, charge))),
        );
        this.queueShake(x, y, z, charge, delay);
        return;
      }
      this.bigBlast.set(vehicleId, t);
      explosion(ctx, x, y, z, charge, kind, surface, {
        onVehicle: true,
        fuel: v.kind === 'truckFuel',
      });
      if (v.kind === 'truckAmmo') this.scheduleCookOffs(vehicleId, x, y + 1, z, 10, 25);
    } else {
      explosion(ctx, x, y, z, charge, kind, surface, {
        onVehicle: vehicleId > 0,
        nx: _n.x,
        ny: _n.y,
        nz: _n.z,
      });
      if (recipe === 'bombBurst') {
        // the soil and smoke a bomb throws up hang over the crater and drift off for half a
        // minute: what leads the eye to a bomb's impact from kilometres away
        const sf = surfaceFx(surface);
        const g = this.groundAt(x, z);
        if (!sf.water && y - g < 6) {
          bombCloud(ctx, x, g, z, charge, surface);
          const k = this.addEmitter(
            EMIT.dustCloud,
            x,
            g,
            z,
            DUST_CLOUD_LIFE,
            Math.min(1.6, Math.cbrt(charge / 96)),
          );
          const c = vehicleId > 0 ? 0.45 : 1;
          this.eColour[k * 3] = sf.dust[0] * c;
          this.eColour[k * 3 + 1] = sf.dust[1] * c;
          this.eColour[k * 3 + 2] = sf.dust[2] * c;
        }
      }
    }
    this.queueShake(x, y, z, charge, delay);
  }

  /**
   * A Maverick's shaped charge striking a vehicle: the jet's white flash through the hull and a
   * spray of spall and burning fragments out of it, before the warhead's own burst. What the
   * vehicle does next (its fire, its ammunition) comes from the targets module.
   */
  private shapedChargeJet(x: number, y: number, z: number, v: Vehicle): void {
    const ctx = this.ctx;
    const { ps } = ctx;
    ps.groundY = this.groundAt(x, z);
    const shape = VEHICLE_SHAPES[v.kind];
    const top = shape.hullClearance + shape.hullHeight;
    flash(ctx, x, y, z, 9, 0.07, 1.8);
    const w = ps.spawn(PK.glint, x, y, z, 0, 0, 0, 4, 6, 0.12);
    ps.emissive(w, 1.4);
    sparks(ctx, x, y + 0.3, z, 0, 1, 0, Math.round(40 * ctx.detail), 1.4, 20, 90, 0.4, 1.6);
    // the hatches and the turret ring blow out: a burst of fire from the top of the hull
    const fy = Math.max(y, v.position.y + top);
    const j = ps.spawn(PK.fireball, v.position.x, fy, v.position.z, 0, 9, 0, 1.2, 4.5, 0.9);
    ps.emissive(j, 1.1);
  }

  /** The ammunition or fuel of a vehicle going up (catastrophic kill). */
  private secondary(
    kind: VehicleKind,
    x: number,
    y: number,
    z: number,
    sim: Sim,
    id: number,
    t: number,
    delay: number,
  ): void {
    const charge = SECONDARY_CHARGE[kind];
    const surface = sim.world.terrain.surfaceAt(x, z);
    this.bigBlast.set(id, t);
    explosion(this.ctx, x, y + 1.2, z, charge, 'secondary', surface, {
      onVehicle: true,
      fuel: kind === 'truckFuel',
    });
    if (kind === 'truckAmmo') this.scheduleCookOffs(id, x, y + 1, z, 12, 30);
    else if (hasAmmo(kind)) this.scheduleCookOffs(id, x, y + 1, z, 4, 12);
    this.queueShake(x, y, z, charge, delay);
  }

  /** Burning debris thrown out of a catastrophic kill, and small fires where it lands. */
  private debrisFire(x: number, y: number, z: number, kind: VehicleKind): void {
    const { ps } = this.ctx;
    ps.groundY = this.groundAt(x, z);
    const n = Math.round((kind === 'truckAmmo' || kind === 'truckFuel' ? 10 : 7) * this.ctx.detail);
    for (let i = 0; i < n; i++) {
      const a = R.next() * Math.PI * 2;
      const up = R.range(10, 26);
      const out = R.range(6, 16);
      const j = ps.spawn(
        PK.burningDebris,
        x,
        y,
        z,
        Math.cos(a) * out,
        up,
        Math.sin(a) * out,
        R.range(0.35, 0.7),
        0.4,
        R.range(2.5, 4.5),
      );
      ps.trail(j, 16 * this.ctx.detail);
    }
    const fires = kind === 'truckFuel' ? 5 : 3;
    for (let i = 0; i < fires; i++) {
      const a = R.next() * Math.PI * 2;
      const r = R.range(4, kind === 'truckFuel' ? 16 : 11);
      const gx = x + Math.cos(a) * r;
      const gz = z + Math.sin(a) * r;
      this.addEmitter(
        EMIT.groundFire,
        gx,
        this.groundAt(gx, gz),
        gz,
        R.range(25, 80),
        R.range(0.3, kind === 'truckFuel' ? 1 : 0.6),
      );
    }
  }

  /** A vehicle destroyed without exploding: a flash inside and smoke out of the hatches. */
  private internalBlast(x: number, y: number, z: number, v: Vehicle | null): void {
    const { ps } = this.ctx;
    ps.groundY = this.groundAt(x, z);
    const top = v ? VEHICLE_SHAPES[v.kind].hullClearance + VEHICLE_SHAPES[v.kind].hullHeight : 2;
    const i = ps.spawn(PK.fireball, x, y + top, z, 0, 5, 0, 0.6, 2.4, 0.6);
    ps.emissive(i, 0.8);
    for (let k = 0; k < 4; k++) {
      const j = ps.spawn(
        PK.blackSmoke,
        x + R.signed(1),
        y + top,
        z + R.signed(1),
        R.signed(1.5),
        R.range(4, 8),
        R.signed(1.5),
        0.8,
        R.range(4, 6),
        R.range(5, 8),
      );
      ps.opacity(j, 0.9);
    }
  }

  /** Pops of ammunition cooking off after a blast (until the simulation reports its own). */
  private scheduleCookOffs(
    vehicleId: number,
    x: number,
    y: number,
    z: number,
    n: number,
    span: number,
  ): void {
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < this.popT.length; i++) {
        if (this.popT[i] >= 0) continue;
        this.popT[i] = R.range(0.6, span) * (0.4 + 0.6 * R.next());
        this.popV[i] = vehicleId;
        this.popX[i] = x + R.signed(2);
        this.popY[i] = y + R.range(0, 1.5);
        this.popZ[i] = z + R.signed(2);
        this.popS[i] = R.range(0.4, 1);
        break;
      }
    }
  }

  /** Start a persistent emitter (the oldest one gives way when all are busy); its slot. */
  private addEmitter(
    kind: number,
    x: number,
    y: number,
    z: number,
    life: number,
    strength: number,
  ): number {
    let pick = -1;
    let oldest = -1;
    for (let i = 0; i < this.eKind.length; i++) {
      if (this.eKind[i] === EMIT.none) {
        pick = i;
        break;
      }
      const f = this.eAge[i] / this.eLife[i];
      if (f > oldest) {
        oldest = f;
        pick = i;
      }
    }
    this.eKind[pick] = kind;
    this.eX[pick] = x;
    this.eY[pick] = y;
    this.eZ[pick] = z;
    this.eAge[pick] = 0;
    this.eLife[pick] = life;
    this.eStrength[pick] = strength;
    this.eAcc[pick] = 0;
    return pick;
  }

  private queueShake(x: number, y: number, z: number, charge: number, delay: number): void {
    const c = this.ctx.camera;
    const d = Math.hypot(x - c.x, y - c.y, z - c.z);
    const s = Math.cbrt(Math.max(0.01, charge));
    const amount = Math.min(1, (22 * s) / Math.max(d, 15));
    if (amount < 0.015) return;
    for (let i = 0; i < this.shakeT.length; i++) {
      if (this.shakeT[i] >= 0) continue;
      this.shakeT[i] = delay + d / SPEED_OF_SOUND;
      this.shakeA[i] = amount;
      return;
    }
  }

  /** Per frame (after the camera has moved): the gun, fires, emitters, pops, shakes. */
  update(sim: Sim | null, dt: number): void {
    if (!sim) {
      if (this.sim) {
        this.reset();
        this.sim = null;
      }
      return;
    }
    this.bind(sim);
    this.ctx.groundAt = this.groundAt;
    this.frame++;
    this.time = sim.time;
    this.ctx.ps.wind.copy(sim.world.surfaceWind);
    this.gun(sim, dt);
    if (dt > 0) {
      this.vehicles(sim, dt);
      this.emitters(dt);
      this.pops(dt);
      this.shakes(dt);
    }
  }

  // ---- the gun ------------------------------------------------------------------------------

  private gun(sim: Sim, dt: number): void {
    const { ps } = this.ctx;
    const gun = sim.gun;
    const ac = sim.aircraft;
    const m = A10_GEOMETRY.muzzle;
    _muzzle.set(m.x, m.y, m.z).applyQuaternion(ac.orientation).add(ac.position);
    if (!this.muzzleValid) {
      this.lastMuzzle.copy(_muzzle);
      this.lastFired = gun.totalFired;
      this.muzzleValid = true;
    }
    let n = gun.totalFired - this.lastFired;
    this.lastFired = gun.totalFired;
    if (n < 0) n = 0;
    if (n === 0 && gun.firing && gun.rate > 0) {
      this.gunAcc += gun.rate * dt;
      n = Math.floor(this.gunAcc);
      this.gunAcc -= n;
    } else this.gunAcc = 0;
    if (n > 0 && dt > 0) {
      _gunDir
        .set(0, -Math.sin(GAU8.gunLineDepression), -Math.cos(GAU8.gunLineDepression))
        .applyQuaternion(ac.orientation);
      ps.groundY = this.groundAt(_muzzle.x, _muzzle.z);
      const v = ac.velocity;
      const detail = this.ctx.detail;
      for (let i = 0; i < n; i++) {
        const u = (i + R.next()) / n;
        _p.lerpVectors(this.lastMuzzle, _muzzle, u);
        ps.delay = u * dt;
        // the muzzle blast throws the gas a few metres ahead of the muzzle
        const ahead = R.range(0.5, 4);
        _p.addScaledVector(_gunDir, ahead);
        // gun gas: leaves forward with the shell, balloons into a cloud metres wide within
        // milliseconds, is stopped by the air and streams back past the nose and both sides of
        // the canopy as the aircraft flies through it (the pilot flies through his own smoke)
        const g = R.range(20, 40);
        const j = ps.spawn(
          PK.gunSmoke,
          _p.x,
          _p.y,
          _p.z,
          v.x + _gunDir.x * g + R.signed(9),
          v.y + _gunDir.y * g + R.signed(9),
          v.z + _gunDir.z * g + R.signed(9),
          R.range(3, 4.5),
          R.range(9, 13),
          R.range(3.2, 5.5),
        );
        ps.opacity(j, R.range(0.75, 1));
        // the part the airflow carries up and round the nose: it streams past the windscreen
        // and both sides of the canopy, where the pilot sees it
        if (detail > 0.8 || (i & 1) === 0) {
          const side = (this.washSide = -this.washSide);
          // up the windscreen sides to about the pilot's eye level (above the glare shield)
          _wash.set(side * R.range(0.4, 2.0), R.range(1.5, 2.3), 0).applyQuaternion(ac.orientation);
          const w = R.range(4, 14);
          const k = ps.spawn(
            PK.gunSmoke,
            _p.x + _wash.x,
            _p.y + _wash.y,
            _p.z + _wash.z,
            v.x + _gunDir.x * w + R.signed(3),
            v.y + _gunDir.y * w + R.signed(3),
            v.z + _gunDir.z * w + R.signed(3),
            R.range(2.5, 3.5),
            R.range(7, 10),
            R.range(2.5, 4),
          );
          ps.opacity(k, R.range(0.6, 0.85));
        }
        if (detail > 0.8 && (i & 1) === 0) {
          const k = ps.spawn(
            PK.gunSmoke,
            _p.x,
            _p.y,
            _p.z,
            v.x + _gunDir.x * 50 + R.signed(14),
            v.y + _gunDir.y * 50 + R.signed(14),
            v.z + _gunDir.z * 50 + R.signed(14),
            1.5,
            R.range(4, 6),
            R.range(1.2, 2),
          );
          ps.opacity(k, 0.6);
        }
      }
      // muzzle flash (once per frame is enough: it lives for a frame or two)
      ps.delay = 0;
      const f = ps.spawn(
        PK.muzzle,
        _muzzle.x + _gunDir.x * 0.8,
        _muzzle.y + _gunDir.y * 0.8,
        _muzzle.z + _gunDir.z * 0.8,
        v.x,
        v.y,
        v.z,
        0.9,
        R.range(1.4, 2.0),
        Math.max(0.03, dt * 1.2),
      );
      ps.emissive(f, R.range(0.7, 1));
    }
    if (gun.firing || n > 0)
      setVibration(0.45 * Math.min(1, Math.max(0.3, gun.rate / GAU8.rate)), GAU8.rate);
    this.lastMuzzle.copy(_muzzle);
  }

  // ---- burning vehicles ---------------------------------------------------------------------

  private vehicles(sim: Sim, dt: number): void {
    const { ps, camera, detail } = this.ctx;
    const list = sim.targets.vehicles;
    for (let vi = 0; vi < list.length; vi++) {
      const v = list[vi];
      const wreck = v.condition === 'destroyed' || v.condition === 'catastrophic';
      const burning = v.fire > 0.01;
      if (!wreck && !burning && !v.thrownTurret) continue;
      const st = this.fireState(v, sim.time);
      st.stamp = this.frame;
      const shape = VEHICLE_SHAPES[v.kind];
      const top = shape.hullClearance + shape.hullHeight;
      // the fire's source: the engine deck, or the open turret ring after a catastrophic kill
      const lz =
        v.condition === 'catastrophic' && shape.turret
          ? shape.turret.offsetZ
          : shape.hullLength * 0.28;
      const sh = Math.sin(v.heading);
      const ch = Math.cos(v.heading);
      // local (0, top, lz) → world: forward is -Z local = (sin h, 0, -cos h) world
      // the terrain under the vehicle (a dug-in vehicle's position is the floor of its pit)
      const ground = this.groundAt(v.position.x, v.position.z);
      _src.set(
        v.position.x - sh * lz,
        Math.max(v.position.y + top, ground + 0.3),
        v.position.z + ch * lz,
      );
      const d = Math.hypot(_src.x - camera.x, _src.y - camera.y, _src.z - camera.z);
      ps.groundY = ground;
      ps.delay = 0;
      const f = v.fire;
      const near = d < 1600 ? 1 : d < 5000 ? 0.5 : 0;

      if (burning) {
        if (!st.scorched) {
          st.scorched = true;
          this.ctx.decals.add(
            v.position.x,
            ground,
            v.position.z,
            0,
            1,
            0,
            shape.hullLength * 0.75,
            DECAL.scorch,
            1800,
          );
        }
        // flames licking out of the hull
        if (near > 0) {
          st.flameAcc += (10 + 22 * f) * detail * near * dt;
          while (st.flameAcc >= 1) {
            st.flameAcc -= 1;
            const ox = R.signed(shape.hullWidth * 0.32);
            const oz = R.signed(shape.hullLength * 0.22);
            const j = ps.spawn(
              PK.flame,
              _src.x + ox * ch - oz * sh,
              _src.y - 0.2,
              _src.z + ox * sh + oz * ch,
              R.signed(0.6),
              R.range(1.5, 3),
              R.signed(0.6),
              R.range(0.9, 1.5) * (0.6 + 0.7 * f),
              R.range(1.8, 3.0) * (0.6 + 0.7 * f),
              R.range(0.5, 1.0),
            );
            ps.delay = 0;
            ps.emissive(j, R.range(0.7, 1.15));
          }
          if (f > 0.35 && d < 1500) {
            st.emberAcc += 4 * f * detail * dt;
            while (st.emberAcc >= 1) {
              st.emberAcc -= 1;
              ps.spawn(
                PK.ember,
                _src.x + R.signed(1),
                _src.y + 0.5,
                _src.z + R.signed(1),
                R.signed(2),
                R.range(3, 8),
                R.signed(2),
                0.1,
                0.06,
                R.range(1.5, 3.5),
              );
            }
          }
        }
        // thick black smoke boiling off the fire: puffs close enough to merge into one
        // billowing plume (fewer far away, where the column carries the picture)
        st.smokeAcc += (3 + 7 * f) * (0.5 + 0.5 * detail) * (near > 0 ? 1 : 0.35) * dt;
        while (st.smokeAcc >= 1) {
          st.smokeAcc -= 1;
          const j = ps.spawn(
            PK.blackSmoke,
            _src.x + R.signed(0.8),
            _src.y + 0.8,
            _src.z + R.signed(0.8),
            R.signed(1),
            R.range(3, 6),
            R.signed(1),
            R.range(1.8, 2.6) * (0.6 + 0.6 * f),
            R.range(14, 20) * (0.6 + 0.6 * f),
            R.range(9, 15),
          );
          ps.opacity(j, 0.6 + 0.3 * f);
        }
        // the column that rises hundreds of metres and leans with the wind (seen from afar):
        // it takes over above the black smoke, in puffs big enough to overlap
        st.columnAcc += (0.5 + 0.6 * f) * dt;
        while (st.columnAcc >= 1) {
          st.columnAcc -= 1;
          const j = ps.spawn(
            PK.column,
            _src.x + R.signed(1.5),
            _src.y + 9,
            _src.z + R.signed(1.5),
            R.signed(1),
            R.range(5, 8),
            R.signed(1),
            R.range(7, 10),
            R.range(55, 85) * (0.7 + 0.4 * f),
            R.range(100, 160),
          );
          ps.opacity(j, 0.5 + 0.4 * f);
        }
        // ammunition cooking off
        if (hasAmmo(v.kind) && !st.simPops && f > 0.25 && sim.time - st.burnSince < 150) {
          st.popTimer -= dt;
          if (st.popTimer <= 0) {
            st.popTimer = R.range(2, 9) * (1 + (sim.time - st.burnSince) / 50);
            if (d < 6000)
              cookOffPop(
                this.ctx,
                _src.x + R.signed(1),
                _src.y + R.range(0, 1),
                _src.z + R.signed(1),
                R.range(0.2, 0.7),
              );
          }
        }
      } else if (wreck) {
        // a smouldering wreck: thin grey smoke for a long time
        st.smoulderAcc += 0.7 * detail * dt;
        while (st.smoulderAcc >= 1) {
          st.smoulderAcc -= 1;
          const j = ps.spawn(
            PK.smoke,
            _src.x + R.signed(1),
            _src.y + 0.3,
            _src.z + R.signed(1),
            R.signed(0.4),
            R.range(1, 2),
            R.signed(0.4),
            1,
            R.range(6, 9),
            R.range(14, 22),
          );
          ps.color(j, 0.16, 0.155, 0.15, 0.4);
        }
      }

      // a thrown turret trails fire and smoke while it flies
      const tt = v.thrownTurret;
      if (tt) {
        if (st.turretValid) {
          const moved = tt.position.distanceTo(st.turret);
          if (moved > 0.2) {
            st.trailAcc += moved * 1.2 * detail;
            const n = Math.min(20, Math.floor(st.trailAcc));
            st.trailAcc -= n;
            for (let k = 0; k < n; k++) {
              const u = (k + R.next()) / Math.max(1, n);
              _p.lerpVectors(st.turret, tt.position, u);
              const j = ps.spawn(
                PK.trailSmoke,
                _p.x,
                _p.y,
                _p.z,
                R.signed(1),
                R.range(0, 1.5),
                R.signed(1),
                0.8,
                R.range(3, 4.5),
                R.range(3, 5),
              );
              ps.opacity(j, 0.9);
              if ((k & 1) === 0) {
                const fl = ps.spawn(PK.fireball, _p.x, _p.y, _p.z, 0, 1, 0, 0.6, 1.6, 0.45);
                ps.emissive(fl, 0.9);
              }
            }
          }
        }
        st.turret.copy(tt.position);
        st.turretValid = true;
      }
    }
    // forget vehicles that are gone (every few seconds; iterating the map allocates a little)
    this.cleanupClock += dt;
    if (this.cleanupClock > 3) {
      this.cleanupClock = 0;
      for (const [id, st] of this.fires) if (st.stamp !== this.frame) this.fires.delete(id);
      for (const [id, t] of this.bigBlast) if (this.time - t > 30) this.bigBlast.delete(id);
    }
  }

  /** The view state of a burning or wrecked vehicle (created when first needed). */
  private fireState(v: Vehicle, time: number): FireState {
    let st = this.fires.get(v.id);
    if (!st) {
      st = {
        id: v.id,
        stamp: this.frame,
        flameAcc: 0,
        smokeAcc: 0,
        columnAcc: R.next(),
        emberAcc: 0,
        smoulderAcc: 0,
        trailAcc: 0,
        popTimer: R.range(2, 6),
        simPops: false,
        burnSince: time,
        scorched: false,
        turret: new Vector3(),
        turretValid: false,
      };
      this.fires.set(v.id, st);
    }
    return st;
  }

  // ---- persistent emitters, pops, shakes ----------------------------------------------------

  private emitters(dt: number): void {
    const { ps, detail } = this.ctx;
    for (let i = 0; i < this.eKind.length; i++) {
      const kind = this.eKind[i];
      if (kind === EMIT.none) continue;
      const age = (this.eAge[i] += dt);
      const life = this.eLife[i];
      if (age >= life) {
        this.eKind[i] = EMIT.none;
        continue;
      }
      const fade = 1 - age / life;
      const s = this.eStrength[i];
      const x = this.eX[i];
      const y = this.eY[i];
      const z = this.eZ[i];
      ps.groundY = y;
      ps.delay = 0;
      if (kind === EMIT.wp) {
        // most of the phosphorus burns in the first minute; pieces smoulder on for minutes
        const tau = 60 * WP_MARK.earlyShare;
        const shape = 0.22 + 0.78 * Math.exp(-age / tau);
        const tail = Math.min(1, (life - age) / 30);
        this.eAcc[i] += WP_MARK.rate * shape * tail * s * Math.max(0.6, detail) * dt;
        while (this.eAcc[i] >= 1) {
          this.eAcc[i] -= 1;
          const j = ps.spawn(
            PK.wpMark,
            x + R.signed(2.5),
            y + 1.5,
            z + R.signed(2.5),
            R.signed(1.2),
            R.range(1.5, 4),
            R.signed(1.2),
            WP_MARK.puffS0 * R.range(0.8, 1.2) * (0.5 + 0.5 * s),
            WP_MARK.puffS1 * R.range(0.8, 1.2) * (0.4 + 0.6 * s),
            WP_MARK.puffLife * R.range(0.8, 1.2),
          );
          ps.opacity(j, 0.85 + 0.15 * shape);
        }
      } else if (kind === EMIT.dustCloud) {
        // the dust settling out of a bomb's cloud and the smoke of its crater, drifting downwind
        // under the climbing cloud (recipes bombCloud): fewer puffs at low detail, drawn larger
        const fill = Math.min(1.5, 1 / Math.sqrt(Math.max(0.45, detail)));
        this.eAcc[i] += 5.5 * s * Math.exp(-age / 9) * detail * dt;
        while (this.eAcc[i] >= 1) {
          this.eAcc[i] -= 1;
          const r = R.range(3, 14) * s;
          const a = R.next() * Math.PI * 2;
          const j = ps.spawn(
            PK.dust,
            x + Math.cos(a) * r,
            y + R.range(4, 26) * s,
            z + Math.sin(a) * r,
            R.signed(1.5),
            R.range(0.5, 2.5),
            R.signed(1.5),
            R.range(9, 13) * s * fill,
            R.range(24, 38) * s * fill,
            R.range(22, 36),
          );
          const o = i * 3;
          ps.color(j, this.eColour[o], this.eColour[o + 1], this.eColour[o + 2], 0.55);
        }
      } else {
        // ground fire (debris, fuel) or the aircraft's own wreck
        const big = kind === EMIT.crashFire ? 3 : 1;
        this.eAcc[i] += (6 + 10 * s) * big * fade * detail * dt;
        while (this.eAcc[i] >= 1) {
          this.eAcc[i] -= 1;
          const j = ps.spawn(
            PK.flame,
            x + R.signed(1.2 * big),
            y + 0.3,
            z + R.signed(1.2 * big),
            0,
            R.range(1, 2.5),
            0,
            R.range(0.6, 1.1) * (0.6 + s) * big,
            R.range(1.2, 2.2) * (0.6 + s) * big,
            R.range(0.5, 0.9),
          );
          ps.emissive(j, R.range(0.7, 1.1));
          if (R.next() < 0.3) {
            const k = ps.spawn(
              PK.blackSmoke,
              x + R.signed(1),
              y + 1.5,
              z + R.signed(1),
              R.signed(0.5),
              R.range(2, 4),
              R.signed(0.5),
              1 * big,
              R.range(5, 8) * big,
              R.range(6, 11),
            );
            ps.opacity(k, 0.6 + 0.3 * s);
          }
        }
      }
    }
  }

  private pops(dt: number): void {
    for (let i = 0; i < this.popT.length; i++) {
      if (this.popT[i] < 0) continue;
      this.popT[i] -= dt;
      if (this.popT[i] < 0) {
        this.popT[i] = -1;
        if (this.fires.get(this.popV[i])?.simPops) continue;
        const c = this.ctx.camera;
        const x = this.popX[i];
        const y = this.popY[i];
        const z = this.popZ[i];
        if (Math.hypot(x - c.x, y - c.y, z - c.z) < 7000)
          cookOffPop(this.ctx, x, y, z, this.popS[i]);
      }
    }
  }

  private shakes(dt: number): void {
    for (let i = 0; i < this.shakeT.length; i++) {
      if (this.shakeT[i] < 0) continue;
      this.shakeT[i] -= dt;
      if (this.shakeT[i] < 0) {
        this.shakeT[i] = -1;
        addShake(this.shakeA[i]);
      }
    }
  }
}

function findVehicle(sim: Sim, id: number): Vehicle | null {
  const list = sim.targets.vehicles;
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
