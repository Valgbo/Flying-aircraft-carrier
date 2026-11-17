/**
 * Fire control (PLAN_A10.md §6.1 rule 2, §6.2 "The sight", §7, §16 gun-sight row): the CCIP gun
 * sight against rounds flown with the weapons module's own integrator, the altitude-source
 * switch over sloping ground, the predictor's accuracy and cost, the range flags, and the
 * generic store predictor. The aircraft is held KINEMATICALLY (position, velocity, attitude set
 * by the test), so these tests do not depend on the flight model; the one test that needs the
 * weapons module's real gun is marked (integration).
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  FIRE_CONTROL,
  gunPredictorStep,
  hudAnglesOfPoint,
  predictStoreImpact,
  registerStoreBallistics,
  roundModel,
  stepError,
  stepFireControl,
  createFireControlGround,
  createImpactPrediction,
  updateFireControlGround,
  type CalibrationShot,
  type StoreBallistics,
} from '../../../src/a10/core/avionics';
import { G0, SIM_DT } from '../../../src/a10/core/constants';
import {
  bodyDirFromHudAngles,
  hudAnglesFromBodyDir,
  quaternionFromAttitude,
  worldToBody,
} from '../../../src/a10/core/frames';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim } from '../../../src/a10/core/types';
import {
  integrateRound,
  roundTypeAt,
  stepGun,
  stepProjectiles,
} from '../../../src/a10/core/weapons';
import { RoundType } from '../../../src/a10/core/weapons/types';
import {
  createFlatTerrain,
  createTerrain,
  generateTerrainData,
  terrainFromHeightFunction,
  windAt,
} from '../../../src/a10/core/world';
import type { Terrain, TerrainHit } from '../../../src/a10/core/world/types';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import { GAU8 } from '../../../src/a10/data/gun';

const DEG = Math.PI / 180;
const KT = 0.514444;
const FT = 0.3048;
const MRAD = 1e-3;

// ---------------------------------------------------------------------------------------------
// Fixtures: a kinematic aircraft in a steady dive
// ---------------------------------------------------------------------------------------------

interface Dive {
  /** Flight-path angle below the horizon, deg. */
  diveDeg: number;
  /** True airspeed along the path, kn. */
  tasKt: number;
  /** Nose above the path (angle of attack), deg. */
  aoaDeg: number;
  /** Heading of the path and the nose, deg. */
  headingDeg: number;
}

const _air = new Vector3();

/** The aircraft's state at time t of a steady dive that starts at p0 (air-relative TAS + wind). */
function diveState(
  sim: Sim,
  d: Dive,
  p0: Vector3,
  t: number,
  pos: Vector3,
  vel: Vector3,
  q: Quaternion,
): void {
  const h = d.headingDeg * DEG;
  const g = -d.diveDeg * DEG;
  const v = d.tasKt * KT;
  _air.set(Math.sin(h) * Math.cos(g) * v, Math.sin(g) * v, -Math.cos(h) * Math.cos(g) * v);
  // Steady over the ground: the drift the wind at the start gives, held.
  windAt(sim.world, p0, vel);
  vel.add(_air);
  pos.copy(p0).addScaledVector(vel, t);
  quaternionFromAttitude(h, g + d.aoaDeg * DEG, 0, q);
}

const _pos = new Vector3();
const _vel = new Vector3();
const _q = new Quaternion();

/** Hold the aircraft at a state; the previous state becomes `prev*` (as a flight step would). */
function holdAircraft(sim: Sim, pos: Vector3, vel: Vector3, q: Quaternion): void {
  const ac = sim.aircraft;
  ac.prevPosition.copy(ac.position);
  ac.prevVelocity.copy(ac.velocity);
  ac.prevOrientation.copy(ac.orientation);
  ac.position.copy(pos);
  ac.velocity.copy(vel);
  ac.orientation.copy(q);
  ac.angularVelocity.set(0, 0, 0);
  ac.altitude = pos.y;
  ac.agl = pos.y - sim.world.terrain.heightAt(pos.x, pos.z);
  ac.tas = vel.length();
  ac.externalForceBody.set(0, 0, 0);
  ac.externalMomentBody.set(0, 0, 0);
}

