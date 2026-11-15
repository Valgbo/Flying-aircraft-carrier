/**
 * The post-processing chain: scene → [heat distortion] → [bloom] → vignette → ACES tone
 * mapping → screen. Built on the `postprocessing` composer directly (the library
 * @react-three/postprocessing wraps) so the chain owns its lifetime: everything it creates —
 * render targets, depth texture, passes, effects — is disposed when it is torn down, which
 * the React wrapper does not do.
 *
 * The scene is rendered into a half-float buffer (HDR survives until tone mapping) with
 * MSAA when the quality preset asks for anti-aliasing. All effects are merged into a single
 * full-screen pass, executed in the order listed above.
 */
import {
  BlendFunction,
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  type Effect,
} from 'postprocessing';
import { HalfFloatType, type PerspectiveCamera, type Scene, type WebGLRenderer } from 'three';
import { HeatDistortionEffect } from './HeatDistortionEffect';

export interface PostChainOptions {
  bloom: boolean;
  heatDistortion: boolean;
  /** MSAA samples of the scene buffer (0 = off). */
  multisampling: number;
}

export interface PostChain {
  /** Render the frame to the screen. `dt` is simulated seconds (sim.dt). */
  render(dt: number): void;
  /** Match the canvas size in CSS pixels; the drawing-buffer size follows the renderer's pixel ratio. */
  setSize(width: number, height: number): void;
  dispose(): void;
}

/** Bloom: only HDR values (emissives above 1, the sun, hot speculars) pass the threshold. */
const BLOOM = {
  luminanceThreshold: 1.0,
  luminanceSmoothing: 0.12,
  intensity: 0.85,
  radius: 0.72,
  levels: 7,
} as const;

const VIGNETTE = { offset: 0.34, darkness: 0.42 } as const;

export function createPostChain(
  gl: WebGLRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
  options: PostChainOptions,
): PostChain {
  const composer = new EffectComposer(gl, {
    depthBuffer: true,
    stencilBuffer: false,
    multisampling: gl.capabilities.isWebGL2 ? options.multisampling : 0,
    frameBufferType: HalfFloatType,
  });
  composer.addPass(new RenderPass(scene, camera));

  const effects: Effect[] = [];
  if (options.heatDistortion) effects.push(new HeatDistortionEffect(camera));
  if (options.bloom) {
    effects.push(
      new BloomEffect({
        // additive on the linear HDR image, before tone mapping
        blendFunction: BlendFunction.ADD,
        mipmapBlur: true,
        luminanceThreshold: BLOOM.luminanceThreshold,
        luminanceSmoothing: BLOOM.luminanceSmoothing,
        intensity: BLOOM.intensity,
        radius: BLOOM.radius,
        levels: BLOOM.levels,
      }),
    );
  }
  effects.push(new VignetteEffect({ offset: VIGNETTE.offset, darkness: VIGNETTE.darkness }));
  effects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
  composer.addPass(new EffectPass(camera, ...effects));

  return {
    render: (dt) => composer.render(dt),
    setSize: (width, height) => composer.setSize(width, height),
    dispose: () => {
      // disposes every pass (and through the EffectPass every effect), both buffers and the depth texture
      composer.dispose();
      gl.setRenderTarget(null);
    },
  };
}
