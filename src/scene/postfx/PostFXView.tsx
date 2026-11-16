/**
 * PostFXView — the post-processing chain as a component, gated by `enabled`:
 *
 *   [pre-effects] → bloom (optional) → vignette → ACES tone mapping
 *
 * Carrier-free: every input comes in as a prop (src/engine re-exports it); the carrier's
 * `PostFX` passes its quality preset, its sim clock and its heat distortion.
 *
 * Tone-mapping ownership (docs/ARCHITECTURE.md, rendering rules): while the chain is mounted
 * the renderer uses NoToneMapping and the chain tone-maps; while it is not, the renderer
 * tone-maps with ACES itself. Exposure is 1 in both paths, so with and without the chain the
 * picture has the same brightness and the chain merely adds glow. Previous renderer values are
 * restored on unmount.
 *
 * The chain renders the frame itself from a useFrame at priority 1 (which switches R3F's own
 * render off while it is mounted).
 */
import { useFrame, useThree } from '@react-three/fiber';
import type { Effect } from 'postprocessing';
import { useLayoutEffect, useRef } from 'react';
import { ACESFilmicToneMapping, NoToneMapping, type PerspectiveCamera } from 'three';
import { createPostChain, type PostChain } from './chain';

/** Frame priority of the composer (docs/ARCHITECTURE.md, frame order). */
const RENDER_PRIORITY = 1;
const EXPOSURE = 1;

export interface PostFXViewProps {
  /** Mount the chain (false: the renderer tone-maps by itself and R3F renders the frame). */
  enabled: boolean;
  bloom: boolean;
  /** MSAA samples of the scene buffer (0 = off). */
  multisampling: number;
  /** Seconds to hand the composer each frame (its effects' time uniform). */
  getDelta: () => number;
  /**
   * Builds the effects that run before bloom, for a camera (the chain owns and disposes them).
   * Must be a stable reference: a new function rebuilds the chain.
   */
  createPreEffects?: ((camera: PerspectiveCamera) => Effect[]) | null;
}

interface ComposerProps {
  bloom: boolean;
  multisampling: number;
  getDelta: () => number;
  createPreEffects: ((camera: PerspectiveCamera) => Effect[]) | null;
}

function Composer({ bloom, multisampling, getDelta, createPreEffects }: ComposerProps) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const dpr = useThree((state) => state.viewport.dpr);
  const chainRef = useRef<PostChain | null>(null);

  // Layout effects run before the next frame, so there is never a frame without a chain;
  // creating and disposing in the same effect keeps StrictMode's double mount leak-free.
  useLayoutEffect(() => {
    const perspective = camera as PerspectiveCamera;
    const chain = createPostChain(gl, scene, perspective, {
      bloom,
      multisampling,
      preEffects: createPreEffects ? createPreEffects(perspective) : undefined,
    });
    chainRef.current = chain;
    return () => {
      chainRef.current = null;
      chain.dispose();
    };
  }, [gl, scene, camera, bloom, createPreEffects, multisampling]);

  // canvas resize and device-pixel-ratio changes (also sizes a freshly built chain)
  useLayoutEffect(() => {
    chainRef.current?.setSize(size.width, size.height);
  }, [size, dpr, gl, scene, camera, bloom, createPreEffects, multisampling]);

  useFrame(() => {
    const chain = chainRef.current;
    if (chain) chain.render(getDelta());
    else gl.render(scene, camera);
  }, RENDER_PRIORITY);

  return null;
}

export default function PostFXView({
  enabled,
  bloom,
  multisampling,
  getDelta,
  createPreEffects = null,
}: PostFXViewProps) {
  const gl = useThree((state) => state.gl);

  useLayoutEffect(() => {
    const previousToneMapping = gl.toneMapping;
    const previousExposure = gl.toneMappingExposure;
    gl.toneMapping = enabled ? NoToneMapping : ACESFilmicToneMapping;
    gl.toneMappingExposure = EXPOSURE;
    return () => {
      gl.toneMapping = previousToneMapping;
      gl.toneMappingExposure = previousExposure;
    };
  }, [gl, enabled]);

  if (!enabled) return null;
  return (
    <Composer
      bloom={bloom}
      multisampling={multisampling}
      getDelta={getDelta}
      createPreEffects={createPreEffects}
    />
  );
}
