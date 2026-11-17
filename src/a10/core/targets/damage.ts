/**
 * What a 30 mm round does to the vehicle it strikes (PLAN §6.3, contract §5):
 *
 *  - obliquity θ between the round's path and the plate normal; effective thickness t / cos θ;
 *  - beyond 70° a hard plate deflects the round (ricochet: reflected, slowed);
 *  - API (and the inert TP slug) penetrate when penetrationMm(type, impact speed), with a small
 *    deterministic round-to-round scatter, exceeds the effective thickness. Spaced layers (track
 *    run, fender stowage, external tanks, the gun barrel) are crossed first and the residual
 *    penetration meets the main armour behind them;
 *  - HEI bursts on contact: it hurts what is outside (sights, tracks, external fuel) and defeats
 *    only thin skin, then hurts what is close behind it;
 *  - behind the armour the penetrator carries on for 1.5–3 m with a cone of behind-armour debris,
 *    and every component box it crosses may be hurt: ammunition → explosion (often after a short
 *    fire), fuel → fire, engine or running gear → mobility kill, gun or sights → firepower kill,
 *    crew → casualties → destroyed.
 *  - tracks are broken, not worn down: only a penetrator that defeats the track run (or heavy
 *    blast, blast.ts) breaks one (review TE-2); a nearby strike does not;
 *  - each external part is struck at most once per round, however many spaced layers the round
 *    crosses on its way (review TE-3).
 *
 * Randomness comes only from sim.rng.damage.
 */
import { Vector3 } from 'three';
import {
  AMMO_EFFECTS,
  COMPONENT_VULNERABILITY,
  FIRE_SOURCES,
  FRAGMENTS,
  ROUND_EFFECTS,
  VEHICLE_MODELS,
} from '../../data/vehicles';
import type { Sim } from '../types';
import { penetrationMm } from '../weapons/penetration';
import { RoundType } from '../weapons/types';
import { plateNormalWorld, rayVehicle, partOfPlate, type PartHit } from './hit';
import {
  hullDirToTurret,
  hullToTurret,
  vehiclePose,
  worldDirToHull,
  worldToHull,
  type Pose,
  type V3,
} from './pose';
import {
  alertGroup,
  emitDamaged,
  evaluateCondition,
  explode,
  findVehicle,
  igniteInside,
  igniteOutside,
  recordHit,
  scheduleExplosion,
  sortDamaged,
  updateComponentHealth,
} from './state';
import type {
  ComponentBox,
  ComponentId,
  RoundHitResult,
  RoundOutcome,
  Vehicle,
  VehicleHit,
  VehicleKind,
} from './types';

/** What hurt a component: decides fire and detonation chances. */
export type DamageCause = 'api' | 'hei' | 'fragment' | 'blast';

/** How strongly each cause sets off ammunition, relative to a DU penetrator. */
const DETONATION_FACTOR: Record<DamageCause, number> = {
  api: 1,
  hei: 0.8,
  fragment: 0.5,
  blast: 0.8,
};

export const WEAPON_NAME: Record<number, string> = {
  [RoundType.API]: 'API',
  [RoundType.HEI]: 'HEI',
  [RoundType.TP]: 'TP',
};

// ---- Component damage --------------------------------------------------------------------------

function pushUnique(list: ComponentId[], id: ComponentId): void {
  for (let i = 0; i < list.length; i++) if (list[i] === id) return;
  list.push(id);
}

/**
 * Hurt component box `i` of `v` by `amount` of health, with the side effects of its kind: fire,
 * ammunition explosion, engine stop. `weight` (0..1) scales the chances (debris, fragments).
 */
