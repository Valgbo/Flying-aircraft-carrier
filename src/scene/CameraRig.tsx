/**
 * CameraRig — owns the default camera on every screen and in every camera mode.
 *
 *   menu      slow cinematic auto-orbit, ship composed right of centre
 *   hangar    user orbit (drag / wheel / pinch), eases to the selected hotspot
 *   flying    orbit · chase · deck · bridge · turbine (store.cameraMode)
 *
 * One custom rig (src/scene/camera/rig.ts) drives all of them so every change of mode or
 * screen is a seamless blend. It runs once per frame at FRAME_PRIORITY.camera — after the
 * driver has written the fresh ship state, before any visual reads the camera — and writes
 * `sim.camera.position` / `sim.camera.quaternion`. Pointer input comes from the canvas
 * element only; the DOM overlay keeps its own events.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import type { PerspectiveCamera } from 'three';
import { FRAME_PRIORITY } from '../config/frame';
import { CameraPointerInput } from './camera/pointerInput';
import { CameraRigController } from './camera/rig';

export default function CameraRig() {
  const canvas = useThree((state) => state.gl.domElement);
  const controller = useMemo(() => new CameraRigController(), []);
  const pointer = useMemo(() => new CameraPointerInput(), []);

  useEffect(() => {
    pointer.attach(canvas);
    return () => pointer.detach();
  }, [canvas, pointer]);

  useFrame(({ camera }) => {
    // the Canvas camera is a perspective camera (fov / near / far are set in App.tsx)
    if ((camera as PerspectiveCamera).isPerspectiveCamera) {
      controller.update(camera as PerspectiveCamera, pointer);
    }
  }, FRAME_PRIORITY.camera);

  return null;
}
