/**
 * Debrief recorder (core/debrief, ARCHITECTURE §12.6): passes from roll-in to pull-off on
 * scripted event sequences, and the links of hits, kills and impacts to their passes.
 *
 * The test bed (core/debrief/testbed.ts) owns the aircraft and the gun counters and appends
 * records the way the weapons and targets modules do; only stepDebrief runs, so these tests
 * measure the debrief alone.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../../src/a10/core/constants';
import {
  burstOfRound,
  createDebriefState,
  missClock,
  toHeadingFrame,
} from '../../../src/a10/core/debrief';
import { createDebriefTestbed as scripted } from '../../../src/a10/core/debrief/testbed';
import { createVehicle } from '../../../src/a10/core/targets';
import type { ReleaseRequest } from '../../../src/a10/core/weapons/types';
import { PASS_RULES } from '../../../src/a10/data/range';

const DEG = Math.PI / 180;

describe('debrief: passes from roll-in to pull-off', () => {
  it('a dive, a burst and the climb after it make one pass', () => {
    const s = scripted();
    s.step(2);
    s.fly({ gamma: -1 });
    s.step(1);
    const rollIn = s.sim.time;
    s.fly({ gamma: -30, agl: 900 });
    s.step(4);
    const fire = s.sim.time;
    s.trigger();
    s.step(1.5);
    s.release();
    s.fly({ gamma: -10, agl: 250 });
    s.step(1.5); // recovering: still descending
    s.fly({ gamma: 5, agl: 200 });
    s.step(0.5);
    const d = s.sim.debrief;
    expect(d.passes).toHaveLength(1);
    const p = d.passes[0];
    expect(p.start).toBeCloseTo(rollIn, 6);
    expect(p.firstEvent).toBeCloseTo(fire, 6);
    expect(p.bursts).toEqual([1]);
    expect(p.endReason).toBe('pullOff');
    expect(p.end).toBeGreaterThan(p.lastEvent + PASS_RULES.pullOffMinTime - 1e-6);
    expect(p.minAgl).toBe(200);
  });

  it('a dive and a climb without a weapon event are not a pass', () => {
    const s = scripted();
    s.fly({ gamma: -30 });
    s.step(5);
    s.fly({ gamma: 10 });
    s.step(5);
    expect(s.sim.debrief.passes).toHaveLength(0);
  });

  it('two bursts in one dive are one pass; a second dive is a second pass', () => {
    const s = scripted();
    s.fly({ gamma: -20 });
    s.step(2);
    s.trigger();
    s.step(1);
    s.release();
    s.step(0.6);
    s.trigger();
    s.step(1);
    s.release();
    s.fly({ gamma: 10 });
    s.step(3);
    s.fly({ gamma: 0 });
    s.step(20);
    s.fly({ gamma: -25 });
    s.step(3);
    s.trigger();
    s.step(1);
    s.release();
    s.fly({ gamma: 8 });
    s.step(3);
    const passes = s.sim.debrief.passes;
    expect(passes.map((p) => p.bursts)).toEqual([[1, 2], [3]]);
    expect(passes.map((p) => p.number)).toEqual([1, 2]);
    expect(passes.every((p) => p.endReason === 'pullOff')).toBe(true);
  });

  it('a level release starts its pass at the release and ends it after a quiet spell', () => {
    const s = scripted();
    s.fly({ gamma: 0 });
    s.step(3);
    const t = s.sim.time;
    s.drop({ delivery: 'CCRP' });
    s.step(PASS_RULES.passTimeout - 1);
    expect(s.sim.debrief.passes[0].endReason).toBe('');
    s.step(1.5);
    const p = s.sim.debrief.passes[0];
    expect(p.start).toBeCloseTo(t, 6);
    expect(p.weapons).toEqual([0]);
    expect(p.endReason).toBe('timeout');
  });

  it('stays open while a ripple is queued, even when climbing', () => {
    const s = scripted();
    s.fly({ gamma: -15 });
    s.step(1);
    s.drop();
    const queued = { time: s.sim.time + 3 } as ReleaseRequest;
    s.sim.stores.releaseQueue.push(queued);
    s.fly({ gamma: 10 });
    s.step(2);
    expect(s.sim.debrief.passes[0].endReason).toBe('');
    s.sim.stores.releaseQueue.length = 0;
    s.drop();
    s.step(2);
    const p = s.sim.debrief.passes[0];
    expect(p.weapons).toEqual([0, 1]);
    expect(p.endReason).toBe('pullOff');
  });

  it('jettison opens no pass; a simulated TRAIN release does', () => {
    const s = scripted();
    s.drop({ delivery: 'JETTISON' });
    s.step(1);
    expect(s.sim.debrief.passes).toHaveLength(0);
    expect(s.sim.debrief.weaponLinks[0].pass).toBe(-1);
    s.fly({ gamma: -20 });
    s.step(1);
    s.drop({ simulated: true, bodyId: 0 });
    s.step(1);
    expect(s.sim.debrief.passes).toHaveLength(1);
    expect(s.sim.debrief.passes[0].weapons).toEqual([1]);
  });

  it('the roll-in is looked for at most maxRollIn before the first event', () => {
    const s = scripted();
    s.fly({ gamma: -5 });
    s.step(60);
    const t = s.sim.time;
    s.trigger();
    s.step(0.5);
    s.release();
    expect(s.sim.debrief.passes[0].start).toBeCloseTo(t - PASS_RULES.maxRollIn, 6);
  });

  it('a crash ends the open pass', () => {
    const s = scripted();
    s.fly({ gamma: -30 });
    s.step(1);
    s.trigger();
    s.step(0.5);
    s.release();
    s.sim.aircraft.crashed = true;
    s.step(SIM_DT);
    expect(s.sim.debrief.passes[0].endReason).toBe('crash');
  });

  it('the run-in is the ground track at the first weapon event', () => {
    const s = scripted();
    s.fly({ gamma: -20, track: 135 });
    s.step(1);
    s.trigger();
    s.step(0.2);
    s.fly({ track: 140 });
    s.step(0.3);
    s.release();
    expect(s.sim.debrief.passes[0].runIn).toBeCloseTo(135 * DEG, 9);
  });
});

describe('debrief: hits, kills and impacts belong to their pass', () => {
  it('rounds find their burst by id; stores by body id; kills by the last hit', () => {
    const s = scripted();
    const tank = createVehicle(s.sim, 'mbt', 0, -2000, 0, 1);
    const truck = createVehicle(s.sim, 'truckCargo', 30, -2000, 0, 1);
    s.fly({ gamma: -30 });
    s.step(1);
    s.trigger(1);
    s.step(0.5);
    const first = s.firstRound();
    s.release();
    s.fly({ gamma: 5 });
    s.step(2);
    // a late round of burst 1 strikes after the pull-off: still pass 1
    s.hit(tank.id, first + 10);
    s.impact(0, -2000, tank.id, 0, 'penetrated');
    s.step(SIM_DT);
    s.fly({ gamma: 0 });
    s.step(15);
    s.fly({ gamma: -20 });
    s.step(1);
    const w = s.drop();
    s.step(0.5);
    // the bomb lands next to the truck: its blast is a hit by body id; the truck dies
    s.sim.events.push({
      type: 'detonation',
      t: s.sim.time,
      position: { x: 34, y: 0, z: -2003 },
      charge: 96,
      kind: 'bomb',
      vehicleId: truck.id,
      surface: 'grass',
      bodyId: w.bodyId,
    });
    s.hit(truck.id, w.bodyId, { weapon: 'MK-82', outcome: 'blast', condition: 'destroyed' });
    s.sim.debrief.kills.push({
      time: s.sim.time,
      vehicleId: truck.id,
      kind: 'truckCargo',
      weapon: 'MK-82',
      catastrophic: false,
    });
    s.step(SIM_DT);
    const d = s.sim.debrief;
    expect(d.passes).toHaveLength(2);
    expect(d.hitLinks[0]).toMatchObject({ pass: 0, burst: 1, direct: true, impact: 0 });
    expect(d.hitLinks[1]).toMatchObject({ pass: 1, record: 0, direct: false, impact: 1 });
    expect(d.hitLinks[1].dx).toBeCloseTo(4, 9);
    expect(d.hitLinks[1].dz).toBeCloseTo(-3, 9);
    expect(d.passes[0].hits).toEqual([0]);
    expect(d.passes[1].hits).toEqual([1]);
    expect(d.passes[1].kills).toEqual([0]);
    expect(d.weaponLinks[0].impact).toBe(1);
    expect(d.impacts[1]).toMatchObject({ kind: 'bomb', weapon: 'MK-82', pass: 1, record: 0 });
  });

  it('a fragment hit is tied to the HEI burst that made it, even one nearer another vehicle', () => {
    const s = scripted();
    const a = createVehicle(s.sim, 'mbt', 0, -2000, 0, 1);
    const b = createVehicle(s.sim, 'mbt', 25, -2000, Math.PI / 2, 1);
    s.fly({ gamma: -30 });
    s.step(1);
    s.trigger(1);
    s.step(0.3);
    const id = s.firstRound();
    // an HEI round bursts on the ground 6 m from A and 19 m from B; its fragments reach B
    s.impact(6, -2000, -1, 1, 'ground');
    s.hit(b.id, id + 2, { weapon: 'HEI', outcome: 'fragment' });
    s.step(SIM_DT);
    s.release();
    const d = s.sim.debrief;
    const imp = d.impacts[0];
    expect(imp.ref).toBe(a.id); // logged in the frame of the nearest vehicle…
    const link = d.hitLinks[0];
    expect(link.impact).toBe(0); // …but the hit on B is tied to it
    expect(link.direct).toBe(false);
    // B heads east: the burst 19 m west of it is 19 m behind it
    const p = toHeadingFrame(link.dx, link.dz, link.heading);
    expect(p.y).toBeCloseTo(-19, 6);
    expect(p.x).toBeCloseTo(0, 6);
  });

  it('two records of one round tie to the one strike (a ricochet and its burst)', () => {
    const s = scripted();
    const a = createVehicle(s.sim, 'mbt', 0, -2000, 0, 1);
    s.trigger(1);
    s.step(0.2);
    const id = s.firstRound();
    s.impact(0.5, -2001, a.id, 1, 'ricochet');
    s.hit(a.id, id, { weapon: 'HEI', outcome: 'ricochet' });
    s.hit(a.id, id, { weapon: 'HEI', outcome: 'fragment' });
    s.step(SIM_DT);
    const d = s.sim.debrief;
    expect(d.impacts).toHaveLength(1);
    expect(d.hitLinks.map((l) => l.impact)).toEqual([0, 0]);
  });

  it('events drained by the frame loop between steps are neither lost nor taken twice', () => {
    const s = scripted();
    s.trigger(1);
    s.step(0.1);
    s.impact(1, -1000);
    s.step(SIM_DT);
    s.sim.events.length = 0; // the frame loop drains
    s.impact(2, -1000);
    s.impact(3, -1000);
    s.step(SIM_DT);
    s.step(SIM_DT);
    expect(s.sim.debrief.impacts.map((i) => i.x)).toEqual([1, 2, 3]);
  });

  it('is deterministic: the same script gives the same record', () => {
    const run = () => {
      const s = scripted();
      createVehicle(s.sim, 'mbt', 0, -2000, 0, 1);
      s.fly({ gamma: -30 });
      s.step(1);
      s.trigger(1);
      s.step(0.5);
      s.impact(1, -2000, -1, 1);
      s.hit(1, s.firstRound() + 3, { weapon: 'HEI', outcome: 'fragment' });
      s.step(0.5);
      s.release();
      s.fly({ gamma: 6 });
      s.step(2);
      const d = s.sim.debrief;
      return JSON.stringify([d.passes, d.impacts, d.hitLinks, d.weaponLinks, d.scores, d.range]);
    };
    expect(run()).toBe(run());
  });
});

describe('debrief: geometry', () => {
  it('clock directions read from the run-in: 12 long, 3 right, 6 short, 9 left', () => {
    // run-in north (0): long is north (−z), right is east (+x)
    expect(missClock(0, -10, 0)).toBe(12);
    expect(missClock(10, 0, 0)).toBe(3);
    expect(missClock(0, 10, 0)).toBe(6);
    expect(missClock(-10, 0, 0)).toBe(9);
    expect(missClock(10, -10, 0)).toBe(2); // 45° right of long: half past one rounds to 2
    // run-in east (90°): long is east
    expect(missClock(10, 0, 90 * DEG)).toBe(12);
    expect(missClock(0, 10, 90 * DEG)).toBe(3);
    expect(Number.isNaN(missClock(0, 0, 0))).toBe(true);
  });

  it('finds the burst of a round id', () => {
    const first = [0, 1, 40, 120];
    expect(burstOfRound(first, 1)).toBe(1);
    expect(burstOfRound(first, 39)).toBe(1);
    expect(burstOfRound(first, 40)).toBe(2);
    expect(burstOfRound(first, 500)).toBe(3);
    expect(burstOfRound([], 5)).toBe(0);
  });

  it('a new debrief state is empty and serialisable', () => {
    const d = createDebriefState();
    expect(d.passes).toEqual([]);
    expect(d.scores.event).toBe('none');
    expect(() => JSON.stringify(d)).not.toThrow();
  });
});