export function damageBox(
  sim: Sim,
  v: Vehicle,
  i: number,
  amount: number,
  cause: DamageCause,
  weight: number,
  list: ComponentId[],
): void {
  const rt = v.internal;
  const box = VEHICLE_MODELS[v.kind].components[i];
  if (rt.boxHealth[i] <= 0 || amount <= 0) return;
  rt.boxHealth[i] = Math.max(0, rt.boxHealth[i] - amount);
  pushUnique(list, box.id);
  const r = sim.rng.damage;
  switch (box.id) {
    case 'ammo': {
      const fx = AMMO_EFFECTS[v.kind];
      if (!fx || v.condition === 'catastrophic') break;
      if (rt.explodeTime < 0 && r.chance(fx.pDetonate * DETONATION_FACTOR[cause] * weight)) {
        if (r.chance(fx.pImmediate)) {
          updateComponentHealth(v);
          explode(sim, v, rt.lastWeapon);
        } else {
          scheduleExplosion(sim, v, r.range(fx.delay[0], fx.delay[1]));
          igniteInside(v, 0.8, 120);
        }
      } else if (r.chance(FIRE_SOURCES.ammo[cause] * weight)) {
        igniteInside(v, FIRE_SOURCES.ammo.intensity, FIRE_SOURCES.ammo.load);
      }
      break;
    }
    case 'fuel': {
      const src =
        v.kind === 'truckFuel' && !box.external
          ? FIRE_SOURCES.tanker
          : box.external
            ? FIRE_SOURCES.fuelExternal
            : FIRE_SOURCES.fuelInternal;
      if (r.chance(src[cause] * weight)) {
        if (box.external) igniteOutside(v, src.intensity, src.load);
        else igniteInside(v, src.intensity, src.load);
      }
      break;
    }
    case 'engine':
      if (r.chance(FIRE_SOURCES.engine[cause] * weight))
        igniteInside(v, FIRE_SOURCES.engine.intensity, FIRE_SOURCES.engine.load);
      break;
    case 'cargo':
      if (r.chance(FIRE_SOURCES.cargo[cause] * weight))
        igniteInside(v, FIRE_SOURCES.cargo.intensity, FIRE_SOURCES.cargo.load);
      break;
    default:
      break;
  }
}

/** Roll whether a strike hurts box `i` (chance pHit × scale) and by how much. */
export function strikeBox(
  sim: Sim,
  v: Vehicle,
  i: number,
  scale: number,
  cause: DamageCause,
  list: ComponentId[],
): void {
  if (scale <= 0) return;
  const box = VEHICLE_MODELS[v.kind].components[i];
  const vul = COMPONENT_VULNERABILITY[box.id];
  const r = sim.rng.damage;
  if (!r.chance(Math.min(1, vul.pHit * scale))) return;
  const amount = r.range(vul.damageMin, vul.damageMax) * (0.5 + 0.5 * Math.min(1, scale));
  damageBox(sim, v, i, amount, cause, Math.min(1, scale), list);
}

// ---- Geometry of boxes -------------------------------------------------------------------------

const _hb: V3 = { x: 0, y: 0, z: 0 };
const _hd: V3 = { x: 0, y: 0, z: 0 };
const _tb: V3 = { x: 0, y: 0, z: 0 };
const _td: V3 = { x: 0, y: 0, z: 0 };

/** Entry parameter of the ray o + t·d (t ∈ [0, tMax]) into a box, or Infinity. */
function rayBox(
  b: ComponentBox,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  tMax: number,
): number {
  let t0 = 0;
  let t1 = tMax;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? ox : a === 1 ? oy : oz;
    const d = a === 0 ? dx : a === 1 ? dy : dz;
    const lo = b.min[a];
    const hi = b.max[a];
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return Infinity;
      continue;
    }
    let ta = (lo - o) / d;
    let tb = (hi - o) / d;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/** Distance from a point to a box (0 inside). */
function boxDistance(b: ComponentBox, x: number, y: number, z: number): number {
  const dx = Math.max(b.min[0] - x, 0, x - b.max[0]);
  const dy = Math.max(b.min[1] - y, 0, y - b.max[1]);
  const dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
  return Math.hypot(dx, dy, dz);
}

/** Set the hull-frame (and turret-frame) origin and direction of a world ray. */
function frameRay(
  pose: Pose,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
): void {
  worldToHull(pose, x, y, z, _hb);
  worldDirToHull(pose, dx, dy, dz, _hd);
  hullToTurret(pose, _hb.x, _hb.y, _hb.z, _tb);
  hullDirToTurret(pose, _hd.x, _hd.y, _hd.z, _td);
}

