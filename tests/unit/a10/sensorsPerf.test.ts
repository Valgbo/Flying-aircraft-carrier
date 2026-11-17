/**
 * Cost of the sensors step on the generated world (sensors brief: "under 0.2 ms per step with 4
 * seekers and a lasing pod on the generated world"; PLAN_A10.md §14: the whole simulation under
 * 4 ms per frame). The scene is the expensive case: the pod point-tracks a running vehicle of a
 * free-hunt group and lases it (a beam trace per pulse), the selected AGM-65D is locked on the
 * same vehicle (line of sight, contrast and IR-capture checks), the other three seekers are caged,
 * the aircraft dives toward the target at 150 m/s and the vehicles drive. Each step's time is the
 * best of several identical runs (the test bed is deterministic), so a busy machine does not fail
 * the test for time the process did not get.
 */
import { Quaternion, Vector3 } from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIM_DT } from '../../../src/a10/core/constants';
import { stepSensors } from '../../../src/a10/core/sensors';
import { quaternionFromAttitude } from '../../../src/a10/core/frames';
import {
  podHeadBody,
  seekerHeadBody,
  vehicleCentreHeight,
} from '../../../src/a10/core/sensors/geometry';
import { cockpitSwitches } from '../../../src/a10/core/sensors/tgp';
import {
  addVehicle,
  aimPodAt,
  createSensorTestbed,
  driveVehicles,
  finishTestbedStep,
  prepareTestbedStep,
  queueRequest,
  setAircraft,
  setVehicleHeat,
  stepSensorTestbed,
} from '../../../src/a10/core/sensors/testbed';
import type { Vehicle } from '../../../src/a10/core/targets/types';
import type { Sim } from '../../../src/a10/core/types';
import { DEG } from '../../../src/a10/core/units';
import { createTerrain, generateTerrainData, type Terrain } from '../../../src/a10/core/world';

const WORLD_SEED = 7;
const RUN_SECONDS = 20;
const REPS = 5;
const STEPS = Math.round(RUN_SECONDS / SIM_DT);
/** Slant geometry of the attack: 8 km out, 1,500 m above the target. */
const START_RANGE = 8000;
const START_HEIGHT = 1500;

let terrain: Terrain;
const report: Array<[string, string]> = [];

beforeAll(() => {
  terrain = createTerrain(generateTerrainData(WORLD_SEED));
}, 60000);

afterAll(() => {
  console.log('\n| sensors cost (generated world) | value |\n|---|---|');
  for (const [k, v] of report) console.log(`| ${k} | ${v} |`);
});

/** Speed of the target along its heading, m/s, and of the aircraft, m/s. */
const TARGET_SPEED = 5;
const AIRCRAFT_SPEED = 150;
const DIVE = -4 * DEG;

const _q = new Quaternion();
const _head = new Vector3();
const _seeker = new Vector3();
const _air = new Vector3();
const _veh = new Vector3();

/**
 * Whether the pod (station 10) and the D's seeker (station 3) see the vehicle's centre all along
 * the planned straight approach from `from` (heading `heading`, DIVE, AIRCRAFT_SPEED) while the
 * vehicle drives at TARGET_SPEED (the test bed's kinematics), sampled every half second.
 */
function visibleAllAlong(v: Vehicle, from: Vector3, heading: number): boolean {
  quaternionFromAttitude(heading, DIVE, 0, _q);
  const vx = Math.sin(heading) * Math.cos(DIVE) * AIRCRAFT_SPEED;
  const vy = Math.sin(DIVE) * AIRCRAFT_SPEED;
  const vz = -Math.cos(heading) * Math.cos(DIVE) * AIRCRAFT_SPEED;
  const h = vehicleCentreHeight(v);
  for (let t = 0; t <= RUN_SECONDS + 1; t += 0.5) {
    _air.set(from.x + vx * t, from.y + vy * t, from.z + vz * t);
    const x = v.position.x + Math.sin(v.heading) * TARGET_SPEED * t;
    const z = v.position.z - Math.cos(v.heading) * TARGET_SPEED * t;
    _veh.set(x, terrain.heightAt(x, z) + h, z);
    podHeadBody(10, _head).applyQuaternion(_q).add(_air);
    seekerHeadBody(3, 'LAU-88', 0, _seeker).applyQuaternion(_q).add(_air);
    if (!terrain.lineOfSight(_head, _veh, true) || !terrain.lineOfSight(_seeker, _veh, true))
      return false;
  }
  return true;
}

