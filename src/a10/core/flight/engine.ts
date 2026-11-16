/**
 * TF34-GE-100A turbofan (data: TF34 in data/aircraft.ts).
 *
 * - Fuel control: the throttle lever sets a fan-speed demand (linear in lever); the core (N2) is
 *   the spool the fuel control drives. It accelerates no faster than an acceleration schedule
 *   that grows with core speed (a cold, slow core has little surplus torque: idle → MAX takes
 *   several seconds, mid-range → MAX is quicker) and decelerates at a fixed limit.
 * - The fan (N1) follows the core through a quasi-static map with a short inertia lag.
 * - Thrust: Mattingly's high-bypass lapse with total (ram) pressure and temperature for MAX,
 *   a small idle thrust that turns into ram drag at speed, and n1^k in between.
 * - Fuel flow: corrected fuel flow (W_f / (δ0·√θ0)) as a function of core speed, anchored to the
 *   static TSFC at MAX.
 *
 * Pure functions over EngineState; no allocation.
 */
import { TF34 } from '../../data/aircraft';
import type { EngineState } from './types';

/** Ambient and flight conditions the engine sees. */
export interface EngineConditions {
  mach: number;
  /** Ambient pressure ratio p / p_SL and temperature ratio T / T_SL (ISA). */
  delta: number;
  theta: number;
  /** Ambient temperature, K (for the ITT gauge). */
  temperature: number;
}

export function createEngineConditions(): EngineConditions {
  return { mach: 0, delta: 1, theta: 1, temperature: 288.15 };
}

/** Maximum (MAX lever) net thrust at the flight condition, N. */
export function maxThrust(c: EngineConditions): number {
  const ram = 1 + 0.2 * c.mach * c.mach;
  const delta0 = c.delta * Math.pow(ram, 3.5);
  const theta0 = c.theta * ram;
  let lapse = 1 - TF34.lapseMachCoefficient * Math.sqrt(Math.max(0, c.mach));
  if (theta0 > TF34.throttleRatio) lapse -= (3 * (theta0 - TF34.throttleRatio)) / (1.5 + c.mach);
  return TF34.staticThrust * Math.max(0, delta0 * lapse);
}

/** Net thrust at flight idle, N (negative at speed: the fan's ram drag exceeds its thrust). */
export function idleThrust(c: EngineConditions): number {
  const [a, b, k] = TF34.idleThrust;
  return TF34.staticThrust * c.delta * (a - b * c.mach - k * c.mach * c.mach);
}

/** Idle fan speed, which windmilling raises in flight. */
export function idleN1(mach: number): number {
  return Math.min(0.6, TF34.n1Idle + TF34.n1IdleRam * mach);
}

/** Quasi-static fan speed for a core speed. */
export function fanSpeedForCore(n2: number, mach: number): number {
  const rel = Math.min(1, Math.max(0, (n2 - TF34.n2Idle) / (1 - TF34.n2Idle)));
  const idle = idleN1(mach);
  return idle + (1 - idle) * Math.pow(rel, TF34.fanCoreExponent);
}

/** Core speed the fuel control aims for at a lever position (fan demand linear in lever). */
export function coreSpeedDemand(lever: number): number {
  const l = Math.min(1, Math.max(0, lever));
  return TF34.n2Idle + (1 - TF34.n2Idle) * Math.pow(l, 1 / TF34.fanCoreExponent);
}

/** Net thrust for a fan speed at the flight condition, N. */
export function thrustAt(n1: number, c: EngineConditions): number {
  const idle = idleN1(c.mach);
  const rel = Math.min(1, Math.max(0, (n1 - idle) / (1 - idle)));
  const tIdle = idleThrust(c);
  return tIdle + (maxThrust(c) - tIdle) * Math.pow(rel, TF34.thrustExponent);
}

/** Fill thrust, fuel flow and ITT from the spool speeds. */
function updateOutputs(e: EngineState, c: EngineConditions): void {
  const ram = 1 + 0.2 * c.mach * c.mach;
  const delta0 = c.delta * Math.pow(ram, 3.5);
  const theta0 = c.theta * ram;
  const rel2 = Math.min(1, Math.max(0, (e.n2 - TF34.n2Idle) / (1 - TF34.n2Idle)));
  if (e.running) {
    e.thrust = thrustAt(e.n1, c);
    const ffMax = TF34.tsfcStatic * TF34.staticThrust;
    const corrected =
      TF34.idleFuelFlow + (ffMax - TF34.idleFuelFlow) * Math.pow(rel2, TF34.fuelFlowExponent);
    e.fuelFlow = corrected * delta0 * Math.sqrt(theta0);
    e.itt =
      TF34.ittIdle +
      (TF34.ittMax - TF34.ittIdle) * Math.pow(rel2, 1.5) +
      0.7 * (c.temperature - 288.15);
  } else {
    // Flamed out (no fuel): the windmilling fan is pure drag.
    e.thrust =
      TF34.staticThrust *
      c.delta *
      (-TF34.idleThrust[1] * c.mach - TF34.idleThrust[2] * c.mach * c.mach);
    e.fuelFlow = 0;
    e.itt = Math.max(c.temperature - 273.15, e.itt - 20);
  }
}

/**
 * Advance one engine by dt: spool dynamics toward the lever, then thrust, fuel flow and ITT.
 * `fuelAvailable` false flames the engine out.
 */
export function stepEngine(
  e: EngineState,
  c: EngineConditions,
  dt: number,
  fuelAvailable: boolean,
): void {
  e.running = fuelAvailable;
  const demand = e.running ? coreSpeedDemand(e.lever) : 0.12 + 0.25 * c.mach;
  const err = demand - e.n2;
  let rate: number;
  if (err > 0) {
    const schedule = TF34.accelBase + TF34.accelSlope * Math.max(0, e.n2 - TF34.n2Idle);
    rate = Math.min(TF34.spoolGain * err, schedule);
  } else {
    rate = Math.max(TF34.spoolGain * err, -TF34.decelRate);
  }
  e.n2 += rate * dt;
  const fanTarget = e.running ? fanSpeedForCore(e.n2, c.mach) : 0.1 + 0.3 * c.mach;
  e.n1 += (fanTarget - e.n1) * Math.min(1, dt / TF34.fanLag);
  updateOutputs(e, c);
}

/** Put an engine in the steady state of its lever (air starts, trim). */
export function settleEngine(e: EngineState, c: EngineConditions): void {
  e.running = true;
  e.n2 = coreSpeedDemand(e.lever);
  e.n1 = fanSpeedForCore(e.n2, c.mach);
  updateOutputs(e, c);
}

/** Steady-state net thrust at a lever position, N. */
export function steadyThrust(lever: number, c: EngineConditions): number {
  return thrustAt(fanSpeedForCore(coreSpeedDemand(lever), c.mach), c);
}

/** Angular momentum of both spools of one engine, N·m·s (about the engine axis, forward). */
export function spoolMomentum(e: EngineState): number {
  const w1 = (TF34.n1MaxRpm * 2 * Math.PI) / 60;
  const w2 = (TF34.n2MaxRpm * 2 * Math.PI) / 60;
  return TF34.fanInertia * e.n1 * w1 + TF34.coreInertia * e.n2 * w2;
}

export function createEngineState(lever: number): EngineState {
  const e: EngineState = {
    lever,
    n1: TF34.n1Idle,
    n2: TF34.n2Idle,
    thrust: 0,
    itt: TF34.ittIdle,
    fuelFlow: TF34.idleFuelFlow,
    running: true,
    igniters: false,
  };
  return e;
}