const MAX_BOXES = 64;
const crossT = new Float64Array(MAX_BOXES);
const crossI = new Int32Array(MAX_BOXES);

/**
 * Walk the internal boxes crossed by the current frame ray (frameRay) up to `length` m, nearest
 * first; each may be struck (chance × `scale`). The penetrator loses each box's absorbMm and
 * stops when `capacityMm` is spent; at most `maxBoxes` boxes are visited.
 */
function walkInterior(
  sim: Sim,
  v: Vehicle,
  length: number,
  capacityMm: number,
  scale: number,
  maxBoxes: number,
  cause: DamageCause,
  list: ComponentId[],
): void {
  const boxes = VEHICLE_MODELS[v.kind].components;
  let n = 0;
  for (let i = 0; i < boxes.length && n < MAX_BOXES; i++) {
    const b = boxes[i];
    if (b.external) continue;
    const t = b.turret
      ? v.thrownTurret
        ? Infinity
        : rayBox(b, _tb.x, _tb.y, _tb.z, _td.x, _td.y, _td.z, length)
      : rayBox(b, _hb.x, _hb.y, _hb.z, _hd.x, _hd.y, _hd.z, length);
    if (t === Infinity) continue;
    // insertion sort by entry distance
    let j = n - 1;
    while (j >= 0 && crossT[j] > t) {
      crossT[j + 1] = crossT[j];
      crossI[j + 1] = crossI[j];
      j--;
    }
    crossT[j + 1] = t;
    crossI[j + 1] = i;
    n++;
  }
  let cap = capacityMm;
  for (let k = 0; k < n && k < maxBoxes; k++) {
    if (cap <= 0) break;
    const i = crossI[k];
    strikeBox(sim, v, i, scale, cause, list);
    cap -= boxes[i].absorbMm;
  }
}

const _u = new Vector3();
const _w = new Vector3();
const _dir = new Vector3();

/**
 * A penetrator (or fragment) that went through the armour at world point p, travelling along the
 * unit world direction d with `residualMm` of penetration left: hurt what lies on its path and,
 * for 30 mm rounds, in the cone of behind-armour debris around it.
 */
export function traceInterior(
  sim: Sim,
  v: Vehicle,
  pose: Pose,
  px: number,
  py: number,
  pz: number,
  dx: number,
  dy: number,
  dz: number,
  residualMm: number,
  cause: DamageCause,
  fragment: boolean,
  scale: number,
  list: ComponentId[],
): void {
  const E = ROUND_EFFECTS;
  const minL = fragment ? FRAGMENTS.residualMin : E.residualMin;
  const maxL = fragment ? FRAGMENTS.residualMax : E.residualMax;
  const ref = fragment ? FRAGMENTS.residualRefMm : E.residualRefMm;
  const excess = Math.min(1, Math.max(0, residualMm) / ref);
  const length = minL + (maxL - minL) * excess;
  frameRay(pose, px, py, pz, dx, dy, dz);
  walkInterior(sim, v, length, residualMm, scale, 8, cause, list);
  if (fragment) return;
  // behind-armour debris: a cone of rays around the shot line
  const r = sim.rng.damage;
  const cone = r.range(E.debrisConeMin, E.debrisConeMax);
  const phase = r.range(0, Math.PI * 2);
  const w = E.debrisWeight * Math.min(1, 0.3 + excess) * scale;
  _dir.set(dx, dy, dz);
  // a basis perpendicular to the shot line
  if (Math.abs(dy) < 0.9) _u.set(0, 1, 0);
  else _u.set(1, 0, 0);
  _u.cross(_dir).normalize();
  _w.copy(_dir).cross(_u);
  const ca = Math.cos(cone);
  const sa = Math.sin(cone);
  for (let k = 0; k < E.debrisRays; k++) {
    const phi = phase + (2 * Math.PI * k) / E.debrisRays;
    const cu = Math.cos(phi) * sa;
    const cw = Math.sin(phi) * sa;
    frameRay(
      pose,
      px,
      py,
      pz,
      dx * ca + _u.x * cu + _w.x * cw,
      dy * ca + _u.y * cu + _w.y * cw,
      dz * ca + _u.z * cu + _w.z * cw,
    );
    walkInterior(sim, v, length * 0.75, Infinity, w, 2, cause, list);
  }
}

