/** Which view the rig shows for a given screen and camera mode. Pure. */
import type { CameraMode, Screen } from '../../state/types';

/**
 * `menu` and `hangar` are orbit cameras with their own behaviour; on the flying screens the
 * view is the selected camera mode.
 */
export type ViewKind = 'menu' | 'hangar' | CameraMode;

export function resolveView(screen: Screen, mode: CameraMode): ViewKind {
  if (screen === 'menu') return 'menu';
  if (screen === 'hangar') return 'hangar';
  return mode;
}

/** Exterior views must stay above the sea and outside the ship; deck and bridge ride on it. */
export function isExteriorView(view: ViewKind): boolean {
  return view !== 'deck' && view !== 'bridge';
}

/**
 * Menu and hangar share one orbit, so moving between them continues the motion instead of
 * re-settling it.
 */
export function sharesOrbit(a: ViewKind | null, b: ViewKind): boolean {
  return (a === 'menu' && b === 'hangar') || (a === 'hangar' && b === 'menu');
}
