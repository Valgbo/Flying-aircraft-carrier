/**
 * The post-processing chain: scene → [pre-effects, e.g. heat distortion] → [bloom] → vignette →
 * ACES tone mapping → screen. Built on the `postprocessing` composer directly (the library
 * @react-three/postprocessing wraps) so the chain owns its lifetime: everything it creates —
 * render targets, depth texture, passes, effects — is disposed when it is torn down, which
 * the React wrapper does not do.
 *
 * The scene is rendered into a half-float buffer (HDR survives until tone mapping) with
 * MSAA when the quality preset asks for anti-aliasing. All effects are merged into a single
 * full-screen pass, executed in the order listed above.
 *
 * Carrier-free (src/engine re-exports it): app-specific effects come in as `preEffects`. An
 * app that draws its frame in several passes of its own (the A-10's world, cockpit and HUD)
 * sets `renderScene: false`, draws into `inputBuffer` and then calls `render`.
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
import {
  HalfFloatType,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';

export interface PostChainOptions {
  bloom: boolean;
  /** MSAA samples of the scene buffer (0 = off). */
  multisampling: number;
  /**
   * Effects run first, in this order, before bloom (the carrier's heat distortion). The chain
   * owns them from now on and disposes them with itself.
   */
  preEffects?: readonly Effect[];
  /**
   * Draw `scene` with `camera` into the scene buffer first (default true). false: the caller
   * draws the frame into `inputBuffer` itself before every `render`.
   */
  renderScene?: boolean;
  /** Give the scene buffer a stencil buffer (default false). */
  stencilBuffer?: boolean;
}

export interface PostChain {
  /** Render the frame to the screen. `dt` is simulated seconds (sim.dt). */
  render(dt: number): void;
  /** Match the canvas size in CSS pixels; the drawing-buffer size follows the renderer's pixel ratio. */
  setSize(width: number, height: number): void;
  dispose(): void;
  /** The linear HDR scene buffer the effects read (drawing-buffer size; MSAA when asked). */
  readonly inputBuffer: WebGLRenderTarget;
}

/**
 * Bloom: only real emitters (lights, plumes, the sun) pass the threshold. It sits above the
 * shoulder of the sea's sun glitter (OCEAN.glitterMax) and of sunlit paint, so a low sun on the
 * water or the deck does not grow a halo that washes over the ship.
 */
const BLOOM = {
  luminanceThreshold: 1.7,
  luminanceSmoothing: 0.5,
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
    stencilBuffer: options.stencilBuffer ?? false,
    multisampling: gl.capabilities.isWebGL2 ? options.multisampling : 0,
    frameBufferType: HalfFloatType,
  });
  if (options.renderScene ?? true) composer.addPass(new RenderPass(scene, camera));

  const effects: Effect[] = [];
  if (options.preEffects) effects.push(...options.preEffects);
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
    get inputBuffer() {
      return composer.inputBuffer;
    },
  };
}