/**
 * Something burst or struck at world point p: external boxes within `externalRadius` (and, when
 * the skin is defeated, internal boxes within `internalRadius`) may be hurt, more the closer.
 */
export function strikeNear(
  sim: Sim,
  v: Vehicle,
  pose: Pose,
  px: number,
  py: number,
  pz: number,
  externalRadius: number,
  internalRadius: number,
  scale: number,
  cause: DamageCause,
  list: ComponentId[],
  once: Uint8Array | null = null,
): void {
  const boxes = VEHICLE_MODELS[v.kind].components;
  worldToHull(pose, px, py, pz, _hb);
  hullToTurret(pose, _hb.x, _hb.y, _hb.z, _tb);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const R = b.external ? externalRadius : internalRadius;
    if (R <= 0) continue;
    // tracks break only when their run is defeated (breakTrack)
    if (b.breakChance !== undefined) continue;
    if (once && once[i]) continue;
    if (b.turret && v.thrownTurret) continue;
    // in a firing pit the earth covers what lies below the rim
    if (v.dugIn && !b.turret && b.max[1] < v.internal.digDepth) continue;
    const d = b.turret ? boxDistance(b, _tb.x, _tb.y, _tb.z) : boxDistance(b, _hb.x, _hb.y, _hb.z);
    if (d >= R) continue;
    if (once) once[i] = 1;
    strikeBox(sim, v, i, scale * (1 - d / R), cause, list);
  }
}

/**
 * For each class, the breakable track box carried by each armour part (by name), or −1: the run
 * a penetrator defeats is the track it may break.
 */
const TRACK_BOX = {} as Record<VehicleKind, Int8Array>;
for (const kind of Object.keys(VEHICLE_MODELS) as VehicleKind[]) {
  const m = VEHICLE_MODELS[kind];
  const map = new Int8Array(m.parts.length).fill(-1);
  m.parts.forEach((part, pi) => {
    map[pi] = m.components.findIndex((b) => b.breakChance !== undefined && b.name === part.name);
  });
  TRACK_BOX[kind] = map;
}

/**
 * A penetrator or fragment defeated the run of armour part `partIndex`: if that part is a track,
 * break it with its break chance × `scale` (a link or a pin severed). Returns true if it broke.
 */
export function breakTrack(
  sim: Sim,
  v: Vehicle,
  partIndex: number,
  scale: number,
  cause: DamageCause,
  list: ComponentId[],
): boolean {
  const i = partIndex >= 0 ? TRACK_BOX[v.kind][partIndex] : -1;
  if (i < 0 || v.internal.boxHealth[i] <= 0) return false;
  const chance = VEHICLE_MODELS[v.kind].components[i].breakChance ?? 0;
  if (!sim.rng.damage.chance(Math.min(1, chance * scale))) return false;
  damageBox(sim, v, i, 1, cause, 1, list);
  return true;
}

/** Mark a burst resolved on `v` at this point in this step (its applyBlast then skips `v`). */
export function markBurst(sim: Sim, v: Vehicle, x: number, y: number, z: number): void {
  const rt = v.internal;
  rt.burstTime = sim.time;
  rt.burstX = x;
  rt.burstY = y;
  rt.burstZ = z;
}

// ---- resolveRoundHit ---------------------------------------------------------------------------

const _ph: PartHit = { t: 0, part: -1, plate: null, exit: 0 };
const _nrm: V3 = { x: 0, y: 0, z: 0 };
/** External boxes already struck by the round being resolved (TE-3: once per round). */
const _struck = new Uint8Array(MAX_BOXES);

