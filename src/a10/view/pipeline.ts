/**
 * Render-pass registry. FOUNDATION-OWNED (docs/a10/ARCHITECTURE.md §6).
 *
 * The A-10 view draws several scenes per frame (sensor pictures, the world, the cockpit, the
 * collimated HUD, post-processing), so it renders through ordered passes instead of R3F's
 * automatic render. Each module registers its own pass; nobody edits another module's pass.
 *
 * Order bands: 0–99 offscreen (sensor render targets) · 100 world · 200 cockpit · 300 HUD ·
 * 400–499 overlays · 900 post-processing (the only pass that may draw to the screen when
 * `ctx.target` is an offscreen buffer).
 */
import type { Camera, Scene, WebGLRenderer, WebGLRenderTarget } from 'three';

export interface RenderPassContext {
  gl: WebGLRenderer;
  /** The world scene (R3F's default scene). */
  scene: Scene;
  /** The world camera (R3F's default camera). */
  camera: Camera;
  /** Drawing-buffer size in pixels. */
  width: number;
  height: number;
  /**
   * Where the main image goes this frame: null = the screen, or the offscreen buffer a
   * post-processing pass asked for (that pass then draws it to the screen).
   */
  target: WebGLRenderTarget | null;
  /** Real seconds since the previous frame. */
  dt: number;
}

export interface RenderPass {
  id: string;
  order: number;
  /** Skip the pass this frame when false (default: always on). */
  enabled?: () => boolean;
  render(ctx: RenderPassContext): void;
  /**
   * Post-processing passes only: return the offscreen target the earlier passes should draw
   * into this frame, or null to let them draw to the screen.
   */
  prepareTarget?(ctx: RenderPassContext): WebGLRenderTarget | null;
}

const passes: RenderPass[] = [];

export function registerRenderPass(pass: RenderPass): () => void {
  const existing = passes.findIndex((p) => p.id === pass.id);
  if (existing >= 0) passes.splice(existing, 1);
  passes.push(pass);
  passes.sort((a, b) => a.order - b.order);
  return () => {
    const i = passes.indexOf(pass);
    if (i >= 0) passes.splice(i, 1);
  };
}

export function getRenderPasses(): readonly RenderPass[] {
  return passes;
}
