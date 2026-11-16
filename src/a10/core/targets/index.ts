/**
 * TARGETS module public API: vehicles, armour hit tests, damage and behaviour.
 * FOUNDATION STAND-IN: places a few parked groups and never registers a hit. The targets module
 * owner replaces the implementation and keeps these exports and their meaning.
 */
import { Vector3 } from 'three';
import { VEHICLE_SHAPES } from '../../data/vehicles';
import type { Sim } from '../types';
import type { RoundType } from '../weapons/types';
import type {
  ComponentId,
  RoundHitResult,
  TargetsState,
  Vehicle,
  VehicleHit,
  VehicleKind,
} from './types';

export type * from './types';
export { VEHICLE_SHAPES };

export function createTargetsState(): TargetsState {
  return { vehicles: [], groups: [], nextVehicleId: 1, nextGroupId: 1, killed: 0, damaged: 0 };
}

const COMPONENTS: ComponentId[] = [
  'engine',
  'fuel',
  'ammo',
  'gun',
  'runningGear',
  'optics',
  'crew',
  'cargo',
];

export function createVehicle(
  sim: Sim,
  kind: VehicleKind,
  x: number,
  z: number,
  heading: number,
  groupId: number,
): Vehicle {
  const components = {} as Record<ComponentId, number>;
  for (const c of COMPONENTS) components[c] = 1;
  const v: Vehicle = {
    id: sim.targets.nextVehicleId++,
    kind,
    position: new Vector3(x, sim.world.terrain.heightAt(x, z), z),
    heading,
    speed: 0,
    turretYaw: 0,
    pitch: 0,
    roll: 0,
    condition: 'intact',
    mobilityKill: false,
    firepowerKill: false,
    fire: 0,
    engineOn: kind !== 'hulk' && kind !== 'panel',
    heat: { engine: 30, exhaust: 60, running: 10, hull: 5 },
    components,
    groupId,
    conditionTime: 0,
    thrownTurret: null,
  };
  sim.targets.vehicles.push(v);
  return v;
}

/** Fill the world with the scenario's vehicle groups. Stand-in: one parked group per target area. */
export function populateScenario(sim: Sim): void {
  if (sim.options.scenario === 'empty') return;
  const kinds: VehicleKind[] = ['mbt', 'mbt', 'ifv', 'apc', 'truckCargo', 'truckFuel'];
  for (const area of sim.world.terrain.targetAreas) {
    const groupId = sim.targets.nextGroupId++;
    const ids: number[] = [];
    kinds.forEach((kind, i) => {
      const a = (i / kinds.length) * Math.PI * 2;
      const v = createVehicle(
        sim,
        kind,
        area.x + Math.cos(a) * 60,
        area.z + Math.sin(a) * 60,
        a,
        groupId,
      );
      ids.push(v.id);
    });
    sim.targets.groups.push({
      id: groupId,
      name: area.name,
      behaviour: 'parked',
      vehicleIds: ids,
      areaId: area.id,
      roadId: -1,
      roadDistance: 0,
      alertTime: -1,
    });
  }
}

/** Vehicle movement, behaviour, fires and heat. Stand-in: nothing moves. */
export function stepTargets(_sim: Sim, _dt: number): void {}

/** First vehicle plate crossed by the segment p0→p1 (world). Stand-in: never hits. */
export function segmentHitVehicle(
  _sim: Sim,
  _p0: Vector3,
  _p1: Vector3,
  _out: VehicleHit,
): boolean {
  return false;
}

/** What a 30 mm round does to the plate it hit. Stand-in: stopped. */
export function resolveRoundHit(
  _sim: Sim,
  _hit: VehicleHit,
  _type: RoundType,
  _velocity: Vector3,
  out: RoundHitResult,
): RoundHitResult {
  out.outcome = 'stopped';
  out.obliquity = 0;
  out.effectiveThicknessMm = 0;
  out.penetrationMm = 0;
  out.damaged = [];
  out.ricochetVelocity.set(0, 0, 0);
  return out;
}

/** Blast and fragments of a detonation (bombs, rockets, missiles, secondaries). Stand-in: none. */
export function applyBlast(
  _sim: Sim,
  _position: Vector3,
  _chargeKg: number,
  _fragmentKg = 0,
): void {}
