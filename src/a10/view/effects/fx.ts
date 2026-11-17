/**
 * The effects runtime shared by EffectsView (which draws and updates it) and VehiclesView (which
 * emits dust and exhaust into it): one particle system, the decal pool, the pressure rings, the
 * director and the stores in flight (view/stores), under one group added to the world scene.
 * Reference-counted so React StrictMode's mount → unmount → mount and sandboxes create and dispose
 * it cleanly.
 */
import { Group, Vector3, type Camera } from 'three';
import type { Sim, SimEvent } from '../../core/types';
import type { FrameInfo } from '../frame';
import { StoresPresenter } from '../stores/presenter';
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
  /** Stores in flight: their models, motor flames and smoke trails (view/stores). */
  stores: StoresPresenter;
  ctx: FxContext;
  /** Wire to `onSimFrame`: the frame's events to the director and the stores in flight. */
  onSimFrame: (events: readonly SimEvent[], sim: Sim, info: FrameInfo) => void;
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
  const stores = new StoresPresenter();
  root.add(stores.root);
  const onSimFrame = (events: readonly SimEvent[], sim: Sim, info: FrameInfo): void => {
    director.onSimFrame(events, sim, info);
    stores.onSimFrame(events, sim, info, ctx);
  };
  return { root, ps, decals, rings, director, stores, ctx, onSimFrame };
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
  fx.stores.dispose();
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
 * quality → budget, director (gun, fires, emitters), the stores in flight (their motors' smoke
 * is born this frame), then particles, decals and rings.
 */
export function updateFx(f: Fx, dt: number, camera: Camera, budgetOverride?: number): void {
  const budget = budgetOverride ?? getA10Quality().particles;
  f.ps.budget = budget;
  f.ctx.detail = detailForBudget(budget);
  f.ctx.camera.copy(camera.position);
  const sim = viewSim();
  f.director.update(sim, dt);
  f.stores.update(sim, dt, f.ctx);
  f.ps.update(dt, camera);
  f.decals.update(dt, camera);
  f.rings.update(dt, camera);
}

/**
 * Development aid (screenshots, the console): run the effects forward by `seconds` of simulated
 * time in 1/30 s steps without stepping the simulation, so fires, smoke columns and dust have
 * developed when a picture is taken.
 */
export function warmFx(seconds: number, camera: Camera): void {
  const f = fx;
  if (!f) return;
  const dt = 1 / 30;
  for (let t = 0; t < seconds; t += dt) updateFx(f, dt, camera);
}

/**
 * Development aid (screenshots, the console): deliver hand-made `events` — each `t` in seconds
 * from now — to the director at their exact times while running the effects forward `seconds` in
 * 1/60 s steps, without stepping the simulation (the live flight may stay paused). A burst of 65
 * impacts then walks along the ground exactly as it does in flight, at any frame rate.
 */
export function playFx(events: readonly SimEvent[], seconds: number, camera: Camera): void {
  const f = fx;
  const sim = viewSim();
  if (!f || !sim) return;
  const dt = 1 / 60;
  const order = events.slice().sort((a, b) => a.t - b.t);
  const batch: SimEvent[] = [];
  const info: FrameInfo = { steps: 1, alpha: 0, realDt: dt, simDt: dt };
  const steps = Math.max(1, Math.round(seconds / dt));
  let next = 0;
  for (let k = 0; k < steps; k++) {
    const end = (k + 1) * dt;
    batch.length = 0;
    while (next < order.length && order[next].t < end) {
      const e = order[next++];
      // the director places an event (t − frame start) into its frame
      batch.push({ ...e, t: sim.time - dt + Math.max(0, e.t - k * dt) });
    }
    f.onSimFrame(batch, sim, info);
    updateFx(f, dt, camera);
  }
}
