/**
 * Where a weapons-range event's targets are (PLAN_A10.md §11): found once, at the first step,
 * from the groups the targets module placed (their `template` and `areaId`) and the terrain's
 * target areas (centre and run-in heading). Free hunt has no layout ('none').
 */
import type { VehicleGroup } from '../targets/types';
import type { Sim } from '../types';
import type { RangeEvent, RangeLayout } from './types';

const RANGE_TEMPLATES: Record<Exclude<RangeEvent, 'none'>, readonly string[]> = {
  strafePit: ['strafePit'],
  bombCircle: ['bombCircle'],
  tacticalLane: ['laneHulks', 'laneColumn'],
};

export function rangeEventOf(scenario: string): RangeEvent {
  return scenario === 'strafePit' || scenario === 'bombCircle' || scenario === 'tacticalLane'
    ? scenario
    : 'none';
}

export function emptyLayout(event: RangeEvent = 'none'): RangeLayout {
  return { event, x: 0, z: 0, runIn: 0, panels: [], vehicles: [], centreId: -1 };
}

/** The layout of the flight's range event (an empty one for free hunt or a missing event). */
export function findRangeLayout(sim: Sim): RangeLayout {
  const event = rangeEventOf(sim.options.scenario);
  const layout = emptyLayout(event);
  if (event === 'none') return layout;
  const templates = RANGE_TEMPLATES[event];
  const groups: VehicleGroup[] = sim.targets.groups.filter((g) => templates.includes(g.template));
  if (groups.length === 0) return layout;
  for (const g of groups) for (const id of g.vehicleIds) layout.vehicles.push(id);

  const terrain = sim.world.terrain;
  const area = terrain.targetAreas.find((a) => a.id === groups[0].areaId && a.id >= 0);
  const vehicles = sim.targets.vehicles;
  const first = vehicles.find((v) => v.id === groups[0].vehicleIds[0]);
  if (area) {
    layout.x = area.x;
    layout.z = area.z;
    layout.runIn = area.heading ?? terrain.start.heading;
  } else if (first) {
    layout.x = first.position.x;
    layout.z = first.position.z;
    layout.runIn = terrain.start.heading;
  }

  if (event === 'strafePit') {
    const panels = vehicles.filter((v) => v.kind === 'panel' && layout.vehicles.includes(v.id));
    if (panels.length > 0) {
      // the panels face the incoming aircraft: the run-in is opposite their heading
      if (!area) {
        layout.runIn = (panels[0].heading + Math.PI) % (Math.PI * 2);
        layout.x = panels.reduce((s, v) => s + v.position.x, 0) / panels.length;
        layout.z = panels.reduce((s, v) => s + v.position.z, 0) / panels.length;
      }
      // left to right across the run-in
      const rx = Math.cos(layout.runIn);
      const rz = Math.sin(layout.runIn);
      panels.sort(
        (a, b) => a.position.x * rx + a.position.z * rz - (b.position.x * rx + b.position.z * rz),
      );
      for (const p of panels) layout.panels.push(p.id);
    }
  } else if (event === 'bombCircle') {
    // the hulk on the bull's-eye: the one nearest the area centre
    let best = Infinity;
    for (const id of layout.vehicles) {
      const v = vehicles.find((x) => x.id === id);
      if (!v) continue;
      const d = Math.hypot(v.position.x - layout.x, v.position.z - layout.z);
      if (d < best) {
        best = d;
        layout.centreId = v.id;
      }
    }
  }
  return layout;
}
