/**
 * The GAU-8/A in the aircraft (PLAN_A10.md §6.2): fire permission, barrel spin, rounds leaving at
 * their exact times, dispersion, recoil, burst bookkeeping and events.
 *
 * Spin. A hydraulic drive turns the seven barrels. With the fire command on, the barrel speed
 * (`spin`, a fraction of the full 65 rounds/s) ramps linearly to 1 in GAU8.spinUpTime, so the
 * rounds in the first second are 65 · (1 − spinUpTime/2) = 50; released, it ramps to 0 in
 * GAU8.spinDownTime while the clearing cycle returns the unfired rounds to the drum.
 *
 * Exact emission (docs/a10/ARCHITECTURE.md §5). The barrels' cycle count is the integral of the
 * rate, phase(τ) = phase0 + R·∫spin dτ, which is piecewise quadratic in τ over a step. A round
 * leaves each time it crosses a whole cycle while the command is on; that instant is solved in
 * closed form. The aircraft's pose at that instant is interpolated between the start of the
 * flight step (`prev*`) and its end: cubic Hermite for the position, linear for the velocity,
 * slerp for the orientation. The round starts at the muzzle (A10_GEOMETRY.muzzle) with
 *     v = muzzle velocity · (dispersed gun line) + v_aircraft + ω × r_muzzle,
 * where the gun line is depressed GAU8.gunLineDepression below body −Z in the x = 0 plane and
 * the dispersion is a circular normal with σ = 2.5 mrad / √(2 ln 5) per axis (80 % of rounds
 * inside the 5 mrad circle), drawn from sim.rng.gun. stepProjectiles flies each new round for
 * the rest of the step.
 *
 * Recoil. Each round's impulse is GAU8.recoilForce / 65 s⁻¹, delivered as a force proportional
 * to the instantaneous firing rate (the gun's recoil adapters smooth the 65 Hz pulses): the
 * step's force is impulse × (cycles fired this step) / dt along the gun line toward the tail,
 * acting through the muzzle. It is ADDED to aircraft.externalForceBody, with its moment about
 * the centre of gravity to externalMomentBody, for the next flight step.
 */
import { Quaternion, Vector3 } from 'three';
import { A10_GEOMETRY } from '../../data/geometry';
import { GAU8 } from '../../data/gun';
import type { BurstRecord, ReleaseConditions } from '../debrief/types';
import type { AircraftState } from '../flight/types';
import type { Sim } from '../types';
import { muzzleVelocity } from './ballistics';
import { allocRound } from './pool';
import { interpolatePose } from './pose';
import { RoundType, type AmmoLoad, type GunState } from './types';

/** Full rate, rounds per second. */
const RATE = GAU8.rate;
/** Recoil impulse of one round, N·s. */
export const RECOIL_IMPULSE = GAU8.recoilForce / GAU8.rate;
/** Dispersion per axis, rad: 80 % of a circular normal lies inside 2.5 mrad of the centre. */
export const DISPERSION_SIGMA = GAU8.dispersion80Diameter / 2 / Math.sqrt(2 * Math.log(5));
/** Barrel-cluster rotation per round, rad. */
const CYCLE_ANGLE = (2 * Math.PI) / GAU8.barrels;
const TWO_PI = 2 * Math.PI;
const SIN_D = Math.sin(GAU8.gunLineDepression);
const COS_D = Math.cos(GAU8.gunLineDepression);

function emptyConditions(): ReleaseConditions {
  return { time: 0, dive: 0, speed: 0, agl: 0, slantRange: 0, gLoad: 1, bank: 0 };
}

export function createGunState(
  load: AmmoLoad = 'combatMix',
  rounds: number = GAU8.typicalLoad,
): GunState {
  return {
    rounds,
    roundsLoaded: rounds,
    load,
    beltIndex: 0,
    spin: 0,
    barrelAngle: 0,
    rate: 0,
    firing: false,
    // The bolt of the next barrel is half a cycle from the firing position.
    phase: 0.5,
    burstStart: -1,
    burstRounds: 0,
    totalFired: 0,
    recoil: 0,
    dispersionScale: 1,
    burstNumber: 0,
    lastRoundTime: -1,
    commanded: false,
    commandTime: -1,
    burstHits: 0,
    openFireRange: 0,
    burstConditions: emptyConditions(),
    dropped: 0,
  };
}

/** Type of the n-th round of a belt load. Combat mix: 5 API then 1 HEI, repeating. */
export function roundTypeAt(load: AmmoLoad, n: number): RoundType {
  switch (load) {
    case 'allHEI':
      return RoundType.HEI;
    case 'allAPI':
      return RoundType.API;
    case 'targetPractice':
      return RoundType.TP;
    default:
      return n % (GAU8.combatMixApiPerHei + 1) === GAU8.combatMixApiPerHei
        ? RoundType.HEI
        : RoundType.API;
  }
}

