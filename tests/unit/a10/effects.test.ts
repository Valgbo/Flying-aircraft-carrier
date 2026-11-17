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
import { createVehicle } from '../../../src/a10/core/targets';
import { acquireFx, releaseFx, updateFx, type Fx } from '../../../src/a10/view/effects/fx';
import { PARTICLE_KINDS, PK } from '../../../src/a10/view/effects/particleKinds';
import { ParticleSystem } from '../../../src/a10/view/effects/ParticleSystem';
import {
  detonationRecipe,
  LINGERING_CLOUD_CHARGE,
  type DetonationKind,
} from '../../../src/a10/view/effects/recipes';
import { setViewSimSource } from '../../../src/a10/view/effects/simSource';
import { WP_MARK } from '../../../src/a10/view/stores/look';

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

// ---------------------------------------------------------------------------------------------
// detonations of stores (wave 2)
// ---------------------------------------------------------------------------------------------

/** Live particles of a kind (reads the system's packed arrays). */
function countKind(fx: Fx, kind: number): number {
  const ps = fx.ps as unknown as { kind: Uint8Array; count: number; age: Float32Array };
  let n = 0;
  for (let i = 0; i < ps.count; i++) if (ps.kind[i] === kind) n++;
  return n;
}

function emissiveBorn(fx: Fx): number {
  const ps = fx.ps as unknown as { kind: Uint8Array; count: number };
  let n = 0;
  for (let i = 0; i < ps.count; i++) if (PARTICLE_KINDS[ps.kind[i]].emissive > 0) n++;
  return n;
}

function decalsUsed(fx: Fx): number {
  return (fx.decals as unknown as { used: number }).used;
}

function detonation(kind: DetonationKind, charge: number, vehicleId = 0): SimEvent {
  return {
    type: 'detonation',
    t: 0,
    position: { x: 0, y: 0, z: 0 },
    charge,
    kind,
    vehicleId,
    surface: 'dirt',
    bodyId: 7,
  };
}

describe('detonations: each kind has its recipe', () => {
  it('maps every detonation kind to the recipe that draws it', () => {
    expect(detonationRecipe('hei', 0.05)).toBe('none');
    expect(detonationRecipe('bomb', 96)).toBe('bombBurst');
    expect(detonationRecipe('bomb', LINGERING_CLOUD_CHARGE - 1)).toBe('smallBurst');
    expect(detonationRecipe('rocket', 1.3)).toBe('smallBurst');
    expect(detonationRecipe('missile', 12)).toBe('missileHit');
    expect(detonationRecipe('whitePhosphorus', 0.3)).toBe('whitePhosphorus');
    expect(detonationRecipe('dud', 0)).toBe('dud');
    expect(detonationRecipe('secondary', 28)).toBe('secondary');
  });

  const camera = new PerspectiveCamera(50, 1.6, 0.5, 90000);
  camera.position.set(0, 400, 500);
  camera.lookAt(0, 0, 0);

  function run(events: SimEvent[], seconds: number, step = 1 / 30): { fx: Fx; sim: ReturnType<typeof createSim> } {
    const sim = createSim({ terrain: createFlatTerrain(0), scenario: 'empty', seed: 1 });
    sim.world.surfaceWind.set(4, 0, 0);
    setViewSimSource(() => sim);
    const fx = acquireFx();
    fx.onSimFrame(events, sim, FRAME);
    for (let t = 0; t < seconds; t += step) {
      sim.time += step;
      updateFx(fx, step, camera, 20000);
    }
    return { fx, sim };
  }

  it('a Mk-82 burst: fireball, debris, a crater, and a dust cloud that lingers half a minute', () => {
    const { fx } = run([detonation('bomb', 96)], 1);
    try {
      expect(countKind(fx, PK.ejecta) + countKind(fx, PK.clod)).toBeGreaterThan(10);
      expect(countKind(fx, PK.smoke)).toBeGreaterThan(10);
      expect(decalsUsed(fx)).toBeGreaterThanOrEqual(2);
      // the cloud is still being fed 20 s later
      for (let t = 0; t < 20; t += 1 / 30) updateFx(fx, 1 / 30, camera, 20000);
      expect(countKind(fx, PK.dust)).toBeGreaterThan(5);
    } finally {
      releaseFx();
      setViewSimSource(null);
    }
  });

  it('a rocket HE burst is small: no lingering cloud', () => {
    const { fx } = run([detonation('rocket', 1.3)], 25);
    try {
      expect(countKind(fx, PK.dust)).toBe(0);
    } finally {
      releaseFx();
      setViewSimSource(null);
    }
  });

  it('white phosphorus: streamers at once, a white mark still fed two minutes later, gone after', () => {
    const { fx } = run([detonation('whitePhosphorus', 0.3)], 0.5);
    try {
      expect(countKind(fx, PK.wpFragment)).toBeGreaterThan(3);
      for (let t = 0.5; t < 120; t += 1 / 30) updateFx(fx, 1 / 30, camera, 20000);
      // two minutes on: a mark of big white puffs, drifting downwind (+x)
      const ps = fx.ps as unknown as {
        kind: Uint8Array;
        count: number;
        px: Float32Array;
        size: Float32Array;
      };
      let n = 0;
      let sumX = 0;
      let big = 0;
      for (let i = 0; i < ps.count; i++) {
        if (ps.kind[i] !== PK.wpMark) continue;
        n++;
        sumX += ps.px[i];
        if (ps.size[i] > 15) big++;
      }
      expect(n).toBeGreaterThan(20);
      expect(big).toBeGreaterThan(5);
      expect(sumX / n).toBeGreaterThan(50);
      // the phosphorus has burnt out a while after its duration
      for (let t = 120; t < WP_MARK.duration + WP_MARK.puffLife * 1.3; t += 1 / 10)
        updateFx(fx, 1 / 10, camera, 20000);
      expect(countKind(fx, PK.wpMark)).toBe(0);
    } finally {
      releaseFx();
      setViewSimSource(null);
    }
  });

  it('a dud is a puff of dust and soil only: no flash, no fire, no smoke', () => {
    const { fx } = run([detonation('dud', 0)], 0.05, 0.05);
    try {
      expect(emissiveBorn(fx)).toBe(0);
      expect(countKind(fx, PK.dust)).toBeGreaterThan(0);
      expect(countKind(fx, PK.smoke)).toBe(0);
    } finally {
      releaseFx();
      setViewSimSource(null);
    }
  });

  it("a Maverick on a tank: the jet's flash and spall, then the warhead's burst on the vehicle", () => {
    const sim = createSim({ terrain: createFlatTerrain(0), scenario: 'empty', seed: 1 });
    setViewSimSource(() => sim);
    const v = createVehicle(sim, 'mbt', 0, 0, 0, 1);
    const fx = acquireFx();
    try {
      fx.onSimFrame([detonation('missile', 12, v.id)], sim, FRAME);
      expect(countKind(fx, PK.spark)).toBeGreaterThan(20);
      expect(countKind(fx, PK.flash)).toBeGreaterThanOrEqual(2);
      // on the vehicle: no crater
      expect(decalsUsed(fx)).toBeLessThanOrEqual(1);
    } finally {
      releaseFx();
      setViewSimSource(null);
    }
  });
});