/**
 * The first running-capable vehicle of the free hunt that stays in plain view of the pod and the
 * D's seeker for the whole run, from one of eight approach directions 8 km out. Deterministic:
 * same world, same seed, same choice.
 */
function chooseTarget(sim: Sim): { v: Vehicle; from: Vector3; heading: number } {
  const from = new Vector3();
  for (const v of sim.targets.vehicles) {
    if (v.condition !== 'intact' || v.dugIn || v.kind === 'panel' || v.kind === 'hulk') continue;
    for (let k = 0; k < 8; k++) {
      const bearing = (k * Math.PI) / 4; // from the target to the aircraft, compass
      from.set(
        v.position.x + Math.sin(bearing) * START_RANGE,
        0,
        v.position.z - Math.cos(bearing) * START_RANGE,
      );
      if (Math.abs(from.x) > 30000 || Math.abs(from.z) > 30000) continue;
      from.y = Math.max(v.position.y + START_HEIGHT, terrain.heightAt(from.x, from.z) + 300);
      const heading = (bearing + Math.PI) % (2 * Math.PI);
      if (visibleAllAlong(v, from, heading)) return { v, from: from.clone(), heading };
    }
  }
  throw new Error('no vehicle in plain view on the generated world');
}

interface Run {
  times: Float64Array;
  lasing: number;
  locked: number;
  point: number;
  vehicles: number;
  target: string;
  state: string;
}

/** Most vehicles alive at once (PLAN §14). */
const MAX_VEHICLES = 80;

/**
 * Fill the scene to MAX_VEHICLES: trucks in rows 1.5–4 km beyond the target and 400 m or more to
 * either side of the attack line (outside every gate, no smoke across the line of sight), every
 * fifth one a burning wreck — so the gate searches, the smoke test and the IR capture check all
 * walk a full vehicle list.
 */
function fillScene(sim: Sim, target: Vehicle, heading: number): void {
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  for (let i = 0; sim.targets.vehicles.length < MAX_VEHICLES; i++) {
    const along = 1500 + 300 * (i % 9);
    const side = (i % 2 === 0 ? 1 : -1) * (400 + 120 * Math.floor(i / 18));
    const x = target.position.x + fx * along - fz * side;
    const z = target.position.z + fz * along + fx * side;
    const o = addVehicle(sim, 'truckCargo', x, z, heading, { heat: 'idle' });
    o.position.y = terrain.heightAt(x, z);
    if (i % 5 === 0) {
      o.condition = 'destroyed';
      o.fire = 1;
    }
  }
}

