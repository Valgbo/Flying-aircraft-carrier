/**
 * The cockpit scene and the camera at the pilot's head, both in BODY coordinates
 * (docs/a10/ARCHITECTURE.md §6). Interface FIXED by the foundation; the COCKPIT module owns the
 * values: its camera rig sets the head pose and field of view every frame (priority camera),
 * its cockpit pass renders `cockpitScene` with `cockpitCamera`. The HUD module reads the
 * camera to draw collimated symbology from the same eye.
 */
import { PerspectiveCamera, Scene } from 'three';
import { A10_GEOMETRY } from '../../data/geometry';

/** Everything drawn in body coordinates in the cockpit pass (cockpit, own airframe from inside). */
export const cockpitScene = new Scene();
cockpitScene.name = 'cockpit';

/** The pilot's head: position in body metres, orientation relative to the body axes. */
export const cockpitCamera = new PerspectiveCamera(62, 16 / 9, 0.03, 40);
cockpitCamera.name = 'cockpit-camera';
cockpitCamera.position.set(A10_GEOMETRY.eye.x, A10_GEOMETRY.eye.y, A10_GEOMETRY.eye.z);

/** True while the cockpit view is active and the cockpit/HUD passes should draw. */
export const cockpitViewState = { active: true };
