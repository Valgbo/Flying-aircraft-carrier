/**
 * useFrame priorities. R3F runs callbacks in ascending priority order every frame.
 * Negative priorities run before the default (0) and do NOT disable automatic rendering
 * (only priorities > 0 do — the post-processing composer uses 1 and renders the frame itself).
 *
 *   physics  → the Rapier world steps (Physics `updatePriority`)
 *   driver   → the active driver copies/derives the carrier state into `sim` and publishes telemetry
 *   systems  → gameplay systems that depend on the fresh carrier state (flight ops, jets, effects logic)
 *   camera   → the camera rig positions the camera from the fresh state
 *   0        → everything visual (default): meshes read `sim` and update themselves
 */
export const FRAME_PRIORITY = {
  physics: -100,
  driver: -90,
  systems: -50,
  camera: -20,
} as const;
