/**
 * Debrief data for the screen (src/a10/ui/debriefData.ts): vehicle frames, what the summary
 * counts (rounds that struck, not hit records: review finding DB-1) and the marks of each
 * vehicle's plot (every hit is plotted on its vehicle, also a burst nearer another vehicle:
 * review finding DB-2).
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../../src/a10/core/constants';
import { createDebriefState, stepDebrief } from '../../../src/a10/core/debrief';
import type { BurstRecord, HitRecord } from '../../../src/a10/core/debrief/types';
import { createSim, stepSim } from '../../../src/a10/core/sim';
import { createVehicle } from '../../../src/a10/core/targets';
import type { Sim } from '../../../src/a10/core/types';
import { stepGun, stepProjectiles } from '../../../src/a10/core/weapons';
import { setKinematicState } from '../../../src/a10/core/weapons/testbed';
import { createFlatTerrain } from '../../../src/a10/core/world';
import {
  burstHitRate,
  classifyImpact,
  hitsByVehicle,
  plotScale,
  strikeSummary,
  summarize,
  toVehicleLocal,
  vehicleMarks,
  vehicleName,
} from '../../../src/a10/ui/debriefData';

const DEG = Math.PI / 180;

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

function burst(n: number, rounds: number, hits: number): BurstRecord {
  return {
    burst: n,
    start: { time: 1, dive: 0.5, speed: 150, agl: 600, slantRange: 1200, gLoad: 1, bank: 0 },
    duration: 1.5,
    rounds,
    hits,
    openFireRange: 1250,
    ceaseFireRange: 900,
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

  it('classifies outcomes for the plot', () => {
    expect(classifyImpact('penetrated', true)).toBe('penetrated');
    expect(classifyImpact('passedThrough', true)).toBe('penetrated');
    expect(classifyImpact('stopped', true)).toBe('defeated');
    expect(classifyImpact('ricochet', true)).toBe('defeated');
    expect(classifyImpact('burst', true)).toBe('burst');
    expect(classifyImpact('fragment', true)).toBe('fragments');
    expect(classifyImpact('blast', true)).toBe('fragments');
    expect(classifyImpact('ground', false)).toBe('ground');
    expect(classifyImpact('skip', false)).toBe('ground');
  });
});

describe('debrief: the summary counts rounds that struck, not hit records (DB-1)', () => {
  it('a doubled record and fragment records do not add gun hits', () => {
    const d = createDebriefState();
    d.bursts.push(burst(1, 90, 2));
    // round 5: an HEI round that ricochets is logged twice (the ricochet, then its burst);
    // round 6: an API round; round 7: an HEI round bursting on the ground, fragments only
    d.hits.push(
      hit(1, { sourceId: 5, weapon: 'HEI', outcome: 'ricochet' }),
      hit(1, { sourceId: 5, weapon: 'HEI', outcome: 'fragment' }),
      hit(1, { sourceId: 6 }),
      hit(2, { sourceId: 7, weapon: 'HEI', outcome: 'fragment' }),
      hit(2, { sourceId: 3, weapon: 'AGM-65D', outcome: 'blast' }),
    );
    d.kills.push({ time: 3, vehicleId: 1, kind: 'mbt', weapon: 'API', catastrophic: false });
    const s = summarize(d, { roundsLoaded: 1150, totalFired: 90, rounds: 1060 }, 12);
    expect(s).toMatchObject({
      roundsLoaded: 1150,
      roundsFired: 90,
      gunHits: 2, // rounds 5 and 6: the burst record's count
      bursts: 1,
      vehiclesHit: 2,
      kills: 1,
      vehiclesTotal: 12,
    });
    // the open burst's hits so far count too
    const open = summarize(
      d,
      { roundsLoaded: 1150, totalFired: 120, rounds: 1030, burstStart: 4, burstHits: 3 },
      12,
    );
    expect(open.gunHits).toBe(5);
    expect(burstHitRate(d.bursts[0])).toBeCloseTo(2 / 90, 9);
    expect(Number.isNaN(burstHitRate({ ...d.bursts[0], rounds: 0 }))).toBe(true);
  });

  it('per vehicle: rounds that struck, store strikes and blast or fragment hits apart', () => {
    const groups = hitsByVehicle([
      hit(7, { sourceId: 5, weapon: 'HEI', outcome: 'ricochet', condition: 'damaged' }),
      hit(7, { sourceId: 5, weapon: 'HEI', outcome: 'fragment' }),
      hit(3, { sourceId: 9 }),
      hit(7, { sourceId: 6 }),
      hit(7, { sourceId: 41, weapon: 'MK-82', outcome: 'blast', condition: 'destroyed' }),
      hit(3, { sourceId: 2, weapon: 'AGM-65H', outcome: 'penetrated' }),
    ]);
    expect(groups.map((g) => g.vehicleId)).toEqual([7, 3]);
    expect(groups[0]).toMatchObject({ rounds: 2, stores: 0, indirect: 2, condition: 'destroyed' });
    expect(groups[0].hits).toHaveLength(4);
    expect(groups[1]).toMatchObject({ rounds: 1, stores: 1, indirect: 0 });
    expect(strikeSummary(groups[0])).toBe('2 rounds · 2 blast or fragment hits');
    expect(strikeSummary(groups[1])).toBe('1 round · 1 direct hit');
  });
});

/** A fixed gun 30° nose down, all HEI and no dispersion: every round bursts on one spot. */
function heiGun(seed: number): { sim: Sim; run: (seconds: number, fire: boolean) => void } {
  const sim = createSim({
    terrain: createFlatTerrain(0),
    scenario: 'empty',
    seed,
    loadoutId: 'gunOnly',
    ammoLoad: 'allHEI',
  });
  sim.avionics.masterArm = 'ARM';
  sim.avionics.gunPac = 'ARM';
  sim.gun.dispersionScale = 0;
  setKinematicState(sim, {
    position: new Vector3(0, 600, 0),
    speed: 0,
    heading: 0,
    pathAngle: -30 * DEG,
  });
  const run = (seconds: number, fire: boolean) => {
    const n = Math.round(seconds / SIM_DT);
    for (let i = 0; i < n; i++) {
      sim.input.trigger = fire ? 2 : 0;
      stepGun(sim, SIM_DT);
      stepProjectiles(sim, SIM_DT);
      stepDebrief(sim, SIM_DT);
      sim.time += SIM_DT;
      sim.stepCount++;
    }
  };
  return { sim, run };
}

