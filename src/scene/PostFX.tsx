/**
 * PostFX — the post-processing chain, gated by the quality preset:
 *
 *   heat distortion (quality.heatDistortion) → bloom (quality.bloom) → vignette → ACES tone mapping
 *
 * Tone-mapping ownership (docs/ARCHITECTURE.md, rendering rules): while the chain is
 * mounted the renderer uses NoToneMapping and the chain tone-maps; while it is not (Low
 * preset) the renderer tone-maps with ACES itself. Exposure is 1 in both paths, so Low and
 * High match in brightness and High merely adds glow. Previous renderer values are restored
 * on unmount.
 *
 * The chain renders the frame itself from a useFrame at priority 1 (which switches R3F's
 * own render off while it is mounted).
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useLayoutEffect, useRef } from 'react';
import { ACESFilmicToneMapping, NoToneMapping, type PerspectiveCamera } from 'three';
import { sim } from '../state/sim';
import { useQuality } from '../state/useQuality';
import { createPostChain, type PostChain } from './postfx/chain';

/** Frame priority of the composer (docs/ARCHITECTURE.md, frame order). */
const RENDER_PRIORITY = 1;
const EXPOSURE = 1;
/** MSAA samples of the scene buffer when the preset has anti-aliasing. */
const MSAA_SAMPLES = 4;

interface ComposerProps {
  bloom: boolean;
  heatDistortion: boolean;
  multisampling: number;
}

function Composer({ bloom, heatDistortion, multisampling }: ComposerProps) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const dpr = useThree((state) => state.viewport.dpr);
  const chainRef = useRef<PostChain | null>(null);

  // Layout effects run before the next frame, so there is never a frame without a chain;
  // creating and disposing in the same effect keeps StrictMode's double mount leak-free.
  useLayoutEffect(() => {
    const chain = createPostChain(gl, scene, camera as PerspectiveCamera, {
      bloom,
      heatDistortion,
      multisampling,
    });
    chainRef.current = chain;
    return () => {
      chainRef.current = null;
      chain.dispose();
    };
  }, [gl, scene, camera, bloom, heatDistortion, multisampling]);

  // canvas resize and device-pixel-ratio changes (also sizes a freshly built chain)
  useLayoutEffect(() => {
    chainRef.current?.setSize(size.width, size.height);
  }, [size, dpr, gl, scene, camera, bloom, heatDistortion, multisampling]);

  useFrame(() => {
    const chain = chainRef.current;
    if (chain) chain.render(sim.dt);
    else gl.render(scene, camera);
  }, RENDER_PRIORITY);

  return null;
}

export default function PostFX() {
  const quality = useQuality();
  const gl = useThree((state) => state.gl);
  const enabled = quality.postprocessing;

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
      bloom={quality.bloom}
      heatDistortion={quality.heatDistortion}
      multisampling={quality.antialias ? MSAA_SAMPLES : 0}
    />
  );
}
