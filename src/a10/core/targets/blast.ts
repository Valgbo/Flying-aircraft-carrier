/**
 * Blast and fragments of a detonation (PLAN §6.5): bombs, rockets, missiles, HEI rounds and the
 * secondaries of other vehicles.
 *
 * Blast: scaled distance Z = R / W^(1/3) (R to the vehicle's nearest surface, W kg TNT) and the
 * side-on impulse i = W^(1/3)·ĩ(Z) select a level from the class table in data/vehicles.ts
 * (catastrophic, destroyed, heavy, light). Both must be reached, so a small charge (30 mm HEI, a
 * rocket warhead) never wrecks armour by scaled distance alone.
 *
 * Fragments: a statistical model. The expected number of fragments heavier than 1 g reaching a
 * vehicle is N × presented area / 4πR² (half of them go into the ground); the number is drawn
 * (Poisson), and each traced fragment gets a Mott mass, its Gurney velocity slowed by drag over
 * its range, and is ray-traced to the plate facing the burst: it penetrates when its penetration
 * exceeds the plate's effective thickness, and then hurts what lies just behind.
 */
import { Vector3 } from 'three';
import {
  BLAST,
  BLAST_THRESHOLDS,
  COMPONENT_VULNERABILITY,
  FRAGMENTS,
  ROUND_EFFECTS,
  VEHICLE_MODELS,
} from '../../data/vehicles';
import type { Rng } from '../rng';
import type { Sim } from '../types';
import { densityAt } from '../world/atmosphere';
import { damageBox, strikeNear, traceInterior } from './damage';
import { plateNormalWorld, rayVehicle, type PartHit } from './hit';
import { hullToWorld, vehiclePose, worldToHull, type V3 } from './pose';
import {
  alertGroup,
  emitDamaged,
  evaluateCondition,
  explode,
  recordHit,
  setCondition,
  sortDamaged,
  updateComponentHealth,
} from './state';
import type { ComponentId, Vehicle, VehicleKind } from './types';

/** Bounds of each class's body (every part but the gun barrel), hull frame. */
const BODY = {} as Record<
  VehicleKind,
  { min: [number, number, number]; max: [number, number, number] }
>;
for (const kind of Object.keys(VEHICLE_MODELS) as VehicleKind[]) {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of VEHICLE_MODELS[kind].parts) {
    if (p.part === 'gun') continue;
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], p.min[a]);
      max[a] = Math.max(max[a], p.max[a]);
    }
  }
  BODY[kind] = { min, max };
}

/** Side-on impulse of a surface burst, Pa·s (W kg TNT, Z m/kg^(1/3)). */
export function blastImpulse(chargeKg: number, z: number): number {
  return (Math.cbrt(chargeKg) * BLAST.impulseCoeff) / Math.pow(Math.max(z, 1e-3), BLAST.impulseExp);
}

export type BlastLevelName = 'catastrophic' | 'destroyed' | 'heavy' | 'light' | 'none';

/**
 * The blast level a vehicle class suffers from a charge of W kg: `z` is the scaled distance to its
 * nearest surface (peak pressure), `zCentre` to its centre (impulse over the whole vehicle).
 */
export function blastLevel(
  kind: VehicleKind,
  chargeKg: number,
  z: number,
  zCentre: number = z,
): BlastLevelName {
  const row = BLAST_THRESHOLDS[kind];
  if (!row || chargeKg <= 0) return 'none';
  const i = blastImpulse(chargeKg, zCentre);
  if (row.catastrophic && z <= row.catastrophic.z && i >= row.catastrophic.impulse)
    return 'catastrophic';
  if (z <= row.destroyed.z && i >= row.destroyed.impulse) return 'destroyed';
  if (z <= row.heavy.z && i >= row.heavy.impulse) return 'heavy';
  if (z <= row.light.z && i >= row.light.impulse) return 'light';
  return 'none';
}

/** Mott scale mass of a case of `caseKg`, kg. */
export function mottScale(caseKg: number): number {
  return FRAGMENTS.mottMuRef * Math.pow(caseKg / FRAGMENTS.mottCaseRef, FRAGMENTS.mottScaleExp);
}

/** Fragments heavier than FRAGMENTS.minMass from a case of `caseKg`. */
export function fragmentCount(caseKg: number): number {
  const mu = mottScale(caseKg);
  return (caseKg / (2 * mu)) * Math.exp(-Math.sqrt(FRAGMENTS.minMass / mu));
}

