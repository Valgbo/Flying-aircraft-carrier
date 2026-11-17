/**
 * The two multifunction displays drawn on the GPU (ARCHITECTURE §12.7, §6): each display
 * composes its page — the sensor picture underneath on the TGP and MAV pages, the page's strokes
 * on top (one instanced draw call through the HUD's line batch, with the display palette) — into
 * its own render target, shown in the cockpit with `DisplaySurface.setPicture`.
 *
 * Colour: the render target stores 8-bit sRGB (hardware encodes on write and decodes on read),
 * holding LINEAR colours like any other texture: the cockpit's unlit, not tone-mapped screen
 * material shows them as they are. The sensor picture is taken as display-referred linear
 * values and clamped to 0..1. It is shown whenever the sensor-view module publishes one: its
 * texture shows what the sensor shows in every state (black without video, a featureless field
 * when masked). Over a picture with video the page is drawn twice into the one batch — first
 * every stroke as a wider dark outline, then the strokes in colour — so it reads on any picture.
 *
 * Cost: a display is drawn only when its page is due (compose.ts): sensor pages at the quality
 * preset's sensor rate, the map at 15 Hz, text pages when they change.
 */
import {
  Color,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { buildDsmsView, createDsmsView } from '../../core/avionics';
import type { MfdPage } from '../../core/avionics/types';
import type { Sim } from '../../core/types';
import { HudLineBatch, type LineStyle } from '../hud/lineBatch';
import { getSensorPicture, type SensorPictureInfo } from '../sensors/pictures';
import {
  createPageInfo,
  continuousPage,
  drawPage,
  pageInterval,
  pageSignature,
  RedrawSchedule,
  type PageInfo,
} from './compose';
import { MessageLog, type MfdDisplay, type PageContext } from './context';
import {
  MFD_COLOR,
  MFD_COLORS,
  MFD_LINE_WIDTH,
  MFD_OUTLINE,
  MFD_RATES,
  MFD_RESOLUTION,
} from './mfdLayout';
import { MfdPainter, type ColorSink } from './painter';

const PICTURE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const PICTURE_FRAGMENT = /* glsl */ `
uniform sampler2D tPicture;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(clamp(texture2D(tPicture, vUv).rgb, 0.0, 1.0), 1.0);
}`;

const _clear = new Color();

/** One display: its render target, scene, schedule and page state. */
export class MfdDisplayRenderer {
  readonly display: MfdDisplay;
  readonly target: WebGLRenderTarget;
  readonly batch = new HudLineBatch(8192);
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  readonly painter: MfdPainter;
  readonly schedule = new RedrawSchedule();
  readonly info: PageInfo = createPageInfo();
  /** Drawings made (diagnostics, tests). */
  draws = 0;
  /** The last drawing had the outline pass (a picture with video under the page). */
  outlined = false;
  private readonly quad: Mesh;
  private readonly pictureMaterial: ShaderMaterial;
  /** Palette colour 0 (the style's) is the outline colour. */
  private readonly style: LineStyle = {
    color: MFD_COLORS.outline.clone(),
    lineWidth: MFD_LINE_WIDTH,
    opacity: 1,
  };
  /** Writes every stroke as its outline: wider, in the outline colour (colour changes ignored). */
  private readonly outline: ColorSink = {
    color: MFD_COLOR.outline,
    seg: (x0, y0, x1, y1, w = 1) => {
      const b = this.batch;
      b.color = MFD_COLOR.outline;
      b.seg(x0, y0, x1, y1, w + MFD_OUTLINE.extraPx / MFD_LINE_WIDTH, 1);
    },
  };
  readonly ctx: PageContext;

  constructor(display: MfdDisplay, messages: MessageLog, size = MFD_RESOLUTION) {
    this.display = display;
    this.target = new WebGLRenderTarget(size, size, {
      colorSpace: SRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
    });
    this.target.texture.name = `mfd-${display}`;
    this.target.texture.anisotropy = 4;

    const b = this.batch;
    b.setNoClip();
    for (const key of Object.keys(MFD_COLOR) as (keyof typeof MFD_COLOR)[])
      b.setPaletteColor(MFD_COLOR[key], MFD_COLORS[key]);
    b.mesh.renderOrder = 1;
    this.painter = new MfdPainter(b);

    this.pictureMaterial = new ShaderMaterial({
      name: `mfd-picture-${display}`,
      vertexShader: PICTURE_VERTEX,
      fragmentShader: PICTURE_FRAGMENT,
      uniforms: { tPicture: { value: null as Texture | null } },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.pictureMaterial);
    this.quad.position.z = -1;
    this.quad.renderOrder = 0;
    this.quad.frustumCulled = false;
    this.quad.visible = false;

    this.scene.name = `mfd-${display}`;
    this.scene.add(this.quad, b.mesh);
    this.scene.updateMatrixWorld(true);
    b.mesh.updateMatrixWorld();

    this.ctx = {
      sim: null as unknown as Sim,
      display,
      page: 'DSMS',
      soi: false,
      time: 0,
      picture: null,
      dsms: createDsmsView(),
      messages,
    };
  }

  /**
   * Draw the page if it is due (`now` real seconds). Returns true when the display was drawn.
   */
  update(
    gl: WebGLRenderer,
    sim: Sim,
    page: MfdPage,
    soi: boolean,
    now: number,
    sensorRate: number,
  ): boolean {
    const ctx = this.ctx;
    ctx.sim = sim;
    ctx.page = page;
    ctx.soi = soi;
    ctx.time = sim.time;
    const continuous = continuousPage(page);
    const signature = continuous ? this.draws + 1 : pageSignature(ctx);
    const interval = pageInterval(page, sensorRate);
    if (!this.schedule.due(now, page, soi, signature, interval, MFD_RATES.keepAlive)) {
      return false;
    }
    this.schedule.done(now, page, soi, signature);
    this.compose(gl, sim, page);
    return true;
  }

  /** Build the page's strokes and render the display (the SOI flag is the last `update`'s). */
  compose(gl: WebGLRenderer, sim: Sim, page: MfdPage): void {
    const ctx = this.ctx;
    ctx.sim = sim;
    ctx.page = page;
    ctx.time = sim.time;
    const picture: SensorPictureInfo | null =
      page === 'TGP' ? getSensorPicture('TGP') : page === 'MAV' ? getSensorPicture('MAV') : null;
    ctx.picture = picture;
    if (page === 'DSMS') buildDsmsView(sim, ctx.dsms);
    const video = picture !== null && (picture.valid || picture.status === 'MASKED');
    const b = this.batch;
    const p = this.painter;
    b.begin();
    if (video) {
      // All outlines first: a later stroke's outline must not cut into an earlier stroke.
      p.reset(this.outline);
      drawPage(ctx, p, this.info);
    }
    p.reset(b);
    p.color(MFD_COLOR.green);
    drawPage(ctx, p, this.info);
    b.end();
    this.outlined = video;
    this.quad.visible = picture !== null;
    this.pictureMaterial.uniforms.tPicture.value = picture?.texture ?? null;
    b.setFrame(this.target.width, this.target.height, this.style, this.camera);

    const prevTarget = gl.getRenderTarget();
    const autoClear = gl.autoClear;
    gl.getClearColor(_clear);
    const clearAlpha = gl.getClearAlpha();
    gl.setRenderTarget(this.target);
    gl.setClearColor(0x000000, 1);
    gl.clear(true, false, false);
    gl.autoClear = false;
    gl.render(this.scene, this.camera);
    gl.autoClear = autoClear;
    gl.setClearColor(_clear, clearAlpha);
    gl.setRenderTarget(prevTarget);
    this.draws++;
  }

  dispose(): void {
    this.batch.dispose();
    this.quad.geometry.dispose();
    this.pictureMaterial.dispose();
    this.target.dispose();
  }
}

/** CPU time the displays take (diagnostics: the dev hook and the sandbox). */
export interface MfdStats {
  /** Last frame's `render` call, ms, and its running average (time constant ≈ 1 s at 60 Hz). */
  cpuMs: number;
  cpuMsAvg: number;
  /** Display drawings in the last frame (0, 1 or 2). */
  draws: number;
}

/** Both displays and the message log they share. */
export class MfdRenderer {
  readonly messages = new MessageLog(32);
  readonly left: MfdDisplayRenderer;
  readonly right: MfdDisplayRenderer;
  readonly stats: MfdStats = { cpuMs: 0, cpuMsAvg: 0, draws: 0 };
  /** Real seconds since the renderer started (the schedules' clock). */
  clock = 0;
  private sim: Sim | null = null;

  constructor(size = MFD_RESOLUTION) {
    this.left = new MfdDisplayRenderer('L', this.messages, size);
    this.right = new MfdDisplayRenderer('R', this.messages, size);
  }

  /** Draw what is due on both displays (`dt` real seconds since the last call). */
  render(gl: WebGLRenderer, sim: Sim, dt: number, sensorRate: number): void {
    if (sim !== this.sim) {
      // A new flight: forget the old one's messages and redraw everything.
      this.sim = sim;
      this.messages.clear();
      this.left.schedule.invalidate();
      this.right.schedule.invalidate();
    }
    this.clock += Math.max(0, dt);
    const t0 = performance.now();
    const av = sim.avionics;
    let n = 0;
    if (this.left.update(gl, sim, av.mfd.left, av.soi === 'LMFD', this.clock, sensorRate)) n++;
    if (this.right.update(gl, sim, av.mfd.right, av.soi === 'RMFD', this.clock, sensorRate)) n++;
    const st = this.stats;
    st.cpuMs = performance.now() - t0;
    st.cpuMsAvg += (st.cpuMs - st.cpuMsAvg) * 0.016;
    st.draws = n;
  }

  /** Redraw both displays at the next render (new surfaces). */
  invalidate(): void {
    this.left.schedule.invalidate();
    this.right.schedule.invalidate();
  }

  dispose(): void {
    this.left.dispose();
    this.right.dispose();
  }
}
