/**
 * The CCIP gun sight (PLAN_A10.md §6.2 "The sight", §16 gun-sight row). Every step the computer
 * flies one round fired NOW with the weapons module's own `integrateRound` (the function that
 * moves the live rounds) and places the pipper on its predicted impact:
 *
 *  - initial state: the gun's own `muzzleState` (weapons module) — the muzzle
 *    (A10_GEOMETRY.muzzle) on a gun line GAU8.gunLineDepression below the body −Z axis, velocity
 *    = the round type's muzzle velocity along the gun line + the aircraft's velocity + ω × r (the
 *    muzzle swings with the airframe): exactly what a live round starts with, minus the random
 *    dispersion;
 *  - the integration step: calibrated once per round type (predict.ts, `calibrateStep`) as the
 *    coarsest step that stays within FIRE_CONTROL.predictorTolerance of the live rounds' step;
 *  - what the real computer knows: the wind measured AT THE AIRCRAFT (held constant along the
 *    whole flight, while live rounds meet the wind where they are), and the ground model of the
 *    altitude-source switch (ground.ts);
 *  - ballistics of the loaded ammunition (combat mix: API, five rounds in six);
 *  - the pipper is the impact's direction from the pilot's EYE (collimated: direction only), the
 *    same way PAC measures it (core/flight/pac.ts);
 *  - minimum and maximum range from data (FIRE_CONTROL): the HUD's cue and range bar read the
 *    same numbers from the solution.
 *
 * Later sights are small additions on the same pieces: a fixed-range reticle is the same flight
 * stopped at a slant range instead of at the ground; a lead-computing cross adds the target's
 * motion over the time of flight; the manual pipper is a fixed depression.
 */
import { Vector3 } from 'three';
import { A10_GEOMETRY } from '../../data/geometry';
import { GAU8 } from '../../data/gun';
import { SIM_DT } from '../constants';
import type { AircraftState } from '../flight/types';
import { hudAnglesFromBodyDir, worldToBody } from '../frames';
import type { Sim } from '../types';
import { DEG, KT } from '../units';
import { integrateRound, muzzleState, muzzleVelocity } from '../weapons';
import { RoundType, type AmmoLoad } from '../weapons/types';
import { windAt } from '../world';
import { FIRE_CONTROL } from './data';
import type { FireControlGround } from './ground';
import {
  calibrateStep,
  createImpactPrediction,
  predictImpact,
  predictorStats,
  type BallisticModel,
  type CalibrationShot,
} from './predict';
import type { GunSolution } from './types';

/** The ballistics the computer is set for: the loaded ammunition (DSMS gun page). */
export function sightRoundType(load: AmmoLoad): RoundType {
  switch (load) {
    case 'allHEI':
      return RoundType.HEI;
    case 'targetPractice':
      return RoundType.TP;
    default:
      // Combat mix (5 API : 1 HEI) and all-API: the API ballistics.
      return RoundType.API;
  }
}

/** A round type's ballistics as the computer flies them: the weapons module's integrator. */
export interface RoundModel extends BallisticModel {
  readonly type: RoundType;
  /** ISA temperature deviation the computer uses (measured air data), K. */
  isaDeviation: number;
}

const models: RoundModel[] = [];

/** The weapons module's round integrator as a ballistic model, per round type. */
export function roundModel(type: RoundType): RoundModel {
  let m = models[type];
  if (!m) {
    m = {
      type,
      isaDeviation: 0,
      integrate(p, v, w, dt) {
        integrateRound(this.type, p, v, w, dt, this.isaDeviation);
      },
    };
    models[type] = m;
  }
  return m;
}

/**
 * Reference shots for the step calibration: 300 kn dives of 10°, 30° and 45° at about 1,220 m
 * slant range over ground at 0, 300 and 1,500 m, and a 5° pass at about 3,000 m, all in a 10 kn
 * crosswind, with the round type's muzzle velocity.
 */
function gunCalibrationShots(type: RoundType): CalibrationShot[] {
  const shots: CalibrationShot[] = [];
  const v = 300 * KT + muzzleVelocity(type);
  for (const [diveDeg, base, range] of [
    [10, 0, 1220],
    [30, 300, 1220],
    [45, 1500, 1220],
    [5, 0, 3000],
  ]) {
    const dive = diveDeg * DEG;
    const height = range * Math.sin(dive + 2 * DEG);
    shots.push({
      origin: { x: 0, y: base + height, z: 0 },
      velocity: { x: 0, y: -Math.sin(dive) * v, z: -Math.cos(dive) * v },
      wind: { x: 10 * KT, y: 0, z: 0 },
      groundHeight: base,
    });
  }
  return shots;
}

