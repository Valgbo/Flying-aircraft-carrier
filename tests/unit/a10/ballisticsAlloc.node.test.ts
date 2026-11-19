/**
 * The round integrator allocates nothing (docs/a10/ARCHITECTURE.md §3 "Allocation"): every live
 * round calls it each step and the fire-control computer flies a round with it each step, so a
 * few boxed doubles per call add up to megabytes of garbage per second while firing.
 *
 * Measured as the stores' integrateStore was: after a full garbage collection, the heap's growth
 * over many calls of the warmed-up (optimised) function, the median of several runs. A Node test:
 * it reads the V8 heap and needs `gc`, which it exposes at run time (no command-line flag).
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../../src/a10/core/constants';
import { integrateRound } from '../../../src/a10/core/weapons/ballistics';
import { RoundType } from '../../../src/a10/core/weapons/types';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

/** Median heap growth per call of `fn`, bytes, once `fn` has been warmed up. */
function bytesPerCall(fn: () => void, calls = 5000, runs = 9): number {
  for (let i = 0; i < 50000; i++) fn();
  const perCall: number[] = [];
  for (let r = 0; r < runs; r++) {
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < calls; i++) fn();
    perCall.push((process.memoryUsage().heapUsed - before) / calls);
  }
  perCall.sort((a, b) => a - b);
  return perCall[runs >> 1];
}

/** 64 states of a round in flight: heights, speeds and directions that are not whole numbers. */
const STATES = Float64Array.from({ length: 64 * 6 }, (_, j) => {
  const n = Math.floor(j / 6);
  const c = j % 6;
  if (c === 0) return 3.7 * n;
  if (c === 1) return 150.3 + 61.7 * n;
  if (c === 2) return -2.1 * n;
  if (c === 3) return 12.4 - 0.37 * n;
  if (c === 4) return -95.6 - 1.3 * n;
  return -1180.3 + 11.9 * n;
});

/** One call per state in turn, with arguments the caller holds already (nothing to box there). */
function caller(type: RoundType, dt: number, isaDeviation: number): () => void {
  const pos = new Vector3();
  const vel = new Vector3();
  const wind = new Vector3(3.3, 0.4, -6.2);
  let n = 0;
  return () => {
    const o = n * 6;
    n = (n + 1) & 63;
    pos.set(STATES[o], STATES[o + 1], STATES[o + 2]);
    vel.set(STATES[o + 3], STATES[o + 4], STATES[o + 5]);
    integrateRound(type, pos, vel, wind, dt, isaDeviation);
  };
}

describe('allocation (ARCHITECTURE §3)', () => {
  it('integrateRound allocates nothing per call (it boxed ≈100 B of doubles before)', () => {
    const live = bytesPerCall(caller(RoundType.API, SIM_DT, 0));
    expect(live, `${live.toFixed(1)} B per call`).toBeLessThan(4);
  });

  it('nor with a partial step and an ISA deviation (a fresh round on a hot day)', () => {
    const fresh = bytesPerCall(caller(RoundType.HEI, SIM_DT * 0.37, 7.5));
    expect(fresh, `${fresh.toFixed(1)} B per call`).toBeLessThan(4);
  });
});
