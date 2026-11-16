/**
 * Fixed simulation constants. See docs/a10/ARCHITECTURE.md §3 (time and stepping).
 */

/** Every simulation system steps at this fixed rate. */
export const SIM_HZ = 120;
/** One simulation step, seconds. */
export const SIM_DT = 1 / SIM_HZ;
/**
 * A slow frame runs at most this many steps; any further backlog is dropped, so a slow frame
 * slows the simulation down instead of making it unstable.
 */
export const MAX_STEPS_PER_FRAME = 5;

/** Standard gravity, m/s². */
export const G0 = 9.80665;

/** Edge of the square world, m. x and z lie in [-WORLD_HALF, WORLD_HALF]. */
export const WORLD_SIZE = 64000;
export const WORLD_HALF = WORLD_SIZE / 2;