/** Unit gun line in body coordinates: GAU8.gunLineDepression below −Z, in the x = 0 plane. */
export function gunLineBody(out: Vector3): Vector3 {
  return out.set(0, -SIN_D, -COS_D);
}

const _r = new Vector3();
const _w = new Vector3();

/**
 * Where an undispersed round of `type` fired at the aircraft's present state starts: the muzzle
 * (world) and its world velocity (muzzle velocity along the gun line + aircraft velocity +
 * ω × r_muzzle). For the fire-control computer, so its predictions start like the live rounds.
 */
export function muzzleState(
  ac: AircraftState,
  type: RoundType,
  outPosition: Vector3,
  outVelocity: Vector3,
): void {
  const m = A10_GEOMETRY.muzzle;
  _r.set(m.x, m.y, m.z);
  outPosition.copy(_r).applyQuaternion(ac.orientation).add(ac.position);
  _w.crossVectors(ac.angularVelocity, _r);
  gunLineBody(outVelocity).multiplyScalar(muzzleVelocity(type)).add(_w);
  outVelocity.applyQuaternion(ac.orientation).add(ac.velocity);
}

// ---- the step ---------------------------------------------------------------------------------

const _pos = new Vector3();
const _vel = new Vector3();
const _q = new Quaternion();
const _d = new Vector3();
const _rv = new Vector3();
const _force = new Vector3();
const _moment = new Vector3();

/** Time τ ∈ [0, ∞) at which R·(s·τ + ½·k·τ²) reaches x (> 0), for s ≥ 0, k ≥ 0. */
function crossingTime(x: number, s: number, k: number): number {
  const c = x / RATE;
  if (k === 0) return c / s;
  // Stable root of ½kτ² + sτ − c = 0.
  return (2 * c) / (s + Math.sqrt(s * s + 2 * k * c));
}

/**
 * Gun mechanics for one step: fire permission, spin, rounds at exact times between the previous
 * and the new aircraft state, recoil for the next flight step, bursts, events.
 */
export function stepGun(sim: Sim, dt: number): void {
  const gun = sim.gun;
  const ac = sim.aircraft;
  const av = sim.avionics;
  const realism = sim.options.realism;
  const unlimited = realism.unlimitedAmmo;
  const t0 = sim.time;

  // Fire permission (docs/a10/ARCHITECTURE.md §4): second detent (or any press with a
  // one-stage trigger), Master Arm ARM, GUN/PAC armed, rounds left (or unlimited), in one piece.
  const trigger = sim.input.trigger;
  const pressed = realism.twoStageTrigger ? trigger === 2 : trigger >= 1;
  const commanded =
    pressed &&
    av.masterArm === 'ARM' &&
    av.gunPac !== 'SAFE' &&
    (gun.rounds > 0 || unlimited) &&
    !ac.crashed;
  if (commanded && !gun.commanded) gun.commandTime = t0;
  if (!commanded && gun.commanded) {
    endBurst(sim, t0);
    gun.commandTime = -1;
  }
  gun.commanded = commanded;

  // Spin and barrel cycles over the step, in at most two segments: a linear ramp toward the
  // target speed, then constant speed. In each, the cycles advance R·(s·τ + ½·k·τ²).
  const target = commanded ? 1 : 0;
  const slope = commanded ? 1 / GAU8.spinUpTime : -1 / GAU8.spinDownTime;
  let s = gun.spin;
  let tau = 0;
  let cycles = 0;
  let firedCycles = 0;
  let canFire = commanded;
  for (let segment = 0; segment < 2 && tau < dt; segment++) {
    const k = s === target ? 0 : slope;
    const end = k === 0 ? dt : Math.min(dt, tau + (target - s) / k);
    const len = end - tau;
    const advance = RATE * (s * len + 0.5 * k * len * len);
    let used = 0;
    if (canFire) {
      // A round leaves each time the barrels complete a cycle while the command is on.
      while (used + (1 - gun.phase) <= advance) {
        used += 1 - gun.phase;
        gun.phase = 0;
        const tc = tau + crossingTime(used, s, k);
        fireRound(sim, tc / dt, t0 + tc, dt);
        if (!(gun.rounds > 0 || unlimited)) {
          canFire = false;
          break;
        }
      }
      firedCycles += canFire ? advance : used;
    }
    gun.phase += advance - used;
    gun.phase -= Math.floor(gun.phase);
    cycles += advance;
    // The ramp stops exactly at the target speed.
    if (k > 0) s = Math.min(target, s + k * len);
    else if (k < 0) s = Math.max(target, s + k * len);
    tau = end;
  }
  gun.spin = s;
  gun.rate = RATE * s;
  gun.barrelAngle = (gun.barrelAngle + CYCLE_ANGLE * cycles) % TWO_PI;
  gun.firing = commanded && canFire && gun.burstStart >= 0;

  // Recoil: rate-proportional force along the gun line toward the tail, through the muzzle.
  const force = (RECOIL_IMPULSE * firedCycles) / dt;
  gun.recoil = force;
  if (force > 0) {
    gunLineBody(_force).multiplyScalar(-force);
    const m = A10_GEOMETRY.muzzle;
    _r.set(m.x, m.y, m.z).sub(ac.cgBody);
    _moment.crossVectors(_r, _force);
    ac.externalForceBody.add(_force);
    ac.externalMomentBody.add(_moment);
  }
}

