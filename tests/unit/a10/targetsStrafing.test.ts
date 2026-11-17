/**
 * Review TE-2 acceptance: armour, angle and range decide mobility kills too (PLAN §1, §6.3). A
 * track is broken only by a penetrator that defeats its run (or heavy blast), not worn down by
 * strikes beside it, so a gun pass from the front or a 30° pass from 1,400 m (no penetration
 * anywhere) seldom immobilises a T-72, while a burst down the side of the track run usually does.
 *
 * Whole simulation (createSim + stepSim): the real flight model, gun, rounds and fire control at
 * 300 kn, PAC-2. The tank is placed at the mean impact point of the same pass flown without it
 * (the pipper held on the tank), and the pass is flown again with the same seed.
 */
import { describe, expect, it } from 'vitest';
import { createSim, stepSim } from '../../../src/a10/core/sim';
import { createVehicle, type VehicleKind } from '../../../src/a10/core/targets';
import type { Sim } from '../../../src/a10/core/types';
import { createFlatTerrain } from '../../../src/a10/core/world';

const DEG = Math.PI / 180;
const DT = 1 / 120;
const KT = 0.514444;
const LONG = 300_000;
const SEEDS = Array.from({ length: 24 }, (_, i) => 100 + i);

function makeSim(seed: number, dive: number, agl: number): Sim {
  const sim = createSim({
    seed,
    terrain: createFlatTerrain(0),
    scenario: 'empty',
    start: { x: 0, z: 0, agl, heading: 0, speed: 300 * KT, gamma: -dive * DEG },
  });
  sim.avionics.masterArm = 'ARM';
  sim.avionics.gunPac = 'ARM';
  return sim;
}

/** Fly the pass: 0.5 s steady, the burst, then 2.5 s for the rounds to land. */
function fly(sim: Sim, burst: number): number {
  let slant = 0;
  const n = Math.round((0.5 + burst + 2.5) / DT);
  const first = Math.round(0.5 / DT);
  const last = first + Math.round(burst / DT);
  for (let i = 0; i < n; i++) {
    sim.input.trigger = i >= first && i < last ? 2 : 0;
    if (i === first) slant = sim.avionics.gun.slantRange;
    stepSim(sim);
  }
  return slant;
}

interface Pass {
  label: string;
  kind: VehicleKind;
  heading: number;
  dive: number;
  agl: number;
  burst: number;
}

function strafe(p: Pass) {
  let mobility = 0;
  let penetrations = 0;
  let slant = 0;
  let struck = 0;
  for (const seed of SEEDS) {
    // where this pass's rounds land with nothing in the way
    const probe = makeSim(seed, p.dive, p.agl);
    slant += fly(probe, p.burst) / SEEDS.length;
    let x = 0;
    let z = 0;
    let k = 0;
    for (const e of probe.events) {
      if (e.type !== 'roundImpact' || e.outcome !== 'ground') continue;
      x += e.position.x;
      z += e.position.z;
      k++;
    }
    expect(k).toBeGreaterThan(10);
    const sim = makeSim(seed, p.dive, p.agl);
    const v = createVehicle(sim, p.kind, x / k, z / k, p.heading, 1);
    fly(sim, p.burst);
    const recs = sim.debrief.hits.filter((h) => h.vehicleId === v.id);
    struck += new Set(recs.map((h) => h.sourceId)).size / SEEDS.length;
    penetrations += recs.filter((h) => h.outcome === 'penetrated').length;
    if (v.mobilityKill) mobility++;
  }
  console.log(
    `[targets] ${p.label}: slant ${slant.toFixed(0)} m, ${struck.toFixed(1)} rounds on the tank per pass, ` +
      `${penetrations} penetrations, mobility kill ${mobility}/${SEEDS.length}`,
  );
  return { mobility, penetrations, slant };
}

describe('strafing a T-72: mobility kills need a cause (review TE-2)', () => {
  it(
    'a 1 s burst from the front at ≈900 m immobilises only a minority of passes',
    { timeout: LONG },
    () => {
      const r = strafe({
        label: 'front, 10° dive, 1 s',
        kind: 'mbt',
        heading: 180 * DEG,
        dive: 10,
        agl: 200,
        burst: 1,
      });
      expect(r.slant).toBeGreaterThan(800);
      expect(r.slant).toBeLessThan(1000);
      expect(r.penetrations).toBe(0);
      expect(r.mobility).toBeLessThanOrEqual(9);
    },
  );

  it('a 2 s burst in a 30° dive from ≈1,400 m behind rarely does', { timeout: LONG }, () => {
    const r = strafe({
      label: 'rear, 30° dive, 2 s',
      kind: 'mbt',
      heading: 0,
      dive: 30,
      agl: 800,
      burst: 2,
    });
    expect(r.slant).toBeGreaterThan(1300);
    expect(r.penetrations).toBe(0);
    expect(r.mobility).toBeLessThanOrEqual(5);
  });

  it('a 1 s burst down the side of the track run usually does', { timeout: LONG }, () => {
    const r = strafe({
      label: 'side, 10° dive, 1 s',
      kind: 'mbt',
      heading: 90 * DEG,
      dive: 10,
      agl: 200,
      burst: 1,
    });
    expect(r.penetrations).toBe(0);
    expect(r.mobility).toBeGreaterThanOrEqual(10);
  });
});