/** Velocity after a ricochet off a plate with world normal n (reflected, slowed, scattered). */
function ricochet(sim: Sim, vx: number, vy: number, vz: number, n: V3, out: Vector3): void {
  const E = ROUND_EFFECTS;
  const vn = vx * n.x + vy * n.y + vz * n.z; // < 0 into the plate
  const tx = vx - vn * n.x;
  const ty = vy - vn * n.y;
  const tz = vz - vn * n.z;
  out.set(
    tx * E.ricochetTangential - vn * E.ricochetNormal * n.x,
    ty * E.ricochetTangential - vn * E.ricochetNormal * n.y,
    tz * E.ricochetTangential - vn * E.ricochetNormal * n.z,
  );
  // a small random deflection, then make sure it leaves the plate
  const r = sim.rng.damage;
  const speed = out.length();
  _dir.copy(out).normalize();
  if (Math.abs(_dir.y) < 0.9) _u.set(0, 1, 0);
  else _u.set(1, 0, 0);
  _u.cross(_dir).normalize();
  _w.copy(_dir).cross(_u);
  const a = r.normal() * E.ricochetScatter;
  const b = r.normal() * E.ricochetScatter;
  out.addScaledVector(_u, speed * Math.tan(a)).addScaledVector(_w, speed * Math.tan(b));
  const away = out.x * n.x + out.y * n.y + out.z * n.z;
  if (away < 0.02 * speed) out.addScaledVector(_dir.set(n.x, n.y, n.z), 0.02 * speed - away);
  out.setLength(speed);
}

/**
 * What a 30 mm round does to the plate it hit (see the file comment). Applies the damage, emits
 * 'vehicleDamaged' / 'vehicleDestroyed' (and 'detonation' kind 'secondary' when ammunition goes
 * up), appends a HitRecord, and returns the outcome in `out` (with the ricochet velocity).
 * `sourceId` is the round id for the hit log.
 */
