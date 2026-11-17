/**
 * Vehicle behaviour, one fixed step (PLAN §9): columns drive their roads at 30–40 km/h about 50 m
 * apart, steering smoothly toward a point ahead on the road and slowing on steep grades; a group
 * that is attacked (a round or blast within ≈150 m of one of its vehicles, or a hit) reacts after
 * a short delay: columns stop and scatter 50–200 m off the road, parked groups start engines and
 * may head for the nearest trees, dug-in groups stay put. Immobilised and destroyed vehicles roll
 * to a stop. Every vehicle sits on the ground (heightAt) with pitch and roll from the slope; turrets
 * scan slowly or follow the aircraft; heat, fires, cook-offs and thrown turrets evolve.
 *
 * Randomness: sim.rng.targets for behaviour, sim.rng.damage for fires and explosions.
 */
import {
  AMMO_EFFECTS,
  FIRE_MODEL,
  KILL_RULES,
  MOBILITY,
  SCENARIO,
  THERMAL,
  VEHICLE_SHAPES,
} from '../../data/vehicles';
import { G0 } from '../constants';
import { headingOf, wrapPi } from '../frames';
import type { Sim } from '../types';
import { createRoadPoint } from '../world/roads';
import { forEachNear } from './grid';
import { extendRoute, legAt, routeEnd, routePoint } from './route';
import { groundOk, spawnHuntGroup, updateGroupBounds } from './scenario';
import {
  evaluateCondition,
  explode,
  findVehicle,
  groundAttitude,
  isAlive,
  scheduleExplosion,
} from './state';
import type { Vehicle, VehicleGroup, VehicleInternal } from './types';

const _rp = createRoadPoint();
const _rq = createRoadPoint();
const _att = { pitch: 0, roll: 0 };

/** Steps between ground-slope samples of a moving vehicle. */
const SLOPE_EVERY = 6;
/** Time constant of the hull settling to the ground slope, s. */
const SETTLE = 0.25;

const tracked = (v: Vehicle) => VEHICLE_SHAPES[v.kind].running.type === 'tracks';
const powered = (v: Vehicle) => v.kind !== 'hulk' && v.kind !== 'panel';

// ---- Alerts ------------------------------------------------------------------------------------

let alertX = 0;
let alertZ = 0;
let alertSim: Sim | null = null;

function visitAlert(i: number): boolean {
  const sim = alertSim as Sim;
  const v = sim.targets.vehicles[i];
  const dx = v.position.x - alertX;
  const dz = v.position.z - alertZ;
  if (dx * dx + dz * dz <= MOBILITY.alertRadius * MOBILITY.alertRadius) {
    const g = groupById(sim, v.groupId);
    if (g && g.reacts && g.alertTime < 0) g.alertTime = sim.time;
  }
  return true;
}

let lastGroup = 0;

function groupById(sim: Sim, id: number): VehicleGroup | null {
  const gs = sim.targets.groups;
  const c = gs[lastGroup];
  if (c && c.id === id) return c;
  for (let i = 0; i < gs.length; i++) {
    if (gs[i].id === id) {
      lastGroup = i;
      return gs[i];
    }
  }
  return null;
}

/** Alert every group with a vehicle within the alert radius of (x, z). */
function alertNear(sim: Sim, x: number, z: number): void {
  alertSim = sim;
  alertX = x;
  alertZ = z;
  const r = MOBILITY.alertRadius;
  forEachNear(sim.targets, x - r, z - r, x + r, z + r, visitAlert);
  alertSim = null;
}

/**
 * Impacts and detonations since the last scan (sim.events is drained by the frame loop: the scan
 * restarts when the event it stopped at is no longer where it was).
 */
function scanEvents(sim: Sim): void {
  const g = sim.targets.internal;
  const ev = sim.events;
  let start = g.eventIndex;
  if (start > ev.length || (start > 0 && ev[start - 1] !== g.lastEvent)) start = 0;
  for (let i = start; i < ev.length; i++) {
    const e = ev[i];
    if (e.type === 'roundImpact' || e.type === 'detonation') alertNear(sim, e.position.x, e.position.z);
  }
  g.eventIndex = ev.length;
  g.lastEvent = ev.length > 0 ? ev[ev.length - 1] : null;
}

// ---- Reactions ---------------------------------------------------------------------------------