function holdAt(sim: Sim, d: Dive, p0: Vector3, t: number): void {
  diveState(sim, d, p0, t, _pos, _vel, _q);
  holdAircraft(sim, _pos, _vel, _q);
  // A held aircraft has no previous motion at the first hold.
  if (t === 0) {
    sim.aircraft.prevPosition.copy(_pos);
    sim.aircraft.prevVelocity.copy(_vel);
    sim.aircraft.prevOrientation.copy(_q);
  }
}

function gunSim(terrain: Terrain, load: 'combatMix' | 'allHEI' = 'combatMix', seed = 3): Sim {
  const sim = createSim({ terrain, scenario: 'empty', loadoutId: 'gunOnly', ammoLoad: load, seed });
  sim.world.turbulence = 0;
  return sim;
}

/**
 * Wind blowing toward the east (a crosswind for a dive to the north) of `kt` knots AT `at`; the
 * profile makes it weaker toward the ground, as the live rounds find it.
 */
function setCrosswind(sim: Sim, kt: number, at: Vector3): void {
  sim.world.windVeer = 0;
  sim.world.surfaceWind.set(1, 0, 0);
  const f = windAt(sim.world, at, new Vector3()).x;
  sim.world.surfaceWind.set((kt * KT) / f, 0, 0);
}

/**
 * Start point p0 such that the gun solution's slant range is `range` at time `tMid` of the dive.
 */
function placeForSlantRange(sim: Sim, d: Dive, range: number, tMid = 0): Vector3 {
  const ground = sim.world.terrain.heightAt(0, 0);
  const p0 = new Vector3(0, ground + range * Math.sin((d.diveDeg + 2) * DEG), 0);
  for (let i = 0; i < 12; i++) {
    holdAt(sim, d, p0, tMid);
    stepFireControl(sim, SIM_DT);
    const g = sim.avionics.gun;
    if (!g.valid) throw new Error('no gun solution while placing the aircraft');
    const err = range - g.slantRange;
    if (Math.abs(err) < 0.05) break;
    // Move back along the line of sight to the impact.
    const los = new Vector3().subVectors(g.impact, sim.aircraft.position).normalize();
    p0.addScaledVector(los, -err);
  }
  return p0;
}

// ---------------------------------------------------------------------------------------------
// A live round flown the way stepProjectiles flies one (wind at the round, steps of SIM_DT, the
// first step partial from the muzzle time to the step end), independent of the avionics code.
// ---------------------------------------------------------------------------------------------

const _hit: TerrainHit = {
  point: new Vector3(),
  normal: new Vector3(),
  distance: 0,
  t: 0,
  surface: 'grass',
};

function flyLiveRound(
  sim: Sim,
  type: RoundType,
  pos: Vector3,
  vel: Vector3,
  fireTime: number,
  out: Vector3,
): boolean {
  const p = pos.clone();
  const v = vel.clone();
  const prev = new Vector3();
  const wind = new Vector3();
  const terrain = sim.world.terrain;
  let t = fireTime;
  for (let i = 0; i < 2000; i++) {
    const next = (Math.floor(t / SIM_DT + 1e-9) + 1) * SIM_DT;
    const h = next - t;
    windAt(sim.world, p, wind);
    prev.copy(p);
    integrateRound(type, p, v, wind, h, sim.world.isaDeviation);
    if (terrain.segmentHit(prev, p, _hit)) {
      out.copy(_hit.point);
      return true;
    }
    t = next;
  }
  return false;
}

/** The round's start from the contract: muzzle, gun line, muzzle velocity, aircraft velocity. */
function contractMuzzleState(sim: Sim, type: RoundType, pos: Vector3, vel: Vector3): void {
  const ac = sim.aircraft;
  const m = A10_GEOMETRY.muzzle;
  const d = GAU8.gunLineDepression;
  const mv = type === RoundType.HEI ? GAU8.muzzleVelocityHei : GAU8.muzzleVelocity;
  const r = new Vector3(m.x, m.y, m.z);
  pos.copy(r).applyQuaternion(ac.orientation).add(ac.position);
  const w = new Vector3().crossVectors(ac.angularVelocity, r);
  vel
    .set(0, -Math.sin(d) * mv, -Math.cos(d) * mv)
    .add(w)
    .applyQuaternion(ac.orientation)
    .add(ac.velocity);
}

