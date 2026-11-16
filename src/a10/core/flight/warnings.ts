/**
 * stepWarnings (docs/a10/ARCHITECTURE.md §3, step 10; PLAN §5, §13). Sets aircraft.warnings and
 * emits a 'warning' event whenever one changes.
 *
 *  stall          steady tone: angle of attack within a few degrees of the stall angle of the
 *                 present configuration (flaps, Mach; slats taken as out, they deploy anyway)
 *  stallChopped   chopped tone: at or beyond the stall
 *  overG          normal load factor beyond the limit for the present load (+7.33 / −3 g clean,
 *                 less with heavy stores)
 *  altitude       below the altitude alert (radar height) while descending
 *  pullUp         ground-collision prediction (also the HUD break-X): a maximum-performance
 *                 recovery started after a reaction allowance — roll wings level, then pull at
 *                 the g the aircraft can give — would bottom out too close to the terrain ahead
 *  overspeed      above Vne (indicated); the airframe buffets
 *  lowFuel        internal fuel low
 *  masterCaution  any caution (low fuel) is lit
 */
import { Vector3 } from 'three';
import { A10, A10_WARNINGS as W } from '../../data/aircraft';
import { G0 } from '../constants';
import type { Sim } from '../types';
import { temperatureAt } from '../world';
import type { TerrainHit } from '../world/types';
import { airViscosity, maxStaticLift, stallAlphaFor } from './aero';
import type { WarningId } from './types';

const DEG = Math.PI / 180;
/** Tallest tree canopy the prediction allows for, m. */
const MAX_CANOPY = 40;
const WARNING_IDS: readonly WarningId[] = [
  'stall',
  'stallChopped',
  'overG',
  'altitude',
  'pullUp',
  'overspeed',
  'lowFuel',
  'masterCaution',
];

function set(sim: Sim, id: WarningId, on: boolean): void {
  const w = sim.aircraft.warnings;
  if (w[id] === on) return;
  w[id] = on;
  sim.events.push({ type: 'warning', t: sim.time, warning: id, on });
}

const _dir = new Vector3();
const _hit: TerrainHit = {
  point: new Vector3(),
  normal: new Vector3(),
  distance: 0,
  t: 0,
  surface: 'grass',
};

/**
 * Predict the lowest clearance (m above ground and trees) of a recovery: the present load
 * factor and bank held for the reaction allowance, roll to wings level, then a pull whose load
 * factor builds at the onset rate to the design recovery g (or what the wing and the limit
 * allow), until the flight path is level, then two seconds level. Flat earth, along the present
 * track; speed changes with gravity only.
 */
export function predictRecoveryClearance(sim: Sim): number {
  const ac = sim.aircraft;
  const terrain = sim.world.terrain;
  const mach = ac.mach;
  const flapsDeg = ac.surfaces.flaps / DEG;
  const weight = ac.mass * G0;
  const s = Math.sin(ac.track);
  const c = -Math.cos(ac.track);
  const rho = densityFactor(sim);
  let v = Math.max(30, ac.tas);
  let gamma = ac.flightPathAngle;
  let bank = ac.bank;
  let x = 0;
  let y = ac.position.y;
  const dt = W.gcasStep;
  const clMax = maxStaticLift(flapsDeg, mach, reynoldsOf(sim));
  let n = ac.gLoad;
  let levelTime = 0;
  let minClear = Infinity;
  for (let t = 0; t < W.gcasHorizon; t += dt) {
    if (t >= W.gcasReactionTime) {
      if (Math.abs(bank) > 5 * DEG) {
        // Roll out unloaded (about 1 g), then pull.
        const step = W.gcasRollRate * dt;
        bank = Math.abs(bank) <= step ? 0 : bank - Math.sign(bank) * step;
        n += Math.max(-W.gcasOnsetRate * dt, Math.min(W.gcasOnsetRate * dt, 1 - n));
      } else {
        bank = 0;
        const available = (clMax * 0.5 * rho * v * v * A10.wingArea) / weight;
        const target = Math.min(
          W.gcasRecoveryG,
          ac.gLimitPositive * W.gcasGFraction,
          available * W.gcasGFraction,
        );
        n += Math.max(-W.gcasOnsetRate * dt, Math.min(W.gcasOnsetRate * dt, target - n));
      }
    }
    gamma += (G0 * (n * Math.cos(bank) - Math.cos(gamma)) * dt) / v;
    v = Math.max(30, v - G0 * Math.sin(gamma) * dt);
    x += v * Math.cos(gamma) * dt;
    y += v * Math.sin(gamma) * dt;
    const gx = ac.position.x + s * x;
    const gz = ac.position.z + c * x;
    let clear = y - terrain.heightAt(gx, gz);
    // Trees only matter close to the ground (canopy queries are costly).
    if (clear < minClear + MAX_CANOPY) clear -= terrain.canopyAt(gx, gz);
    if (clear < minClear) minClear = clear;
    if (gamma >= 0 && t > W.gcasReactionTime) {
      levelTime += dt;
      if (levelTime > 2) break;
    }
  }
  return minClear;
}

