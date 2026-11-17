/**
 * Scenarios (PLAN §11): where the vehicle groups are put at the start of a flight, and the free
 * hunt's replacement groups. Areas are found by name and kind in terrain.targetAreas (generated
 * by the world module); any missing one falls back to another area, then to a point on valid
 * ground ahead of the start. Randomness comes only from sim.rng.targets.
 */
import {
  GROUP_TEMPLATES,
  MOBILITY,
  PLACEMENT_TEMPLATES,
  RANGE_LAYOUT,
  SCENARIO,
  VEHICLE_SHAPES,
} from '../../data/vehicles';
import { headingOf } from '../frames';
import type { Rng } from '../rng';
import type { Sim } from '../types';
import { createRoadPoint, pointAlongRoad, roadLength } from '../world/roads';
import type { TargetArea } from '../world/types';
import { loopPath, routePoint } from './route';
import { createVehicle, setEngineCold } from './state';
import type { GroupBehaviour, Vehicle, VehicleGroup, VehicleKind } from './types';

export type Placement = 'column' | 'dugIn' | 'treeline' | 'open';

/** A place for a group: an area, or a spot made up when the areas run out. */
interface Spot {
  id: number;
  name: string;
  kind: TargetArea['kind'];
  x: number;
  z: number;
  radius: number;
  heading: number;
  roadId: number;
  roadDistance: number;
}

function spotOf(a: TargetArea): Spot {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    x: a.x,
    z: a.z,
    radius: a.radius,
    heading: a.heading ?? 0,
    roadId: a.roadId ?? -1,
    roadDistance: a.roadDistance ?? 0,
  };
}

/** Ground a vehicle may stand on: on the map, dry, not too steep (and clear of trees). */
export function groundOk(sim: Sim, x: number, z: number, needClear: boolean): boolean {
  const t = sim.world.terrain;
  const half = t.size / 2 - 150;
  if (Math.abs(x) > half || Math.abs(z) > half) return false;
  if (t.surfaceAt(x, z) === 'water') return false;
  if (t.waterLevelAt && t.waterLevelAt(x, z) > -Infinity) return false;
  if (needClear && t.canopyAt(x, z) > 0) return false;
  const h = 4;
  const sx = (t.heightAt(x + h, z) - t.heightAt(x - h, z)) / (2 * h);
  const sz = (t.heightAt(x, z + h) - t.heightAt(x, z - h)) / (2 * h);
  return Math.atan(Math.hypot(sx, sz)) <= MOBILITY.maxSlopeWheeled;
}

function tooClose(sim: Sim, x: number, z: number, min: number): boolean {
  const list = sim.targets.vehicles;
  for (let i = 0; i < list.length; i++) {
    const p = list[i].position;
    if ((p.x - x) ** 2 + (p.z - z) ** 2 < min * min) return true;
  }
  return false;
}

function newGroup(
  sim: Sim,
  name: string,
  behaviour: GroupBehaviour,
  areaId: number,
  template: string,
  reacts: boolean,
): VehicleGroup {
  const t = sim.targets;
  const g: VehicleGroup = {
    id: t.nextGroupId++,
    name,
    behaviour,
    vehicleIds: [],
    areaId,
    roadId: -1,
    roadDistance: 0,
    alertTime: -1,
    template,
    reacts,
    route: [],
    speed: 0,
    spacing: SCENARIO.parkedSpacingMin,
    cx: 0,
    cz: 0,
    radius: 0,
    wipedOut: false,
    reacted: false,
  };
  t.groups.push(g);
  return g;
}

function add(sim: Sim, g: VehicleGroup, kind: VehicleKind, x: number, z: number, heading: number): Vehicle {
  const v = createVehicle(sim, kind, x, z, heading, g.id);
  g.vehicleIds.push(v.id);
  return v;
}

/** Recompute a group's centre and radius (alert tests). */
export function updateGroupBounds(sim: Sim, g: VehicleGroup): void {
  let n = 0;
  let cx = 0;
  let cz = 0;
  const list = sim.targets.vehicles;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v.groupId !== g.id) continue;
    cx += v.position.x;
    cz += v.position.z;
    n++;
  }
  if (n === 0) return;
  cx /= n;
  cz /= n;
  let r = 0;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v.groupId !== g.id) continue;
    r = Math.max(r, Math.hypot(v.position.x - cx, v.position.z - cz));
  }
  g.cx = cx;
  g.cz = cz;
  g.radius = r + 10;
}