/** HUD angles from the eye of a world point, for the aircraft's present state. */
function anglesOf(sim: Sim, p: Vector3): { az: number; el: number } {
  return hudAnglesOfPoint(sim.aircraft, p, { az: 0, el: 0 });
}

// ---------------------------------------------------------------------------------------------

describe('gun sight agreement (PLAN §16): 30° dive, 300 kn, 1,220 m, 10 kn crosswind', () => {
  const DIVE: Dive = { diveDeg: 30, tasKt: 300, aoaDeg: 2, headingDeg: 0 };

  it('rounds fired with integrateRound land on the pipper computed when each was fired', () => {
    const sim = gunSim(createFlatTerrain(250));
    const probe = new Vector3(0, 250 + 650, 0);
    setCrosswind(sim, 10, probe);
    const p0 = placeForSlantRange(sim, DIVE, 1220, 0.5);
    const pos = new Vector3();
    const vel = new Vector3();
    const impact = new Vector3();
    const errAz: number[] = [];
    const errEl: number[] = [];
    let sumAz = 0;
    let sumEl = 0;
    let mixAz = 0;
    let mixEl = 0;
    const n = 65; // one second at full rate
    for (let i = 0; i < n; i++) {
      const t = i / GAU8.rate;
      holdAt(sim, DIVE, p0, t);
      stepFireControl(sim, SIM_DT);
      const g = sim.avionics.gun;
      expect(g.valid).toBe(true);
      // The computer's own type (API) round: the computer's error alone.
      contractMuzzleState(sim, RoundType.API, pos, vel);
      expect(flyLiveRound(sim, RoundType.API, pos, vel, t, impact)).toBe(true);
      const a = anglesOf(sim, impact);
      errAz.push(a.az - g.pipperAz);
      errEl.push(a.el - g.pipperEl);
      sumAz += a.az - g.pipperAz;
      sumEl += a.el - g.pipperEl;
      // The belt's own round (5 API : 1 HEI) for the burst centre.
      const type = roundTypeAt('combatMix', i);
      contractMuzzleState(sim, type, pos, vel);
      expect(flyLiveRound(sim, type, pos, vel, t, impact)).toBe(true);
      const b = anglesOf(sim, impact);
      mixAz += b.az - g.pipperAz;
      mixEl += b.el - g.pipperEl;
    }
    const worst = Math.max(...errAz.map((a, k) => Math.hypot(a, errEl[k])));
    const centre = Math.hypot(sumAz / n, sumEl / n);
    const mixCentre = Math.hypot(mixAz / n, mixEl / n);
    console.log(
      `[firecontrol] gun sight (unit): per-round API error ≤ ${(worst / MRAD).toFixed(3)} mrad, ` +
        `API centre ${(centre / MRAD).toFixed(3)} mrad, combat-mix centre ${(mixCentre / MRAD).toFixed(3)} mrad ` +
        `(az ${(mixAz / n / MRAD).toFixed(3)}, el ${(mixEl / n / MRAD).toFixed(3)})`,
    );
    expect(worst).toBeLessThan(1.5 * MRAD);
    expect(centre).toBeLessThan(1.5 * MRAD);
    expect(mixCentre).toBeLessThan(1.5 * MRAD);
  });

  it('the centre of a burst from the gun lands within 1.5 mrad of the pipper (integration)', (ctx) => {
    // Integration: needs the weapons module's real stepGun / stepProjectiles.
    const sim = gunSim(createFlatTerrain(250), 'combatMix', 21);
    const probe = new Vector3(0, 250 + 650, 0);
    setCrosswind(sim, 10, probe);
    const burst = 1.0;
    const p0 = placeForSlantRange(sim, DIVE, 1220, burst / 2);
    const av = sim.avionics;
    av.masterArm = 'ARM';
    av.gunPac = 'ARM';
    sim.time = 0;
    holdAt(sim, DIVE, p0, 0);
    stepFireControl(sim, SIM_DT);
    const prevImpact = av.gun.impact.clone();
    const pipperSum = new Vector3();
    const impactSum = new Vector3();
    const eyeMid = new Vector3();
    let fired = 0;
    let impacts = 0;
    const steps = Math.round(3.5 / SIM_DT);
    for (let k = 0; k < steps; k++) {
      sim.input.trigger = k * SIM_DT < burst ? 2 : 0;
      const before = sim.gun.totalFired;
      holdAt(sim, DIVE, p0, (k + 1) * SIM_DT);
      stepGun(sim, SIM_DT);
      stepProjectiles(sim, SIM_DT);
      stepFireControl(sim, SIM_DT);
      sim.aircraft.externalForceBody.set(0, 0, 0);
      sim.aircraft.externalMomentBody.set(0, 0, 0);
      const n = sim.gun.totalFired - before;
      if (n > 0) {
        // Rounds of this step: the pipper between the step's start and end solutions.
        pipperSum.addScaledVector(prevImpact, n / 2).addScaledVector(av.gun.impact, n / 2);
        fired += n;
      }
      if (Math.abs((k + 1) * SIM_DT - burst / 2) < SIM_DT / 2) {
        const e = A10_GEOMETRY.eye;
        eyeMid.set(e.x, e.y, e.z).applyQuaternion(sim.aircraft.orientation);
        eyeMid.add(sim.aircraft.position);
      }
      prevImpact.copy(av.gun.impact);
      for (const e of sim.events) {
        if (e.type === 'roundImpact') {
          impactSum.x += e.position.x;
          impactSum.y += e.position.y;
          impactSum.z += e.position.z;
          impacts++;
        }
      }
      sim.events.length = 0;
      sim.time += SIM_DT;
      sim.stepCount++;
    }
    if (fired === 0) ctx.skip('the weapons module stepGun fired no rounds (stand-in)');
    expect(impacts).toBe(fired);
    const meanPipper = pipperSum.multiplyScalar(1 / fired);
    const meanImpact = impactSum.multiplyScalar(1 / impacts);
    const los = new Vector3().subVectors(meanPipper, eyeMid);
    const range = los.length();
    los.normalize();
    const miss = new Vector3().subVectors(meanImpact, meanPipper);
    miss.addScaledVector(los, -miss.dot(los));
    const err = miss.length() / range;
    console.log(
      `[firecontrol] gun sight (integration): ${fired} rounds, burst centre ${(err / MRAD).toFixed(3)} mrad from the pipper at ${range.toFixed(0)} m`,
    );
    expect(fired).toBeGreaterThan(40);
    expect(err).toBeLessThan(1.5 * MRAD);
  }, 60_000);
});