/** One deterministic run: set up the attack, then time `stepSensors` alone on every step. */
function attackRun(fill: boolean): Run {
  const sim = createSensorTestbed({
    terrain,
    scenario: 'freeHunt',
    seed: 1,
    x: 0,
    z: 0,
    altitude: 3000,
    timeOfDay: 10.5,
  });
  const { v, from, heading } = chooseTarget(sim);
  if (fill) fillScene(sim, v, heading);
  setVehicleHeat(v, 'running', TARGET_SPEED);
  v.speed = TARGET_SPEED;
  setAircraft(sim, from, { heading, pitch: DIVE, bank: 0, speed: AIRCRAFT_SPEED });
  // pod: slaved to the target, point track, laser armed and latched
  aimPodAt(sim, v.position);
  stepSensorTestbed(sim);
  queueRequest(sim, 'TGP', 'tms', 'up');
  stepSensorTestbed(sim);
  sim.avionics.laserArm = 'ARM';
  cockpitSwitches(sim).laserLatch = true;
  // the D on station 3: narrow field of view, slaved to the SPI, lock
  cockpitSwitches(sim).selectedStation = 3;
  stepSensorTestbed(sim);
  queueRequest(sim, 'MAV', 'dms', 'up');
  queueRequest(sim, 'MAV', 'slaveSpi', '', true);
  stepSensorTestbed(sim);
  queueRequest(sim, 'MAV', 'tms', 'up');
  stepSensorTestbed(sim);

  const times = new Float64Array(STEPS);
  const tgp = sim.sensors.tgp;
  let lasing = 0;
  let locked = 0;
  let point = 0;
  for (let k = 0; k < STEPS; k++) {
    driveVehicles(sim);
    prepareTestbedStep(sim);
    const t0 = performance.now();
    stepSensors(sim, SIM_DT);
    times[k] = performance.now() - t0;
    finishTestbedStep(sim);
    if (tgp.lasing) lasing++;
    if (tgp.mode === 'POINT') point++;
    const s = sim.sensors.mavericks[sim.sensors.selectedMaverick];
    if (s?.locked) locked++;
  }
  const s = sim.sensors.mavericks[sim.sensors.selectedMaverick];
  return {
    times,
    lasing,
    locked,
    point,
    vehicles: sim.targets.vehicles.length,
    target: `${v.kind} #${v.id} at (${v.position.x.toFixed(0)}, ${v.position.z.toFixed(0)})`,
    state: JSON.stringify([
      tgp.los.toArray(),
      tgp.point.toArray(),
      tgp.spot.toArray(),
      tgp.laserRange,
      tgp.mode,
      s?.los.toArray(),
      s?.lockedVehicle,
      s?.contrast,
      sim.sensors.mavericks.length,
    ]),
  };
}

/** Per-step time as the best of REPS identical runs, and its statistics, ms. */
function measure(fill: boolean) {
  const runs: Run[] = [];
  for (let r = 0; r < REPS; r++) runs.push(attackRun(fill));
  const best = new Float64Array(STEPS).fill(Infinity);
  for (const run of runs) for (let k = 0; k < STEPS; k++) best[k] = Math.min(best[k], run.times[k]);
  const sorted = Array.from(best).sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / STEPS;
  // the plain mean of each run (no best-of), the median run
  const raw = runs.map((run) => run.times.reduce((a, b) => a + b, 0) / STEPS).sort((a, b) => a - b)[
    Math.floor(REPS / 2)
  ];
  return {
    runs,
    mean,
    raw,
    p99: sorted[Math.floor(0.99 * (STEPS - 1))],
    max: sorted[STEPS - 1],
  };
}

describe('sensors step cost on the generated world', () => {
  for (const fill of [false, true]) {
    const name = fill ? `filled to ${MAX_VEHICLES} vehicles` : 'the free hunt as generated';
    it(`stays under 0.2 ms per step with four seekers and a lasing pod (${name}); runs are identical`, () => {
      const m = measure(fill);
      const first = m.runs[0];
      // the expensive case was measured: tracking, lasing and locked all the time
      expect(first.point / STEPS).toBeGreaterThan(0.95);
      expect(first.lasing / STEPS).toBeGreaterThan(0.95);
      expect(first.locked / STEPS).toBeGreaterThan(0.95);
      // determinism on the generated world: every run ends in the same state
      for (const run of m.runs) expect(run.state).toBe(first.state);
      const pct = (n: number) => ((100 * n) / STEPS).toFixed(1);
      report.push([
        `scene: ${name}`,
        `${first.vehicles} vehicles (world seed ${WORLD_SEED}); target ${first.target}; POINT / lasing / MAV locked ${pct(first.point)} / ${pct(first.lasing)} / ${pct(first.locked)} % of ${STEPS} steps`,
      ]);
      report.push([
        `stepSensors, ${name}: mean (best of ${REPS} per step) / plain mean (median run)`,
        `${(m.mean * 1000).toFixed(1)} / ${(m.raw * 1000).toFixed(1)} µs (budget 200 µs)`,
      ]);
      report.push([
        `stepSensors, ${name}: 99th percentile / worst step`,
        `${(m.p99 * 1000).toFixed(0)} / ${(m.max * 1000).toFixed(0)} µs`,
      ]);
      expect(m.mean).toBeLessThan(0.2);
    }, 120000);
  }
});