// ---- Placements ---------------------------------------------------------------------------------

/** A loose group parked in the open, roughly abreast across the area's heading. */
function placeOpen(sim: Sim, spot: Spot, template: string, name: string): VehicleGroup {
  const r = sim.rng.targets;
  const kinds = GROUP_TEMPLATES[template];
  const g = newGroup(sim, name, 'parked', spot.id, template, true);
  const h = spot.heading;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const spacing = r.range(SCENARIO.parkedSpacingMin, SCENARIO.parkedSpacingMax);
  g.spacing = spacing;
  const reach = Math.max(60, spot.radius * 0.6);
  kinds.forEach((kind, i) => {
    for (let tries = 0; tries < 16; tries++) {
      const across = (i - (kinds.length - 1) / 2) * spacing + r.range(-10, 10) + (tries > 4 ? r.range(-reach, reach) : 0);
      const along = r.range(-25, 25) + (tries > 4 ? r.range(-reach, reach) : 0);
      const x = spot.x + Math.cos(h) * across + fx * along;
      const z = spot.z + Math.sin(h) * across + fz * along;
      if (!groundOk(sim, x, z, true) || tooClose(sim, x, z, 14)) continue;
      add(sim, g, kind, x, z, wrap(h + r.range(-0.5, 0.5)));
      break;
    }
  });
  parkedEngines(sim, g);
  return g;
}

/** Parked along a tree line, just outside the canopy, facing the open ground. */
function placeTreeline(sim: Sim, spot: Spot, template: string, name: string): VehicleGroup {
  const t = sim.world.terrain;
  const r = sim.rng.targets;
  const h = spot.heading;
  const rx = Math.cos(h);
  const rz = Math.sin(h);
  let side = 0;
  let edge = 0;
  for (let off = 15; off <= 320 && side === 0; off += 10) {
    for (const s of [1, -1]) {
      if (t.canopyAt(spot.x + rx * off * s, spot.z + rz * off * s) > 0) {
        side = s;
        edge = off;
        break;
      }
    }
  }
  if (side === 0) return placeOpen(sim, spot, template, name);
  const kinds = GROUP_TEMPLATES[template];
  const g = newGroup(sim, name, 'parked', spot.id, template, true);
  const spacing = r.range(25, 40);
  g.spacing = spacing;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  // facing away from the trees
  const face = headingOf(-rx * side, -rz * side);
  kinds.forEach((kind, i) => {
    const along = (i - (kinds.length - 1) / 2) * spacing + r.range(-5, 5);
    let px = spot.x + fx * along;
    let pz = spot.z + fz * along;
    // move toward the trees until just outside the canopy
    let placed = false;
    for (let off = Math.max(0, edge - 120); off <= edge + 60; off += 3) {
      const x = px + rx * side * off;
      const z = pz + rz * side * off;
      if (t.canopyAt(x + rx * side * 6, z + rz * side * 6) > 0) {
        if (groundOk(sim, x, z, true) && !tooClose(sim, x, z, 12)) {
          add(sim, g, kind, x, z, wrap(face + r.range(-0.3, 0.3)));
          placed = true;
        }
        break;
      }
    }
    if (!placed) {
      px += rx * side * (edge - 8);
      pz += rz * side * (edge - 8);
      if (groundOk(sim, px, pz, true) && !tooClose(sim, px, pz, 12)) add(sim, g, kind, px, pz, face);
    }
  });
  if (g.vehicleIds.length === 0) {
    sim.targets.groups.pop();
    return placeOpen(sim, spot, template, name);
  }
  parkedEngines(sim, g);
  return g;
}

/** Dug in abreast across the area's heading: hull in a pit, turret and hull top exposed. */
function placeDugIn(sim: Sim, spot: Spot, template: string, name: string): VehicleGroup {
  const r = sim.rng.targets;
  const kinds = GROUP_TEMPLATES[template];
  const g = newGroup(sim, name, 'dugIn', spot.id, template, true);
  const h = spot.heading;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  g.spacing = SCENARIO.dugInSpacing;
  kinds.forEach((kind, i) => {
    for (let tries = 0; tries < 12; tries++) {
      const across = (i - (kinds.length - 1) / 2) * SCENARIO.dugInSpacing + r.range(-8, 8) * (1 + tries);
      const along = r.range(-10, 10) * (1 + tries * 0.5);
      const x = spot.x + Math.cos(h) * across + fx * along;
      const z = spot.z + Math.sin(h) * across + fz * along;
      if (!groundOk(sim, x, z, true) || tooClose(sim, x, z, 20)) continue;
      const v = add(sim, g, kind, x, z, wrap(h + r.range(-0.15, 0.15)));
      digIn(sim, v);
      break;
    }
  });
  for (const id of g.vehicleIds) {
    const v = findIn(sim, id);
    if (v) setEngineCold(v);
  }
  return g;
}

