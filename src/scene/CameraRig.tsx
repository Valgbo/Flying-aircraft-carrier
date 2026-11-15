/** CameraRig — PLACEHOLDER: slow orbit in idle scenes, fixed chase view while flying. */
import { useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';
import { FRAME_PRIORITY } from '../config/frame';
import { sim } from '../state/sim';
import { isFlyingScreen, useGameStore } from '../state/useGameStore';

const _offset = new Vector3();
const _target = new Vector3();

export default function CameraRig() {
  useFrame(({ camera, clock }) => {
    const flying = isFlyingScreen(useGameStore.getState().screen);
    const c = sim.carrier;
    if (flying) {
      _offset.set(0, 110, 430).applyQuaternion(c.quaternion);
    } else {
      const a = clock.elapsedTime * 0.06 + 0.7;
      _offset.set(Math.sin(a) * 430, 120, Math.cos(a) * 430);
    }
    camera.position.copy(c.position).add(_offset);
    _target.copy(c.position);
    camera.lookAt(_target);
    sim.camera.position.copy(camera.position);
    sim.camera.quaternion.copy(camera.quaternion);
  }, FRAME_PRIORITY.camera);
  return null;
}