/** Reynolds number on the mean chord at the aircraft. */
function reynoldsOf(sim: Sim): number {
  const ac = sim.aircraft;
  const t = temperatureAt(ac.altitude, sim.world.isaDeviation);
  return (densityFactor(sim) * ac.tas * A10.mac) / airViscosity(t);
}

/** Air density ratio at the aircraft (from the dynamic pressure and true airspeed). */
function densityFactor(sim: Sim): number {
  const ac = sim.aircraft;
  return ac.tas > 1 ? (2 * ac.dynamicPressure) / (ac.tas * ac.tas) : 1.225;
}

/** Time to hit the ground if the present (straight) flight path continues, s. */
function timeToImpact(sim: Sim): number {
  const ac = sim.aircraft;
  const speed = ac.velocity.length();
  if (speed < 1 || ac.verticalSpeed >= 0) return Infinity;
  _dir.copy(ac.velocity);
  const range = Math.min(speed * W.gcasHorizon, 30000);
  return sim.world.terrain.raycast(ac.position, _dir, range, _hit)
    ? _hit.distance / speed
    : Infinity;
}

/**
 * Upper bound of the height a recovery can lose: free fall during the reaction and roll-out,
 * then a pull-out at the recovery g from the steepest dive and highest speed that can give.
 */
function recoveryLossBound(sim: Sim): number {
  const ac = sim.aircraft;
  const delay = W.gcasReactionTime + Math.abs(ac.bank) / W.gcasRollRate;
  const sink = Math.max(0, -ac.verticalSpeed);
  const v = ac.tas + G0 * delay;
  const sinkEnd = Math.min(v, sink + G0 * delay);
  const cosDive = Math.sqrt(Math.max(0, 1 - (sinkEnd / v) ** 2));
  // A weak pull loses the most height: assume no more than 2 g, less when the wing (CL ≈ 1.2)
  // cannot give it at the present dynamic pressure.
  const available = (1.2 * ac.dynamicPressure * A10.wingArea) / (ac.mass * G0);
  const n = Math.min(2, Math.max(1.05, W.gcasGFraction * available));
  const pull = ((v * v) / G0) * Math.log((n - cosDive) / (n - 1));
  return sink * delay + 0.5 * G0 * delay * delay + Math.max(0, pull);
}

function stepGroundCollision(sim: Sim): void {
  const ac = sim.aircraft;
  const f = ac.fcs;
  if (f.gcasCounter > 0) {
    f.gcasCounter--;
    return;
  }
  f.gcasCounter = W.gcasInterval - 1;
  const terrain = sim.world.terrain;
  // Far above everything the recovery could reach: nothing to predict.
  const margin = W.gcasMinClearance + W.gcasHysteresis + MAX_CANOPY + 100;
  if (ac.position.y - terrain.maxHeight > recoveryLossBound(sim) + margin || ac.crashed) {
    ac.groundCollision.clearance = Infinity;
    ac.groundCollision.timeToImpact = Infinity;
    set(sim, 'pullUp', false);
    return;
  }
  const clearance = predictRecoveryClearance(sim);
  ac.groundCollision.clearance = clearance;
  ac.groundCollision.timeToImpact = timeToImpact(sim);
  const on = ac.warnings.pullUp
    ? clearance < W.gcasMinClearance + W.gcasHysteresis
    : clearance < W.gcasMinClearance;
  set(sim, 'pullUp', on);
}

/** Warning logic (see the file comment). */
export function stepWarnings(sim: Sim, _dt: number): void {
  const ac = sim.aircraft;
  const w = ac.warnings;
  if (ac.crashed) {
    for (let i = 0; i < WARNING_IDS.length; i++) set(sim, WARNING_IDS[i], false);
    return;
  }

  // Stall tones.
  const flying = ac.ias > W.stallMinSpeed;
  const stallAlpha = stallAlphaFor(ac.surfaces.flaps / DEG, 1, ac.mach, reynoldsOf(sim));
  set(sim, 'stallChopped', flying && ac.alpha > stallAlpha - W.stallChoppedMargin);
  set(sim, 'stall', flying && !w.stallChopped && ac.alpha > stallAlpha - W.stallSteadyMargin);

  // Over-g with hysteresis.
  const h = W.overGHysteresis;
  const over = w.overG
    ? ac.gLoad > ac.gLimitPositive - h || ac.gLoad < ac.gLimitNegative + h
    : ac.gLoad > ac.gLimitPositive || ac.gLoad < ac.gLimitNegative;
  set(sim, 'overG', over);

  // Altitude alert: below the setting while descending.
  const alt = w.altitude
    ? ac.agl < ac.altitudeAlert + 10 && ac.verticalSpeed < 0.5
    : ac.agl < ac.altitudeAlert && ac.verticalSpeed < -1;
  set(sim, 'altitude', alt);

  stepGroundCollision(sim);

  set(sim, 'overspeed', w.overspeed ? ac.ias > A10.vne - 1 : ac.ias > A10.vne);
  set(sim, 'lowFuel', ac.fuel < W.lowFuel);
  set(sim, 'masterCaution', w.lowFuel);
}
