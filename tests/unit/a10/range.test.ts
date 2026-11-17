/**
 * Weapons-range scoring (PLAN_A10.md §11, core/debrief scoring.ts): the strafe pit per pass and
 * panel with its fouls, the bombing circle's miss distance and clock (12 = along the run-in) and
 * session average, and the tactical lane's kills by weapon and time to kill. Scripted on the
 * debrief test bed, plus one strafe pass on the panels with the real gun and rounds.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../../src/a10/core/constants';
import { stepDebrief } from '../../../src/a10/core/debrief';
import { createDebriefTestbed } from '../../../src/a10/core/debrief/testbed';
import { createSim } from '../../../src/a10/core/sim';
import type { ScenarioKind, Sim } from '../../../src/a10/core/types';
import { stepGun, stepProjectiles } from '../../../src/a10/core/weapons';
import { setKinematicState } from '../../../src/a10/core/weapons/testbed';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { RANGE_RULES } from '../../../src/a10/data/range';

const DEG = Math.PI / 180;
/** The flat test world's first area (ALPHA, run-in north) hosts every range event. */
const AREA = { x: 0, z: -6000 };

describe('strafe pit: hits out of rounds per pass and panel, with fouls', () => {
  function strafePit() {
    const s = createDebriefTestbed('strafePit');
    s.step(SIM_DT);
    const layout = s.sim.debrief.internal.layout!;
    return { s, panels: layout.panels };
  }

  it('finds the panels left to right across the run-in', () => {
    const { s, panels } = strafePit();
    const layout = s.sim.debrief.internal.layout!;
    expect(layout.event).toBe('strafePit');
    expect(panels).toHaveLength(4);
    const xs = panels.map((id) => s.sim.targets.vehicles.find((v) => v.id === id)!.position.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(layout.runIn).toBeCloseTo(0, 9);
    expect(layout.z).toBeCloseTo(AREA.z, 6);
  });

  it('scores a clean pass, voids a foul-line pass and a pass below the minimum altitude', () => {
    const { s, panels } = strafePit();
    const onPanel = { vehicleKind: 'panel', outcome: 'passedThrough' as const, weapon: 'TP' };
    // pass 1: open fire 1,300 m short, cease 900 m short, recover at 120 m
    s.fly({ gamma: -10, agl: 250, x: -23, z: AREA.z + 1300 });
    s.step(1);
    s.trigger(1);
    s.step(0.4);
    const r1 = s.firstRound();
    for (let k = 0; k < 12; k++) s.hit(panels[1], r1 + 2 * k, onPanel);
    // an HEI round through the panel leaves two records (passedThrough + its burst): one round
    s.hit(panels[1], r1 + 30, { ...onPanel, weapon: 'HEI' });
    s.hit(panels[1], r1 + 30, { ...onPanel, weapon: 'HEI', outcome: 'fragment' });
    s.hit(panels[2], r1 + 31, onPanel);
    s.hit(panels[2], r1 + 33, onPanel);
    s.fly({ z: AREA.z + 900 });
    s.step(0.2);
    s.release(800);
    s.fly({ gamma: -2, agl: 120 });
    s.step(0.5);
    s.fly({ gamma: 6, agl: 130 });
    s.step(2);
    // pass 2: presses to 500 m short of the panel line (inside the 2,000 ft foul line)
    s.fly({ gamma: 0, agl: 600 });
    s.step(15);
    s.fly({ gamma: -12, agl: 300, z: AREA.z + 1100 });
    s.step(1);
    s.trigger(1);
    s.step(0.3);
    const r2 = s.firstRound();
    for (let k = 0; k < 5; k++) s.hit(panels[0], r2 + k, onPanel);
    s.fly({ z: AREA.z + 500 });
    s.step(0.2);
    s.release(520);
    s.fly({ gamma: 8 });
    s.step(2);
    // pass 3: fires from 1,200 m but bottoms out at 20 m (below the 100 ft minimum)
    s.fly({ gamma: 0, agl: 600 });
    s.step(15);
    s.fly({ gamma: -5, agl: 100, z: AREA.z + 1200 });
    s.step(1);
    s.trigger(1);
    s.step(0.3);
    const r3 = s.firstRound();
    s.hit(panels[3], r3 + 1, onPanel);
    s.release(1000);
    s.fly({ gamma: -1, agl: 20 });
    s.step(1);
    s.fly({ gamma: 4, agl: 25 });
    s.step(2);

    const d = s.sim.debrief;
    expect(d.passes).toHaveLength(3);
    const st = d.scores.strafe!;
    expect(st.passes).toHaveLength(3);
    const [p1, p2, p3] = st.passes;
    expect(p1).toMatchObject({
      panel: panels[1],
      rounds: d.bursts[0].rounds,
      hits: 13,
      panelHits: [0, 13, 2, 0],
      scored: 13,
      foulLine: false,
      minAltitude: false,
      openFireRange: 1200,
      ceaseFireRange: 800,
    });
    expect(p1.closestFiring).toBeCloseTo(900, 6);
    expect(p1.minAgl).toBe(120);
    expect(p2).toMatchObject({ panel: panels[0], hits: 5, scored: 0, foulLine: true });
    expect(p2.closestFiring).toBeLessThan(RANGE_RULES.strafeFoulLine);
    expect(p3).toMatchObject({ panel: panels[3], hits: 1, scored: 0, minAltitude: true });
    expect(p3.foulLine).toBe(false);
    expect(st).toMatchObject({ hits: 19, scored: 13, fouls: 2 });
    expect(st.rounds).toBe(d.bursts.reduce((n, b) => n + b.rounds, 0));
    expect(d.range).toMatchObject({ passes: 3, strafeHits: 19, strafeScored: 13, strafeFouls: 2 });
  });
});

describe('bombing circle: miss distance and clock from the bull, the session average', () => {
  it('scores each store from the bull along its run-in (12 = long)', () => {
    const s = createDebriefTestbed('bombCircle');
    s.step(SIM_DT);
    const layout = s.sim.debrief.internal.layout!;
    expect(layout.event).toBe('bombCircle');
    expect(layout.centreId).toBeGreaterThan(0);
    const bomb = (track: number, dx: number, dz: number, extra: { dud?: boolean } = {}) => {
      s.fly({ gamma: -20, track });
      s.step(1);
      const w = s.drop({ ...extra });
      s.fly({ gamma: 10 });
      s.step(2);
      s.sim.events.push({
        type: 'detonation',
        t: s.sim.time,
        position: { x: AREA.x + dx, y: 0, z: AREA.z + dz },
        charge: extra.dud ? 0 : 96,
        kind: extra.dud ? 'dud' : 'bomb',
        vehicleId: 0,
        surface: 'grass',
        bodyId: w.bodyId,
      });
      w.impactTime = s.sim.time;
      w.dud = extra.dud ?? false;
      s.fly({ gamma: 0 });
      s.step(12);
    };
    bomb(0, 0, -20); // 20 m long
    bomb(0, 15, 0); // 15 m right
    bomb(0, 0, 10); // 10 m short
    bomb(90, 10, 0); // run in east, 10 m east: long
    bomb(0, -30, 0, { dud: true }); // 30 m left, a dud
    // a store that lands without a detonation event seen: scored from its record
    s.fly({ gamma: -20, track: 180 });
    s.step(1);
    const w = s.drop();
    s.step(1);
    w.impactTime = s.sim.time;
    w.impact = { x: AREA.x - 5, y: 0, z: AREA.z + 5 }; // south-west of the bull
    s.step(SIM_DT);
    // nothing scored: a simulated release, a jettisoned store
    s.drop({ simulated: true, bodyId: 0 });
    s.drop({ delivery: 'JETTISON' });
    s.step(12);

    const b = s.sim.debrief.scores.bombs!;
    expect(b.centreX).toBeCloseTo(AREA.x, 6);
    expect(b.centreZ).toBeCloseTo(AREA.z, 6);
    expect(b.scores.map((x) => Math.round(x.miss))).toEqual([20, 15, 10, 10, 30, 7]);
    // running in south (180°), an impact south-west of the bull is long and to the right:
    // bearing 225°, 45° right of the run-in: half past one, which rounds to 2 o'clock
    expect(b.scores.map((x) => x.clock)).toEqual([12, 3, 6, 12, 9, 2]);
    expect(b.scores[4].dud).toBe(true);
    const misses = [20, 15, 10, 10, 30, Math.hypot(5, 5)];
    expect(b.mean).toBeCloseTo(misses.reduce((a, x) => a + x, 0) / misses.length, 6);
    expect(b.cep).toBeCloseTo((10 + 15) / 2, 6); // median of 7.1, 10, 10, 15, 20, 30
    expect(b.best).toBeCloseTo(Math.hypot(5, 5), 6);
    expect(s.sim.debrief.range).toMatchObject({ bombs: 6 });
  });
});

describe('tactical lane: kills by weapon and time to kill', () => {
  it('counts releases, strikes and kills per weapon and times each kill from its pass', () => {
    const s = createDebriefTestbed('tacticalLane');
    s.step(SIM_DT);
    const layout = s.sim.debrief.internal.layout!;
    expect(layout.event).toBe('tacticalLane');
    expect(layout.vehicles.length).toBeGreaterThanOrEqual(4);
    const [a, b] = layout.vehicles.slice(-2);
    // pass 1: the gun kills A
    s.fly({ gamma: -15 });
    s.step(1);
    const t1 = s.sim.time;
    s.trigger(1);
    s.step(0.5);
    const r = s.firstRound();
    s.hit(a, r + 1);
    s.hit(a, r + 2);
    s.hit(a, r + 2, { outcome: 'stopped' }); // the same round again (a ricochet): one strike
    s.hit(a, r + 9, { weapon: 'HEI', outcome: 'fragment' });
    s.release();
    s.step(0.6);
    s.sim.debrief.kills.push({
      time: s.sim.time,
      vehicleId: a,
      kind: 'apc',
      weapon: 'API',
      catastrophic: false,
    });
    const k1 = s.sim.time;
    s.fly({ gamma: 6 });
    s.step(2);
    // pass 2: a Maverick kills B
    s.fly({ gamma: 0 });
    s.step(20);
    const t2 = s.sim.time;
    const w = s.drop({ store: 'AGM-65D', weapon: 'AGM-65D', delivery: 'MAV' });
    s.step(4);
    s.hit(b, w.bodyId, { weapon: 'AGM-65D', outcome: 'penetrated', condition: 'destroyed' });
    s.sim.debrief.kills.push({
      time: s.sim.time,
      vehicleId: b,
      kind: 'mbt',
      weapon: 'AGM-65D',
      catastrophic: true,
    });
    const k2 = s.sim.time;
    s.step(12);

    const lane = s.sim.debrief.scores.lane!;
    expect(lane.vehicles).toBe(layout.vehicles.length);
    expect(lane.kills.map((k) => [k.weapon, k.pass])).toEqual([
      ['GUN', 0],
      ['AGM-65D', 1],
    ]);
    expect(lane.kills[0].timeToKill).toBeCloseTo(k1 - t1, 6);
    expect(lane.kills[1].timeToKill).toBeCloseTo(k2 - t2, 6);
    expect(lane.meanTimeToKill).toBeCloseTo((k1 - t1 + k2 - t2) / 2, 6);
    const gun = lane.byWeapon.find((x) => x.weapon === 'GUN')!;
    expect(gun).toMatchObject({ released: s.sim.gun.totalFired, hits: 2, kills: 1 });
    expect(lane.byWeapon.find((x) => x.weapon === 'AGM-65D')).toMatchObject({
      released: 1,
      hits: 1,
      kills: 1,
    });
  });
});

// ---- the real gun on the panels ------------------------------------------------------------------

/**
 * A strafing run from a fixed mount (no walk of the burst along the ground): the gun 10° nose
 * down at `start`, firing for `fire` s, then the flight path turned to a climb (the pull-off).
 */
function strafeRun(scenario: ScenarioKind, start: Vector3, fire: number): Sim {
  const sim = createSim({
    terrain: createFlatTerrain(0),
    scenario,
    seed: 5,
    loadoutId: 'gunOnly',
    ammoLoad: 'targetPractice',
  });
  sim.avionics.masterArm = 'ARM';
  sim.avionics.gunPac = 'ARM';
  setKinematicState(sim, { position: start, speed: 0, heading: 0, pathAngle: -10 * DEG });
  const ac = sim.aircraft;
  ac.track = 0;
  ac.groundSpeed = 0;
  ac.gLoad = 1;
  const n = Math.round((fire + 5) / SIM_DT);
  for (let i = 0; i < n; i++) {
    const t = i * SIM_DT;
    sim.input.trigger = t >= 0.5 && t < 0.5 + fire ? 2 : 0;
    if (t >= fire + 3) ac.flightPathAngle = 6 * DEG;
    ac.prevPosition.copy(ac.position);
    ac.prevVelocity.copy(ac.velocity);
    ac.prevOrientation.copy(ac.orientation);
    ac.agl = ac.position.y;
    stepGun(sim, SIM_DT);
    stepProjectiles(sim, SIM_DT);
    stepDebrief(sim, SIM_DT);
    sim.time += SIM_DT;
    sim.stepCount++;
  }
  return sim;
}

describe('strafe pit with the real gun (integration)', () => {
  it('counts the rounds through the panel attacked, and fouls a pass pressed inside the line', () => {
    // where a burst from this geometry lands, relative to the gun (no panels in the way)
    const from = new Vector3(0, 230, 0);
    const dry = strafeRun('empty', from, 0.8);
    let mx = 0;
    let mz = 0;
    let n = 0;
    for (const imp of dry.debrief.impacts) {
      mx += imp.x - from.x;
      mz += imp.z - from.z;
      n++;
    }
    expect(n).toBeGreaterThan(20);
    mx /= n;
    mz /= n;
    // the second panel from the left; the burst centred 12 m beyond it, so the rounds cross
    // its 20 ft face about 2.5 m up
    const probe = createSim({ terrain: createFlatTerrain(0), scenario: 'strafePit', seed: 5 });
    const panels = probe.targets.vehicles.filter((v) => v.kind === 'panel');
    panels.sort((p, q) => p.position.x - q.position.x);
    const target = panels[1].position;
    const sim = strafeRun('strafePit', new Vector3(target.x - mx, 230, target.z - 12 - mz), 0.5);

    const d = sim.debrief;
    expect(d.passes).toHaveLength(1);
    expect(d.passes[0].endReason).toBe('pullOff');
    const score = d.scores.strafe!.passes[0];
    const layout = d.internal.layout!;
    expect(score.panel).toBe(layout.panels[1]);
    expect(score.rounds).toBe(d.bursts[0].rounds);
    // every round through the panel is one hit, whatever records it left
    const through = new Set(
      d.hits
        .filter((h) => h.vehicleId === score.panel && h.outcome === 'passedThrough')
        .map((h) => h.sourceId),
    );
    expect(score.hits).toBe(through.size);
    expect(score.hits).toBeGreaterThan(score.rounds / 2);
    expect(score.hits).toBeLessThanOrEqual(d.bursts[0].hits);
    expect(score).toMatchObject({ foulLine: false, minAltitude: false });
    expect(score.scored).toBe(score.hits);
    expect(score.closestFiring).toBeGreaterThan(RANGE_RULES.strafeFoulLine);
    // its rounds were logged in the panel's frame
    expect(d.impacts.some((imp) => imp.ref === score.panel)).toBe(true);

    // the same pass pressed to 450 m: inside the 2,000 ft foul line
    const k = 450 / Math.hypot(mx, mz, 230);
    const pressed = strafeRun(
      'strafePit',
      new Vector3(target.x - mx * k, 230 * k, target.z - 12 - mz * k),
      0.3,
    );
    const foul = pressed.debrief.scores.strafe!.passes[0];
    expect(foul.foulLine).toBe(true);
    expect(foul.scored).toBe(0);
  });
});