/** Lower a vehicle into a firing pit: only the hull top and turret stay above the ground. */
export function digIn(sim: Sim, v: Vehicle): void {
  const s = VEHICLE_SHAPES[v.kind];
  const depth = Math.max(0, s.hullClearance + s.hullHeight - MOBILITY.dugInExposed);
  v.dugIn = true;
  v.internal.digDepth = depth;
  v.position.y = sim.world.terrain.heightAt(v.position.x, v.position.z) - depth;
  v.pitch = 0;
  v.roll = 0;
  v.internal.groundPitch = 0;
  v.internal.groundRoll = 0;
  sim.targets.internal.dirty = true;
}

const _rp = createRoadPoint();

/** A column on a road, the lead at `distance`, driving the way with more road ahead. */
function placeColumn(
  sim: Sim,
  roadIndex: number,
  distance: number,
  template: string,
  name: string,
  areaId: number,
  speed?: number,
): VehicleGroup | null {
  const road = sim.world.terrain.roads[roadIndex];
  if (!road) return null;
  const r = sim.rng.targets;
  const kinds = GROUP_TEMPLATES[template];
  const L = roadLength(road);
  const spacing = MOBILITY.columnSpacing;
  const need = (kinds.length - 1) * spacing + 50;
  if (L < need + 200) return null;
  const dir: 1 | -1 = L - distance >= distance ? 1 : -1;
  // the last vehicle's road distance (the leg starts there); keep the whole column on the road
  let lead = Math.min(Math.max(distance, 0), L);
  if (dir > 0) lead = Math.max(lead, need);
  else lead = Math.min(lead, L - need);
  const tail = lead - dir * (kinds.length - 1) * spacing;
  const g = newGroup(sim, name, 'column', areaId, template, true);
  g.speed = speed ?? r.range(MOBILITY.columnSpeedMin, MOBILITY.columnSpeedMax);
  g.spacing = spacing;
  g.roadId = roadIndex;
  g.roadDistance = lead;
  g.route.push({ road, dir, loop: false, roadIndex, from: tail, to: dir > 0 ? L : 0, start: 0 });
  const offset = MOBILITY.roadKeepRight * road.width;
  kinds.forEach((kind, i) => {
    const s = (kinds.length - 1 - i) * spacing;
    routePoint(g, s, offset, _rp);
    const v = add(sim, g, kind, _rp.x, _rp.z, _rp.heading);
    v.internal.s = s;
    v.internal.leg = 0;
    v.internal.cruise = g.speed;
    v.speed = g.speed;
    warmMoving(v);
  });
  return g;
}

/** A loop column for the range lane (remote-controlled: does not react to attacks). */
function placeLoopColumn(sim: Sim, spot: Spot, name: string): VehicleGroup {
  const t = sim.targets;
  const kinds = RANGE_LAYOUT.laneColumn;
  const path = loopPath(
    -1 - t.internal.paths.length,
    spot.x,
    spot.z,
    spot.radius * RANGE_LAYOUT.laneLoopAcross,
    spot.radius * RANGE_LAYOUT.laneLoopAlong,
    spot.heading,
  );
  t.internal.paths.push(path);
  const g = newGroup(sim, name, 'column', spot.id, 'laneColumn', false);
  g.speed = MOBILITY.laneSpeed;
  g.spacing = MOBILITY.columnSpacing;
  g.route.push({ road: path, dir: 1, loop: true, roadIndex: -1, from: 0, to: 0, start: 0 });
  kinds.forEach((kind, i) => {
    const s = (kinds.length - 1 - i) * g.spacing;
    routePoint(g, s, 0, _rp);
    const v = add(sim, g, kind, _rp.x, _rp.z, _rp.heading);
    v.internal.s = s;
    v.internal.cruise = g.speed;
    v.speed = g.speed;
    warmMoving(v);
  });
  return g;
}

function warmMoving(v: Vehicle): void {
  v.engineOn = true;
  v.heat.engine = 42;
  v.heat.exhaust = 90;
  v.heat.running = 18;
  v.heat.hull = 11;
}

