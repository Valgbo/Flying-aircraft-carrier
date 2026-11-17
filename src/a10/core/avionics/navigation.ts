/**
 * Steerpoints and the sensor point of interest (PLAN_A10.md §7, "SOI and SPI").
 *
 * Steerpoints are built at the start of the flight from the terrain's target areas (ALPHA … in
 * order of distance from the start, then the range pads) and the airbase, each at the centre on
 * the ground. The SPI — the one ground point the pod, the Mavericks, CCRP bombing and the map can
 * all be slaved to — defaults to the active steerpoint (source 'STPT'). TMS forward long makes
 * the sensor of interest the SPI generator; TMS aft long returns the SPI to the steerpoint.
 * A sensor-generated SPI follows its sensor every step (a pod in point track follows a vehicle).
 */
import { Vector3 } from 'three';
import type { ScenarioKind, Sim } from '../types';
import { switched } from './notify';
import type { SpiState } from './types';

/** The range pad a weapons-range scenario starts at (its steerpoint is made active). */
const SCENARIO_AREA: Partial<Record<ScenarioKind, string>> = {
  strafePit: 'STRAFE PIT',
  bombCircle: 'BOMB CIRCLE',
  tacticalLane: 'TACTICAL LANE',
};

/** Build the steerpoints from the terrain (kept as they are if something already set them). */
export function buildSteerpoints(sim: Sim): void {
  const av = sim.avionics;
  if (av.steerpoints.length > 0) return;
  const terrain = sim.world.terrain;
  let id = 1;
  for (const a of terrain.targetAreas) {
    av.steerpoints.push({
      id: id++,
      name: a.name,
      position: new Vector3(a.x, terrain.heightAt(a.x, a.z), a.z),
    });
  }
  const base = terrain.airbase;
  if (base) {
    av.steerpoints.push({
      id,
      name: 'AIRBASE',
      position: new Vector3(base.x, terrain.heightAt(base.x, base.z), base.z),
    });
  }
  const want = SCENARIO_AREA[sim.options.scenario];
  const i = want ? av.steerpoints.findIndex((s) => s.name === want) : -1;
  av.activeSteerpoint = i >= 0 ? i : 0;
}

/** The active steerpoint, or undefined when there is none. */
export function activeSteerpoint(sim: Sim) {
  const av = sim.avionics;
  return av.steerpoints[av.activeSteerpoint];
}

/** Return the SPI to the active steerpoint (TMS aft long, and the default). */
export function spiToSteerpoint(sim: Sim): void {
  const spi = sim.avionics.spi;
  const sp = activeSteerpoint(sim);
  spi.source = 'STPT';
  spi.valid = sp !== undefined;
  if (sp) spi.position.copy(sp.position);
}

/** Make a ground point the SPI. */
export function setSpi(sim: Sim, source: SpiState['source'], point: Vector3): void {
  const spi = sim.avionics.spi;
  spi.source = source;
  spi.valid = true;
  spi.position.copy(point);
}

/** Step through the steerpoints (±1, wrapping). The SPI follows when it is the steerpoint. */
export function cycleSteerpoint(sim: Sim, dir: 1 | -1): void {
  const av = sim.avionics;
  const n = av.steerpoints.length;
  if (n === 0) return;
  const cur = av.activeSteerpoint >= 0 && av.activeSteerpoint < n ? av.activeSteerpoint : 0;
  av.activeSteerpoint = (((cur + dir) % n) + n) % n;
  if (av.spi.source === 'STPT') spiToSteerpoint(sim);
  switched(sim, 'steerpoint', av.steerpoints[av.activeSteerpoint].name);
}

/** Every step: a steerpoint or sensor SPI follows its source. */
export function updateSpi(sim: Sim): void {
  const av = sim.avionics;
  const spi = av.spi;
  switch (spi.source) {
    case 'STPT': {
      const sp = activeSteerpoint(sim);
      spi.valid = sp !== undefined;
      if (sp) spi.position.copy(sp.position);
      break;
    }
    case 'TGP': {
      // The pod's point while it has one; otherwise the SPI stays where the pod last looked.
      const tgp = sim.sensors.tgp;
      if (tgp.pointValid) spi.position.copy(tgp.point);
      break;
    }
    case 'MAV': {
      const i = sim.sensors.selectedMaverick;
      const mav = i >= 0 ? sim.sensors.mavericks[i] : undefined;
      if (mav && mav.locked) spi.position.copy(mav.lockPoint);
      break;
    }
    default:
      // HUD and TAD points are fixed ground points.
      break;
  }
}
