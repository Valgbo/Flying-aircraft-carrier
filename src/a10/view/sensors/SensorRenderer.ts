/**
 * The targeting pod's and the selected Maverick's pictures (PLAN_A10.md §8, §6.4, §14):
 * offscreen renders of the world scene from each sensor's camera, turned into sensor video.
 * OWNED BY THE SENSOR-VIEW MODULE. Driven by SensorsView's render pass (order 50, before the
 * world pass), no React.
 *
 * Per picture (at most one sensor per frame, at the preset's sensor rate, only while a display
 * shows that sensor's page):
 *   1. SCENE    the world scene from the sensor camera (sensorPose.ts) into a half-float target
 *               with a depth texture, at the sensor's EFFECTIVE resolution (the detector's
 *               pixels across the displayed field after electronic zoom, and the optics'
 *               diffraction limit) — television: the normal scene with its haze; infrared: the
 *               thermal hooks on and the sky, clouds and non-thermal overlays left out
 *               (sceneState.ts);
 *   2. SIGNAL   kelvin or luminance per detector pixel, with the infrared atmosphere and sky
 *               from the depth buffer and the detector's noise (sensorShaders.ts);
 *   3. STATS    a few times a second: 64 × 64 samples read back asynchronously for the AGC;
 *   4. DISPLAY  upsampled to the picture size, gain, level, polarity, video noise, into an 8-bit
 *               sRGB target: the published picture (pictures.ts).
 * Masked (pod): no scene, the out-of-focus airframe field. No video (off, warming up, not
 * aligned): black.
 */