function parkedEngines(sim: Sim, g: VehicleGroup): void {
  if (!sim.rng.targets.chance(MOBILITY.parkedEnginesOff)) return;
  for (const id of g.vehicleIds) {
    const v = findIn(sim, id);
    if (v) setEngineCold(v);
  }
}

function findIn(sim: Sim, id: number): Vehicle | null {
  const list = sim.targets.vehicles;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].id === id) return list[i];
  return null;
}

const wrap = (h: number) => {
  const T = Math.PI * 2;
  h %= T;
  return h < 0 ? h + T : h;
};

function shuffle<T>(r: Rng, a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    const s = a[i];
    a[i] = a[j];
    a[j] = s;
  }
}

// ---- Free hunt ----------------------------------------------------------------------------------

function placementOf(spot: Spot, wantColumn: boolean): Placement {
  if (spot.kind === 'road' && wantColumn && spot.roadId >= 0) return 'column';
  if (spot.kind === 'dugIn') return 'dugIn';
  if (spot.kind === 'treeline') return 'treeline';
  return 'open';
}

/** Put one group on a spot; returns null when nothing could be placed. */
function placeGroup(sim: Sim, spot: Spot, placement: Placement): VehicleGroup | null {
  const r = sim.rng.targets;
  const template = r.pick(PLACEMENT_TEMPLATES[placement]);
  let g: VehicleGroup | null;
  switch (placement) {
    case 'column':
      g = placeColumn(sim, spot.roadId, spot.roadDistance, template, spot.name, spot.id);
      if (!g) g = placeOpen(sim, spot, r.pick(PLACEMENT_TEMPLATES.open), spot.name);
      break;
    case 'dugIn':
      g = placeDugIn(sim, spot, template, spot.name);
      break;
    case 'treeline':
      g = placeTreeline(sim, spot, template, spot.name);
      break;
    default:
      g = placeOpen(sim, spot, template, spot.name);
  }
  if (g && g.vehicleIds.length === 0) {
    const i = sim.targets.groups.indexOf(g);
    if (i >= 0) sim.targets.groups.splice(i, 1);
    return null;
  }
  if (g) updateGroupBounds(sim, g);
  return g;
}

/** A made-up spot on valid ground between `minD` and `maxD` from (x, z). */
function freeSpot(sim: Sim, x: number, z: number, minD: number, maxD: number, id: number): Spot | null {
  const r = sim.rng.targets;
  for (let k = 0; k < 60; k++) {
    const a = r.range(0, Math.PI * 2);
    const d = r.range(minD, maxD);
    const px = x + Math.cos(a) * d;
    const pz = z + Math.sin(a) * d;
    if (!groundOk(sim, px, pz, true)) continue;
    return {
      id,
      name: `GRID ${Math.round(px / 1000)}/${Math.round(-pz / 1000)}`,
      kind: 'open',
      x: px,
      z: pz,
      radius: 300,
      heading: r.range(0, Math.PI * 2),
      roadId: -1,
      roadDistance: 0,
    };
  }
  return null;
}

/** A spot on some road at least `minD` from (x, z), for a column when no road area is left. */
function roadSpot(sim: Sim, x: number, z: number, minD: number): Spot | null {
  const roads = sim.world.terrain.roads;
  if (roads.length === 0) return null;
  const r = sim.rng.targets;
  for (let k = 0; k < 40; k++) {
    const ri = r.int(0, roads.length - 1);
    const road = roads[ri];
    const L = roadLength(road);
    if (L < 1000) continue;
    const d = r.range(400, L - 400);
    const p = pointAlongRoad(road, d, _rp);
    if (Math.hypot(p.x - x, p.z - z) < minD) continue;
    return { id: -1, name: 'ROAD', kind: 'road', x: p.x, z: p.z, radius: 600, heading: p.heading, roadId: ri, roadDistance: d };
  }
  return null;
}

/** Groups alive (any vehicle intact or damaged). */
export function aliveGroups(sim: Sim): number {
  let n = 0;
  for (const g of sim.targets.groups) if (!g.wipedOut && g.reacts) n++;
  return n;
}