describe('predictor accuracy against the live-round integrator', () => {
  it('stays within 0.2 mrad of SIM_DT rounds at about 1,200 m (still air)', () => {
    for (const load of ['combatMix', 'allHEI'] as const) {
      for (const diveDeg of [10, 30, 45]) {
        const sim = gunSim(createFlatTerrain(0), load);
        sim.world.surfaceWind.set(0, 0, 0);
        const d: Dive = { diveDeg, tasKt: 300, aoaDeg: 2, headingDeg: 40 };
        placeForSlantRange(sim, d, 1220);
        const g = sim.avionics.gun;
        const type = g.roundType;
        const pos = new Vector3();
        const vel = new Vector3();
        const impact = new Vector3();
        contractMuzzleState(sim, type, pos, vel);
        // Fired at a step boundary: the live round's steps are all SIM_DT.
        expect(flyLiveRound(sim, type, pos, vel, 0, impact)).toBe(true);
        const a = anglesOf(sim, impact);
        const err = Math.hypot(a.az - g.pipperAz, a.el - g.pipperEl);
        expect(err).toBeLessThan(0.2 * MRAD);
        expect(Math.abs(g.slantRange - 1220)).toBeLessThan(1);
      }
    }
  });

  it('uses a coarser step only where it holds the tolerance (calibration)', () => {
    const shots: CalibrationShot[] = [];
    for (const diveDeg of [10, 20, 30, 45, 60]) {
      for (const base of [0, 800, 2000]) {
        const dive = diveDeg * DEG;
        const v = 300 * KT + GAU8.muzzleVelocity;
        shots.push({
          origin: { x: 0, y: base + 1220 * Math.sin(dive + 2 * DEG), z: 0 },
          velocity: { x: 0, y: -Math.sin(dive) * v, z: -Math.cos(dive) * v },
          wind: { x: 10 * KT, y: 0, z: 3 * KT },
          groundHeight: base,
        });
      }
    }
    for (const type of [RoundType.API, RoundType.HEI, RoundType.TP]) {
      const dt = gunPredictorStep(type);
      const err = stepError(roundModel(type), shots, dt, SIM_DT);
      console.log(
        `[firecontrol] predictor step for round type ${type}: 1/${(1 / dt).toFixed(0)} s, ` +
          `worst error vs SIM_DT over ${shots.length} shots ${(err / MRAD).toFixed(4)} mrad`,
      );
      expect(dt).toBeGreaterThanOrEqual(SIM_DT);
      expect(err).toBeLessThan(0.2 * MRAD);
    }
  });
});

