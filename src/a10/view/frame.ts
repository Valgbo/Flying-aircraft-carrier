/**
 * Per-frame plumbing shared by every view module. FOUNDATION-OWNED (docs/a10/ARCHITECTURE.md §6).
 *
 * useFrame priorities (ascending order each frame; priorities > 0 take over rendering):
 *   sim     -100  SimDriver steps the simulation, drains events, notifies listeners
 *   systems  -50  view logic that needs the fresh sim state before the camera (effects spawning)
 *   camera   -20  the camera rig places the world and cockpit cameras
 *   0             everything visual reads the sim and updates itself
 *   render     1  RenderPipeline renders the registered passes
 */
import type { Quaternion, Vector3 } from 'three';
import type { Sim, SimEvent } from '../core/types';

export const A10_PRIORITY = {
  sim: -100,
  systems: -50,
  camera: -20,
  render: 1,
} as const;

export interface FrameInfo {
  /** Simulation steps taken this frame (0 while paused). */
  steps: number;
  /** Fraction of a step left in the accumulator, 0..1 (for optional interpolation). */
  alpha: number;
  /** Real seconds since the previous frame (clamped). */
  realDt: number;
  /** Simulated seconds advanced this frame. */
  simDt: number;
}

export type SimFrameListener = (events: readonly SimEvent[], sim: Sim, info: FrameInfo) => void;

/**
 * The aircraft pose to DRAW this frame (ARCHITECTURE §6, "Interpolation"): between the start and
 * the end of the last simulation step, by `frameInfo.alpha` (one step of render lag, ≤ 8.3 ms).
 * Without it the world judders whenever a frame takes 0 or 2 steps (75–165 Hz displays, jitter).
 * Cameras, the drawn aircraft and the HUD's world-referenced symbols all use this one pose.
 */
export function drawPose(sim: Sim, outPosition: Vector3, outOrientation: Quaternion): void {
  const ac = sim.aircraft;
  const a = frameInfo.alpha;
  outPosition.lerpVectors(ac.prevPosition, ac.position, a);
  outOrientation.slerpQuaternions(ac.prevOrientation, ac.orientation, a);
}

const listeners = new Set<SimFrameListener>();
const beforeListeners = new Set<(sim: Sim, realDt: number) => void>();

/**
 * Called once per frame right BEFORE the simulation steps (the input layer samples devices
 * and writes sim.input / sim.commands here, so every step of the frame sees fresh controls).
 */
export function onBeforeSimSteps(listener: (sim: Sim, realDt: number) => void): () => void {
  beforeListeners.add(listener);
  return () => beforeListeners.delete(listener);
}

/** For SimDriver only. */
export function notifyBeforeSimSteps(sim: Sim, realDt: number): void {
  for (const l of beforeListeners) l(sim, realDt);
}

/**
 * Called once per frame after the simulation has stepped, with the events of those steps.
 * Effects, audio, cameras and UI subscribe here. Returns an unsubscribe function.
 */
export function onSimFrame(listener: SimFrameListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For SimDriver only. */
export function notifySimFrame(events: readonly SimEvent[], sim: Sim, info: FrameInfo): void {
  for (const l of listeners) l(events, sim, info);
}

/** The latest frame info (read anywhere). */
export const frameInfo: FrameInfo = { steps: 0, alpha: 0, realDt: 0, simDt: 0 };