function pickScatterGoal(sim: Sim, v: Vehicle, index: number): boolean {
  const r = sim.rng.targets;
  const rt = v.internal;
  const h = v.heading;
  const rx = Math.cos(h);
  const rz = Math.sin(h);
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  let side = index % 2 === 0 ? 1 : -1;
  if (r.chance(0.3)) side = -side;
  for (let k = 0; k < 8; k++) {
    const d = r.range(MOBILITY.scatterMin, MOBILITY.scatterMax) * (k < 4 ? 1 : 0.6);
    const along = r.range(-30, 40);
    const s = k % 2 === 0 ? side : -side;
    const x = v.position.x + rx * s * d + fx * along;
    const z = v.position.z + rz * s * d + fz * along;
    if (!groundOk(sim, x, z, false)) continue;
    rt.goalX = x;
    rt.goalZ = z;
    rt.hasGoal = true;
    return true;
  }
  return false;
}

function pickCover(sim: Sim, v: Vehicle): boolean {
  const t = sim.world.terrain;
  const r = sim.rng.targets;
  const phase = r.range(0, Math.PI * 2);
  for (let d = 30; d <= MOBILITY.coverSearch; d += 30) {
    for (let k = 0; k < 16; k++) {
      const a = phase + (k / 16) * Math.PI * 2;
      const x = v.position.x + Math.cos(a) * d;
      const z = v.position.z + Math.sin(a) * d;
      if (t.canopyAt(x, z) <= 0) continue;
      // just inside the edge of the trees
      const gx = x + Math.cos(a) * 4;
      const gz = z + Math.sin(a) * 4;
      if (!groundOk(sim, gx, gz, false)) continue;
      v.internal.goalX = gx;
      v.internal.goalZ = gz;
      v.internal.hasGoal = true;
      return true;
    }
  }
  return false;
}

function startEngine(v: Vehicle): void {
  if (powered(v) && isAlive(v) && v.components.engine > KILL_RULES.boxDead) v.engineOn = true;
}

/** A group's reaction to its first alert. */
function react(sim: Sim, g: VehicleGroup): void {
  g.reacted = true;
  if (!g.reacts) return;
  const r = sim.rng.targets;
  const now = sim.time;
  if (g.behaviour === 'column') {
    g.behaviour = 'scatter';
    let index = 0;
    for (const id of g.vehicleIds) {
      const v = findVehicle(sim, id);
      if (!v) continue;
      v.internal.waitUntil = now + r.range(MOBILITY.reactionMin, MOBILITY.reactionMax);
      if (isAlive(v) && !v.mobilityKill) pickScatterGoal(sim, v, index);
      index++;
    }
  } else if (g.behaviour === 'parked') {
    const toCover = r.chance(MOBILITY.coverChance);
    for (const id of g.vehicleIds) {
      const v = findVehicle(sim, id);
      if (!v) continue;
      startEngine(v);
      if (toCover && isAlive(v) && !v.mobilityKill && v.engineOn && pickCover(sim, v))
        v.internal.waitUntil = now + r.range(MOBILITY.coverDelayMin, MOBILITY.coverDelayMax);
    }
  } else if (g.behaviour === 'dugIn') {
    for (const id of g.vehicleIds) {
      const v = findVehicle(sim, id);
      if (v) startEngine(v);
    }
  }
}

// ---- Driving -----------------------------------------------------------------------------------

/** Speed factor on a grade (uphill slows the vehicle). */
function gradeFactor(sim: Sim, v: Vehicle): number {
  const t = sim.world.terrain;
  const fx = Math.sin(v.heading) * 5;
  const fz = -Math.cos(v.heading) * 5;
  const grade = (t.heightAt(v.position.x + fx, v.position.z + fz) - t.heightAt(v.position.x - fx, v.position.z - fz)) / 10;
  const f = 1 - MOBILITY.gradeSlow * Math.max(0, grade - MOBILITY.gradeStart);
  return f < MOBILITY.gradeMinFactor ? MOBILITY.gradeMinFactor : f > 1 ? 1 : f;
}

/** Bring the speed toward `target` within the acceleration and braking limits. */
function approachSpeed(v: Vehicle, target: number, dt: number): void {
  if (v.speed < target) v.speed = Math.min(target, v.speed + MOBILITY.accel * dt);
  else v.speed = Math.max(target, v.speed - MOBILITY.brake * dt);
}

