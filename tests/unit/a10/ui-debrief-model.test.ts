/**
 * Debrief data → screen model (src/a10/ui/debriefModel.ts): what the debrief screen shows for
 * each pass — the weapons, the target, the result, the release conditions, the overhead plot
 * with the run-in up — and the range score tables, on flights scripted with the debrief test bed.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../../src/a10/core/constants';
import { createDebriefTestbed } from '../../../src/a10/core/debrief/testbed';
import { applyRangeConditions } from '../../../src/a10/core/sim';
import { createVehicle } from '../../../src/a10/core/targets';
import type { SimOptions } from '../../../src/a10/core/types';
import {
  buildDebriefModel,
  passPlot,
  rangeConditions,
  rangeView,
} from '../../../src/a10/ui/debriefModel';
import { rangeWind, toRangeConditions } from '../../../src/a10/ui/rangeOptions';

const DEG = Math.PI / 180;
const AREA = { x: 0, z: -6000 };

describe('debrief screen model: passes', () => {
  it('a strafe pass on a panel: weapons, target, result, conditions and a run-in-up plot', () => {
    const s = createDebriefTestbed('strafePit');
    s.step(SIM_DT);
    const panels = s.sim.debrief.internal.layout!.panels;
    const panel = s.sim.targets.vehicles.find((v) => v.id === panels[1])!;
    // the gun's pipper on the panel's foot when the burst opens
    s.sim.avionics.gun.valid = true;
    s.sim.avionics.gun.impact.set(panel.position.x, 0, panel.position.z);
    s.fly({ gamma: -10, agl: 230, x: panel.position.x, z: AREA.z + 1200, g: 1.2 });
    s.step(1);
    s.trigger(1);
    s.step(0.5);
    const r = s.firstRound();
    for (let k = 0; k < 6; k++) {
      // rounds pass the panel, then strike the ground 8 m beyond it (north: the run-in is north)
      s.impact(panel.position.x + k - 3, panel.position.z, panel.id, 2, 'passedThrough');
      s.hit(panel.id, r + k, { vehicleKind: 'panel', weapon: 'TP', outcome: 'passedThrough' });
      s.impact(panel.position.x + k - 3, panel.position.z - 8, -1, 2, 'ground');
      s.step(SIM_DT);
    }
    s.release(820);
    s.fly({ gamma: 5, g: 3.1 });
    s.step(2);

    const m = buildDebriefModel(s.sim);
    expect(m.passes).toHaveLength(1);
    const p = m.passes[0];
    expect(p.number).toBe(1);
    expect(p.open).toBe(false);
    expect(p.target).toBe('Strafe panel 2');
    expect(p.weapons).toBe(`GAU-8 · 1 burst · ${s.sim.debrief.bursts[0].rounds} rounds`);
    expect(p.result).toMatch(/^6 of \d+ rounds through the panel \(\d+\s%\)$/);
    expect(p.fouls).toEqual([]);
    expect(p.maxG).toBeCloseTo(3.1, 9);
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({
      kind: 'burst',
      label: 'Burst 1',
      agl: 230,
      g: 1.2,
      slantRange: 1200,
    });
    expect(p.events[0].dive).toBeCloseTo(10 * DEG, 9);
    expect(p.events[0].detail).toMatch(/^\d+ rounds in \d\.\d s, 6 struck$/);
    expect(p.vehicles.map((v) => v.name)).toEqual(['Strafe panel 2']);
    expect(p.vehicles[0].strikes).toBe('6 rounds');
    // the plot: centred on the panel, the run-in up; the ground strikes are 8 m long (up)
    const plot = p.plot;
    expect(plot.target).toMatchObject({ kind: 'panel', name: 'Strafe panel 2' });
    // the panel faces the incoming aircraft: its front points down the plot
    expect(Math.abs(Math.cos(plot.target!.rotation) + 1)).toBeLessThan(1e-9);
    expect(plot.aim!.x).toBeCloseTo(0, 6);
    expect(plot.aim!.y).toBeCloseTo(0, 6);
    const ground = plot.marks.filter((k) => k.cls === 'ground');
    expect(ground).toHaveLength(6);
    for (const g of ground) expect(g.y).toBeCloseTo(8, 6);
    expect(plot.marks.filter((k) => k.cls === 'penetrated')).toHaveLength(6);
    expect(plot.radius % plot.step).toBe(0);
    expect(plot.radius).toBeGreaterThanOrEqual(8);
  });

  it('a pass on a vehicle: hits grouped by vehicle, the kill, and the plot follows the run-in', () => {
    const s = createDebriefTestbed('empty');
    const tank = createVehicle(s.sim, 'mbt', 100, -3000, 90 * DEG, 1);
    s.fly({ gamma: -30, track: 90 }); // running in east, the tank heading east too
    s.step(1);
    s.trigger(1);
    s.step(0.3);
    const r = s.firstRound();
    // a strike on the tank, and a round 5 m beyond it (east = long when running in east)
    s.impact(100, -3000, tank.id, 0, 'penetrated');
    s.hit(tank.id, r, { condition: 'destroyed', damaged: ['ammo'] });
    s.impact(105, -3000, -1, 0, 'ground');
    s.sim.debrief.kills.push({
      time: s.sim.time,
      vehicleId: tank.id,
      kind: 'mbt',
      weapon: 'API',
      catastrophic: true,
    });
    s.step(SIM_DT);
    s.release();
    s.fly({ gamma: 6 });
    s.step(2);
    const p = buildDebriefModel(s.sim).passes[0];
    expect(p.target).toBe(`T-72 #${tank.id}`);
    expect(p.result).toBe(`T-72 #${tank.id} destroyed`);
    expect(p.kills).toEqual([
      {
        time: expect.any(Number),
        name: `T-72 #${tank.id}`,
        weapon: '30 mm API',
        catastrophic: true,
      },
    ]);
    expect(p.vehicles[0]).toMatchObject({ condition: 'destroyed', strikes: '1 round' });
    expect(p.vehicles[0].rows[0]).toMatchObject({ plate: 'Top hull', outcome: 'penetrated' });
    // the target points along the run-in: up
    expect(p.plot.target!.rotation).toBeCloseTo(0, 9);
    const long = p.plot.marks.find((k) => k.cls === 'ground')!;
    expect(long.y).toBeCloseTo(5, 6);
    expect(long.x).toBeCloseTo(0, 6);
  });
});

describe('debrief screen model: range scores', () => {
  it('bombing circle: numbered bomb marks, score rings, the table and the session figures', () => {
    const s = createDebriefTestbed('bombCircle');
    s.step(SIM_DT);
    const drop = (dx: number, dz: number) => {
      s.fly({ gamma: -20, track: 0 });
      s.step(1);
      const w = s.drop({ aim: { x: AREA.x, y: 0, z: AREA.z } });
      s.step(1);
      s.sim.events.push({
        type: 'detonation',
        t: s.sim.time,
        position: { x: AREA.x + dx, y: 0, z: AREA.z + dz },
        charge: 96,
        kind: 'bomb',
        vehicleId: 0,
        surface: 'grass',
        bodyId: w.bodyId,
      });
      w.impactTime = s.sim.time;
      s.fly({ gamma: 8 });
      s.step(2);
      s.fly({ gamma: 0 });
      s.step(12);
    };
    drop(0, -30); // 30 m long
    drop(12, 0); // 12 m right
    const m = buildDebriefModel(s.sim);
    expect(m.passes).toHaveLength(2);
    const plot = m.passes[0].plot;
    expect(plot.marks).toEqual([expect.objectContaining({ cls: 'bomb', label: '1' })]);
    expect(plot.marks[0].y).toBeCloseTo(30, 6);
    expect(plot.rings).toContain(25);
    expect(plot.aim).toEqual({ x: 0, y: 0 });
    expect(m.passes[0].result).toMatch(/^Mk-82 30\sm 12 o'clock$/);
    expect(m.passes[1].events[0].detail).toMatch(/^12\sm from the bull, 3 o'clock$/);
    const view = m.range!;
    expect(view.title).toBe('Bombing circle');
    expect(view.bombs!.rows.map((b) => [b.n, b.pass, Math.round(b.miss), b.clock])).toEqual([
      [1, 1, 30, 12],
      [2, 2, 12, 3],
    ]);
    expect(view.bombs!.mean).toBeCloseTo(21, 6);
    expect(view.bombs!.cep).toBeCloseTo(21, 6);
  });

  it('strafe pit: a row per pass with its fouls; free hunt: no range score', () => {
    const s = createDebriefTestbed('strafePit');
    s.step(SIM_DT);
    const panels = s.sim.debrief.internal.layout!.panels;
    s.fly({ gamma: -10, agl: 200, z: AREA.z + 450 });
    s.step(1);
    s.trigger(1);
    s.step(0.3);
    s.hit(panels[0], s.firstRound() + 1, {
      vehicleKind: 'panel',
      weapon: 'TP',
      outcome: 'passedThrough',
    });
    s.release(470);
    s.fly({ gamma: 6 });
    s.step(2);
    const m = buildDebriefModel(s.sim);
    const view = rangeView(s.sim)!;
    expect(view.title).toBe('Strafe pit');
    expect(view.line).toMatch(
      /^Foul line 610\sm \(2,000\sft\) short of the panels · minimum altitude 100\sft/,
    );
    expect(view.strafe!.rows).toEqual([
      expect.objectContaining({
        pass: 1,
        panel: 'Panel 1',
        hits: 1,
        scored: 0,
        fouls: 'Foul line',
      }),
    ]);
    expect(m.passes[0].fouls[0]).toMatch(/^Fired inside the foul line: 450 m short of the panels/);
    expect(m.passes[0].result).toMatch(/FOUL: scores 0$/);

    // the range card states the weather the way the range calls it
    expect(view.conditions).toBe('Calm wind · light turbulence');

    const free = createDebriefTestbed('freeHunt');
    free.step(SIM_DT);
    expect(rangeView(free.sim)).toBeNull();
    expect(buildDebriefModel(free.sim).passes).toEqual([]);
  });

  it('the range weather: the wind’s clock direction from the run-in, the turbulence setting', () => {
    const run = 0.7; // a run-in heading of about 40°
    const at = (kt: number, clock: number, turbulence: number) => {
      const w = rangeWind(kt, clock, run);
      return rangeConditions({ surfaceWind: w, turbulence }, run);
    };
    expect(at(15, 3, 0.5)).toBe("Wind 15 kn from 3 o'clock · moderate turbulence");
    expect(at(10, 12, 0)).toBe("Wind 10 kn from 12 o'clock · calm turbulence");
    expect(at(20, 8, 1)).toBe("Wind 20 kn from 8 o'clock · strong turbulence");
    expect(at(0, 5, 0.15)).toBe('Calm wind · light turbulence');
    // a range flight with the options applied states them on its card
    const s = createDebriefTestbed('bombCircle');
    (s.sim.options as SimOptions).range = toRangeConditions({
      windKt: 15,
      windClock: 9,
      turbulence: 'moderate',
      columnKmh: 15,
    });
    expect(applyRangeConditions(s.sim)).toBe(true);
    s.step(SIM_DT);
    expect(rangeView(s.sim)!.conditions).toBe("Wind 15 kn from 9 o'clock · moderate turbulence");
  });

  it('a pass without a target is centred on its aim point, then on its impacts', () => {
    const s = createDebriefTestbed('empty');
    s.fly({ gamma: -20 });
    s.step(1);
    s.trigger(1);
    s.step(0.2);
    s.impact(500, -2000);
    s.impact(504, -2000);
    s.step(SIM_DT);
    s.release();
    const p = s.sim.debrief.passes[0];
    const plot = passPlot(s.sim, p);
    expect(plot.target).toBeNull();
    expect(plot.aim).toBeNull();
    expect(plot.marks.map((k) => Math.round(k.x))).toEqual([-2, 2]);
  });
});
