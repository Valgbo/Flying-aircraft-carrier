/**
 * Where the listener (the active camera) is, for code outside the <Canvas> such as audio.
 * FOUNDATION-OWNED (docs/a10/ARCHITECTURE.md §6). RenderPipeline copies the world camera's pose
 * here every frame, after the camera rig has placed it; nobody else writes it.
 */
import { Quaternion, Vector3 } from 'three';

export interface ListenerPose {
  /** World position of the camera, m. */
  position: Vector3;
  /** World orientation of the camera (three.js camera: looks along its local -Z). */
  quaternion: Quaternion;
  /** World velocity of the camera, m/s (finite difference). */
  velocity: Vector3;
  /** True when the camera is inside the cockpit (view 'cockpit'). */
  inCockpit: boolean;
}

export const listenerPose: ListenerPose = {
  position: new Vector3(),
  quaternion: new Quaternion(),
  velocity: new Vector3(),
  inCockpit: true,
};
