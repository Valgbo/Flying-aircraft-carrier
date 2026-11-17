/**
 * Effects (VEHICLES-AND-EFFECTS module): contract and integration rules that screenshots cannot
 * catch. docs/a10/ARCHITECTURE.md §4: HEI bursts are drawn from roundImpact, never a second
 * time from a detonation of kind 'hei'.
 */
import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { createSim } from '../../../src/a10/core/sim';
import { createFlatTerrain } from '../../../src/a10/core/world';
import type { SimEvent } from '../../../src/a10/core/types';
import { acquireFx, releaseFx } from '../../../src/a10/view/effects/fx';
import { PK } from '../../../src/a10/view/effects/particleKinds';
import { ParticleSystem } from '../../../src/a10/view/effects/ParticleSystem';
import { setViewSimSource } from '../../../src/a10/view/effects/simSource';

const FRAME = { steps: 1, alpha: 0, realDt: 1 / 60, simDt: 1 / 60 };

describe('effects director', () => {
  it('draws nothing for a detonation of kind hei, a burst for its roundImpact', () => {
    const sim = createSim({ terrain: createFlatTerrain(0), scenario: 'empty', seed: 1 });
    setViewSimSource(() => sim);
    const fx = acquireFx();
    try {
      const at = { x: 0, y: 0, z: 0 };
      const hei: SimEvent = {
        type: 'detonation',
        t: 0,
        position: at,
        charge: 0.05,
        kind: 'hei',
        vehicleId: 0,
        surface: 'dirt',
      };
      fx.director.onSimFrame([hei], sim, FRAME);
      expect(fx.ps.count).toBe(0);
      const impact: SimEvent = {
        type: 'roundImpact',
        t: 0,
        round: 1,
        position: at,
        velocity: { x: 0, y: -400, z: -500 },
        normal: { x: 0, y: 1, z: 0 },
        target: { kind: 'ground', surface: 'dirt' },
        outcome: 'ground',
      };
      fx.director.onSimFrame([impact], sim, FRAME);
      expect(fx.ps.count).toBeGreaterThan(0);
    } finally {
      releaseFx();
      setViewSimSource(null);
    }
  });
});

describe('particle system', () => {
  it('moves a particle the same at 5 and at 60 updates per second', () => {
    const camera = new PerspectiveCamera();
    const fast = new ParticleSystem(4);
    const slow = new ParticleSystem(4);
    for (const ps of [fast, slow]) ps.spawn(PK.gunSmoke, 0, 100, 0, 150, 0, 0, 3, 9, 4);
    for (let i = 0; i < 60; i++) fast.update(1 / 60, camera);
    for (let i = 0; i < 5; i++) slow.update(1 / 5, camera);
    const x = (ps: ParticleSystem) => (ps as unknown as { px: Float32Array }).px[0];
    // gun gas leaving at 150 m/s stops within metres (drag 11/s): ≈150 / 11 m
    expect(x(fast)).toBeCloseTo(150 / 11, 1);
    expect(Math.abs(x(fast) - x(slow))).toBeLessThan(0.01);
    fast.dispose();
    slow.dispose();
  });
});
