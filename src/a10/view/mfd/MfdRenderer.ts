/**
 * The two multifunction displays drawn on the GPU (ARCHITECTURE §12.7, §6): each display
 * composes its page — the sensor picture underneath on the TGP and MAV pages, the page's strokes
 * on top (one instanced draw call through the HUD's line batch, with the display palette) — into
 * its own render target, shown in the cockpit with `DisplaySurface.setPicture`.
 *
 * Colour: the render target stores 8-bit sRGB (hardware encodes on write and decodes on read),
 * holding LINEAR colours like any other texture: the cockpit's unlit, not tone-mapped screen
 * material shows them as they are. The sensor picture is taken as display-referred linear
 * values and clamped to 0..1.
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
  MFD_RATES,
  MFD_RESOLUTION,
} from './mfdLayout';
import { MfdPainter } from './painter';

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
  private readonly quad: Mesh;
  private readonly pictureMaterial: ShaderMaterial;
  private readonly style: LineStyle = {
    color: MFD_COLORS.green.clone(),
    lineWidth: MFD_LINE_WIDTH,
    opacity: 1,
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

  /** Build the page's strokes and render the display. */
  compose(gl: WebGLRenderer, sim: Sim, page: MfdPage): void {
    const ctx = this.ctx;
    const picture: SensorPictureInfo | null =
      page === 'TGP' ? getSensorPicture('TGP') : page === 'MAV' ? getSensorPicture('MAV') : null;
    ctx.picture = picture;
    if (page === 'DSMS') buildDsmsView(sim, ctx.dsms);
    const b = this.batch;
    b.begin();
    this.painter.reset(b);
    drawPage(ctx, this.painter, this.info);
    b.end();
    this.quad.visible = picture !== null && picture.valid;
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

/** Both displays and the message log they share. */
export class MfdRenderer {
  readonly messages = new MessageLog(32);
  readonly left: MfdDisplayRenderer;
  readonly right: MfdDisplayRenderer;
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
    const av = sim.avionics;
    this.left.update(gl, sim, av.mfd.left, av.soi === 'LMFD', this.clock, sensorRate);
    this.right.update(gl, sim, av.mfd.right, av.soi === 'RMFD', this.clock, sensorRate);
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