import {
  Color,
  DataTexture,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  Matrix3,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  SRGBColorSpace,
  UnsignedByteType,
  UnsignedIntType,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { SensorPicture, TgpState } from '../../core/sensors/types';
import type { Sim } from '../../core/types';
import { CONTRAST, MAVERICK, TGP } from '../../data/sensors';
import { getSim } from '../../state/runtime';
import { a10Env } from '../environment/env';
import type { RenderPassContext } from '../pipeline';
import { getA10Quality, type A10Quality } from '../quality';
import { terrainUniforms } from '../terrain/terrainMaterial';
import {
  agcFromStats,
  AGC_BINS,
  createAgc,
  LUT_SIZE,
  resetAgc,
  stepAgc,
  type AgcState,
  type SensorBand,
} from './agc';
import { publishSensorPicture, type SensorName, type SensorPictureInfo } from './pictures';
import {
  hazeDensity,
  skinRecoveryK,
  skyLevelKelvin,
  skyZenithKelvin,
  sunElevationSine,
  tvLight,
} from './radiometry';
import { createSavedSceneState, enterSensorScene, exitSensorScene } from './sceneState';
import { createSensorSchedule, nextSensorFrame, type SensorDemand } from './schedule';
import {
  createSensorCameraPose,
  maverickCameraPose,
  maverickPicture,
  pictureEffectivePixels,
  tgpCameraPose,
  type SensorCameraPose,
} from './sensorPose';
import {
  createDisplayMaterial,
  createFullscreenTriangle,
  createSignalMaterial,
  createStatsMaterial,
} from './sensorShaders';
import { RADIOMETRY, SENSOR_AGC, SENSOR_NOISE, SENSOR_OPTICS, SENSOR_RENDER } from './sensorViewData';
import {
  hasVideo,
  maverickPictureStatus,
  showsScene,
  tgpPictureStatus,
  type SensorPictureStatus,
} from './validity';

/** Live numbers of one sensor's passes (the sandbox, the performance report). */
export interface SensorPassStats {
  /** Pictures rendered so far. */
  renders: number;
  /** Latest picture: draw calls and triangles (world scene + the picture passes). */
  calls: number;
  triangles: number;
  /** Of which the world scene. */
  sceneCalls: number;
  sceneTriangles: number;
  /** Main-thread time of the latest picture, ms (with `sensorViewOverrides.finish`: GPU too). */
  cpuMs: number;
  /** Moving average of `cpuMs`. */
  cpuMsAvg: number;
  size: number;
  effectivePixels: number;
  band: SensorBand;
  status: SensorPictureStatus | null;
  /** AGC: infrared window (K) or television exposure and black level. */
  agcLo: number;
  agcHi: number;
  exposure: number;
  black: number;
}

function createPassStats(): SensorPassStats {
  return {
    renders: 0,
    calls: 0,
    triangles: 0,
    sceneCalls: 0,
    sceneTriangles: 0,
    cpuMs: 0,
    cpuMsAvg: 0,
    size: 0,
    effectivePixels: 0,
    band: 'IR',
    status: null,
    agcLo: 0,
    agcHi: 0,
    exposure: 0,
    black: 0,
  };
}

export const sensorViewStats: Record<SensorName, SensorPassStats> = {
  TGP: createPassStats(),
  MAV: createPassStats(),
};

/** Development and test switches (sandboxes, measurements). */
export const sensorViewOverrides = {
  /** Render the picture even when no display shows its page. */
  forceTgp: false,
  forceMav: false,
  /** Wait for the GPU after each picture so `cpuMs` includes its execution (measurement only). */
  finish: false,
  /** Most the close-range terrain detail distance may grow with the sensor's magnification. */
  detailScaleMax: 6,
};

let source: () => Sim | null = getSim;

/** Sandboxes only: draw the pictures of this sim instead of the live flight (null: default). */
export function setSensorViewSim(fn: (() => Sim | null) | null): void {
  source = fn ?? getSim;
}

interface Channel {
  name: SensorName;
  camera: PerspectiveCamera;
  pose: SensorCameraPose;
  size: number;
  scene: WebGLRenderTarget | null;
  signal: WebGLRenderTarget | null;
  output: WebGLRenderTarget | null;
  stats: WebGLRenderTarget;
  statsBytes: Uint8Array;
  statsPending: boolean;
  statsBand: SensorBand;
  statsClock: number;
  agc: AgcState;
  /** The AGC's transfer curve as a texture, and the curve version it holds. */
  lut: DataTexture;
  lutVersion: number;
  band: SensorBand;
  picture: SensorPicture;
  fovSetting: string;
  refocus: number;
  lastStatus: SensorPictureStatus | null;
  /** Real seconds since this sensor's last picture. */
  sinceRender: number;
  frame: number;
  fpnSeed: number;
  info: SensorPictureInfo | null;
  passStats: SensorPassStats;
  onStats: () => void;
  onStatsError: () => void;
}

const BLACK = new Color(0, 0, 0);
const _clear = new Color();
const _rot = new Matrix3();

/** Round a picture size to a multiple of 16 pixels. */
function round16(n: number): number {
  return Math.max(16, Math.round(n / 16) * 16);
}

export class SensorRenderer {
  private readonly tgp: Channel;
  private readonly mav: Channel;
  private readonly schedule = createSensorSchedule();
  private readonly demand: SensorDemand = { tgp: false, mav: false };
  private readonly saved = createSavedSceneState();
  private readonly signalMaterial = createSignalMaterial();
  private readonly displayMaterial = createDisplayMaterial();
  private readonly statsMaterial = createStatsMaterial();
  private readonly quadScene = new Scene();
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: Mesh;
  private readonly hist = new Int32Array(AGC_BINS);
  private readonly counts = new Float32Array(LUT_SIZE);
  private disposed = false;

  constructor(private readonly gl: WebGLRenderer) {
    this.quad = new Mesh(createFullscreenTriangle(), this.signalMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.tgp = this.createChannel('TGP', 11);
    this.mav = this.createChannel('MAV', 23);
  }

  private createChannel(name: SensorName, fpnSeed: number): Channel {
    const n = SENSOR_RENDER.statsSize;
    const stats = new WebGLRenderTarget(n, n, {
      type: UnsignedByteType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    stats.texture.name = `a10-${name.toLowerCase()}-stats`;
    const lut = new DataTexture(new Uint8Array(LUT_SIZE * 4), LUT_SIZE, 1, RGBAFormat);
    lut.minFilter = LinearFilter;
    lut.magFilter = LinearFilter;
    lut.needsUpdate = true;
    // the most gain the AGC gives: a uniform scene's noise fills a tenth of the picture
    const pod = name === 'TGP';
    const netd = pod ? SENSOR_NOISE.podNetd : SENSOR_NOISE.maverickIrNetd;
    const fpn = pod ? SENSOR_NOISE.podFpn : SENSOR_NOISE.maverickIrFpn;
    const minSpan = Math.max(SENSOR_AGC.irMinSpan, 10 * Math.hypot(netd, fpn));
    const ch: Channel = {
      name,
      camera: new PerspectiveCamera(4, 1, SENSOR_RENDER.nearMin, SENSOR_RENDER.far),
      pose: createSensorCameraPose(),
      size: 0,
      scene: null,
      signal: null,
      output: null,
      stats,
      statsBytes: new Uint8Array(n * n * 4),
      statsPending: false,
      statsBand: 'IR',
      statsClock: SENSOR_AGC.updateInterval,
      agc: createAgc('IR', minSpan),
      lut,
      lutVersion: -1,
      band: 'IR',
      picture: 'WHOT',
      fovSetting: '',
      refocus: 0,
      lastStatus: null,
      sinceRender: 0,
      frame: 0,
      fpnSeed,
      info: null,
      passStats: sensorViewStats[name],
      onStats: () => {
        ch.statsPending = false;
        if (this.disposed || ch.statsBand !== ch.agc.band) return;
        agcFromStats(ch.agc, ch.statsBytes, n * n, this.hist, this.counts);
      },
      onStatsError: () => {
        ch.statsPending = false;
      },
    };
    return ch;
  }

  /** Make the channel's targets `size` pixels square. */
  private ensureTargets(ch: Channel, size: number): void {
    if (ch.size === size && ch.output) return;
    this.disposeTargets(ch);
    ch.size = size;
    const depth = new DepthTexture(size, size);
    depth.type = UnsignedIntType;
    ch.scene = new WebGLRenderTarget(size, size, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: depth,
      generateMipmaps: false,
    });
    ch.signal = new WebGLRenderTarget(size, size, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    ch.output = new WebGLRenderTarget(size, size, {
      type: UnsignedByteType,
      format: RGBAFormat,
      colorSpace: SRGBColorSpace,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    ch.output.texture.name = `a10-${ch.name.toLowerCase()}-picture`;
    // the new targets hold nothing yet: the AGC starts over with the next picture
    resetAgc(ch.agc, ch.band);
    if (ch.info) ch.info.texture = ch.output.texture;
  }

  private disposeTargets(ch: Channel): void {
    ch.scene?.depthTexture?.dispose();
    ch.scene?.dispose();
    ch.signal?.dispose();
    ch.output?.dispose();
    ch.scene = ch.signal = ch.output = null;
    ch.size = 0;
  }

  /** One frame of the render pass: publish both pictures' state, render at most one. */
  frame(ctx: RenderPassContext): void {
    if (this.disposed) return;
    const sim = source();
    if (!sim) {
      this.publish(this.tgp, null, null);
      this.publish(this.mav, null, null);
      return;
    }
    const quality = getA10Quality();
    const tgpStatus = tgpPictureStatus(sim);
    const mavStatus = maverickPictureStatus(sim);
    this.publish(this.tgp, sim, tgpStatus);
    this.publish(this.mav, sim, mavStatus);

    const mfd = sim.avionics.mfd;
    this.demand.tgp =
      tgpStatus !== null &&
      (mfd.left === 'TGP' || mfd.right === 'TGP' || sensorViewOverrides.forceTgp);
    this.demand.mav =
      mavStatus !== null &&
      (mfd.left === 'MAV' || mfd.right === 'MAV' || sensorViewOverrides.forceMav);
    this.tgp.sinceRender += ctx.dt;
    this.mav.sinceRender += ctx.dt;
    const pick = nextSensorFrame(
      this.schedule,
      ctx.dt,
      this.demand,
      quality.sensorRate,
      quality.sensorRate,
    );
    if (pick === 'TGP' && tgpStatus) this.render(this.tgp, sim, ctx, quality, tgpStatus);
    else if (pick === 'MAV' && mavStatus) this.render(this.mav, sim, ctx, quality, mavStatus);
  }

  /** Keep the published info in step with the sensor state (every frame, cheap). */
  private publish(ch: Channel, sim: Sim | null, status: SensorPictureStatus | null): void {
    if (!sim || status === null) {
      publishSensorPicture(ch.name, null);
      return;
    }
    if (!ch.output) this.ensureTargets(ch, this.sizeFor(ch, getA10Quality()));
    let info = ch.info;
    if (!info) {
      info = ch.info = {
        texture: ch.output!.texture,
        valid: false,
        fov: 0,
        picture: 'WHOT',
        status,
        frame: 0,
        time: 0,
        size: ch.size,
        effectivePixels: 0,
        agcSettled: false,
      };
    }
    info.status = status;
    info.valid = showsScene(status) && ch.frame > 0 && ch.lastStatus === 'OK';
    if (ch.name === 'TGP') {
      info.picture = sim.sensors.tgp.picture;
      info.fov = sim.sensors.tgp.fov;
    } else {
      info.picture = ch.picture;
      info.fov = ch.pose.fov;
    }
    publishSensorPicture(ch.name, info);
  }

  private sizeFor(ch: Channel, quality: A10Quality): number {
    return ch.name === 'TGP'
      ? quality.sensorResolution
      : round16(quality.sensorResolution * SENSOR_RENDER.maverickScale);
  }

  private render(
    ch: Channel,
    sim: Sim,
    ctx: RenderPassContext,
    quality: A10Quality,
    status: SensorPictureStatus,
  ): void {
    const gl = this.gl;
    const glContext = sensorViewOverrides.finish ? gl.getContext() : null;
    glContext?.finish();
    const t0 = performance.now();
    const pose = ch.pose;
    const posed = ch.name === 'TGP' ? tgpCameraPose(sim, pose) : maverickCameraPose(sim, pose);
    if (!posed) return;

    // ---- mode, band, field of view ----
    let picture: SensorPicture;
    let detector: number;
    let wavelength: number;
    let aperture: number;
    let zoom = 1;
    let fovSetting: string;
    // the airframe hides the scene (a gimbal limit does not: the pod sees along its limit)
    let airframeMasked = status === 'MASKED';
    if (ch.name === 'TGP') {
      const tgp = sim.sensors.tgp as TgpState & { maskReason?: string };
      picture = tgp.picture;
      detector = TGP.imagePixels;
      wavelength =
        picture === 'CCD' ? SENSOR_OPTICS.ccdWavelengthUm : SENSOR_OPTICS.podFlirWavelengthUm;
      aperture = SENSOR_OPTICS.podApertureM;
      zoom = tgp.zoom;
      fovSetting = tgp.fovSetting;
      if (tgp.maskReason === 'GIMBAL') airframeMasked = false;
    } else {
      const index = sim.sensors.selectedMaverick;
      picture = maverickPicture(sim, index);
      detector = MAVERICK.imagePixels;
      wavelength =
        picture === 'CCD' ? SENSOR_OPTICS.ccdWavelengthUm : SENSOR_OPTICS.maverickIrWavelengthUm;
      aperture = SENSOR_OPTICS.maverickApertureM;
      fovSetting = sim.sensors.mavericks[index]?.fov ?? 'WIDE';
    }
    const band: SensorBand = picture === 'CCD' ? 'TV' : 'IR';
    const video = hasVideo(status);
    if (band !== ch.band || (video && !hasVideo(ch.lastStatus))) resetAgc(ch.agc, band);
    if (fovSetting !== ch.fovSetting) {
      if (ch.frame > 0) ch.refocus = SENSOR_AGC.refocusTime;
      ch.fovSetting = fovSetting;
    }
    ch.band = band;
    ch.picture = picture;
    ch.lastStatus = status;

    const size = this.sizeFor(ch, quality);
    this.ensureTargets(ch, size);
    const n = pictureEffectivePixels(size, pose.fov, zoom, detector, wavelength, aperture);
    const dt = ch.sinceRender;
    ch.sinceRender = 0;
    stepAgc(ch.agc, dt);
    ch.refocus = Math.max(0, ch.refocus - dt);
    ch.statsClock += dt;
    const state = showsScene(status) || (status === 'MASKED' && !airframeMasked) ? 2 : airframeMasked ? 1 : 0;

    // renderer state we change
    const prevTarget = gl.getRenderTarget();
    const prevAutoClear = gl.autoClear;
    gl.getClearColor(_clear);
    const prevClearAlpha = gl.getClearAlpha();
    gl.autoClear = false;

    const floor = sim.world.terrain.minHeight;
    const visibility = sim.world.visibilityKm;
    // the haze the seekers see through: the environment's law at the sensor's own height
    const rho = hazeDensity(visibility, pose.position.y - floor);
    let sceneCalls = 0;
    let sceneTriangles = 0;

    try {
      // ---- 1. the world scene ----
      if (state === 2) {
        const cam = ch.camera;
        const fovDeg = (pose.fov * 180) / Math.PI;
        if (
          cam.fov !== fovDeg ||
          cam.near !== pose.near ||
          cam.far !== pose.far ||
          cam.aspect !== 1
        ) {
          cam.fov = fovDeg;
          cam.near = pose.near;
          cam.far = pose.far;
          cam.aspect = 1;
          cam.updateProjectionMatrix();
        }
        cam.position.copy(pose.position);
        cam.quaternion.copy(pose.quaternion);
        cam.updateMatrixWorld();
        const target = ch.scene!;
        target.viewport.set(0, 0, n, n);
        target.scissor.set(0, 0, n, n);
        target.scissorTest = true;
        // the outside view's pixel, for the terrain's close-detail distance
        const mainFov = (ctx.camera as PerspectiveCamera).fov ?? 50;
        const mainPixel =
          (2 * Math.tan(((mainFov * Math.PI) / 180) * 0.5)) / Math.max(1, ctx.height);
        const pixel = pose.fov / n;
        const detailScale = Math.min(
          sensorViewOverrides.detailScaleMax,
          Math.max(1, mainPixel / pixel),
        );
        enterSensorScene(
          ctx.scene,
          gl,
          {
            band,
            pixelAngle: pixel,
            near: pose.near,
            detailDistance: terrainUniforms.uDetailDistance.value * detailScale,
            hazeDensity: rho,
          },
          this.saved,
        );
        try {
          gl.setRenderTarget(target);
          gl.setClearColor(BLACK, 0);
          gl.clear(true, true, false);
          const info = gl.info;
          const calls0 = info.autoReset ? 0 : info.render.calls;
          const tris0 = info.autoReset ? 0 : info.render.triangles;
          gl.render(ctx.scene, cam);
          sceneCalls = info.render.calls - calls0;
          sceneTriangles = info.render.triangles - tris0;
        } finally {
          exitSensorScene(ctx.scene, gl, this.saved);
        }
      }

      // ---- 2. signal ----
      const sig = ch.signal!;
      sig.viewport.set(0, 0, n, n);
      sig.scissor.set(0, 0, n, n);
      sig.scissorTest = true;
      const su = this.signalMaterial.uniforms;
      su.tScene.value = ch.scene!.texture;
      su.tDepth.value = ch.scene!.depthTexture;
      su.uRect.value.set(n / size, n / size);
      su.uPixels.value.set(n, n);
      su.uBand.value = band === 'IR' ? 1 : 0;
      su.uState.value = state;
      su.uNear.value = pose.near;
      su.uFar.value = pose.far;
      su.uTanHalf.value = Math.tan(pose.fov * 0.5);
      ch.camera.position.copy(pose.position);
      ch.camera.quaternion.copy(pose.quaternion);
      ch.camera.updateMatrixWorld();
      su.uCamRot.value.copy(_rot.setFromMatrix4(ch.camera.matrixWorld));
      su.uAmbient.value = CONTRAST.ambientLevel;
      su.uKPerUnit.value = CONTRAST.kelvinPerLevel;
      su.uHazeRho.value = rho;
      su.uHazeShare.value = CONTRAST.irHazeShare;
      su.uSkyHorizon.value = skyLevelKelvin();
      su.uSkyZenith.value = skyZenithKelvin(visibility);
      su.uSkyBase.value = 1 - RADIOMETRY.skyZenithEmissivity;
      su.uMaskK.value = skinRecoveryK(sim.aircraft.velocity.length());
      su.uMaskLum.value =
        (0.25 / Math.PI) *
        (0.2126 * a10Env.ambientColor.r +
          0.7152 * a10Env.ambientColor.g +
          0.0722 * a10Env.ambientColor.b);
      const pod = ch.name === 'TGP';
      su.uNetd.value = pod ? SENSOR_NOISE.podNetd : SENSOR_NOISE.maverickIrNetd;
      su.uFpn.value = pod ? SENSOR_NOISE.podFpn : SENSOR_NOISE.maverickIrFpn;
      su.uFpnRows.value = pod ? 0 : 1;
      su.uFpnSeed.value = ch.fpnSeed;
      // photo-electrons per unit luminance: fewer toward dusk, when a TV seeker loses its lock
      su.uElectrons.value =
        ((pod ? SENSOR_NOISE.podCcdElectrons : SENSOR_NOISE.maverickTvElectrons) *
          Math.max(0.002, tvLight(sunElevationSine(sim.world.timeOfDay)))) /
        SENSOR_NOISE.daylightLuminance;
      su.uRead.value = SENSOR_NOISE.readNoise;
      su.uFrame.value = ch.frame + 1;
      this.quad.material = this.signalMaterial;
      gl.setRenderTarget(sig);
      gl.render(this.quadScene, this.quadCamera);

      // ---- 3. statistics for the AGC (asynchronous readback) ----
      let passes = 2;
      if (state > 0 && !ch.statsPending && ch.statsClock >= SENSOR_AGC.updateInterval) {
        const stu = this.statsMaterial.uniforms;
        stu.tSignal.value = sig.texture;
        stu.uRect.value.set(n / size, n / size);
        stu.uBand.value = band === 'IR' ? 1 : 0;
        this.quad.material = this.statsMaterial;
        gl.setRenderTarget(ch.stats);
        gl.render(this.quadScene, this.quadCamera);
        passes++;
        ch.statsClock = 0;
        ch.statsPending = true;
        ch.statsBand = band;
        const s = SENSOR_RENDER.statsSize;
        gl.readRenderTargetPixelsAsync(ch.stats, 0, 0, s, s, ch.statsBytes).then(
          ch.onStats,
          ch.onStatsError,
        );
        // three leaves its pixel-pack buffer bound while the read completes: unbind it, or any
        // synchronous readPixels meanwhile (anyone's) fails; it binds it again to finish
        const raw = gl.getContext() as WebGL2RenderingContext;
        raw.bindBuffer(raw.PIXEL_PACK_BUFFER, null);
      }

      // ---- 4. the picture ----
      if (ch.lutVersion !== ch.agc.version) {
        const data = ch.lut.image.data as Uint8Array;
        for (let i = 0; i < LUT_SIZE; i++) {
          const v = Math.round(Math.min(1, Math.max(0, ch.agc.lut[i])) * 255);
          data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
          data[i * 4 + 3] = 255;
        }
        ch.lut.needsUpdate = true;
        ch.lutVersion = ch.agc.version;
      }
      const du = this.displayMaterial.uniforms;
      du.tSignal.value = sig.texture;
      du.tLut.value = ch.lut;
      du.uLutSize.value = LUT_SIZE;
      du.uTexSize.value.set(size, size);
      du.uPixels.value.set(n, n);
      du.uOutPixels.value.set(size, size);
      du.uBand.value = band === 'IR' ? 1 : 0;
      du.uState.value = state;
      du.uPolarity.value = picture === 'BHOT' ? 1 : 0;
      du.uLo.value = ch.agc.lo;
      du.uHi.value = ch.agc.hi;
      du.uDispLo.value = SENSOR_AGC.displayLow;
      du.uDispHi.value = SENSOR_AGC.displayHigh;
      du.uExposure.value = ch.agc.exposure;
      du.uBlack.value = ch.agc.black;
      du.uGamma.value = SENSOR_AGC.tvGamma;
      du.uVideo.value = SENSOR_NOISE.video;
      du.uFrame.value = ch.frame + 1;
      du.uBlur.value = (ch.refocus / SENSOR_AGC.refocusTime) * 3;
      du.uSharp.value = n === size ? 1 : 0;
      this.quad.material = this.displayMaterial;
      const out = ch.output!;
      out.scissorTest = false;
      gl.setRenderTarget(out);
      gl.render(this.quadScene, this.quadCamera);

      ch.frame++;
      const st = ch.passStats;
      st.renders++;
      st.sceneCalls = sceneCalls;
      st.sceneTriangles = sceneTriangles;
      st.calls = sceneCalls + passes;
      st.triangles = sceneTriangles + passes;
    } finally {
      gl.setRenderTarget(prevTarget);
      gl.setClearColor(_clear, prevClearAlpha);
      gl.autoClear = prevAutoClear;
    }

    glContext?.finish();
    const st = ch.passStats;
    st.cpuMs = performance.now() - t0;
    st.cpuMsAvg = st.renders <= 1 ? st.cpuMs : st.cpuMsAvg * 0.9 + st.cpuMs * 0.1;
    st.size = size;
    st.effectivePixels = n;
    st.band = band;
    st.status = status;
    st.agcLo = ch.agc.lo;
    st.agcHi = ch.agc.hi;
    st.exposure = ch.agc.exposure;
    st.black = ch.agc.black;
    const info = ch.info;
    if (info) {
      info.frame = ch.frame;
      info.time = sim.time;
      info.size = size;
      info.effectivePixels = n;
      info.picture = picture;
      info.fov = pose.fov;
      info.valid = showsScene(status);
      info.agcSettled = ch.agc.settled;
    }
  }

  /** The latest picture of a sensor as a PNG data URL (development: screenshots). */
  snapshot(sensor: SensorName): string | null {
    const ch = sensor === 'TGP' ? this.tgp : this.mav;
    const out = ch.output;
    if (!out || typeof document === 'undefined') return null;
    const size = ch.size;
    const bytes = new Uint8Array(size * size * 4);
    this.gl.readRenderTargetPixels(out, 0, 0, size, size, bytes);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const c2d = canvas.getContext('2d');
    if (!c2d) return null;
    const img = c2d.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      // GL rows run bottom-up
      const src = (size - 1 - y) * size * 4;
      img.data.set(bytes.subarray(src, src + size * 4), y * size * 4);
    }
    c2d.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  dispose(): void {
    this.disposed = true;
    for (const ch of [this.tgp, this.mav]) {
      this.disposeTargets(ch);
      ch.stats.dispose();
      ch.lut.dispose();
      publishSensorPicture(ch.name, null);
      ch.info = null;
    }
    this.signalMaterial.dispose();
    this.displayMaterial.dispose();
    this.statsMaterial.dispose();
    this.quad.geometry.dispose();
  }
}
