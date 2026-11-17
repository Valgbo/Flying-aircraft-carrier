/**
 * Debrief test bed: a Sim whose aircraft and gun counters a test or sandbox drives by hand,
 * appending records and events the way the weapons and targets modules do. Each step runs only
 * stepDebrief, so a scripted sequence measures the debrief alone (tests/unit/a10/debrief*.test.ts
 * and range*.test.ts; import directly, like core/weapons/testbed.ts).
 */
import { SIM_DT } from '../constants';
import { createSim } from '../sim';
import type { ScenarioKind, SimEvent } from '../types';
import { createFlatTerrain } from '../world';
import type { Terrain } from '../world/types';
import { stepDebrief } from './index';
import type { HitRecord, WeaponRecord } from './types';

const DEG = Math.PI / 180;

export type DebriefTestbed = ReturnType<typeof createDebriefTestbed>;

/** A sim whose aircraft and gun the test drives by hand; each step runs stepDebrief only. */
export function createDebriefTestbed(scenario: ScenarioKind = 'empty', terrain: Terrain = createFlatTerrain(0)) {
  const sim = createSim({ terrain, scenario, seed: 3 });
  sim.events.length = 0;
  const ac = sim.aircraft;
  const gun = sim.gun;
  const pool = sim.projectiles.rounds;
  const d = sim.debrief;
  ac.agl = 1000;
  ac.flightPathAngle = 0;
  ac.track = 0;
  ac.groundSpeed = 150;
  ac.gLoad = 1;
  let firing = 0;
  /** Rounds already counted for their burst (one count per round, as weapons does). */
  const counted = new Set<number>();

  const h = {
    sim,
    /** Set the flight path (deg, + climb), height, position, track (deg) and load. */
    fly(p: { gamma?: number; agl?: number; x?: number; z?: number; track?: number; g?: number }) {
      if (p.gamma !== undefined) ac.flightPathAngle = p.gamma * DEG;
      if (p.agl !== undefined) ac.agl = p.agl;
      if (p.x !== undefined) ac.position.x = p.x;
      if (p.z !== undefined) ac.position.z = p.z;
      if (p.track !== undefined) ac.track = p.track * DEG;
      if (p.g !== undefined) ac.gLoad = p.g;
    },
    /** Run `seconds` of steps; while a burst is open, `firing` rounds leave per step. */
    step(seconds: number, each?: () => void) {
      const n = Math.round(seconds / SIM_DT);
      for (let i = 0; i < n; i++) {
        if (gun.burstStart >= 0 && firing > 0) {
          gun.burstRounds += firing;
          gun.totalFired += firing;
          pool.nextId += firing;
          gun.lastRoundTime = sim.time;
        }
        each?.();
        stepDebrief(sim, SIM_DT);
        sim.time += SIM_DT;
        sim.stepCount++;
      }
    },
    /** Open a burst now (its first round leaves in this step), with the gun's conditions. */
    trigger(roundsPerStep = 1) {
      gun.burstNumber++;
      gun.burstStart = sim.time;
      gun.burstRounds = 0;
      gun.burstHits = 0;
      gun.openFireRange = 1200;
      const c = gun.burstConditions;
      c.time = sim.time;
      c.dive = -ac.flightPathAngle;
      c.speed = ac.groundSpeed;
      c.agl = ac.agl;
      c.slantRange = gun.openFireRange;
      c.gLoad = ac.gLoad;
      c.bank = 0;
      firing = roundsPerStep;
    },
    /** Close the open burst: the gun appends its record (hits so far). */
    release(ceaseFireRange = 800) {
      d.bursts.push({
        burst: gun.burstNumber,
        start: { ...gun.burstConditions },
        duration: sim.time - gun.burstStart,
        rounds: gun.burstRounds,
        hits: gun.burstHits,
        openFireRange: gun.openFireRange,
        ceaseFireRange,
      });
      gun.burstStart = -1;
      firing = 0;
    },
    /** First round id of the newest burst. */
    firstRound(): number {
      return pool.nextId - gun.burstRounds;
    },
    /** A store release as the weapons module records it. */
    drop(patch: Partial<WeaponRecord> = {}): WeaponRecord {
      const w: WeaponRecord = {
        id: d.weapons.length + 1,
        weapon: 'MK-82',
        release: {
          time: sim.time,
          dive: -ac.flightPathAngle,
          speed: 150,
          agl: ac.agl,
          slantRange: 1500,
          gLoad: ac.gLoad,
          bank: 0,
        },
        impactTime: NaN,
        missDistance: NaN,
        missClock: NaN,
        dud: false,
        fragmentWarning: false,
        store: 'MK-82',
        station: 5,
        delivery: 'CCIP',
        aim: { x: 0, y: 0, z: -3000 },
        aimValid: true,
        impact: { x: NaN, y: NaN, z: NaN },
        simulated: false,
        bodyId: 100 + d.weapons.length,
        ...patch,
      };
      d.weapons.push(w);
      return w;
    },
    /**
     * A hit record as the targets module appends it. A round's first strike on a vehicle also
     * counts for its burst, once per round, as the weapons module does (`burst`: which one;
     * default the newest); blast and fragment hits never count.
     */
    hit(vehicleId: number, sourceId: number, patch: Partial<HitRecord> = {}, burst = 0): HitRecord {
      const r: HitRecord = {
        time: sim.time,
        sourceId,
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
        damaged: [],
        condition: 'damaged',
        ...patch,
      };
      d.hits.push(r);
      const round = r.weapon === 'API' || r.weapon === 'HEI' || r.weapon === 'TP';
      const direct = r.outcome !== 'fragment' && r.outcome !== 'blast';
      if (round && direct && !counted.has(sourceId)) {
        counted.add(sourceId);
        const b = burst || gun.burstNumber;
        if (gun.burstStart >= 0 && b === gun.burstNumber) gun.burstHits++;
        else {
          const rec = d.bursts.find((x) => x.burst === b);
          if (rec) rec.hits++;
        }
      }
      return r;
    },
    /** A roundImpact event at (x, z), on a vehicle or the ground. */
    impact(x: number, z: number, vehicleId = -1, round: 0 | 1 | 2 = 0, outcome = 'ground') {
      const e: SimEvent = {
        type: 'roundImpact',
        t: sim.time + SIM_DT / 2,
        round,
        position: { x, y: 0, z },
        velocity: { x: 0, y: -500, z: -500 },
        normal: { x: 0, y: 1, z: 0 },
        target:
          vehicleId > 0
            ? { kind: 'vehicle', vehicleId, part: 'hull' }
            : { kind: 'ground', surface: 'grass' },
        outcome: outcome as 'ground',
      };
      sim.events.push(e);
    },
  };
  return h;
}

