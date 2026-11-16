/**
 * RenderPipeline — renders the registered passes in order every frame (priority 1, which turns
 * off R3F's automatic render). Registers the default WORLD pass. FOUNDATION-OWNED.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { Vector2 } from 'three';
import { A10_PRIORITY } from './frame';
import { getRenderPasses, registerRenderPass, type RenderPassContext } from './pipeline';

const _size = new Vector2();

export default function RenderPipeline() {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    return registerRenderPass({
      id: 'world',
      order: 100,
      render(ctx) {
        ctx.gl.setRenderTarget(ctx.target);
        ctx.gl.autoClear = false;
        ctx.gl.clear(true, true, true);
        ctx.gl.render(ctx.scene, ctx.camera);
      },
    });
  }, []);

  useFrame((state, delta) => {
    const size = gl.getDrawingBufferSize(_size);
    const ctx: RenderPassContext = {
      gl,
      scene: state.scene,
      camera: state.camera,
      width: size.x,
      height: size.y,
      target: null,
      dt: delta,
    };
    const passes = getRenderPasses();
    for (const p of passes) {
      if (p.prepareTarget && (p.enabled?.() ?? true))
        ctx.target = p.prepareTarget(ctx) ?? ctx.target;
    }
    for (const p of passes) {
      if (p.enabled && !p.enabled()) continue;
      p.render(ctx);
    }
    gl.setRenderTarget(null);
  }, A10_PRIORITY.render);

  return null;
}
