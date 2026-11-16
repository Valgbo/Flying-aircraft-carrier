/**
 * The collimated HUD render pass (docs/a10/ARCHITECTURE.md §6, order 300; PLAN_A10.md §7).
 *
 * A real HUD is focused at infinity: move your head and each symbol stays on the same piece
 * of ground, and only the part of the symbology inside the combiner glass is visible. Here:
 *
 *  (a) the combiner glass quad (A10_GEOMETRY.hudCorners, body frame) is drawn into the STENCIL
 *      buffer only, with the cockpit camera — the pilot's head, which the camera rig moves —
 *      and depth-tested against the cockpit, so the frame and canopy bow still hide it;
 *  (b) the symbology is drawn with a ROTATION-ONLY camera (the head's orientation, field of
 *      view and aspect, at the origin) from a scene where every symbol is a body DIRECTION on
 *      the plane z = −1, with a stencil test so only the part inside the glass shows.
 *
 * Head movement therefore slides the glass window over symbology fixed to the world.
 * Nothing is cleared but the stencil; the world and cockpit images are already in the target.
 * A target without a stencil buffer (an offscreen post-processing buffer created without one)
 * falls back to an analytic per-fragment glass test (lineBatch.ts).
 */
import {
  AlwaysStencilFunc,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  KeepStencilOp,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  ReplaceStencilOp,
  Scene,
  Vector3,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { A10_GEOMETRY } from '../../data/geometry';
import type { Sim } from '../../core/types';
import { cockpitCamera } from '../cockpit/cockpitCamera';
import { a10Env } from '../environment/env';
import type { RenderPassContext } from '../pipeline';
import { HUD_GLASS, computeHudLayout } from './hudLayout';
import { HudLineBatch, type LineStyle } from './lineBatch';
import { HudSymbology, type HudBuildInfo } from './symbology';

/** HUD green, #2fff4a (converted to linear by three's colour management). */
export const HUD_GREEN = new Color(0x2fff4a);

/**
 * Brightness by day (slightly above 1 linear, so the High preset's bloom can catch it), at
 * night, and an extra gain into an HDR target. Drawn to the screen the HUD is not tone-mapped
 * (exactly #2fff4a by day); into the post-processing target it goes through ACES with the
 * world, which already pales a bright green, so the HDR gain stays 1 — raise it (or lower the
 * bloom threshold below ≈0.9 luminance) for a stronger glow.
 */
const DAY_GAIN = 1.25;
const NIGHT_GAIN = 0.4;
const HDR_GAIN = 1.0;

/** Stroke width in drawing-buffer pixels at a 720-pixel-high target, and its limits. */
const LINE_WIDTH_720 = 1.6;
const LINE_WIDTH_MIN = 1.2;
const LINE_WIDTH_MAX = 3.4;

/** The stencil glass sits this far in front of the glass's aft face (beats the cockpit's own glass in the depth test). */
const GLASS_LIFT = 0.003;

const _eye = new Vector3();
const _q = new Quaternion();

export class HudRenderer {
  readonly symbology = new HudSymbology(computeHudLayout());
  readonly batch = new HudLineBatch(4096);
  /** The symbology scene: body directions on the plane z = −1. */
  readonly symbolScene = new Scene();
  /** The stencil mask scene: the combiner glass in body coordinates. */
  readonly glassScene = new Scene();
  /** Rotation-only camera: the head's orientation and projection, at the origin. */
  readonly hudCamera = new PerspectiveCamera(62, 16 / 9, 0.05, 10);
  /** Draw the stencil glass and test against it (false: analytic clip). */
  stencilAvailable = true;
  private readonly glassGeometry: BufferGeometry;
  private readonly glassMaterial: MeshBasicMaterial;
  private readonly style: LineStyle = { color: new Color(), lineWidth: 1.5, opacity: 0.75 };
  private screenStencil: boolean | null = null;

  constructor() {
    this.symbolScene.name = 'hud-symbols';
    this.symbolScene.matrixWorldAutoUpdate = false;
    this.symbolScene.add(this.batch.mesh);
    this.batch.mesh.updateMatrixWorld();

    // The glass quad, lifted toward the pilot along its normal.
    const n = A10_GEOMETRY.hudNormal;
    const pos = new Float32Array(12);
    HUD_GLASS.forEach((c, i) => {
      pos[i * 3] = c.x + n.x * GLASS_LIFT;
      pos[i * 3 + 1] = c.y + n.y * GLASS_LIFT;
      pos[i * 3 + 2] = c.z + n.z * GLASS_LIFT;
    });
    this.glassGeometry = new BufferGeometry();
    this.glassGeometry.setAttribute('position', new BufferAttribute(pos, 3));
    this.glassGeometry.setIndex([0, 3, 2, 0, 2, 1]);
    this.glassMaterial = new MeshBasicMaterial({
      name: 'hud-glass-stencil',
      colorWrite: false,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      stencilWrite: true,
      stencilWriteMask: 0xff,
      stencilRef: 1,
      stencilFunc: AlwaysStencilFunc,
      stencilFail: KeepStencilOp,
      stencilZFail: KeepStencilOp,
      stencilZPass: ReplaceStencilOp,
    });
    const glass = new Mesh(this.glassGeometry, this.glassMaterial);
    glass.name = 'hud-glass-stencil';
    glass.frustumCulled = false;
    this.glassScene.name = 'hud-glass';
    this.glassScene.add(glass);
  }

  /** The last frame's build results (velocity vector, pipper…). */
  get info(): HudBuildInfo {
    return this.symbology.info;
  }

  /** Build this frame's symbology from the simulation and draw it into ctx.target. */
  render(ctx: RenderPassContext, sim: Sim): void {
    const gl = ctx.gl;
    cockpitCamera.updateMatrixWorld();
    cockpitCamera.getWorldPosition(_eye);
    cockpitCamera.getWorldQuaternion(_q);

    const batch = this.batch;
    batch.begin();
    this.symbology.build(sim, _eye, batch);
    batch.end();
    if (batch.count === 0) return;

    syncHudCamera(this.hudCamera, cockpitCamera, _q);

    const target = ctx.target;
    const width = target ? target.width : ctx.width;
    const height = target ? target.height : ctx.height;
    const s = this.style;
    s.lineWidth = Math.min(
      LINE_WIDTH_MAX,
      Math.max(LINE_WIDTH_MIN, (LINE_WIDTH_720 * height) / 720),
    );
    const day = Math.min(1, Math.max(0, a10Env.daylight));
    const gain = (NIGHT_GAIN + (DAY_GAIN - NIGHT_GAIN) * day) * (target ? HDR_GAIN : 1);
    s.color.copy(HUD_GREEN).multiplyScalar(gain);
    // By day the strokes nearly replace the background (a HUD is far brighter than the sky,
    // which a monitor cannot show); at night they add more softly.
    s.opacity = 0.55 + 0.37 * day;
    batch.setFrame(width, height, s, this.hudCamera);

    gl.setRenderTarget(target);
    const stencil = this.stencilAvailable && this.targetHasStencil(gl, target);
    batch.setClip(stencil, _eye, HUD_GLASS);
    const autoClear = gl.autoClear;
    gl.autoClear = false;
    if (stencil) {
      gl.clear(false, false, true);
      gl.render(this.glassScene, cockpitCamera);
    }
    gl.render(this.symbolScene, this.hudCamera);
    gl.autoClear = autoClear;
    gl.state.buffers.stencil.setTest(false);
  }

  private targetHasStencil(gl: WebGLRenderer, target: WebGLRenderTarget | null): boolean {
    if (target) return target.stencilBuffer;
    if (this.screenStencil === null)
      this.screenStencil = gl.getContext().getContextAttributes()?.stencil === true;
    return this.screenStencil;
  }

  dispose(): void {
    this.batch.dispose();
    this.glassGeometry.dispose();
    this.glassMaterial.dispose();
  }
}

/**
 * Give the HUD camera the cockpit camera's projection (field of view, aspect, zoom, view
 * offset) and the head's ORIENTATION, at the origin: directions drawn with it land exactly
 * where the world at infinity appears in the cockpit view. Allocation-free.
 */
export function syncHudCamera(dst: PerspectiveCamera, src: PerspectiveCamera, q: Quaternion): void {
  let dirty = false;
  if (dst.fov !== src.fov) {
    dst.fov = src.fov;
    dirty = true;
  }
  if (dst.aspect !== src.aspect) {
    dst.aspect = src.aspect;
    dirty = true;
  }
  if (dst.zoom !== src.zoom) {
    dst.zoom = src.zoom;
    dirty = true;
  }
  if (dst.filmGauge !== src.filmGauge || dst.filmOffset !== src.filmOffset) {
    dst.filmGauge = src.filmGauge;
    dst.filmOffset = src.filmOffset;
    dirty = true;
  }
  const v = src.view;
  const dv = dst.view;
  if (v !== null && v.enabled) {
    if (
      dv === null ||
      !dv.enabled ||
      dv.fullWidth !== v.fullWidth ||
      dv.fullHeight !== v.fullHeight ||
      dv.offsetX !== v.offsetX ||
      dv.offsetY !== v.offsetY ||
      dv.width !== v.width ||
      dv.height !== v.height
    ) {
      dst.setViewOffset(v.fullWidth, v.fullHeight, v.offsetX, v.offsetY, v.width, v.height);
      dirty = false;
    }
  } else if (dv !== null && dv.enabled) {
    dst.clearViewOffset();
    dirty = false;
  }
  if (dirty) dst.updateProjectionMatrix();
  dst.position.set(0, 0, 0);
  dst.quaternion.copy(q);
  dst.updateMatrixWorld();
}
