/**
 * The effects runtime shared by EffectsView (which draws and updates it) and VehiclesView (which
 * emits dust and exhaust into it): one particle system, the decal pool, the pressure rings and the
 * director, under one group added to the world scene. Reference-counted so React StrictMode's
 * mount → unmount → mount and sandboxes create and dispose it cleanly.
 */
import { Group, Vector3, type Camera } from 'three';
import { getA10Quality } from '../quality';
import { disposeAtlas } from './atlas';
import { DecalPool } from './decals';
import { EffectsDirector } from './director';
import { ParticleSystem } from './ParticleSystem';
import type { FxContext } from './recipes';
import { RingPool } from './rings';
import { viewSim } from './simSource';

export interface Fx {
  root: Group;
  ps: ParticleSystem;
  decals: DecalPool;
  rings: RingPool;
  director: EffectsDirector;
  ctx: FxContext;
}

let fx: Fx | null = null;
let refs = 0;

/** Particle count multiplier for a live-particle budget (low ≈ 0.6, medium 1, high 1.3). */
export function detailForBudget(particles: number): number {
  return Math.min(1.3, Math.max(0.45, 0.35 + 0.65 * (particles / 10000)));
}

function create(): Fx {
  const ps = new ParticleSystem(20000);
  const decals = new DecalPool(384);
  const rings = new RingPool(24);
  const root = new Group();
  root.name = 'a10-effects';
  root.add(decals.mesh, ps.mesh, rings.mesh);
  const ctx: FxContext = {
    ps,
    decals,
    rings,
    camera: new Vector3(),
    detail: 1,
    groundAt: (x, z) => viewSim()?.world.terrain.heightAt(x, z) ?? 0,
  };
  const director = new EffectsDirector(ctx);
  return { root, ps, decals, rings, director, ctx };
}

export function acquireFx(): Fx {
  if (!fx) fx = create();
  refs++;
  return fx;
}

export function releaseFx(): void {
  refs = Math.max(0, refs - 1);
  if (refs > 0 || !fx) return;
  fx.root.removeFromParent();
  fx.ps.dispose();
  fx.decals.dispose();
  fx.rings.dispose();
  disposeAtlas();
  fx = null;
}

/** The live effects runtime, or null when no view holds it. */
export function getFx(): Fx | null {
  return fx;
}

/**
 * One frame of effects (EffectsView calls it at visual priority, after the camera moved):
 * quality → budget, director (gun, fires, emitters), then particles, decals and rings.
 */
export function updateFx(f: Fx, dt: number, camera: Camera, budgetOverride?: number): void {
  const budget = budgetOverride ?? getA10Quality().particles;
  f.ps.budget = budget;
  f.ctx.detail = detailForBudget(budget);
  f.ctx.camera.copy(camera.position);
  f.director.update(viewSim(), dt);
  f.ps.update(dt, camera);
  f.decals.update(dt, camera);
  f.rings.update(dt, camera);
}
