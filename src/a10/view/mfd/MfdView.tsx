/**
 * The A-10C multifunction displays (ARCHITECTURE §12.7). OWNED BY THE HUD-MFD MODULE.
 *
 * Registers the `mfd` render pass (order 99: the end of the offscreen band, after the sensor
 * pictures of orders 0–98 and before the world and cockpit passes), which composes each display's
 * page into its render target when due, and hands the two targets to the cockpit's display
 * surfaces (`onDisplaySurfaces` → `DisplaySurface.setPicture`). Cockpit view only: elsewhere the
 * displays are not seen and nothing is drawn. The flight's `message` events feed the MSG page.
 */
import { useEffect } from 'react';
import type { Sim } from '../../core/types';
import { getSim } from '../../state/runtime';
import { cockpitViewState } from '../cockpit/cockpitCamera';
import { onDisplaySurfaces, type DisplaySurface } from '../cockpit/displays';
import { onSimFrame } from '../frame';
import { registerRenderPass } from '../pipeline';
import { getA10Quality } from '../quality';
import { MfdRenderer } from './MfdRenderer';

/** Render-pass order of the display composition. */
export const MFD_PASS_ORDER = 99;

/** The live displays, for the sandbox and debugging (null when not mounted). */
export const mfdHandle: { current: MfdRenderer | null } = { current: null };

/**
 * Create the displays and register their pass for as long as the calling component is mounted.
 * `source` returns the simulation to show (the live flight, or a sandbox's).
 */
export function useMfdPass(source: () => Sim | null): void {
  useEffect(() => {
    const mfd = new MfdRenderer();
    mfdHandle.current = mfd;
    const held: { surfaces: { left: DisplaySurface; right: DisplaySurface } | null } = {
      surfaces: null,
    };
    const offSurfaces = onDisplaySurfaces((d) => {
      held.surfaces = d;
      d.left.setPicture(mfd.left.target.texture);
      d.right.setPicture(mfd.right.target.texture);
      mfd.invalidate();
    });
    const offMessages = onSimFrame((events, sim) => {
      if (sim === source()) mfd.messages.addEvents(events);
    });
    const unregister = registerRenderPass({
      id: 'mfd',
      order: MFD_PASS_ORDER,
      enabled: () => cockpitViewState.active && held.surfaces !== null && source() !== null,
      render(ctx) {
        const sim = source();
        if (sim) mfd.render(ctx.gl, sim, ctx.dt, getA10Quality().sensorRate);
      },
    });
    return () => {
      unregister();
      offMessages();
      offSurfaces();
      const s = held.surfaces;
      if (s) {
        s.left.setPicture(null);
        s.right.setPicture(null);
      }
      mfd.dispose();
      if (mfdHandle.current === mfd) mfdHandle.current = null;
    };
  }, [source]);
}

export default function MfdView() {
  useMfdPass(getSim);
  return null;
}