export function resolveRoundHit(
  sim: Sim,
  hit: VehicleHit,
  type: RoundType,
  velocity: Vector3,
  out: RoundHitResult,
  sourceId = 0,
): RoundHitResult {
  out.damaged.length = 0;
  out.ricochetVelocity.set(0, 0, 0);
  out.obliquity = 0;
  out.effectiveThicknessMm = 0;
  out.penetrationMm = 0;
  out.outcome = 'stopped';
  const v = findVehicle(sim, hit.vehicleId);
  if (!v) return out;
  const model = VEHICLE_MODELS[v.kind];
  const weapon = WEAPON_NAME[type] ?? 'API';
  const speed = velocity.length();
  if (speed < 1e-6) return out;
  const dx = velocity.x / speed;
  const dy = velocity.y / speed;
  const dz = velocity.z / speed;
  const list = out.damaged;
  const r = sim.rng.damage;
  const E = ROUND_EFFECTS;
  const pose = vehiclePose(v, model.turretZ);
  v.hits++;
  v.lastHitTime = sim.time;
  v.internal.lastWeapon = weapon;
  alertGroup(sim, v.groupId);

  let partIndex = hit.partIndex ?? partOfPlate(model, hit.plate);
  let plate = model.plates[hit.plate] ?? model.parts[partIndex].plates[0];
  _nrm.x = hit.normal.x;
  _nrm.y = hit.normal.y;
  _nrm.z = hit.normal.z;
  let cosT = Math.max(1e-3, -(dx * _nrm.x + dy * _nrm.y + dz * _nrm.z));
  const theta = Math.acos(Math.min(1, cosT));
  const nominal = penetrationMm(type, speed);
  const kinetic = type !== RoundType.HEI;
  // round-to-round scatter (striking yaw, plate hardness)
  const scatter = kinetic
    ? 1 + Math.max(-E.penetrationClip, Math.min(E.penetrationClip, r.normal() * E.penetrationSigma))
    : 1;
  const pen = nominal * scatter;
  out.obliquity = theta;
  out.effectiveThicknessMm = plate.thicknessMm / cosT;
  out.penetrationMm = pen;
  let decidingPlate = plate.index;
  let outcome: RoundOutcome = 'stopped';
  const cause: DamageCause =
    type === RoundType.API ? 'api' : type === RoundType.HEI ? 'hei' : 'fragment';
  const px = hit.point.x;
  const py = hit.point.y;
  const pz = hit.point.z;

  // The weapons module bursts every HEI round that strikes a vehicle and applies its blast at
  // this point: whatever the outcome here, that blast must not count this vehicle again (TE-4).
  if (!kinetic) markBurst(sim, v, px, py, pz);
  _struck.fill(0);

  if (v.kind === 'panel') {
    outcome = 'passedThrough';
  } else if (!kinetic) {
    // HEI: the nose fuze functions on contact, also at a grazing angle; defeats only thin skin
    outcome = 'burst';
    const part = model.parts[partIndex];
    const skin = !part.spaced && pen > plate.thicknessMm / cosT;
    strikeNear(
      sim,
      v,
      pose,
      px,
      py,
      pz,
      E.heiBurstRadius,
      skin ? E.heiInteriorRadius : 0,
      1,
      'hei',
      list,
    );
  } else if (theta > E.ricochetObliquity && plate.thicknessMm >= E.ricochetMinThicknessMm) {
    outcome = 'ricochet';
    ricochet(sim, velocity.x, velocity.y, velocity.z, _nrm, out.ricochetVelocity);
  } else {
    // API / TP: through any spaced layers to the main armour
    let cap = pen;
    let ax = px;
    let ay = py;
    let az = pz;
    for (let layer = 0; layer < E.maxLayers; layer++) {
      const part = model.parts[partIndex];
      const eff = plate.thicknessMm / cosT;
      if (layer > 0) {
        if (
          Math.acos(Math.min(1, cosT)) > E.ricochetObliquity &&
          plate.thicknessMm >= E.ricochetMinThicknessMm
        ) {
          outcome = 'stopped';
          decidingPlate = plate.index;
          break;
        }
      }
      // what the round strikes on the outside (sights, external tanks), each part once
      strikeNear(
        sim,
        v,
        pose,
        ax,
        ay,
        az,
        E.directHitRadius,
        0,
        E.kineticExternalFactor,
        cause,
        list,
        _struck,
      );
      decidingPlate = plate.index;
      if (cap <= eff) {
        outcome = 'stopped';
        break;
      }
      cap -= eff;
      // through a track run: a link or a pin may be severed
      breakTrack(sim, v, partIndex, 1, cause, list);
      if (!part.spaced) {
        outcome = 'penetrated';
        traceInterior(sim, v, pose, ax, ay, az, dx, dy, dz, cap, cause, false, 1, list);
        break;
      }
      // through a spaced layer: is there armour behind it?
      const L = E.spacedSearch;
      if (
        !rayVehicle(sim, v, pose, ax, ay, az, dx * L, dy * L, dz * L, 1e-5, 1, partIndex, _ph) ||
        !_ph.plate
      ) {
        outcome = 'passedThrough';
        break;
      }
      partIndex = _ph.part;
      plate = _ph.plate;
      ax += dx * L * _ph.t;
      ay += dy * L * _ph.t;
      az += dz * L * _ph.t;
      plateNormalWorld(pose, model.parts[partIndex], plate, _nrm);
      cosT = Math.max(1e-3, -(dx * _nrm.x + dy * _nrm.y + dz * _nrm.z));
      outcome = 'stopped';
    }
  }

  if (list.length > 0) {
    updateComponentHealth(v);
    evaluateCondition(sim, v, weapon);
    sortDamaged(list);
    emitDamaged(sim, v, list[0]);
  }
  out.outcome = outcome;
  out.plate = decidingPlate;
  out.condition = v.condition;
  const dp = model.plates[decidingPlate];
  const dpart = model.parts[partOfPlate(model, decidingPlate)];
  recordHit(
    sim,
    v,
    sourceId,
    weapon,
    decidingPlate,
    dp.face,
    dpart.part,
    speed,
    decidingPlate === hit.plate ? theta : Math.acos(Math.min(1, cosT)),
    dp.thicknessMm / (decidingPlate === hit.plate ? Math.max(1e-3, Math.cos(theta)) : cosT),
    pen,
    outcome,
    list,
  );
  return out;
}