/** Turn toward `heading` no faster than the vehicle can, then move forward. */
function drive(sim: Sim, v: Vehicle, heading: number, dt: number): void {
  const radius = tracked(v) ? MOBILITY.turnRadiusTracked : MOBILITY.turnRadiusWheeled;
  const maxTurn = (Math.max(1, v.speed) / radius) * dt;
  let dh = wrapPi(heading - v.heading);
  if (dh > maxTurn) dh = maxTurn;
  else if (dh < -maxTurn) dh = -maxTurn;
  let h = v.heading + dh;
  if (h < 0) h += Math.PI * 2;
  else if (h >= Math.PI * 2) h -= Math.PI * 2;
  v.heading = h;
  v.position.x += Math.sin(h) * v.speed * dt;
  v.position.z -= Math.cos(h) * v.speed * dt;
  settle(sim, v, dt, true);
}

/** Keep a vehicle on the ground and let the hull follow the slope. */
function settle(sim: Sim, v: Vehicle, dt: number, moving: boolean): void {
  const rt = v.internal;
  v.position.y = sim.world.terrain.heightAt(v.position.x, v.position.z) - (v.dugIn ? rt.digDepth : 0);
  if (v.dugIn) return;
  if (moving && --rt.slopeTimer <= 0) {
    rt.slopeTimer = SLOPE_EVERY;
    groundAttitude(sim, v.kind, v.position.x, v.position.z, v.heading, _att);
    rt.groundPitch = _att.pitch;
    rt.groundRoll = _att.roll;
  }
  const k = Math.min(1, dt / SETTLE);
  v.pitch += (rt.groundPitch - v.pitch) * k;
  v.roll += (rt.groundRoll - v.roll) * k;
}

/** One column on its route: car-following along the route, pure-pursuit steering. */
function stepColumn(sim: Sim, g: VehicleGroup, dt: number): boolean {
  if (g.route.length === 0) return false;
  let moved = false;
  let prevS = Infinity;
  let lead = true;
  for (const id of g.vehicleIds) {
    const v = findVehicle(sim, id);
    if (!v) continue;
    const rt = v.internal;
    if (!isAlive(v) || v.mobilityKill) {
      if (v.speed > 0) {
        approachSpeed(v, 0, dt);
        drive(sim, v, v.heading, dt);
        moved = true;
      }
      // a stopped vehicle blocks the road for those behind it
      prevS = rt.s;
      lead = false;
      continue;
    }
    const offset = g.route[legAt(g, rt.s)].loop ? 0 : MOBILITY.roadKeepRight * g.route[legAt(g, rt.s)].road.width;
    let target = g.speed * gradeFactor(sim, v);
    if (lead) {
      if (rt.s + MOBILITY.lookAhead + 40 > routeEnd(g)) extendRoute(sim, g);
      const left = routeEnd(g) - rt.s;
      if (left < 60) target = Math.min(target, Math.sqrt(2 * MOBILITY.brake * Math.max(0, left - 10)));
    } else {
      const gap = prevS - rt.s;
      target = Math.max(0, Math.min(1.3 * g.speed, target + 0.3 * (gap - g.spacing)));
      if (gap < 0.5 * g.spacing) target = 0;
    }
    approachSpeed(v, target, dt);
    rt.s += v.speed * dt;
    if (v.speed > 0.01) {
      routePoint(g, rt.s + MOBILITY.lookAhead, offset, _rp);
      drive(sim, v, headingOf(_rp.x - v.position.x, _rp.z - v.position.z), dt);
      moved = true;
      // keep the route distance matched to where the vehicle really is
      routePoint(g, rt.s, offset, _rq);
      const e = (v.position.x - _rq.x) * Math.sin(_rq.heading) - (v.position.z - _rq.z) * Math.cos(_rq.heading);
      if (Math.abs(e) < 10) rt.s += e;
    }
    rt.leg = legAt(g, rt.s);
    if (lead) {
      routePoint(g, rt.s, 0, _rq);
      g.roadDistance = _rq.distance;
      g.roadId = g.route[rt.leg].roadIndex;
    }
    prevS = rt.s;
    lead = false;
  }
  return moved;
}

