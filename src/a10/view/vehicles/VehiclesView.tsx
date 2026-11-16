/**
 * Ground vehicles: models, damage states, dust, exhaust. OWNED BY THE VEHICLES-AND-EFFECTS MODULE
 * (docs/a10/ARCHITECTURE.md §11).
 *
 * Mounted by SceneRoot. Draws `sim.targets.vehicles` every frame at visual priority 0 (after the
 * camera rig), with one instanced draw per kind and level of detail (VehicleRenderer). Listens to
 * the simulation's events for where heavy hits land, and emits dust and exhaust into the shared
 * effects particle system. The thermal rendering hook for the sensors is in `thermal.ts`.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { acquireFx, detailForBudget, getFx, releaseFx } from '../effects/fx';
import { viewSim } from '../effects/simSource';
import { frameInfo, onSimFrame } from '../frame';
import { getA10Quality } from '../quality';
import { VehicleRenderer } from './VehicleRenderer';

let current: VehicleRenderer | null = null;

/** The live vehicle renderer (stats for sandboxes and budget checks), or null. */
export function getVehicleRenderer(): VehicleRenderer | null {
  return current;
}

export default function VehiclesView() {
  const scene = useThree((s) => s.scene);
  const renderer = useRef<VehicleRenderer | null>(null);

  useEffect(() => {
    const r = new VehicleRenderer();
    renderer.current = r;
    current = r;
    acquireFx();
    scene.add(r.root);
    const off = onSimFrame((events, sim) => r.onEvents(events, sim));
    return () => {
      off();
      r.dispose();
      releaseFx();
      if (current === r) current = null;
      renderer.current = null;
    };
  }, [scene]);

  useFrame((state) => {
    const r = renderer.current;
    if (!r) return;
    const quality = getA10Quality();
    const fx = getFx();
    r.update(viewSim(), frameInfo.simDt, state.camera, quality, fx ? fx.ps : null, detailForBudget(quality.particles));
  });

  return null;
}
