import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { DebriefState, HitRecord } from '../../../src/a10/core/debrief/types';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import type { Vehicle } from '../../../src/a10/core/targets/types';
import {
  burstHitRate,
  classifyImpact,
  hitsByVehicle,
  ImpactRecorder,
  nearestVehicle,
  plotScale,
  summarize,
  toVehicleLocal,
  vehicleName,
} from '../../../src/a10/ui/debriefData';

const DEG = Math.PI / 180;

function vehicle(id: number, x: number, z: number, heading: number): Vehicle {
  return { id, kind: 'mbt', position: new Vector3(x, 0, z), heading } as unknown as Vehicle;
}

function hit(vehicleId: number, patch: Partial<HitRecord> = {}): HitRecord {
  return {
    time: 1,
    sourceId: 1,
    weapon: 'API',
    vehicleId,
    vehicleKind: 'mbt',
    plate: 0,
    face: 'top',
    part: 'hull',
    speed: 800,
    obliquity: 0.3,
    effectiveThicknessMm: 25,
    penetrationMm: 40,
    outcome: 'penetrated',
    damaged: ['engine'],
    condition: 'damaged',
    ...patch,
  };
}

function impact(
  x: number,
  z: number,
  target: Extract<SimEvent, { type: 'roundImpact' }>['target'],
  outcome: Extract<SimEvent, { type: 'roundImpact' }>['outcome'],
): SimEvent {
  return {
    type: 'roundImpact',
    t: 2,
    round: 0,
    position: { x, y: 0, z },
    velocity: { x: 0, y: -1, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    target,
    outcome,
  };
}

describe('debrief: vehicle frame', () => {
  it('a vehicle heading north has its front toward −z and its right toward +x', () => {
    const p = toVehicleLocal(100, -10, 100, 0, 0);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(10, 9);
    const r = toVehicleLocal(103, 0, 100, 0, 0);
    expect(r.x).toBeCloseTo(3, 9);
    expect(r.y).toBeCloseTo(0, 9);
  });

  it('heading east: a point to the east is ahead, a point to the south is on the right', () => {
    const ahead = toVehicleLocal(10, 0, 0, 0, 90 * DEG);
    expect(ahead.y).toBeCloseTo(10, 9);
    expect(ahead.x).toBeCloseTo(0, 9);
    const right = toVehicleLocal(0, 5, 0, 0, 90 * DEG);
    expect(right.x).toBeCloseTo(5, 9);
    expect(right.y).toBeCloseTo(0, 9);
  });
});

describe('debrief: impacts and summaries', () => {
  it('classifies outcomes for the plot', () => {
    expect(classifyImpact('penetrated', true)).toBe('penetrated');
    expect(classifyImpact('passedThrough', true)).toBe('penetrated');
    expect(classifyImpact('stopped', true)).toBe('defeated');
    expect(classifyImpact('ricochet', true)).toBe('defeated');
    expect(classifyImpact('burst', true)).toBe('burst');
    expect(classifyImpact('ground', false)).toBe('ground');
  });

  it('records hits and near misses in each vehicle frame, and restarts with a new flight', () => {
    const v1 = vehicle(1, 0, 0, 0);
    const v2 = vehicle(2, 500, 0, 90 * DEG);
    const sim = { targets: { vehicles: [v1, v2] } } as unknown as Sim;
    const rec = new ImpactRecorder();
    rec.record(
      [
        impact(0.5, -2, { kind: 'vehicle', vehicleId: 1, part: 'hull' }, 'penetrated'),
        impact(10, 0, { kind: 'ground', surface: 'grass' } as never, 'ground'),
        impact(510, 0, { kind: 'ground', surface: 'grass' } as never, 'ground'),
        impact(250, 0, { kind: 'ground', surface: 'grass' } as never, 'ground'),
      ],
      sim,
    );
    const m1 = rec.marksFor(sim, 1);
    expect(m1).toHaveLength(2);
    expect(m1[0]).toMatchObject({ cls: 'penetrated' });
    expect(m1[0].y).toBeCloseTo(2, 9);
    expect(m1[1]).toMatchObject({ cls: 'ground' });
    const m2 = rec.marksFor(sim, 2);
    expect(m2).toHaveLength(1);
    expect(m2[0].y).toBeCloseTo(10, 9); // 10 m east of a vehicle heading east: ahead of it
    expect(rec.vehicleIds(sim).sort()).toEqual([1, 2]);
    const next = { targets: { vehicles: [v1] } } as unknown as Sim;
    expect(rec.marksFor(next, 1)).toHaveLength(0);
    rec.record([], next);
    expect(rec.marksFor(sim, 1)).toHaveLength(0);
  });

  it('finds the nearest vehicle inside a radius', () => {
    const vs = [vehicle(1, 0, 0, 0), vehicle(2, 30, 0, 0)];
    expect(nearestVehicle(vs, 20, 0, 40)?.id).toBe(2);
    expect(nearestVehicle(vs, 200, 0, 40)).toBeUndefined();
  });

  it('groups hits by vehicle in first-hit order, keeping the last condition', () => {
    const groups = hitsByVehicle([
      hit(7, { condition: 'damaged' }),
      hit(3),
      hit(7, { condition: 'destroyed' }),
    ]);
    expect(groups.map((g) => g.vehicleId)).toEqual([7, 3]);
    expect(groups[0].hits).toHaveLength(2);
    expect(groups[0].condition).toBe('destroyed');
  });

  it('summarizes the flight', () => {
    const d: DebriefState = {
      bursts: [
        {
          burst: 1,
          start: { time: 1, dive: 0.5, speed: 150, agl: 600, slantRange: 1200, gLoad: 1, bank: 0 },
          duration: 1.5,
          rounds: 90,
          hits: 9,
          openFireRange: 1250,
          ceaseFireRange: 900,
        },
      ],
      hits: [hit(1), hit(1), hit(2, { weapon: 'AGM-65D', outcome: 'blast' })],
      weapons: [],
      kills: [{ time: 3, vehicleId: 1, kind: 'mbt', weapon: 'API', catastrophic: false }],
      range: {},
    };
    const s = summarize(d, { roundsLoaded: 1150, totalFired: 90, rounds: 1060 }, 12);
    expect(s).toMatchObject({
      roundsLoaded: 1150,
      roundsFired: 90,
      gunHits: 2,
      bursts: 1,
      vehiclesHit: 2,
      kills: 1,
      vehiclesTotal: 12,
    });
    expect(burstHitRate(d.bursts[0])).toBeCloseTo(0.1, 9);
    expect(Number.isNaN(burstHitRate({ ...d.bursts[0], rounds: 0 }))).toBe(true);
  });

  it('plot extent covers the vehicle and every mark, on a whole grid step', () => {
    expect(plotScale([], 3.45)).toEqual({ radius: 6, step: 2 });
    expect(plotScale([{ x: 12, y: -3 }], 3.45)).toEqual({ radius: 15, step: 5 });
    expect(plotScale([{ x: 0, y: 33 }], 3.45)).toEqual({ radius: 40, step: 10 });
  });

  it('names vehicles', () => {
    expect(vehicleName('mbt')).toBe('T-72');
    expect(vehicleName('somethingNew')).toBe('somethingNew');
  });
});