const steps: number[] = [];

/**
 * The predictor step for a round type: the coarsest step that stays within
 * FIRE_CONTROL.predictorTolerance of the live rounds' SIM_DT integration (measured once).
 */
export function gunPredictorStep(type: RoundType): number {
  let dt = steps[type];
  if (dt === undefined) {
    dt = calibrateStep(roundModel(type), gunCalibrationShots(type), SIM_DT);
    steps[type] = dt;
  }
  return dt;
}

/** The pilot's design eye point in the world. */
export function eyeWorld(ac: AircraftState, out: Vector3): Vector3 {
  const e = A10_GEOMETRY.eye;
  return out.set(e.x, e.y, e.z).applyQuaternion(ac.orientation).add(ac.position);
}

const _eye = new Vector3();
const _dir = new Vector3();
const _angles = { az: 0, el: 0 };

/** HUD angles (from the eye, rad) of a world point. */
export function hudAnglesOfPoint(
  ac: AircraftState,
  point: Vector3,
  out: { az: number; el: number },
): { az: number; el: number } {
  eyeWorld(ac, _eye);
  worldToBody(ac.orientation, _dir.subVectors(point, _eye), _dir);
  return hudAnglesFromBodyDir(_dir, out);
}

export function createGunSolution(): GunSolution {
  return {
    valid: false,
    impact: new Vector3(),
    pipperAz: 0,
    pipperEl: 0,
    slantRange: 0,
    timeOfFlight: 0,
    tooClose: false,
    tooFar: false,
    minRange: FIRE_CONTROL.gunMinRange,
    maxRange: FIRE_CONTROL.gunMaxRange,
    gunLineAz: 0,
    gunLineEl: -GAU8.gunLineDepression,
    groundSource: 'DELTA',
    groundPlane: NaN,
    groundValid: false,
    roundType: RoundType.API,
    impactSpeed: 0,
  };
}

const _origin = new Vector3();
const _vel = new Vector3();
const _wind = new Vector3();
const _pred = createImpactPrediction();

/** Compute `sim.avionics.gun` for a round fired now against `ground`. Allocation-free. */
export function computeGunSolution(sim: Sim, ground: FireControlGround): void {
  const ac = sim.aircraft;
  const av = sim.avionics;
  const g = av.gun;
  const type = sightRoundType(sim.gun.load);
  g.roundType = type;
  g.groundSource = ground.source;
  g.groundPlane = ground.terrain ? NaN : ground.plane;
  g.groundValid = ground.valid;
  g.minRange = FIRE_CONTROL.gunMinRange;
  g.maxRange = FIRE_CONTROL.gunMaxRange;
  // The gun cross: the gun line is a body direction, so collimated it sits at a fixed angle.
  g.gunLineAz = 0;
  g.gunLineEl = -GAU8.gunLineDepression;

  // The round leaves exactly as a live round would (the gun's own initial state, undispersed).
  muzzleState(ac, type, _origin, _vel);
  windAt(sim.world, ac.position, _wind);
  const model = roundModel(type);
  model.isaDeviation = sim.world.isaDeviation;
  const ok = predictImpact(
    model,
    _origin,
    _vel,
    _wind,
    ground,
    FIRE_CONTROL.gunMaxTimeOfFlight,
    gunPredictorStep(type),
    _pred,
  );
  av.fc.steps = predictorStats.steps;
  av.fc.groundTests = predictorStats.groundTests;
  g.valid = ok;
  if (!ok) {
    g.tooClose = false;
    g.tooFar = false;
    g.impactSpeed = 0;
    av.fc.prevTimeOfFlight = 0;
    return;
  }
  g.impact.copy(_pred.point);
  g.timeOfFlight = _pred.time;
  g.impactSpeed = _pred.velocity.length();
  g.slantRange = g.impact.distanceTo(ac.position);
  hudAnglesOfPoint(ac, g.impact, _angles);
  g.pipperAz = _angles.az;
  g.pipperEl = _angles.el;
  g.tooClose = g.slantRange < g.minRange;
  g.tooFar = g.slantRange > g.maxRange;
  av.fc.prevTimeOfFlight = g.timeOfFlight;
}
