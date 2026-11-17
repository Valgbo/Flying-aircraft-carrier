/**
 * Targeting-pod and Maverick sensor pictures (PLAN_A10.md §8, §6.4; ARCHITECTURE §12.7).
 * OWNED BY THE SENSOR-VIEW MODULE. Mounted by SceneRoot.
 *
 * Registers the offscreen render pass 'sensors' (order 50, before the world pass): each frame it
 * publishes both pictures' state (`getSensorPicture`, pictures.ts) and renders at most one of
 * them, at the preset's sensor resolution and rate, only while a display shows that sensor's
 * page (`sim.avionics.mfd`). See SensorRenderer.ts for the passes.
 *
 * Development (dev server only): `window.__A10_SENSORS__ = { stats, overrides, snapshot(sensor) }`
 * — live numbers per pass, switches to force the pictures, and a PNG of the latest picture.
 */
import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { registerRenderPass } from '../pipeline';
import type { SensorName } from './pictures';
import { SensorRenderer, sensorViewOverrides, sensorViewStats } from './SensorRenderer';

/** Order of the sensor pass among the offscreen passes (0–99). */
export const SENSOR_PASS_ORDER = 50;

export default function SensorsView() {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const renderer = new SensorRenderer(gl);
    const unregister = registerRenderPass({
      id: 'sensors',
      order: SENSOR_PASS_ORDER,
      render: (ctx) => renderer.frame(ctx),
    });
    const w =
      import.meta.env.DEV && typeof window !== 'undefined'
        ? (window as unknown as { __A10_SENSORS__?: unknown })
        : null;
    if (w) {
      w.__A10_SENSORS__ = {
        stats: sensorViewStats,
        overrides: sensorViewOverrides,
        snapshot: (sensor: SensorName) => renderer.snapshot(sensor),
      };
    }
    return () => {
      unregister();
      renderer.dispose();
      if (w) delete w.__A10_SENSORS__;
    };
  }, [gl]);

  return null;
}
