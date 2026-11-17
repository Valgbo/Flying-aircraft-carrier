/**
 * Vehicle renderer (STORES-VIEW module, wave 2): what the drawn vehicle shows of its damage.
 *
 * TE-5 (wave-1 review): a thrown track is drawn only for a track that has failed in the
 * simulation (its running-gear box at or below KILL_RULES.boxDead), on the side that failed —
 * not for an engine kill, a dead driver or a catastrophic kill with both tracks intact, and not
 * moved to the other side by a later harmless hit. The renderer reads only the public vehicle
 * state (`components.runningGear`, `mobilityKill`) and the frame's events.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createSim } from '../../../src/a10/core/sim';
import {
  createVehicle,
  resolveRoundHit,
  segmentHitVehicle,
  type RoundHitResult,
  type Vehicle,
  type VehicleHit,
} from '../../../src/a10/core/targets';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { RoundType } from '../../../src/a10/core/weapons';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { VEHICLE_SHAPES } from '../../../src/a10/data/vehicles';
import { A10_QUALITY } from '../../../src/a10/view/quality';
import { FLAG } from '../../../src/a10/view/vehicles/material';
import { VehicleRenderer } from '../../../src/a10/view/vehicles/VehicleRenderer';

const TRACKS = FLAG.trackLeft | FLAG.trackRight;

function newHit(): VehicleHit {
  return {
    vehicleId: 0,
    t: 0,
    point: new Vector3(),
    normal: new Vector3(),
    thicknessMm: 0,
    part: 'hull',
    face: 'front',
    plate: 0,
  };
}

function newResult(): RoundHitResult {
  return {
    outcome: 'stopped',
    obliquity: 0,
    effectiveThicknessMm: 0,
    penetrationMm: 0,
    damaged: [],
    ricochetVelocity: new Vector3(),
  };
}

/**
 * One 30 mm round from `from` along `dir` (unit) at `speed`, through the targets module's own
 * hit test and damage model; returns the roundImpact event the weapons module would emit.
 */
function fire(
  sim: Sim,
  from: Vector3,
  dir: Vector3,
  speed: number,
  type: RoundType = RoundType.API,
): SimEvent | null {
  const hit = newHit();
  const res = newResult();
  const to = from.clone().addScaledVector(dir, 60);
  if (!segmentHitVehicle(sim, from, to, hit)) return null;
  const vel = dir.clone().multiplyScalar(speed);
  resolveRoundHit(sim, hit, type, vel, res, 1);
  return {
    type: 'roundImpact',
    t: sim.time,
    round: type,
    position: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
    velocity: { x: vel.x, y: vel.y, z: vel.z },
    normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
    target: { kind: 'vehicle', vehicleId: hit.vehicleId, part: hit.part },
    outcome: res.outcome,
  };
}

function setup(): { sim: Sim; v: Vehicle; r: VehicleRenderer; frame: (e: SimEvent[]) => number } {
  const sim = createSim({ seed: 3, terrain: createFlatTerrain(0), scenario: 'empty' });
  // heading 0: the tank faces north (−Z); its left side faces west (−X)
  const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
  const r = new VehicleRenderer();
  const cam = new PerspectiveCamera(62, 1.6, 1, 50000);
  cam.position.set(0, 300, 500);
  cam.lookAt(0, 0, 0);
  // one frame as VehiclesView runs it: the frame's events, then the update
  const frame = (events: SimEvent[]) => {
    r.onEvents(events, sim);
    r.update(sim, 1 / 60, cam, A10_QUALITY.low, null, 1);
    return r.damageFlags(v);
  };
  frame([]);
  return { sim, v, r, frame };
}

describe('thrown tracks (TE-5)', () => {
  it('an engine kill through the engine deck draws no thrown track', () => {
    const { sim, v, r, frame } = setup();
    const s = VEHICLE_SHAPES.mbt;
    const top = s.hullClearance + s.hullHeight;
    const dir = new Vector3(0.2, -1, 0.1).normalize();
    for (let k = 0; k < 12 && !v.mobilityKill; k++) {
      const p = new Vector3(0.1 * k - 0.4, top, s.hullLength / 2 - 0.9);
      const e = fire(sim, p.addScaledVector(dir, -30), dir, 1150);
      frame(e ? [e] : []);
    }
    expect(v.mobilityKill).toBe(true);
    expect(v.components.runningGear).toBe(1);
    expect(frame([]) & TRACKS).toBe(0);
    r.dispose();
  });

  it('a catastrophic kill with both tracks intact draws no thrown track', () => {
    const { v, r, frame } = setup();
    // what explode() leaves in the public state: catastrophic, immobilised, tracks untouched
    v.condition = 'catastrophic';
    v.mobilityKill = true;
    v.firepowerKill = true;
    expect(frame([]) & TRACKS).toBe(0);
    r.dispose();
  });

  it('a failed left track is drawn on the left and stays there after a harmless hit on the right', () => {
    const { sim, v, r, frame } = setup();
    const s = VEHICLE_SHAPES.mbt;
    const y = s.hullClearance * 0.5 + 0.25;
    // API rounds from the west into the left track run, along the hull
    const east = new Vector3(1, 0, 0);
    for (let k = 0; k < 40 && !v.mobilityKill; k++) {
      const z = -s.hullLength * 0.35 + ((k * 0.37) % (s.hullLength * 0.7));
      const e = fire(sim, new Vector3(-30, y, z), east, 1000);
      frame(e ? [e] : []);
    }
    expect(v.mobilityKill).toBe(true);
    expect(v.components.runningGear).toBeLessThan(0.66);
    expect(frame([]) & TRACKS).toBe(FLAG.trackLeft);
    // a later round that strikes the right track but does no damage (the health stays)
    const before = v.components.runningGear;
    const harmless: SimEvent = {
      type: 'roundImpact',
      t: sim.time,
      round: RoundType.API,
      position: { x: 1.6, y, z: 0 },
      velocity: { x: -900, y: 0, z: 0 },
      normal: { x: 1, y: 0, z: 0 },
      target: { kind: 'vehicle', vehicleId: v.id, part: 'tracks' },
      outcome: 'stopped',
    };
    expect(frame([harmless]) & TRACKS).toBe(FLAG.trackLeft);
    expect(v.components.runningGear).toBe(before);
    r.dispose();
  });

  it('draws both tracks thrown when both have failed', () => {
    const { sim, r, frame } = setup();
    const s = VEHICLE_SHAPES.mbt;
    const y = s.hullClearance * 0.5 + 0.25;
    const east = new Vector3(1, 0, 0);
    const west = new Vector3(-1, 0, 0);
    let flags = 0;
    for (let k = 0; k < 80 && (flags & TRACKS) !== TRACKS; k++) {
      const z = -s.hullLength * 0.35 + ((k * 0.37) % (s.hullLength * 0.7));
      // alternate frames: one round on the left track, the next on the right
      const e =
        k % 2 === 0
          ? fire(sim, new Vector3(-30, y, z), east, 1000)
          : fire(sim, new Vector3(30, y, z), west, 1000);
      flags = frame(e ? [e] : []);
    }
    expect(flags & TRACKS).toBe(TRACKS);
    r.dispose();
  });
});