describe('altitude source over sloping ground', () => {
  const DIVE: Dive = { diveDeg: 25, tasKt: 300, aoaDeg: 2, headingDeg: 0 };

  /** Ground rising (sign +1) or falling (−1) toward the north at 20 %, around z = 0. */
  function slope(sign: 1 | -1): Terrain {
    const data = { seed: 0, size: 64000, resolution: 0, heights: new Float32Array(0), extra: {} };
    const h = (_x: number, z: number) => Math.min(1200, Math.max(0, 600 - sign * 0.2 * z));
    return terrainFromHeightFunction(data, h, 0, 1200, 0.25);
  }

  /**
   * For each altitude source: the pipper's elevation error against a live round (rad, + = the
   * round lands ABOVE the pipper), and how far beyond the ground point under the pipper (where
   * the pilot would put a target) the round lands along the track (m, + = long).
   */
  function sourceErrors(sign: 1 | -1) {
    const terrain = slope(sign);
    const sim = gunSim(terrain);
    sim.world.surfaceWind.set(0, 0, 0);
    // Aircraft south of the slope's middle, diving north toward it.
    const p0 = new Vector3(0, terrain.heightAt(0, 1600) + 700, 1600);
    holdAt(sim, DIVE, p0, 0);
    // The steerpoint 800 m short of the impact area (lower on rising ground, higher on falling
    // ground): BARO assumes the target is at its elevation.
    sim.avionics.steerpoints.length = 0;
    sim.avionics.steerpoints.push({
      id: 1,
      name: 'TGT',
      position: new Vector3(0, terrain.heightAt(0, 900), 900),
    });
    sim.avionics.activeSteerpoint = 0;
    const el: Record<string, number> = {};
    const long: Record<string, number> = {};
    const pos = new Vector3();
    const vel = new Vector3();
    const impact = new Vector3();
    contractMuzzleState(sim, RoundType.API, pos, vel);
    expect(flyLiveRound(sim, RoundType.API, pos, vel, 0, impact)).toBe(true);
    const actual = anglesOf(sim, impact);
    const ac = sim.aircraft;
    const eye = new Vector3();
    const dir = new Vector3();
    const e = A10_GEOMETRY.eye;
    for (const src of ['DELTA', 'RADAR', 'BARO'] as const) {
      sim.avionics.altSource = src;
      stepFireControl(sim, SIM_DT);
      const g = sim.avionics.gun;
      expect(g.valid).toBe(true);
      expect(g.groundSource).toBe(src);
      el[src] = actual.el - g.pipperEl;
      // The ground under the pipper: the line of sight from the eye meets the real terrain.
      eye.set(e.x, e.y, e.z).applyQuaternion(ac.orientation).add(ac.position);
      bodyDirFromHudAngles(g.pipperAz, g.pipperEl, dir).applyQuaternion(ac.orientation);
      expect(terrain.raycast(eye, dir, 20000, _hit)).toBe(true);
      // Along the track (north = −z).
      long[src] = -(impact.z - _hit.point.z);
    }
    return { el, long };
  }

  it('DELTA is accurate; RADAR and BARO put the pipper too low over rising ground', () => {
    const { el, long } = sourceErrors(1);
    console.log(
      `[firecontrol] rising ground: pipper error DELTA ${(el.DELTA / MRAD).toFixed(3)}, RADAR ${(el.RADAR / MRAD).toFixed(2)}, BARO ${(el.BARO / MRAD).toFixed(2)} mrad; ` +
        `rounds land long by DELTA ${long.DELTA.toFixed(2)} m, RADAR ${long.RADAR.toFixed(1)} m, BARO ${long.BARO.toFixed(1)} m`,
    );
    expect(Math.abs(el.DELTA)).toBeLessThan(0.05 * MRAD);
    expect(Math.abs(long.DELTA)).toBeLessThan(0.5);
    // The assumed ground is too low: the computed impact is too far along the trajectory, so
    // the pipper is too low and the rounds land above it, beyond the target under it (long).
    // The 30 mm path is so flat at 1.3 s of flight that even a 240 m error (RADAR) moves the
    // impact only metres: the error is the extra gravity drop over the longer computed flight.
    expect(el.RADAR).toBeGreaterThan(1 * MRAD);
    expect(el.BARO).toBeGreaterThan(0.3 * MRAD);
    expect(long.RADAR).toBeGreaterThan(2);
    expect(long.BARO).toBeGreaterThan(0.5);
    // The radar measures the ground straight below, the lowest here, so it errs most.
    expect(el.RADAR).toBeGreaterThan(el.BARO);
  });

  it('…and too high over falling ground (the rounds land below the pipper, short)', () => {
    const { el, long } = sourceErrors(-1);
    console.log(
      `[firecontrol] falling ground: pipper error DELTA ${(el.DELTA / MRAD).toFixed(3)}, RADAR ${(el.RADAR / MRAD).toFixed(2)}, BARO ${(el.BARO / MRAD).toFixed(2)} mrad; ` +
        `long by DELTA ${long.DELTA.toFixed(2)} m, RADAR ${long.RADAR.toFixed(1)} m, BARO ${long.BARO.toFixed(1)} m`,
    );
    expect(Math.abs(el.DELTA)).toBeLessThan(0.05 * MRAD);
    expect(Math.abs(long.DELTA)).toBeLessThan(0.5);
    expect(el.RADAR).toBeLessThan(-1 * MRAD);
    expect(el.BARO).toBeLessThan(-0.3 * MRAD);
    expect(long.RADAR).toBeLessThan(-2);
    expect(long.BARO).toBeLessThan(-0.5);
  });

  it('RADAR has no data above the radar altimeter range; BARO needs a steerpoint', () => {
    const sim = gunSim(createFlatTerrain(0));
    sim.world.surfaceWind.set(0, 0, 0);
    const d: Dive = { diveDeg: 30, tasKt: 300, aoaDeg: 2, headingDeg: 0 };
    holdAt(sim, d, new Vector3(0, FIRE_CONTROL.radarAltimeterMax + 300, 0), 0);
    sim.avionics.altSource = 'RADAR';
    stepFireControl(sim, SIM_DT);
    expect(sim.avionics.gun.groundValid).toBe(false);
    expect(sim.avionics.gun.valid).toBe(false);
    holdAt(sim, d, new Vector3(0, FIRE_CONTROL.radarAltimeterMax - 300, 0), 0);
    stepFireControl(sim, SIM_DT);
    expect(sim.avionics.gun.groundValid).toBe(true);
    expect(sim.avionics.gun.valid).toBe(true);
    expect(sim.avionics.gun.groundPlane).toBeCloseTo(0, 6);

    sim.avionics.altSource = 'BARO';
    stepFireControl(sim, SIM_DT);
    expect(sim.avionics.gun.valid).toBe(true);
    expect(sim.avionics.gun.groundPlane).toBeCloseTo(sim.avionics.steerpoints[0].position.y, 6);
    sim.avionics.steerpoints.length = 0;
    stepFireControl(sim, SIM_DT);
    expect(sim.avionics.gun.groundValid).toBe(false);
    expect(sim.avionics.gun.valid).toBe(false);
  });
});