function populateFreeHunt(sim: Sim): void {
  const r = sim.rng.targets;
  const t = sim.targets;
  const ax = sim.aircraft.position.x;
  const az = sim.aircraft.position.z;
  const n = r.int(SCENARIO.huntGroupsMin, SCENARIO.huntGroupsMax);
  const columns = r.int(SCENARIO.huntColumnsMin, SCENARIO.huntColumnsMax);
  t.huntGroups = n;
  const areas = sim.world.terrain.targetAreas
    .filter((a) => a.kind !== 'range' && Math.hypot(a.x - ax, a.z - az) >= SCENARIO.minDistance)
    .map(spotOf);
  shuffle(r, areas);
  const used: boolean[] = areas.map(() => false);
  let placed = 0;
  const take = (pred: (s: Spot) => boolean): Spot | null => {
    for (let i = 0; i < areas.length; i++) {
      if (!used[i] && pred(areas[i])) {
        used[i] = true;
        return areas[i];
      }
    }
    return null;
  };
  // a column or two on the roads
  for (let c = 0; c < columns && placed < n; c++) {
    const spot =
      take((s) => s.kind === 'road' && s.roadId >= 0) ?? roadSpot(sim, ax, az, SCENARIO.minDistance);
    if (spot && placeGroup(sim, spot, 'column')) placed++;
  }
  // one of each other kind for variety
  for (const kind of ['dugIn', 'treeline', 'open'] as const) {
    if (placed >= n) break;
    const spot = take((s) => s.kind === kind);
    if (spot && placeGroup(sim, spot, placementOf(spot, false))) placed++;
  }
  // the rest anywhere
  let guard = 0;
  while (placed < n && guard++ < 50) {
    let spot = take(() => true);
    if (!spot) spot = freeSpot(sim, ax, az, SCENARIO.minDistance + 1000, 22000, -1);
    if (!spot) break;
    if (placeGroup(sim, spot, placementOf(spot, false))) placed++;
  }
}

/**
 * A replacement group in another area more than SCENARIO.minDistance from the aircraft, where no
 * group is alive (a column if none is left on the roads).
 */
export function spawnHuntGroup(sim: Sim): VehicleGroup | null {
  const r = sim.rng.targets;
  const ax = sim.aircraft.position.x;
  const az = sim.aircraft.position.z;
  const busy = (id: number) => sim.targets.groups.some((g) => !g.wipedOut && g.areaId === id && id >= 0);
  const spots = sim.world.terrain.targetAreas
    .filter((a) => a.kind !== 'range' && Math.hypot(a.x - ax, a.z - az) > SCENARIO.minDistance && !busy(a.id))
    .map(spotOf);
  shuffle(r, spots);
  const columnAlive = sim.targets.groups.some((g) => !g.wipedOut && g.behaviour === 'column' && g.reacts);
  if (!columnAlive) {
    const road = spots.find((s) => s.kind === 'road' && s.roadId >= 0) ?? roadSpot(sim, ax, az, SCENARIO.minDistance);
    if (road) {
      const g = placeGroup(sim, road, 'column');
      if (g) return g;
    }
  }
  for (const s of spots) {
    const g = placeGroup(sim, s, placementOf(s, false));
    if (g) return g;
  }
  const spot = freeSpot(sim, ax, az, SCENARIO.minDistance + 500, 20000, -1);
  return spot ? placeGroup(sim, spot, 'open') : null;
}

/**
 * Place a group by hand (tests, sandboxes): a column on terrain road `roadId` with its lead at
 * `roadDistance`, or a group parked in the open, along a tree line or dug in at (x, z) facing
 * `heading`. `template` names a GROUP_TEMPLATES entry. Returns null if nothing could be placed.
 */
export function spawnGroup(
  sim: Sim,
  placement: Placement,
  where: {
    x?: number;
    z?: number;
    heading?: number;
    radius?: number;
    roadId?: number;
    roadDistance?: number;
    name?: string;
  },
  template: string,
): VehicleGroup | null {
  const spot: Spot = {
    id: -1,
    name: where.name ?? template.toUpperCase(),
    kind: placement === 'column' ? 'road' : placement,
    x: where.x ?? 0,
    z: where.z ?? 0,
    radius: where.radius ?? 400,
    heading: where.heading ?? 0,
    roadId: where.roadId ?? -1,
    roadDistance: where.roadDistance ?? 0,
  };
  if (placement === 'column') {
    const g = placeColumn(sim, spot.roadId, spot.roadDistance, template, spot.name, -1);
    if (g) updateGroupBounds(sim, g);
    return g;
  }
  const g =
    placement === 'dugIn'
      ? placeDugIn(sim, spot, template, spot.name)
      : placement === 'treeline'
        ? placeTreeline(sim, spot, template, spot.name)
        : placeOpen(sim, spot, template, spot.name);
  updateGroupBounds(sim, g);
  return g.vehicleIds.length ? g : null;
}

