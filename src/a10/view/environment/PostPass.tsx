/**
 * The post-processing pass of the A-10 view (High preset only): pass 'post', order 900 in the
 * render pipeline (docs/a10/ARCHITECTURE.md §6).
 *
 * `prepareTarget` hands the world, cockpit and HUD passes one offscreen buffer: half-float
 * (linear HDR — three.js neither tone-maps nor encodes into a render target), 4× MSAA, depth
 * and stencil (the HUD stencils its combiner glass). `render` then runs the carrier's chain
 * (shared through src/engine) on it — bloom (threshold ≈ 1.7, so only the sun, fires, muzzle
 * flash and tracers glow), vignette, ACES — and writes the screen. Without this pass the
 * renderer's own ACES applies, at the same exposure, so presets differ only by glow.
 */
import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { Vector2, type PerspectiveCamera } from 'three';
import { createPostChain } from '../../../engine';
import { registerRenderPass } from '../pipeline';
import { postState } from './envState';

const MSAA_SAMPLES = 4;
const _css = new Vector2();

export default function PostPass() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    const chain = createPostChain(gl, scene, camera as PerspectiveCamera, {
      bloom: true,
      multisampling: MSAA_SAMPLES,
      renderScene: false,
      stencilBuffer: true,
    });
    postState.active = true;
    const unregister = registerRenderPass({
      id: 'post',
      order: 900,
      prepareTarget(ctx) {
        const target = chain.inputBuffer;
        if (target.width !== ctx.width || target.height !== ctx.height) {
          // CSS size: the chain sizes its buffers to the drawing buffer (pixel ratio included)
          gl.getSize(_css);
          chain.setSize(_css.x, _css.y);
        }
        return chain.inputBuffer;
      },
      render(ctx) {
        chain.render(ctx.dt);
      },
    });
    return () => {
      unregister();
      postState.active = false;
      chain.dispose();
    };
  }, [gl, scene, camera]);

  return null;
}