describe('gun solution', () => {
  const DIVE: Dive = { diveDeg: 30, tasKt: 300, aoaDeg: 2, headingDeg: 0 };

  it('flags inside the minimum range and beyond the range bar, with the same numbers it exports', () => {
    const sim = gunSim(createFlatTerrain(0));
    const g = sim.avionics.gun;
    expect(FIRE_CONTROL.gunMinRange).toBeCloseTo(2000 * FT, 6);
    expect(FIRE_CONTROL.gunMaxRange).toBeCloseTo(12000 * FT, 6);
    const shallow: Dive = { diveDeg: 6, tasKt: 300, aoaDeg: 2, headingDeg: 0 };
    for (const [d, range, close, far] of [
      [DIVE, 450, true, false],
      [DIVE, 700, false, false],
      [DIVE, 3000, false, false],
      [shallow, 4200, false, true],
    ] as const) {
      placeForSlantRange(sim, d, range);
      expect(g.valid).toBe(true);
      expect(g.minRange).toBe(FIRE_CONTROL.gunMinRange);
      expect(g.maxRange).toBe(FIRE_CONTROL.gunMaxRange);
      expect(g.tooClose).toBe(close);
      expect(g.tooFar).toBe(far);
    }
  });

  it('measures the pipper from the eye, not the centre of gravity', () => {
    const sim = gunSim(createFlatTerrain(0));
    sim.world.surfaceWind.set(0, 0, 0);
    placeForSlantRange(sim, DIVE, 600);
    const g = sim.avionics.gun;
    const ac = sim.aircraft;
    const fromEye = anglesOf(sim, g.impact);
    expect(g.pipperAz).toBeCloseTo(fromEye.az, 12);
    expect(g.pipperEl).toBeCloseTo(fromEye.el, 12);
    const fromCg = hudAnglesFromBodyDir(
      worldToBody(ac.orientation, new Vector3().subVectors(g.impact, ac.position), new Vector3()),
      { az: 0, el: 0 },
    );
    const parallax = Math.abs(fromCg.el - g.pipperEl);
    // The eye sits 1.2 m above and 4.45 m ahead of the CG: ≈1–2 mrad at 600 m.
    expect(parallax).toBeGreaterThan(0.8 * MRAD);
    expect(parallax).toBeLessThan(3 * MRAD);
  });

  it('puts the gun cross on the gun line and has no solution in level flight at altitude', () => {
    const sim = gunSim(createFlatTerrain(0));
    const g = sim.avionics.gun;
    holdAt(sim, { diveDeg: 0, tasKt: 280, aoaDeg: 3, headingDeg: 90 }, new Vector3(0, 2400, 0), 0);
    stepFireControl(sim, SIM_DT);
    expect(g.gunLineAz).toBe(0);
    expect(g.gunLineEl).toBeCloseTo(-GAU8.gunLineDepression, 12);
    expect(g.valid).toBe(false);
    expect(g.tooClose).toBe(false);
    expect(g.tooFar).toBe(false);
  });

  it('is deterministic and follows the loaded ammunition', () => {
    const a = gunSim(createFlatTerrain(0));
    const b = gunSim(createFlatTerrain(0));
    for (const s of [a, b]) placeForSlantRange(s, DIVE, 1220);
    expect(a.avionics.gun.impact.equals(b.avionics.gun.impact)).toBe(true);
    expect(a.avionics.gun.roundType).toBe(RoundType.API);
    const hei = gunSim(createFlatTerrain(0), 'allHEI');
    placeForSlantRange(hei, DIVE, 1220);
    expect(hei.avionics.gun.roundType).toBe(RoundType.HEI);
  });

  it('costs well under 0.15 ms per step (flat and generated terrain, dive and no solution)', () => {
    const results: string[] = [];
    const worlds: Array<[string, Terrain]> = [
      ['flat', createFlatTerrain(300)],
      ['generated', createTerrain(generateTerrainData(1))],
    ];
    for (const [name, terrain] of worlds) {
      const sim = gunSim(terrain);
      const ac = sim.aircraft;
      const x = ac.position.x;
      const z = ac.position.z;
      const base = terrain.heightAt(x, z);
      for (const [label, d, agl] of [
        ['30° dive', DIVE, 650],
        ['5° pass', { diveDeg: 5, tasKt: 300, aoaDeg: 2, headingDeg: 0 }, 300],
        ['level (none)', { diveDeg: 0, tasKt: 280, aoaDeg: 3, headingDeg: 0 }, 2400],
      ] as const) {
        const p0 = new Vector3(x, base + agl, z);
        for (const src of ['DELTA', 'RADAR'] as const) {
          sim.avionics.altSource = src;
          let best = Infinity;
          for (let batch = 0; batch < 6; batch++) {
            const t0 = performance.now();
            for (let i = 0; i < 150; i++) {
              holdAt(sim, d, p0, i * SIM_DT);
              stepFireControl(sim, SIM_DT);
            }
            best = Math.min(best, (performance.now() - t0) / 150);
          }
          results.push(`${name} ${label} ${src}: ${(best * 1000).toFixed(1)} µs`);
          expect(best).toBeLessThan(0.15);
        }
      }
    }
    console.log(`[firecontrol] stepFireControl cost (best batch mean): ${results.join('; ')}`);
  }, 120_000);
});