// ---- Range events -------------------------------------------------------------------------------

/** The named range area, else any range area, else any area, else a point ahead of the start. */
function rangeSpot(sim: Sim, name: string): Spot {
  const areas = sim.world.terrain.targetAreas;
  const want = name.toUpperCase();
  const a =
    areas.find((x) => x.name.toUpperCase() === want) ??
    areas.find((x) => x.kind === 'range') ??
    areas[0];
  if (a) return spotOf(a);
  const s = sim.world.terrain.start;
  const x = s.x + Math.sin(s.heading) * 10000;
  const z = s.z - Math.cos(s.heading) * 10000;
  return { id: -1, name, kind: 'range', x, z, radius: 400, heading: s.heading, roadId: -1, roadDistance: 0 };
}

function populateStrafePit(sim: Sim): void {
  const r = sim.rng.targets;
  const spot = rangeSpot(sim, 'STRAFE PIT');
  const g = newGroup(sim, spot.name, 'static', spot.id, 'strafePit', false);
  const h = spot.heading;
  const rx = Math.cos(h);
  const rz = Math.sin(h);
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const n = RANGE_LAYOUT.strafePanels;
  // panels abreast across the run-in line, facing the aircraft coming in along the heading
  for (let i = 0; i < n; i++) {
    const across = (i - (n - 1) / 2) * RANGE_LAYOUT.panelSpacing;
    add(sim, g, 'panel', spot.x + rx * across, spot.z + rz * across, wrap(h + Math.PI));
  }
  for (let i = 0; i < RANGE_LAYOUT.strafeHulks; i++) {
    const across = (i - (RANGE_LAYOUT.strafeHulks - 1) / 2) * RANGE_LAYOUT.panelSpacing * 1.5;
    const along = RANGE_LAYOUT.hulksBehind;
    add(sim, g, 'hulk', spot.x + rx * across + fx * along, spot.z + rz * across + fz * along, r.range(0, Math.PI * 2));
  }
  updateGroupBounds(sim, g);
}

function populateBombCircle(sim: Sim): void {
  const r = sim.rng.targets;
  const spot = rangeSpot(sim, 'BOMB CIRCLE');
  const g = newGroup(sim, spot.name, 'static', spot.id, 'bombCircle', false);
  add(sim, g, 'hulk', spot.x, spot.z, r.range(0, Math.PI * 2));
  const n = RANGE_LAYOUT.circleHulks;
  const rMax = Math.min(RANGE_LAYOUT.circleRadiusMax, spot.radius * 0.8);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r.range(-0.3, 0.3);
    const d = r.range(RANGE_LAYOUT.circleRadiusMin, Math.max(RANGE_LAYOUT.circleRadiusMin + 10, rMax));
    add(sim, g, 'hulk', spot.x + Math.cos(a) * d, spot.z + Math.sin(a) * d, r.range(0, Math.PI * 2));
  }
  updateGroupBounds(sim, g);
}

function populateTacticalLane(sim: Sim): void {
  const r = sim.rng.targets;
  const spot = rangeSpot(sim, 'TACTICAL LANE');
  const g = newGroup(sim, spot.name, 'static', spot.id, 'laneHulks', false);
  const reach = spot.radius * 0.7;
  for (let i = 0; i < RANGE_LAYOUT.laneHulks; i++) {
    for (let k = 0; k < 20; k++) {
      const a = r.range(0, Math.PI * 2);
      const d = Math.sqrt(r.next()) * reach;
      const x = spot.x + Math.cos(a) * d;
      const z = spot.z + Math.sin(a) * d;
      if (!groundOk(sim, x, z, false) || tooClose(sim, x, z, 30)) continue;
      add(sim, g, 'hulk', x, z, r.range(0, Math.PI * 2));
      break;
    }
  }
  updateGroupBounds(sim, g);
  updateGroupBounds(sim, placeLoopColumn(sim, spot, `${spot.name} COLUMN`));
}

/** Fill the world with the scenario's vehicle groups (createSim calls this once). */
export function populateScenario(sim: Sim): void {
  switch (sim.options.scenario) {
    case 'freeHunt':
      populateFreeHunt(sim);
      break;
    case 'strafePit':
      populateStrafePit(sim);
      break;
    case 'bombCircle':
      populateBombCircle(sim);
      break;
    case 'tacticalLane':
      populateTacticalLane(sim);
      break;
    default:
      break;
  }
}