describe('debrief: every hit is plotted on its vehicle (DB-2)', () => {
  it('a burst nearer another vehicle still marks the vehicle its fragments reached', () => {
    let checked = false;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      // find the burst point with a dry run, then park A 6 m west of it and B 14 m east,
      // B heading east: the ground impacts are nearer A, the fragments reach both
      const dry = heiGun(seed);
      dry.run(0.3, true);
      dry.run(2, false);
      const spot = dry.sim.debrief.impacts[0];
      expect(spot).toBeDefined();
      const live = heiGun(seed);
      const a = createVehicle(live.sim, 'mbt', spot.x - 6, spot.z, 0, 1);
      const b = createVehicle(live.sim, 'mbt', spot.x + 14, spot.z, 90 * DEG, 1);
      live.run(0.5, true);
      live.run(2, false);
      const d = live.sim.debrief;
      const onB = d.hits.map((h, i) => ({ h, i })).filter(({ h }) => h.vehicleId === b.id);
      if (onB.length === 0) continue; // no fragment reached B with this seed
      checked = true;
      // the old recorder's rule — each ground impact to the nearest vehicle only — logs them on A
      expect(d.impacts.filter((imp) => imp.kind === 'round').every((imp) => imp.ref === a.id)).toBe(
        true,
      );
      // every hit on B is tied to its burst…
      for (const { i } of onB) expect(d.hitLinks[i].impact).toBeGreaterThanOrEqual(0);
      // …and B's plot shows it: 14 m west of B, which heads east, is 14 m behind it
      const marks = vehicleMarks(d, b.id);
      expect(marks.length).toBeGreaterThan(0);
      for (const m of marks.filter((x) => x.cls === 'fragments')) {
        expect(m.y).toBeCloseTo(-14, 0);
        expect(Math.abs(m.x)).toBeLessThan(1);
      }
      expect(marks.some((m) => m.cls === 'fragments')).toBe(true);
      // A's plot shows the bursts 6 m to its right
      expect(vehicleMarks(d, a.id).some((m) => Math.abs(m.x - 6) < 1 && Math.abs(m.y) < 1)).toBe(
        true,
      );
      break;
    }
    expect(checked).toBe(true);
  });

  it('a recorded strafing pass: every vehicle with a hit has its hits plotted (integration)', {
    timeout: 120_000,
  }, () => {
    /** A trimmed 45° dive at 300 kn, a one-second burst at two T-72s 20 m apart. */
    const pass = (seed: number, tanks: { x: number; z: number }[]): Sim => {
      const sim = createSim({
        seed,
        terrain: createFlatTerrain(100),
        scenario: 'empty',
        start: { x: 0, z: 0, agl: 700, heading: 0, speed: 300 * 0.514444, gamma: -45 * DEG },
      });
      for (const t of tanks) createVehicle(sim, 'mbt', t.x, t.z, 0, 1);
      sim.avionics.masterArm = 'ARM';
      sim.avionics.gunPac = 'ARM';
      for (let i = 0; i < 120 * 4; i++) {
        sim.input.trigger = i >= 60 && i < 180 ? 2 : 0;
        stepSim(sim);
      }
      return sim;
    };
    const dry = pass(17, []);
    let x = 0;
    let z = 0;
    for (const imp of dry.debrief.impacts) {
      x += imp.x;
      z += imp.z;
    }
    x /= dry.debrief.impacts.length;
    z /= dry.debrief.impacts.length;
    let fragmentOnly = 0;
    for (const seed of [17, 18, 19, 20]) {
      const sim = pass(seed, [
        { x: x + 3, z },
        { x: x + 23, z },
      ]);
      const d = sim.debrief;
      expect(d.passes).toHaveLength(1);
      expect(d.hitLinks).toHaveLength(d.hits.length);
      for (const link of d.hitLinks) expect(link.impact).toBeGreaterThanOrEqual(0);
      for (const g of hitsByVehicle(d.hits)) {
        expect(vehicleMarks(d, g.vehicleId).length, `seed ${seed} vehicle ${g.vehicleId}`).toBeGreaterThan(0);
        if (g.rounds === 0 && g.indirect > 0) fragmentOnly++;
      }
      // DB-1 on the same pass: rounds that struck, never more than the rounds fired
      const s = summarize(d, sim.gun, 2);
      expect(s.gunHits).toBe(d.bursts.reduce((n, b) => n + b.hits, 0));
      expect(s.gunHits).toBeLessThanOrEqual(s.roundsFired);
      expect(s.gunHits).toBeLessThanOrEqual(d.hits.length);
      expect(d.passes[0].hits).toHaveLength(d.hits.length);
    }
    // the case of the review: a vehicle hit only by the fragments of bursts nearby
    expect(fragmentOnly).toBeGreaterThan(0);
  });
});

describe('debrief: plots and names', () => {
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