/** One round leaves at fraction `f` of the step of length dt (sim time t). */
function fireRound(sim: Sim, f: number, t: number, dt: number): void {
  const gun = sim.gun;
  const ac = sim.aircraft;
  const type = roundTypeAt(gun.load, gun.beltIndex);
  gun.beltIndex++;
  if (!sim.options.realism.unlimitedAmmo) gun.rounds--;
  gun.totalFired++;
  if (gun.burstStart < 0) openBurst(sim, t);
  gun.burstRounds++;
  gun.lastRoundTime = t;

  // The aircraft at that instant.
  interpolatePose(ac, f, dt, _pos, _vel, _q);

  // Dispersed gun line (body): small angles about the two axes across it.
  const scale = DISPERSION_SIGMA * gun.dispersionScale;
  const ex = sim.rng.gun.normal() * scale;
  const ey = sim.rng.gun.normal() * scale;
  // gun line d = (0, −sin δ, −cos δ); across it: +X, and up = (0, cos δ, −sin δ).
  _d.set(ex, -SIN_D + ey * COS_D, -COS_D - ey * SIN_D).normalize();

  const m = A10_GEOMETRY.muzzle;
  _r.set(m.x, m.y, m.z);
  _rv.crossVectors(ac.angularVelocity, _r);
  _d.multiplyScalar(muzzleVelocity(type)).add(_rv).applyQuaternion(_q).add(_vel);
  _r.applyQuaternion(_q).add(_pos);

  const pool = sim.projectiles.rounds;
  const i = allocRound(pool);
  if (i < 0) {
    gun.dropped++;
    return;
  }
  pool.type[i] = type;
  pool.px[i] = _r.x;
  pool.py[i] = _r.y;
  pool.pz[i] = _r.z;
  pool.vx[i] = _d.x;
  pool.vy[i] = _d.y;
  pool.vz[i] = _d.z;
  pool.fireTime[i] = t;
  pool.burst[i] = gun.burstNumber;
}

/** The first round of a burst left at sim time t. */
function openBurst(sim: Sim, t: number): void {
  const gun = sim.gun;
  const ac = sim.aircraft;
  const sol = sim.avionics.gun;
  gun.burstNumber++;
  gun.burstStart = t;
  gun.burstRounds = 0;
  gun.burstHits = 0;
  gun.openFireRange = sol.valid ? sol.slantRange : 0;
  const c = gun.burstConditions;
  c.time = t;
  c.dive = -ac.flightPathAngle;
  c.speed = ac.tas;
  c.agl = ac.agl;
  c.slantRange = gun.openFireRange;
  c.gLoad = ac.gLoad;
  c.bank = ac.bank;
  sim.events.push({ type: 'gunStart', t });
}

/**
 * Close the open burst (the fire command ended at sim time `tCease`): gunStop at the exact time
 * of its last round, and a BurstRecord for the debrief. Rounds still in flight add their hits
 * to the record when they land (stepProjectiles).
 */
export function endBurst(sim: Sim, tCease: number): void {
  const gun = sim.gun;
  gun.firing = false;
  if (gun.burstStart < 0) return;
  const sol = sim.avionics.gun;
  sim.events.push({
    type: 'gunStop',
    t: gun.lastRoundTime,
    rounds: gun.burstRounds,
    duration: gun.lastRoundTime - gun.burstStart,
  });
  const c = gun.burstConditions;
  const record: BurstRecord = {
    burst: gun.burstNumber,
    start: { ...c },
    duration: Math.max(0, tCease - (gun.commandTime >= 0 ? gun.commandTime : gun.burstStart)),
    rounds: gun.burstRounds,
    hits: gun.burstHits,
    openFireRange: gun.openFireRange,
    ceaseFireRange: sol.valid ? sol.slantRange : 0,
  };
  sim.debrief.bursts.push(record);
  gun.burstStart = -1;
  gun.burstHits = 0;
}

/** Count a vehicle hit for the burst a round belongs to (once per round). */
export function countBurstHit(sim: Sim, burst: number): void {
  const gun = sim.gun;
  if (gun.burstStart >= 0 && burst === gun.burstNumber) {
    gun.burstHits++;
    return;
  }
  const records = sim.debrief.bursts;
  for (let k = records.length - 1; k >= 0; k--) {
    if (records[k].burst === burst) {
      records[k].hits++;
      return;
    }
  }
}
