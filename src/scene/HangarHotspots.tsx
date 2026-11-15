/**
 * HangarHotspots — the in-canvas half of the hangar hotspots (mounted on the hangar screen).
 * Every frame, once the camera rig has placed the camera, it projects the HOTSPOTS anchors
 * (carrier-local → world → screen) and publishes position, depth and visibility through
 * src/ui/shell/hotspotProjection.ts, where the DOM pins of HangarOverlay pick them up in the
 * same frame. Renders nothing.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect } from 'react';
import { clearHotspotProjections, projectHotspots } from '../ui/shell/hotspotProjection';

export default function HangarHotspots() {
  // Default priority (0): after the camera rig (FRAME_PRIORITY.camera) has written this
  // frame's pose and before the frame is drawn. A positive priority is not an option — it
  // would switch off the renderer's own draw call.
  useFrame(({ camera, size }) => {
    // The renderer refreshes the camera matrices only when it draws; the projection needs
    // the pose of THIS frame, so bring them up to date first (parents included).
    camera.updateWorldMatrix(true, false);
    projectHotspots(camera, size);
  });

  // leaving the hangar hides the pins instead of freezing them at their last position
  useEffect(() => clearHotspotProjections, []);

  return null;
}
