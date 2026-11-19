/**
 * Collimated HUD symbology, clipped to the combiner glass. OWNED BY THE HUD-MFD MODULE.
 *
 * Registers the `hud` render pass (order 300, docs/a10/ARCHITECTURE.md §6). It runs only in
 * the cockpit view (`cockpitViewState.active`) while a flight exists, after the world (100)
 * and cockpit (200) passes have drawn into the target. See HudRenderer.ts for how the
 * collimation works. The two multifunction displays are `view/mfd/MfdView`, which SceneRoot
 * mounts beside this component.
 */
import { useEffect } from 'react';
import type { Sim } from '../../core/types';
import { getSim } from '../../state/runtime';
import { cockpitViewState } from '../cockpit/cockpitCamera';
import { registerRenderPass } from '../pipeline';
import { HudRenderer } from './HudRenderer';

/** The live HUD renderer, for the sandbox and debugging (null when not mounted). */
export const hudHandle: { current: HudRenderer | null } = { current: null };

/**
 * Create the HUD and register its render pass for as long as the calling component is
 * mounted. `source` returns the simulation to draw (the live flight, or a sandbox's fake one).
 */
export function useHudPass(source: () => Sim | null): void {
  useEffect(() => {
    const hud = new HudRenderer();
    hudHandle.current = hud;
    const unregister = registerRenderPass({
      id: 'hud',
      order: 300,
      enabled: () => cockpitViewState.active && source() !== null,
      render(ctx) {
        const sim = source();
        if (sim) hud.render(ctx, sim);
      },
    });
    return () => {
      unregister();
      hud.dispose();
      if (hudHandle.current === hud) hudHandle.current = null;
    };
  }, [source]);
}

export default function HudView() {
  useHudPass(getSim);
  return null;
}