/** Off-road driving to a goal (scatter, cover), then halt. */
function stepGoal(sim: Sim, v: Vehicle, dt: number): boolean {
  const rt = v.internal;
  const canDrive = isAlive(v) && !v.mobilityKill && v.engineOn;
  if (!rt.hasGoal || !canDrive || sim.time < rt.waitUntil) {
    if (v.speed > 0) {
      approachSpeed(v, 0, dt);
      drive(sim, v, v.heading, dt);
      return true;
    }
    return false;
  }
  const dx = rt.goalX - v.position.x;
  const dz = rt.goalZ - v.position.z;
  const d = Math.hypot(dx, dz);
  if (d < 4) {
    rt.hasGoal = false;
    approachSpeed(v, 0, dt);
    if (v.speed > 0) drive(sim, v, v.heading, dt);
    return v.speed > 0;
  }
  const vMax = (tracked(v) ? MOBILITY.offRoadTracked : MOBILITY.offRoadWheeled) * gradeFactor(sim, v);
  approachSpeed(v, Math.min(vMax, Math.sqrt(2 * MOBILITY.brake * Math.max(0, d - 3))), dt);
  drive(sim, v, headingOf(dx, dz), dt);
  return true;
}

// ---- Turret, heat, fire ------------------------------------------------------------------------

function stepTurret(sim: Sim, v: Vehicle, g: VehicleGroup | null, dt: number): void {
  if (!VEHICLE_SHAPES[v.kind].turret || v.thrownTurret || !isAlive(v) || v.kind === 'hulk') return;
  if (v.components.crew <= KILL_RULES.crewKill) return;
  let target: number;
  if (g && g.alertTime >= 0 && g.reacts) {
    const a = sim.aircraft.position;
    target = wrapPi(headingOf(a.x - v.position.x, a.z - v.position.z) - v.heading);
  } else {
    const w = MOBILITY.turretScanRate / MOBILITY.turretScan;
    target = MOBILITY.turretScan * Math.sin(sim.time * w + v.internal.scanPhase);
  }
  let d = wrapPi(target - v.turretYaw);
  const max = MOBILITY.turretSlewRate * dt;
  if (d > max) d = max;
  else if (d < -max) d = -max;
  v.turretYaw = wrapPi(v.turretYaw + d);
}

/** Exponential approach factors for this step (shared by every vehicle). */
const K = {
  engineWarm: 0,
  engineCool: 0,
  exhaustWarm: 0,
  exhaustCool: 0,
  runningWarm: 0,
  runningCool: 0,
  hull: 0,
  fireWarm: 0,
  fireCool: 0,
  dt: -1,
};

function factors(dt: number): void {
  if (K.dt === dt) return;
  const f = (tau: number) => 1 - Math.exp(-dt / tau);
  K.engineWarm = f(THERMAL.engineWarm);
  K.engineCool = f(THERMAL.engineCool);
  K.exhaustWarm = f(THERMAL.exhaustWarm);
  K.exhaustCool = f(THERMAL.exhaustCool);
  K.runningWarm = f(THERMAL.runningWarm);
  K.runningCool = f(THERMAL.runningCool);
  K.hull = f(THERMAL.hullTime);
  K.fireWarm = f(THERMAL.fireWarm);
  K.fireCool = f(THERMAL.fireCool);
  K.dt = dt;
}

function toward(x: number, target: number, up: number, down: number): number {
  return x + (target - x) * (target > x ? up : down);
}

function stepHeat(sim: Sim, v: Vehicle): void {
  const h = v.heat;
  const moving = Math.abs(v.speed) > 0.5;
  const tod = sim.world.timeOfDay;
  const sun = Math.max(0, Math.sin((Math.PI * (tod - 6)) / 12));
  const engine = v.engineOn ? (moving ? THERMAL.engineLoad : THERMAL.engineIdle) : 0;
  const exhaust = v.engineOn ? (moving ? THERMAL.exhaustLoad : THERMAL.exhaustIdle) : 0;
  const running = moving ? Math.min(THERMAL.runningMax, THERMAL.runningPerSpeed * Math.abs(v.speed)) : 0;
  h.engine = toward(h.engine, engine, K.engineWarm, K.engineCool);
  h.exhaust = toward(h.exhaust, exhaust, K.exhaustWarm, K.exhaustCool);
  h.running = toward(h.running, running, K.runningWarm, K.runningCool);
  const hullTarget = THERMAL.hullSun * (0.3 + 0.7 * sun) + THERMAL.hullEngineShare * h.engine;
  const fireHeat = THERMAL.fireHull * v.fire;
  if (fireHeat > h.hull) h.hull = toward(h.hull, fireHeat, K.fireWarm, K.fireWarm);
  else h.hull = toward(h.hull, hullTarget, h.hull > hullTarget ? K.fireCool : K.hull, K.fireCool);
  // a burnt-out hull keeps its engine deck and exhaust warm with it
  if (v.condition === 'destroyed' || v.condition === 'catastrophic') {
    h.engine = Math.max(h.engine, h.hull * 0.6);
    h.exhaust = Math.max(h.exhaust, h.hull * 0.5);
  }
}

