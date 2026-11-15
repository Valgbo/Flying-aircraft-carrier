/**
 * HangarHotspots — the in-canvas half of the hangar hotspots (mounted on the hangar screen).
 * Every frame, once the camera rig has placed the camera, it projects the HOTSPOTS anchors
 * (carrier-local → world → screen) and publishes position, depth and visibility through
 * src/ui/shell/hotspotProjection.ts, where the DOM pins of HangarOverlay pick them up in the
 * same frame. It also shifts the picture (a camera view offset, no change of pose) so that
 * whatever the rig centres — the ship or the selected hotspot — sits in the middle of the area
 * the info card and the bottom sheets leave free. Renders nothing.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import {
  clearHotspotProjections,
  hangarObstruction,
  projectHotspots,
} from '../ui/shell/hotspotProjection';

/** Time constant of the picture shift when a panel opens or closes, s. */
const SHIFT_SMOOTH_TIME = 0.22;
/** Below this the shift counts as arrived / as zero, px. */
const SHIFT_EPSILON = 0.25;

export default function HangarHotspots() {
  const camera = useThree((state) => state.camera);
  // the eased shift of the picture, px (right / down positive), and what the camera carries
  const shift = useRef({ x: 0, y: 0, appliedX: 0, appliedY: 0, width: 0, height: 0 });

  // Default priority (0): after the camera rig (FRAME_PRIORITY.camera) has written this
  // frame's pose and before the frame is drawn. A positive priority is not an option — it
  // would switch off the renderer's own draw call.
  useFrame(({ camera: view, size }, delta) => {
    const s = shift.current;
    const { insets } = hangarObstruction;
    const targetX = (insets.left - insets.right) / 2;
    const targetY = (insets.top - insets.bottom) / 2;
    const blend = 1 - Math.exp(-delta / SHIFT_SMOOTH_TIME);
    s.x += (targetX - s.x) * blend;
    s.y += (targetY - s.y) * blend;
    if (Math.abs(targetX - s.x) < SHIFT_EPSILON) s.x = targetX;
    if (Math.abs(targetY - s.y) < SHIFT_EPSILON) s.y = targetY;

    if (
      s.x !== s.appliedX ||
      s.y !== s.appliedY ||
      size.width !== s.width ||
      size.height !== s.height
    ) {
      s.appliedX = s.x;
      s.appliedY = s.y;
      s.width = size.width;
      s.height = size.height;
      // the view window moves against the shift it produces in the picture
      if (s.x === 0 && s.y === 0) view.clearViewOffset();
      else view.setViewOffset(size.width, size.height, -s.x, -s.y, size.width, size.height);
    }

    // The renderer refreshes the camera matrices only when it draws; the projection needs
    // the pose of THIS frame, so bring them up to date first (parents included).
    view.updateWorldMatrix(true, false);
    projectHotspots(view, size);
  });

  // leaving the hangar hands the camera back unshifted and hides the pins instead of
  // freezing them at their last position
  useEffect(
    () => () => {
      camera.clearViewOffset();
      clearHotspotProjections();
    },
    [camera],
  );

  return null;
}