/** Initial fragment velocity (Gurney, cylinder), m/s. */
export function gurneyVelocity(chargeKg: number, caseKg: number): number {
  return FRAGMENTS.gurney / Math.sqrt(caseKg / Math.max(chargeKg, 1e-3) + 0.5);
}

/** Speed of a fragment of mass m (kg) after `range` m in air of density rho, m/s. */
export function fragmentSpeed(v0: number, m: number, range: number, rho: number): number {
  const lambda = (2 * Math.cbrt(m)) / (FRAGMENTS.dragCoeff * rho * FRAGMENTS.shapeFactor);
  return v0 * Math.exp(-range / lambda);
}

/** Steel penetrated by a fragment of mass m (kg) at speed v (m/s), mm RHA. */
export function fragmentPenetration(m: number, v: number): number {
  return (
    FRAGMENTS.penCoeff * Math.cbrt(m * 1000) * Math.pow(Math.max(0, v) / 1000, FRAGMENTS.penExp)
  );
}

function poisson(r: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * r.normal()));
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r.next();
  } while (p > limit);
  return k - 1;
}

const _b: V3 = { x: 0, y: 0, z: 0 };
const _c: V3 = { x: 0, y: 0, z: 0 };
const _n: V3 = { x: 0, y: 0, z: 0 };
const _ph: PartHit = { t: 0, part: -1, plate: null, exit: 0 };
const _list: ComponentId[] = [];

/** Strike every box of one component kind (a blast level's global effect). */
function strikeAll(
  sim: Sim,
  v: Vehicle,
  id: ComponentId,
  scale: number,
  external: boolean | null,
): void {
  const boxes = VEHICLE_MODELS[v.kind].components;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.id !== id || (external !== null && b.external !== external)) continue;
    if (scale >= 1) {
      damageBox(sim, v, i, 1, 'blast', 1, _list);
      continue;
    }
    const vul = COMPONENT_VULNERABILITY[id];
    const r = sim.rng.damage;
    if (r.chance(Math.min(1, vul.pHit * scale)))
      damageBox(sim, v, i, r.range(vul.damageMin, vul.damageMax), 'blast', scale, _list);
  }
}

/**
 * Blast and fragments of `chargeKg` kg of TNT-equivalent explosive with a fragmenting case of
 * `fragmentKg` kg, detonating at `position` (world). `weapon` names it in the hit log and kill
 * attribution ('MK-82', 'M151' …); `sourceId` is the store body id.
 *
 * An HEI round that has just been resolved against a vehicle by resolveRoundHit (same step,
 * same point) is not applied to that vehicle again.
 */
export function applyBlast(
  sim: Sim,
  position: Vector3,
  chargeKg: number,
  fragmentKg = 0,
  weapon = 'blast',
  sourceId = 0,
): void {
  if (!(chargeKg > 0) && !(fragmentKg > 0)) return;
  const W = Math.max(chargeKg, 0);
  const w13 = Math.cbrt(Math.max(W, 1e-9));
  const r = sim.rng.damage;
  const rho = densityAt(position.y);
  const mu = fragmentKg > 0 ? mottScale(fragmentKg) : 0;
  const nFrag = fragmentKg > 0 ? fragmentCount(fragmentKg) : 0;
  const v0 = fragmentKg > 0 ? gurneyVelocity(W, fragmentKg) : 0;
  // farthest a fragment heavier than ≈4μ still flies faster than the minimum velocity
  const fragRange =
    fragmentKg > 0
      ? Math.max(0, Math.log(v0 / FRAGMENTS.minVelocity)) *
        ((2 * Math.cbrt(Math.max(4 * mu, FRAGMENTS.minMass))) /
          (FRAGMENTS.dragCoeff * rho * FRAGMENTS.shapeFactor))
      : 0;
  const blastRange = W > 0 ? 14 * w13 : 0;
  const reach = Math.min(1500, Math.max(fragRange, blastRange)) + 10;
  const list = sim.targets.vehicles;
  for (let vi = 0; vi < list.length; vi++) {
    const v = list[vi];
    if (Math.abs(v.position.x - position.x) > reach || Math.abs(v.position.z - position.z) > reach)
      continue;
    const rt = v.internal;
    // HEI already resolved on this vehicle by resolveRoundHit
    if (
      rt.heiTime === sim.time &&
      Math.hypot(rt.heiX - position.x, rt.heiY - position.y, rt.heiZ - position.z) < 0.5
    )
      continue;
    applyToVehicle(sim, v, position, W, w13, fragmentKg, mu, nFrag, v0, rho, weapon, sourceId, r);
  }
}

