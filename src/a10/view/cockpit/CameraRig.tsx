/**
 * Camera rig: cockpit head look and zoom, outside views. OWNED BY THE COCKPIT MODULE.
 * FOUNDATION STAND-IN: the world camera at the pilot's eye, aligned with the aircraft.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import { A10_GEOMETRY } from '../../data/geometry';
import { getSim } from '../../state/runtime';
import { useA10Store } from '../../state/store';
import { A10_PRIORITY } from '../frame';

const _eye = new Vector3();

export default function CameraRig() {
  const camera = useThree((s) => s.camera);
  useFrame(() => {
    const sim = getSim();
    if (!sim) return;
    const ac = sim.aircraft;
    const e = A10_GEOMETRY.eye;
    _eye.set(e.x, e.y, e.z).applyQuaternion(ac.orientation).add(ac.position);
    camera.position.copy(_eye);
    camera.quaternion.copy(ac.orientation);
    const fov = useA10Store.getState().settings.fov;
    if ('fov' in camera && (camera as { fov: number }).fov !== fov) {
      (camera as unknown as { fov: number; updateProjectionMatrix(): void }).fov = fov;
      (camera as unknown as { updateProjectionMatrix(): void }).updateProjectionMatrix();
    }
  }, A10_PRIORITY.camera);
  return null;
}
