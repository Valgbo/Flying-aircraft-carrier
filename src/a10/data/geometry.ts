/**
 * Aircraft geometry the simulation needs, in the BODY frame (m; origin = the reference point
 * R = FlightGear model (7.65, 0, 0.30), i.e. 25 % of the model wing's mean aerodynamic chord on
 * the centreline; +X right, +Y up, -Z nose).
 *
 * Measured on the FlightGear A-10 model (github.com/l0k1/A-10 @ 72da115, GPL) by parsing its AC3D
 * and XML files (see docs/a10/REFERENCE_DATA.md). Mapping from the AC3D file axes (+x aft, +y up,
 * +z left): X = -z_ac, Y = y_ac - 0.30, Z = x_ac - 7.65.
 *
 * Owned by the AIRCRAFT (asset pipeline) module. The values are copied from
 * public/a10/models/a10-meta.json, which scripts/a10/convert-ac3d.mjs writes;
 * tests/unit/a10/assets.node.test.ts fails when the two disagree.
 */
export const A10_GEOMETRY = {
  /**
   * Muzzle of the firing barrel (on the centreline, below the nose): the centre of the barrel
   * mouth at X = 0 on the model's muzzle face (a10-meta.json gun.muzzle; was −0.59, −7.81 before
   * the converter measured the barrel itself).
   */
  muzzle: { x: 0, y: -0.6, z: -7.816 },
  /**
   * Direction of the modelled barrel cluster axis (3.0° below -Z). The simulation's gun line
   * uses GAU8.gunLineDepression from data/gun.ts.
   */
  muzzleDirection: { x: 0, y: -0.0521, z: -0.9986 },
  /** Pilot's design eye point (FlightGear cockpit view 0). */
  eye: { x: 0, y: 1.2, z: -4.45 },
  /** FlightGear's default cockpit view pitch (looking down at the panel), rad. */
  eyeDefaultPitch: (-12.5 * Math.PI) / 180,
  /** FlightGear's default cockpit field of view, degrees, on the WIDER screen axis. */
  eyeDefaultFovDeg: 65,
  /** HUD combiner glass, aft face: centre and size (width, height along the glass), m. */
  hudCenter: { x: 0, y: 1.0776, z: -5.4589 },
  hudSize: { width: 0.2375, height: 0.3302 },
  /** HUD combiner glass corners (aft face): top-left, top-right, bottom-right, bottom-left. */
  hudCorners: [
    { x: -0.1188, y: 1.2334, z: -5.4042 },
    { x: 0.1187, y: 1.2334, z: -5.4042 },
    { x: 0.1187, y: 0.9218, z: -5.5136 },
    { x: -0.1188, y: 0.9218, z: -5.5136 },
  ],
  /** Unit normal of the combiner glass, pointing toward the pilot. */
  hudNormal: { x: 0, y: -0.3313, z: 0.9436 },
  /**
   * Pylon suspension points (pylon bottom), index 1..11 = stations 1 (left wing tip) … 6
   * (centreline) … 11 (right wing tip); index 0 unused. Pylon bottoms slope ≈3° nose-down.
   */
  stations: [
    null,
    { x: -5.894, y: -0.357, z: -0.05 },
    { x: -4.847, y: -0.537, z: -0.05 },
    { x: -3.627, y: -0.676, z: -0.05 },
    { x: -1.681, y: -0.781, z: -0.05 },
    { x: -0.565, y: -0.783, z: -0.05 },
    { x: 0.003, y: -0.783, z: -0.05 },
    { x: 0.565, y: -0.783, z: -0.05 },
    { x: 1.681, y: -0.781, z: -0.05 },
    { x: 3.627, y: -0.675, z: -0.05 },
    { x: 4.847, y: -0.537, z: -0.05 },
    { x: 5.894, y: -0.357, z: -0.05 },
  ],
  /** Nose tip and tail cone along Z, and the half-span to the wing tips, m. */
  noseZ: -7.655,
  tailZ: 8.407,
  wingTipX: 8.904,
  /**
   * Lowest point of the fuselage with the gear up (belly), Y, m: its two keels (`hull.belly`).
   * Was −1.64, the bottom of the 600-gal tanks, which the model shows only when they are loaded.
   */
  bellyY: -0.9,
  /** Fin tip height, Y, m. */
  finTopY: 2.455,
  /**
   * Pylon bottom slope about +X, rad (negative = nose down), index as `stations`. Stores hang at
   * this attitude and leave the aircraft with it.
   */
  stationPitch: [
    null,
    -0.0495,
    -0.0524,
    -0.0524,
    -0.0575,
    -0.0509,
    -0.0509,
    -0.0509,
    -0.0575,
    -0.0527,
    -0.0527,
    -0.0495,
  ],
  /**
   * Tyre contact points with the gear down and the struts uncompressed (the FlightGear model's
   * gear stands 0.7 m taller than the real aircraft's), and the wheel radii, m.
   */
  gearContacts: {
    nose: { x: 0.311, y: -2.646, z: -4.796, radius: 0.328 },
    left: { x: -2.677, y: -2.712, z: 0.546, radius: 0.496 },
    right: { x: 2.677, y: -2.712, z: 0.546, radius: 0.496 },
  },
  /** Engines: fan hub (on the spin axis) and the nozzle exit (aft end of the nacelle). */
  engines: [
    { fan: { x: -1.476, y: 0.965, z: 2.134 }, exhaust: { x: -1.476, y: 0.965, z: 5.179 } },
    { fan: { x: 1.476, y: 0.965, z: 2.134 }, exhaust: { x: 1.476, y: 0.965, z: 5.179 } },
  ],
  /** Gun barrel cluster: a point on its spin axis (the front clamp ring), body frame. */
  gunClusterAxisPoint: { x: -0.0489, y: -0.597, z: -7.783 },
  /**
   * Hull points for ground contact with the gear UP, measured on the parts that are always drawn
   * (a10-meta.json `hull`). Points off the centreline are given for the RIGHT side; the left side
   * mirrors X.
   */
  hull: {
    /** Nose tip and tail-cone tip (centreline). */
    noseTip: { x: 0, y: -0.296, z: -7.655 },
    tailTip: { x: 0, y: 0.269, z: 8.407 },
    /** The two keels of the flat belly: the lowest fuselage points (they run aft to z −1.05). */
    belly: { x: 0.661, y: -0.9, z: -1.85 },
    /** Lowest fuselage point aft of the wing (centreline, at the wing-root trailing edge). */
    aftBelly: { x: 0, y: -0.416, z: 3.048 },
    /**
     * Wing tip: the wing's outermost point (beside the nav light; the strobe lens reaches
     * x 8.952), and the tip chord's leading and trailing ends on the lower surface. The trailing
     * end is the lowest point of the tip.
     */
    wingTip: {
      outer: { x: 8.904, y: 0.182, z: 0.964 },
      leading: { x: 8.89, y: 0.038, z: 0.561 },
      trailing: { x: 8.889, y: 0.008, z: 1.796 },
    },
    /**
     * Fin (one of the twin fins): lateral centre, and the top and bottom of the fin at the middle
     * of their chords (the fins reach below the tailplane; the bottom is the lowest aft point).
     */
    fin: {
      x: 2.86,
      top: { x: 2.853, y: 2.455, z: 7.033 },
      bottom: { x: 2.871, y: -0.594, z: 6.493 },
    },
    /**
     * Main-gear pod with the gear up: the retracted wheel stands out below the pod (as on the
     * real aircraft) and is the lowest point of the clean aircraft; the pod's bottom near its
     * front and rear ends.
     */
    gearPod: {
      tyre: { x: 2.678, y: -1.286, z: -1.174 },
      front: { x: 2.43, y: -0.931, z: -1.48 },
      rear: { x: 2.63, y: -0.801, z: 1.092 },
    },
    /** Pave Penny pod under the nose, right of the centreline only (lowest point). */
    pavePenny: { x: 0.713, y: -0.97, z: -4.909 },
  },
} as const;
