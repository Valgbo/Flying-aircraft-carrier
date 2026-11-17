/**
 * What a vehicle puts into the air: dust trails behind it on dry ground (the surface kind and,
 * when the world provides it, the moisture decide how much), and diesel exhaust puffs while the
 * engine runs (more when it pulls away). PLAN_A10.md §8: dust and exhaust are how the eye finds a
 * moving column from altitude.
 */
import type { Vehicle, VehicleKind } from '../../core/targets/types';
import type { Terrain } from '../../core/world/types';
import { VEHICLE_SHAPES } from '../../data/vehicles';
import { fxRandom as R } from '../effects/noise';
import { PK } from '../effects/particleKinds';
import type { ParticleSystem } from '../effects/ParticleSystem';
import { surfaceFx } from '../effects/surfaces';

export interface EmitterState {
  dustAcc: number;
  exhaustAcc: number;
  surfaceTimer: number;
  trail: number;
  dust: [number, number, number];
  prevSpeed: number;
  side: number;
}

export function createEmitterState(): EmitterState {
  return {
    dustAcc: R.next(),
    exhaustAcc: R.next(),
    surfaceTimer: 0,
    trail: 0,
    dust: [0.3, 0.24, 0.16],
    prevSpeed: 0,
    side: 1,
  };
}

/** Local exhaust outlet (x, y, z) and its direction (dx, dy, dz) per kind, from the model layout. */
function exhaustOf(kind: VehicleKind, out: number[]): boolean {
  const s = VEHICLE_SHAPES[kind];
  const W = s.hullWidth;
  const L = s.hullLength;
  const C = s.hullClearance;
  const H = s.hullHeight;
  const tw = s.running.type === 'tracks' ? s.running.width : 0.4;
  switch (kind) {
    case 'mbt':
      out.push(-(W / 2 - tw), C + H * 0.55, L / 2 - 1.55, -1, 0.25, 0.3);
      return true;
    case 'ifv':
      out.push(W / 2, C + H * 0.55, -L / 2 + 2.0, 1, 0.3, 0.1);
      return true;
    case 'apc':
      out.push(W / 2 - 0.35, C + H - 0.3, L / 2 + 0.05, 0.2, 0.4, 1);
      return true;
    case 'truckCargo':
    case 'truckFuel':
    case 'truckAmmo': {
      const cab = s.cabLength ?? 2.2;
      out.push(0.95, Math.min(C + H - 0.25, C + 1.75) + 0.2, -L / 2 + cab + 0.04, 0, 1, 0.1);
      return true;
    }
    default:
      return false;
  }
}

const EXHAUST: Partial<Record<VehicleKind, number[]>> = {};
for (const k of Object.keys(VEHICLE_SHAPES) as VehicleKind[]) {
  const a: number[] = [];
  if (exhaustOf(k, a)) EXHAUST[k] = a;
}

type MoistureTerrain = Terrain & { moistureAt?: (x: number, z: number) => number };

/**
 * Emit this frame's dust and exhaust for one vehicle. `dist` is the camera distance, `detail`
 * the quality's particle multiplier.
 */
export function emitVehicle(
  ps: ParticleSystem,
  terrain: Terrain,
  v: Vehicle,
  st: EmitterState,
  dt: number,
  dist: number,
  detail: number,
): void {
  if (dt <= 0) return;
  const alive = v.condition === 'intact' || v.condition === 'damaged';
  const speed = Math.abs(v.speed);
  const accel = (speed - st.prevSpeed) / dt;
  st.prevSpeed = speed;
  if (!alive) return;
  const sh = Math.sin(v.heading);
  const ch = Math.cos(v.heading);
  const s = VEHICLE_SHAPES[v.kind];
  const px = v.position.x;
  const py = v.position.y;
  const pz = v.position.z;
  // world forward of the hull: (sin h, 0, -cos h)
  const fx = sh * Math.sign(v.speed || 1);
  const fz = -ch * Math.sign(v.speed || 1);

  // ---- dust ----
  if (speed > 1.2 && dist < 14000) {
    st.surfaceTimer -= dt;
    if (st.surfaceTimer <= 0) {
      st.surfaceTimer = 0.5;
      const sf = surfaceFx(terrain.surfaceAt(px, pz));
      let trail = sf.trail;
      const mt = terrain as MoistureTerrain;
      if (typeof mt.moistureAt === 'function')
        trail *= 1 - 0.8 * Math.min(1, Math.max(0, mt.moistureAt(px, pz)));
      st.trail = trail;
      st.dust[0] = sf.dust[0];
      st.dust[1] = sf.dust[1];
      st.dust[2] = sf.dust[2];
    }
    if (st.trail > 0.02) {
      const far = dist > 2500;
      const rate = (1.5 + 1.0 * speed) * st.trail * detail * (far ? 0.35 : 1);
      st.dustAcc += rate * dt;
      ps.groundY = py;
      ps.delay = 0;
      const halfW = s.hullWidth / 2 - 0.3;
      const back = s.hullLength / 2 + 0.3;
      while (st.dustAcc >= 1) {
        st.dustAcc -= 1;
        st.side = -st.side;
        const lx = st.side * halfW;
        const wx = px + lx * ch - back * sh * Math.sign(v.speed || 1);
        const wz = pz + lx * sh + back * ch * Math.sign(v.speed || 1);
        const k = far ? 1.6 : 1;
        const i = ps.spawn(
          PK.dustTrail,
          wx,
          py + 0.5,
          wz,
          fx * speed * 0.2 + R.signed(1.2) + st.side * ch * 0.8,
          R.range(0.6, 1.8),
          fz * speed * 0.2 + R.signed(1.2) + st.side * sh * 0.8,
          R.range(2, 3) * k,
          R.range(9, 14) * k * (0.7 + 0.3 * Math.min(1.5, st.trail)),
          R.range(10, 18),
        );
        ps.color(i, st.dust[0], st.dust[1], st.dust[2], Math.min(1, 0.6 + 0.35 * st.trail));
      }
    }
  }

  // ---- exhaust ----
  const ex = EXHAUST[v.kind];
  if (ex && v.engineOn && dist < 2000) {
    const pull = Math.max(0, accel);
    const rate = (4 + speed * 0.5 + pull * 8) * detail;
    st.exhaustAcc += rate * dt;
    // a dug-in vehicle sits in a pit: its exhaust comes out at the surface
    const surface = terrain.heightAt(px, pz);
    ps.groundY = surface;
    ps.delay = 0;
    while (st.exhaustAcc >= 1) {
      st.exhaustAcc -= 1;
      const lx = ex[0];
      const ly = ex[1];
      const lz = ex[2];
      const wx = px + lx * ch - lz * sh;
      const wz = pz + lx * sh + lz * ch;
      const dx = ex[3] * ch - ex[5] * sh;
      const dz = ex[3] * sh + ex[5] * ch;
      const sp = R.range(1.5, 3.5) + pull;
      const i = ps.spawn(
        PK.exhaust,
        wx,
        Math.max(py + ly, surface + 0.3),
        wz,
        dx * sp + fx * speed * 0.5,
        ex[4] * sp + 0.5,
        dz * sp + fz * speed * 0.5,
        0.25,
        R.range(1.4, 2.4) * (1 + pull * 0.3),
        R.range(1.2, 2.4),
      );
      if (pull > 0.5) ps.color(i, 0.05, 0.05, 0.05, 0.75);
    }
  }
}
