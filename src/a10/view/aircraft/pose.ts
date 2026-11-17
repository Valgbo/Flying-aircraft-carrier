/**
 * Where the drawn aircraft is this frame. OWNED BY THE STORES-VIEW MODULE (wave 2).
 *
 * The simulation steps at 120 Hz while the display runs at 60–165 Hz, so a frame takes 0, 1 or 2
 * steps. Drawn at the last step's pose the aircraft would jump by a whole step (≈1 m at 250 kn)
 * whenever a frame takes 2 and stand still when it takes 0. Drawn at `drawPose` it moves by
 * exactly the real time of each frame, one step (≤ 8.3 ms) behind the simulation, like the
 * cameras and the HUD (docs/a10/ARCHITECTURE.md §6, "Interpolation"; wave-1 review FC-4).
 */
import type { Object3D } from 'three';
import type { Sim } from '../../core/types';
import { drawPose } from '../frame';

/** Place `obj` (the aircraft instance's root, BODY frame) at the aircraft's draw pose. */
export function placeAircraft(obj: Object3D, sim: Sim): void {
  drawPose(sim, obj.position, obj.quaternion);
}