/** Grow a fire toward its intensity while it has fuel, then let it die away. */
function burnInside(rt: VehicleInternal, dt: number): void {
  if (rt.fireInLoad > 0) {
    rt.fireIn += (rt.fireInTarget - rt.fireIn) * Math.min(1, dt / FIRE_MODEL.growTime);
    rt.fireInLoad -= rt.fireIn * dt;
    if (rt.fireInLoad <= 0) {
      rt.fireInLoad = 0;
      rt.fireInTarget = 0;
    }
  } else if (rt.fireIn > 0) {
    rt.fireIn -= rt.fireIn * Math.min(1, dt / FIRE_MODEL.decayTime);
    if (rt.fireIn < FIRE_MODEL.out) rt.fireIn = 0;
  }
}

function burnOutside(rt: VehicleInternal, dt: number): void {
  if (rt.fireOutLoad > 0) {
    rt.fireOut += (rt.fireOutTarget - rt.fireOut) * Math.min(1, dt / FIRE_MODEL.growTime);
    rt.fireOutLoad -= rt.fireOut * dt;
    if (rt.fireOutLoad <= 0) {
      rt.fireOutLoad = 0;
      rt.fireOutTarget = 0;
    }
  } else if (rt.fireOut > 0) {
    rt.fireOut -= rt.fireOut * Math.min(1, dt / FIRE_MODEL.decayTime);
    if (rt.fireOut < FIRE_MODEL.out) rt.fireOut = 0;
  }
}

function stepFire(sim: Sim, v: Vehicle, dt: number): void {
  const rt = v.internal;
  burnInside(rt, dt);
  burnOutside(rt, dt);
  v.fire = Math.max(rt.fireIn, rt.fireOut);
  if (rt.fireIn >= KILL_RULES.fireKill && isAlive(v)) evaluateCondition(sim, v, rt.lastWeapon);
  // a fire inside may cook off the ammunition (or burst a tanker's load) later
  const fx = AMMO_EFFECTS[v.kind];
  if (fx && !rt.cookOffDecided && rt.fireIn >= FIRE_MODEL.cookOffFire && v.condition !== 'catastrophic') {
    rt.cookOffDecided = true;
    const load = v.kind === 'truckFuel' ? v.components.fuel : v.components.ammo;
    if (load > 0 && sim.rng.damage.chance(fx.pCookOff))
      scheduleExplosion(sim, v, sim.rng.damage.range(fx.cookOffDelay[0], fx.cookOffDelay[1]));
  }
  if (rt.explodeTime >= 0 && sim.time >= rt.explodeTime) explode(sim, v, rt.lastWeapon);
  if (rt.popsLeft > 0 && sim.time >= rt.popTime && fx) {
    const r = sim.rng.damage;
    rt.popsLeft--;
    rt.popTime = sim.time + r.range(1.5, Math.max(2, (fx.popSpan[1] - fx.popSpan[0]) / 4));
    sim.events.push({
      type: 'detonation',
      t: sim.time,
      position: {
        x: v.position.x + r.range(-2, 2),
        y: v.position.y + r.range(0.5, 2),
        z: v.position.z + r.range(-2, 2),
      },
      charge: r.range(fx.popCharge[0], fx.popCharge[1]),
      kind: 'secondary',
      vehicleId: v.id,
      surface: sim.world.terrain.surfaceAt(v.position.x, v.position.z),
    });
  }
}

