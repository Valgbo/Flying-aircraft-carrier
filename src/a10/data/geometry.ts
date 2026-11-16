/**
 * Aircraft geometry the simulation needs, in the BODY frame (m, origin = reference CG; +X right,
 * +Y up, -Z nose). Owned by the AIRCRAFT (asset pipeline) module, which replaces the stand-in
 * values with values measured on the converted FlightGear model (public/a10/models/a10-meta.json)
 * and records how they were measured.
 */
export const A10_GEOMETRY = {
  /** Muzzle of the firing barrel (on the centreline, below the nose). */
  muzzle: { x: 0, y: -0.75, z: -8.9 },
  /** Pilot's design eye point. */
  eye: { x: 0, y: 1.05, z: -4.15 },
  /** HUD combiner glass centre and size (width, height), m. */
  hudCenter: { x: 0, y: 1.0, z: -4.75 },
  hudSize: { width: 0.17, height: 0.15 },
  /** Station positions, index 1..11 (0 unused). */
  stations: [
    null,
    { x: -7.0, y: -0.35, z: 0.1 },
    { x: -5.6, y: -0.4, z: 0.1 },
    { x: -4.1, y: -0.45, z: 0.0 },
    { x: -2.2, y: -0.75, z: -0.4 },
    { x: -0.9, y: -1.0, z: -0.4 },
    { x: 0, y: -1.05, z: -0.4 },
    { x: 0.9, y: -1.0, z: -0.4 },
    { x: 2.2, y: -0.75, z: -0.4 },
    { x: 4.1, y: -0.45, z: 0.0 },
    { x: 5.6, y: -0.4, z: 0.1 },
    { x: 7.0, y: -0.35, z: 0.1 },
  ],
} as const;