describe('store fire control (structure)', () => {
  /** A drag-free test store: the predictor must reproduce the closed-form fall. */
  const vacuum: StoreBallistics = {
    ejection: { x: 0, y: -1.5, z: 0 },
    integrate(p, v, _w, dt) {
      p.x += v.x * dt;
      p.y += v.y * dt - 0.5 * G0 * dt * dt;
      p.z += v.z * dt;
      v.y -= G0 * dt;
    },
  };

  it('predictStoreImpact flies a store model to the ground model', () => {
    const sim = gunSim(createFlatTerrain(100));
    const ground = updateFireControlGround(sim, 'DELTA', createFireControlGround());
    const out = createImpactPrediction();
    const o = new Vector3(0, 1600, 0);
    const v = new Vector3(0, -40, -130);
    expect(predictStoreImpact(vacuum, o, v, new Vector3(), ground, out)).toBe(true);
    // 1500 = 40 t + g t² / 2
    const t = (-40 + Math.sqrt(40 * 40 + 2 * G0 * 1500)) / G0;
    // Exact to the chord interpolation inside the last step (well under a millimetre).
    expect(out.time).toBeCloseTo(t, 5);
    expect(out.point.y).toBeCloseTo(100, 6);
    expect(out.point.z).toBeCloseTo(-130 * t, 3);
  });

  it('the release solution stays invalid until the store has a model, then follows it', () => {
    const terrain = createFlatTerrain(0);
    const sim = createSim({ terrain, scenario: 'empty', loadoutId: 'rangeTraining', seed: 4 });
    const av = sim.avionics;
    holdAt(sim, { diveDeg: 30, tasKt: 300, aoaDeg: 2, headingDeg: 0 }, new Vector3(0, 1500, 0), 0);
    stepFireControl(sim, SIM_DT);
    const mk82 = av.profiles.find((p) => p.store === 'MK-82');
    expect(mk82).toBeDefined();
    av.selectedProfile = mk82!.id;
    av.masterMode = 'CCIP';
    stepFireControl(sim, SIM_DT);
    expect(av.sight).toBe('CCIP');
    expect(av.release.valid).toBe(false);
    expect(av.ccipInvalid).toBe(true);
    registerStoreBallistics('MK-82', vacuum);
    try {
      stepFireControl(sim, SIM_DT);
      const rel = av.release;
      expect(rel.valid).toBe(true);
      expect(av.ccipInvalid).toBe(false);
      expect(rel.impact.y).toBeCloseTo(0, 6);
      expect(rel.timeOfFall).toBeGreaterThan(5);
      const a = anglesOf(sim, rel.impact);
      expect(rel.az).toBeCloseTo(a.az, 12);
      expect(rel.el).toBeCloseTo(a.el, 12);
      // A 30° dive at 300 kn puts the bomb's impact far below the HUD glass.
      expect(rel.belowGlass).toBe(true);
      // 1,500 m above the target is above the profile's minimum altitude.
      expect(rel.belowMinimum).toBe(false);
      holdAt(sim, { diveDeg: 30, tasKt: 300, aoaDeg: 2, headingDeg: 0 }, new Vector3(0, 300, 0), 0);
      stepFireControl(sim, SIM_DT);
      expect(av.release.belowMinimum).toBe(true);
    } finally {
      registerStoreBallistics('MK-82', null);
    }
    stepFireControl(sim, SIM_DT);
    expect(av.release.valid).toBe(false);
  });
});
