/**
 * The exterior aircraft in the world scene: the converted FlightGear A-10 with its control
 * surfaces, flaps, slats, speed brakes, gear, fans, gun barrels, night lights and the stores on
 * its stations, all driven by the simulation. OWNED BY THE AIRCRAFT MODULE.
 *
 * Drawn in the outside views only; in the cockpit view the cockpit module draws a forCockpit
 * instance (createAircraftInstance) in its own pass. Nothing is drawn before the models load.
 * Stores in flight are drawn by the weapons view with createStoreInstance / getStoreTemplate.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useState } from 'react';
import type { PerspectiveCamera } from 'three';
import {
  createAircraftInstance,
  disposeAircraftInstance,
  onAircraftTemplates,
  setAircraftShadows,
  updateAircraftDetail,
  updateAircraftInstance,
  type AircraftInstance,
} from '../../assets';
import { getSim } from '../../state/runtime';
import { useA10Store } from '../../state/store';
import { a10Env } from '../environment/env';
import { getA10Quality } from '../quality';

export default function AircraftView() {
  const scene = useThree((s) => s.scene);
  const [inst, setInst] = useState<AircraftInstance | null>(null);

  useEffect(() => {
    let created: AircraftInstance | null = null;
    const off = onAircraftTemplates(() => {
      created = createAircraftInstance({ forCockpit: false });
      created.root.visible = false;
      setInst(created);
    });
    return () => {
      off();
      if (created) disposeAircraftInstance(created);
    };
  }, []);

  useEffect(() => {
    if (!inst) return;
    scene.add(inst.root);
    return () => {
      scene.remove(inst.root);
    };
  }, [inst, scene]);

  useFrame((state) => {
    if (!inst) return;
    const sim = getSim();
    const outside = useA10Store.getState().view !== 'cockpit';
    inst.root.visible = !!sim && outside;
    if (!sim || !outside) return;
    inst.root.position.copy(sim.aircraft.position);
    inst.root.quaternion.copy(sim.aircraft.orientation);
    const q = getA10Quality();
    setAircraftShadows(inst, q.shadows && q.level === 'high');
    updateAircraftInstance(inst, sim, a10Env.daylight);
    // the camera rig ran before (priority −20): no pilot or cockpit when they would be specks
    const cam = state.camera as PerspectiveCamera;
    updateAircraftDetail(inst, cam.position, cam.fov ?? 62, state.size.height);
  });

  return null;
}