function applyToVehicle(
  sim: Sim,
  v: Vehicle,
  position: Vector3,
  W: number,
  w13: number,
  fragmentKg: number,
  mu: number,
  nFrag: number,
  v0: number,
  rho: number,
  weapon: string,
  sourceId: number,
  r: Rng,
): void {
  const model = VEHICLE_MODELS[v.kind];
  const body = BODY[v.kind];
  const pose = vehiclePose(v, model.turretZ);
  worldToHull(pose, position.x, position.y, position.z, _b);
  // distance to the body's nearest surface (hull frame)
  const qx = Math.max(body.min[0] - _b.x, 0, _b.x - body.max[0]);
  const qy = Math.max(body.min[1] - _b.y, 0, _b.y - body.max[1]);
  const qz = Math.max(body.min[2] - _b.z, 0, _b.z - body.max[2]);
  const R = Math.hypot(qx, qy, qz) * (v.dugIn ? BLAST.dugInFactor : 1);
  const z = Math.max(R, BLAST.contactRadius) / w13;
  // distance to the body centre (the impulse that loads the whole vehicle)
  const Rc =
    Math.hypot(
      _b.x - (body.min[0] + body.max[0]) / 2,
      _b.y - (body.min[1] + body.max[1]) / 2,
      _b.z - (body.min[2] + body.max[2]) / 2,
    ) * (v.dugIn ? BLAST.dugInFactor : 1);
  const level = W > 0 ? blastLevel(v.kind, W, z, Math.max(Rc, BLAST.contactRadius) / w13) : 'none';
  _list.length = 0;
  const wasAlive = v.condition === 'intact' || v.condition === 'damaged';
  const lastWeapon = v.internal.lastWeapon;
  if (level !== 'none') v.internal.lastWeapon = weapon;

  // ---- blast ----
  if (level !== 'none') {
    const row = BLAST_THRESHOLDS[v.kind];
    if (level === 'catastrophic') {
      explode(sim, v, weapon);
    } else if (level === 'destroyed') {
      strikeAll(sim, v, 'crew', 1, null);
      strikeAll(sim, v, 'fuel', 0.6, null);
      strikeAll(sim, v, 'runningGear', 1, null);
      strikeAll(sim, v, 'optics', 1, null);
      updateComponentHealth(v);
      setCondition(sim, v, 'destroyed', weapon);
    } else if (level === 'heavy') {
      strikeAll(sim, v, 'runningGear', 1, null);
      strikeAll(sim, v, 'optics', 1, null);
      strikeAll(sim, v, 'gun', 0.7, null);
      strikeAll(sim, v, 'fuel', 0.6, true);
      strikeAll(sim, v, 'crew', 0.25, null);
      strikeAll(sim, v, 'engine', 0.3, null);
    } else if (row) {
      // light: external components near the burst, more the closer it is
      const radius = row.light.z * w13;
      strikeNear(
        sim,
        v,
        pose,
        position.x,
        position.y,
        position.z,
        radius,
        0,
        0.9 * (1 - z / row.light.z),
        'blast',
        _list,
      );
    }
  }

  // ---- fragments ----
  let fragHits = 0;
  let firstPlate = -1;
  let firstSpeed = 0;
  let firstObliquity = 0;
  let firstEff = 0;
  let firstPen = 0;
  if (fragmentKg > 0 && nFrag > 0) {
    const bx = (body.min[0] + body.max[0]) / 2;
    const by = (body.min[1] + body.max[1]) / 2;
    const bz = (body.min[2] + body.max[2]) / 2;
    const sx = body.max[0] - body.min[0];
    const sy = body.max[1] - body.min[1];
    const sz = body.max[2] - body.min[2];
    // direction from the body centre to the burst (hull frame) and the presented area
    let ux = _b.x - bx;
    let uy = _b.y - by;
    let uz = _b.z - bz;
    const rc = Math.hypot(ux, uy, uz);
    if (rc > 1e-6) {
      ux /= rc;
      uy /= rc;
      uz /= rc;
    }
    const area = Math.abs(ux) * sy * sz + Math.abs(uy) * sx * sz + Math.abs(uz) * sx * sy;
    const halfDiag = 0.5 * Math.hypot(sx, sy, sz);
    const rEff = Math.max(rc, halfDiag);
    const lambda = (FRAGMENTS.groundFactor * nFrag * area) / (4 * Math.PI * rEff * rEff);
    const n = poisson(r, lambda);
    if (n > 0) {
      const traced = Math.min(n, FRAGMENTS.maxTraced);
      const per = n / traced;
      const scale = FRAGMENTS.damageFactor * per;
      const s0 = Math.sqrt(FRAGMENTS.minMass / mu);
      for (let k = 0; k < traced; k++) {
        let u = r.next();
        if (u < 1e-12) u = 1e-12;
        const m = mu * (s0 - Math.log(u)) ** 2;
        // aim at a random point of the body
        hullToWorld(
          pose,
          body.min[0] + sx * r.next(),
          body.min[1] + sy * r.next(),
          body.min[2] + sz * r.next(),
          _c,
        );
        const dx = _c.x - position.x;
        const dy = _c.y - position.y;
        const dz = _c.z - position.z;
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-6) continue;
        const ext = (len + 2) / len;
        if (
          !rayVehicle(
            sim,
            v,
            pose,
            position.x,
            position.y,
            position.z,
            dx * ext,
            dy * ext,
            dz * ext,
            0,
            1,
            -1,
            _ph,
          ) ||
          !_ph.plate
        )
          continue;
        const dist = _ph.t * len * ext;
        const speed = fragmentSpeed(v0, m, dist, rho);
        if (speed < FRAGMENTS.minVelocity) continue;
        fragHits += per;
        const part = model.parts[_ph.part];
        const plate = _ph.plate;
        plateNormalWorld(pose, part, plate, _n);
        const ix = dx / len;
        const iy = dy / len;
        const iz = dz / len;
        const cosT = Math.max(1e-3, -(ix * _n.x + iy * _n.y + iz * _n.z));
        const theta = Math.acos(Math.min(1, cosT));
        const eff = plate.thicknessMm / cosT;
        const pen = fragmentPenetration(m, speed);
        if (firstPlate < 0) {
          firstPlate = plate.index;
          firstSpeed = speed;
          firstObliquity = theta;
          firstEff = eff;
          firstPen = pen;
        }
        const hx = position.x + dx * ext * _ph.t;
        const hy = position.y + dy * ext * _ph.t;
        const hz = position.z + dz * ext * _ph.t;
        if (
          theta > ROUND_EFFECTS.ricochetObliquity &&
          plate.thicknessMm >= ROUND_EFFECTS.ricochetMinThicknessMm
        )
          continue;
        if (pen > eff) {
          if (part.spaced) {
            strikeNear(
              sim,
              v,
              pose,
              hx,
              hy,
              hz,
              ROUND_EFFECTS.directHitRadius,
              0,
              scale,
              'fragment',
              _list,
            );
          } else {
            traceInterior(
              sim,
              v,
              pose,
              hx,
              hy,
              hz,
              ix,
              iy,
              iz,
              pen - eff,
              'fragment',
              true,
              scale,
              _list,
            );
          }
        } else {
          strikeNear(
            sim,
            v,
            pose,
            hx,
            hy,
            hz,
            ROUND_EFFECTS.directHitRadius,
            0,
            scale * 0.3,
            'fragment',
            _list,
          );
        }
      }
    }
  }

  if (level === 'none' && fragHits === 0) {
    v.internal.lastWeapon = lastWeapon;
    return;
  }
  v.internal.lastWeapon = weapon;
  v.hits++;
  v.lastHitTime = sim.time;
  alertGroup(sim, v.groupId);
  if (_list.length > 0) {
    updateComponentHealth(v);
    evaluateCondition(sim, v, weapon);
    sortDamaged(_list);
    if (wasAlive || v.condition === 'catastrophic') emitDamaged(sim, v, _list[0]);
  }
  const plate = firstPlate >= 0 ? model.plates[firstPlate] : null;
  recordHit(
    sim,
    v,
    sourceId,
    weapon,
    firstPlate,
    plate ? plate.face : 'side',
    plate ? partKindOf(v.kind, firstPlate) : 'hull',
    firstSpeed,
    firstObliquity,
    firstEff,
    firstPen,
    level !== 'none' ? 'blast' : 'fragment',
    _list,
  );
}

function partKindOf(kind: VehicleKind, plateIndex: number): string {
  for (const p of VEHICLE_MODELS[kind].parts) {
    for (const pl of p.plates) if (pl.index === plateIndex) return p.part;
  }
  return 'hull';
}