/** The thrown turret flies a ballistic arc, tumbling, and comes to rest on the ground. */
function stepThrownTurret(sim: Sim, v: Vehicle, dt: number): void {
  const tt = v.thrownTurret;
  if (!tt || (tt.velocity.x === 0 && tt.velocity.y === 0 && tt.velocity.z === 0)) return;
  tt.velocity.y -= G0 * dt;
  tt.position.addScaledVector(tt.velocity, dt);
  tt.angle.addScaledVector(tt.spin, dt);
  const s = VEHICLE_SHAPES[v.kind].turret;
  const rest = (s ? s.height : 0.7) * 0.55;
  const ground = sim.world.terrain.heightAt(tt.position.x, tt.position.z);
  if (tt.velocity.y < 0 && tt.position.y - rest <= ground) {
    tt.position.y = ground + rest;
    tt.velocity.set(0, 0, 0);
    tt.spin.set(0, 0, 0);
    // it settles upright or on its roof, slightly tilted
    const r = sim.rng.damage;
    tt.angle.x = Math.round(tt.angle.x / Math.PI) * Math.PI + r.range(-0.25, 0.25);
    tt.angle.z = r.range(-0.2, 0.2);
  }
}

// ---- Free hunt and housekeeping ----------------------------------------------------------------

function stepGroups(sim: Sim): void {
  const t = sim.targets;
  for (const g of t.groups) {
    if (g.wipedOut) continue;
    let alive = false;
    for (const id of g.vehicleIds) {
      const v = findVehicle(sim, id);
      if (v && isAlive(v)) {
        alive = true;
        break;
      }
    }
    if (!alive) g.wipedOut = true;
  }
  if (t.huntGroups <= 0) return;
  let alive = 0;
  for (const g of t.groups) if (!g.wipedOut && g.reacts) alive++;
  if (alive < t.huntGroups && t.respawnTime < 0) {
    t.respawnTime = sim.time + sim.rng.targets.range(SCENARIO.respawnDelayMin, SCENARIO.respawnDelayMax);
  }
  if (t.respawnTime >= 0 && sim.time >= t.respawnTime) {
    t.respawnTime = -1;
    if (alive < t.huntGroups) spawnHuntGroup(sim);
  }
}

/** Remove old wrecks far from the aircraft once there are too many vehicles. */
function cleanupWrecks(sim: Sim): void {
  const t = sim.targets;
  if (t.vehicles.length <= SCENARIO.maxVehicles) return;
  const a = sim.aircraft.position;
  let oldest = -1;
  for (let i = 0; i < t.vehicles.length; i++) {
    const v = t.vehicles[i];
    if (isAlive(v) || sim.time - v.conditionTime < SCENARIO.wreckAge) continue;
    if (Math.hypot(v.position.x - a.x, v.position.z - a.z) < SCENARIO.wreckDistance) continue;
    if (oldest < 0 || v.conditionTime < t.vehicles[oldest].conditionTime) oldest = i;
  }
  if (oldest < 0) return;
  const v = t.vehicles[oldest];
  t.vehicles.splice(oldest, 1);
  const g = groupById(sim, v.groupId);
  if (g) {
    const k = g.vehicleIds.indexOf(v.id);
    if (k >= 0) g.vehicleIds.splice(k, 1);
    if (g.vehicleIds.length === 0) t.groups.splice(t.groups.indexOf(g), 1);
  }
  t.internal.dirty = true;
}

// ---- The step ----------------------------------------------------------------------------------

/** Vehicle movement, behaviour, turrets, heat, fires and cook-offs (step 7 of stepSim). */
export function stepTargets(sim: Sim, dt: number): void {
  const t = sim.targets;
  scanEvents(sim);
  factors(dt);
  let moved = false;
  const groups = t.groups;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.alertTime >= 0 && !g.reacted) react(sim, g);
    if (g.behaviour === 'column' && stepColumn(sim, g, dt)) moved = true;
  }
  const list = t.vehicles;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    const g = groupById(sim, v.groupId);
    if ((!g || g.behaviour !== 'column') && stepGoal(sim, v, dt)) moved = true;
    stepTurret(sim, v, g, dt);
    stepHeat(sim, v);
    stepFire(sim, v, dt);
    stepThrownTurret(sim, v, dt);
  }
  if (moved) {
    t.internal.dirty = true;
    for (let i = 0; i < groups.length; i++) if (!groups[i].wipedOut) updateGroupBounds(sim, groups[i]);
  }
  if (sim.stepCount % 60 === 0) stepGroups(sim);
  if (sim.stepCount % 600 === 0) cleanupWrecks(sim);
}

