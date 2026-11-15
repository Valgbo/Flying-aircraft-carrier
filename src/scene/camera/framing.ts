/**
 * Camera framing: every tunable distance, angle and eye point of the rig in one place.
 * Ship coordinates are derived from the layout — never hard-coded.
 *
 * Angle conventions (radians): orbit `yaw` is the azimuth of the camera around its target in
 * the convention of `sphericalOffset` (0 = astern of a north-heading ship, positive toward
 * starboard / +X); `pitch` is the elevation of the camera above its target.
 */
import {
  DECK,
  HOTSPOTS,
  ISLAND,
  LANDING_STRIP,
  TURBINE_MOUNTS,
  type HotspotId,
  type Vec3Tuple,
} from '../../config/layout';
import { DEG2RAD } from '../../utils/math';

/** Seconds a mode / screen change takes to blend. */
export const TRANSITION_TIME = 0.9;

/** Exterior cameras stay at least this far above the local wave height, m. */
export const SEA_CLEARANCE = 2;

/** Vertical field of view per kind of view, degrees. */
export const FOV = {
  exterior: 50,
  deck: 62,
  bridge: 58,
  /** Extra degrees the chase camera opens up at full speed. */
  chaseSpeedGain: 6,
} as const;

/** Pointer drag across the full canvas height turns the view by this many radians. */
export const DRAG_RADIANS = 2.6;
/** Orbit rate of a fully deflected look stick, rad/s. */
export const STICK_RATE = 1.5;

/** Menu: slow cinematic auto-orbit, ship composed right of centre on wide screens. */
export const MENU = {
  distance: 480,
  distanceSwing: 22,
  distanceRate: 0.09,
  /** Azimuth at sim.time = 0: off the starboard bow. */
  yaw0: 140 * DEG2RAD,
  /** rad/s — one revolution in a little over two minutes. */
  yawRate: 0.045,
  pitch: 9.5 * DEG2RAD,
  pitchSwing: 3.5 * DEG2RAD,
  pitchRate: 0.13,
  /** Where the ship centre sits horizontally on wide screens (NDC, 0 = centre, 1 = right edge). */
  shipNdcX: 0.3,
  /** Aspect ratios between which the horizontal composition fades in. */
  shiftAspectMin: 1.05,
  shiftAspectMax: 1.5,
  smoothTime: 0.5,
} as const;

/** Hangar: user orbit around the whole ship or a selected hotspot. */
export const HANGAR = {
  distance: 430,
  minDistance: 110,
  maxDistance: 900,
  /** Azimuth relative to the ship when the hangar is entered without coming from the menu. */
  yaw0: 140 * DEG2RAD,
  pitch: 13 * DEG2RAD,
  /** Low enough to look up at the turbines from underneath … */
  minPitch: -52 * DEG2RAD,
  /** … and high enough for a plan view, without ever reaching the poles. */
  maxPitch: 78 * DEG2RAD,
  /** Seconds without input before the slow auto-rotation resumes. */
  autoDelay: 8,
  /** Seconds over which the auto-rotation fades in once it resumes. */
  autoRamp: 2.5,
  autoRate: 0.05,
  /** Smoothing of user-driven orbit angles (short: responsive but weighty). */
  userSmoothTime: 0.22,
  /** Smoothing while the rig eases to / from a hotspot. */
  easeSmoothTime: 0.75,
  /** How long after a hotspot change the slower easing stays in effect, s. */
  easeDuration: 2.4,
  focusSmoothTime: 0.6,
  distanceSmoothTime: 0.4,
} as const;

/** Free orbit while flying (world-aligned). */
export const FLIGHT_ORBIT = {
  distance: 520,
  minDistance: 110,
  maxDistance: 900,
  /** Initial azimuth relative to dead astern: a rear three-quarter view. */
  yawOffset: 35 * DEG2RAD,
  pitch: 17 * DEG2RAD,
  minPitch: -40 * DEG2RAD,
  maxPitch: 80 * DEG2RAD,
  /** Orbit centre in carrier-local coordinates. */
  focus: [0, 6, 0] as Vec3Tuple,
} as const;

/** Chase camera: behind and above the stern, following the heading only. */
export const CHASE = {
  distance: 400,
  minDistance: 250,
  maxDistance: 900,
  elevation: 14.5 * DEG2RAD,
  minElevation: -20 * DEG2RAD,
  maxElevation: 75 * DEG2RAD,
  /** The look target sits this far ahead of / above the centre of mass, m. */
  lookAhead: 45,
  lookUp: 10,
  yawSmoothTime: 0.6,
  /** Seconds after the last drag before the view starts easing back behind the ship. */
  returnDelay: 0.9,
  returnSmoothTime: 0.65,
  dragSmoothTime: 0.14,
  /** Fraction the distance grows at `speedRef`. */
  speedDistanceGain: 0.1,
  /** Ground speed at which the speed breathing saturates, m/s. */
  speedRef: 110,
  speedSmoothTime: 1.3,
} as const;

export interface FirstPersonView {
  /** Eye point, carrier-local. */
  eye: Vec3Tuple;
  /** Resting view direction: rotation about the ship's +Y (positive = toward port) and pitch (positive = up). */
  yaw: number;
  pitch: number;
  /** Look-around limits relative to the resting direction, rad. */
  maxLookYaw: number;
  minLookPitch: number;
  maxLookPitch: number;
  fov: number;
}

const stripDx = LANDING_STRIP.end[0] - LANDING_STRIP.threshold[0];
const stripDz = LANDING_STRIP.end[2] - LANDING_STRIP.threshold[2];
const stripLength = Math.hypot(stripDx, stripDz);
/** How far up the strip from the threshold the deck observer stands, m. */
const DECK_EYE_ALONG_STRIP = 16;
const DECK_EYE_HEIGHT = 3;

/** Deck: standing on the landing-strip centreline near the stern, looking up the strip. */
export const DECK_VIEW: FirstPersonView = {
  eye: [
    LANDING_STRIP.threshold[0] + (stripDx / stripLength) * DECK_EYE_ALONG_STRIP,
    DECK.y + DECK_EYE_HEIGHT,
    LANDING_STRIP.threshold[2] + (stripDz / stripLength) * DECK_EYE_ALONG_STRIP,
  ],
  yaw: Math.atan2(-stripDx, -stripDz),
  pitch: -1.5 * DEG2RAD,
  maxLookYaw: 130 * DEG2RAD,
  minLookPitch: -28 * DEG2RAD,
  maxLookPitch: 55 * DEG2RAD,
  fov: FOV.deck,
};

/** Bridge: the navigation-bridge eye point, looking forward and slightly to port over the deck. */
export const BRIDGE_VIEW: FirstPersonView = {
  eye: ISLAND.bridgeEye,
  yaw: 13 * DEG2RAD,
  pitch: -9 * DEG2RAD,
  maxLookYaw: 115 * DEG2RAD,
  minLookPitch: -32 * DEG2RAD,
  maxLookPitch: 32 * DEG2RAD,
  fov: FOV.bridge,
};

/** Smoothing of first-person look-around, s. */
export const LOOK_SMOOTH_TIME = 0.12;

export interface TurbineView {
  /** Orbit centre, carrier-local: below the fan so the exhaust is in frame. */
  focus: Vec3Tuple;
  /** Resting azimuth / elevation of the camera around `focus`, in the ship frame. */
  yaw: number;
  pitch: number;
}

/** Turbine close-up: tuning shared by all four turbines. */
export const TURBINE_VIEW = {
  distance: 92,
  minDistance: 62,
  maxDistance: 170,
  /** The look target sits this far below the tilt pivot, m. */
  focusDrop: 12,
  elevation: 24 * DEG2RAD,
  /** Three-quarter angle: how far the camera swings from straight outboard toward the nearer end of the ship. */
  quarterAngle: 38 * DEG2RAD,
  maxOrbitYaw: 55 * DEG2RAD,
  minElevation: -18 * DEG2RAD,
  maxElevation: 50 * DEG2RAD,
  smoothTime: 0.2,
} as const;

/** Close exterior three-quarter view of turbine `index` from outboard and slightly above. */
export function turbineView(index: number): TurbineView {
  const m = TURBINE_MOUNTS[index];
  const outboard = Math.sign(m[0]) || 1;
  const toEnd = Math.sign(m[2]) || 1;
  return {
    focus: [m[0], m[1] - TURBINE_VIEW.focusDrop, m[2]],
    yaw: Math.atan2(
      outboard * Math.cos(TURBINE_VIEW.quarterAngle),
      toEnd * Math.sin(TURBINE_VIEW.quarterAngle),
    ),
    pitch: TURBINE_VIEW.elevation,
  };
}

export interface HotspotFraming {
  /** Orbit centre, carrier-local. */
  anchor: Vec3Tuple;
  distance: number;
  /** Preferred azimuth (ship frame) and elevation the rig eases to when the hotspot is selected. */
  yaw: number;
  pitch: number;
}

/** Whole-ship orbit centre in the hangar, carrier-local. */
export const HANGAR_FOCUS: Vec3Tuple = [0, 4, 0];

function frameHotspot(id: HotspotId, anchor: Vec3Tuple): HotspotFraming {
  if (id.startsWith('turbine-')) {
    // close, from outboard of that turbine toward the nearer end of the ship
    const view = turbineView(Number(id.slice('turbine-'.length)));
    return { anchor, distance: 150, yaw: view.yaw, pitch: 20 * DEG2RAD };
  }
  // deck features: from the side of the ship the feature is on, toward the nearer end, looking down on it
  const side = anchor[0] > 8 ? 1 : -1;
  const end = anchor[2] < 0 ? -1 : 1;
  if (id === 'island') {
    // seen across the deck from off the port bow so the bridge front and the deck both read
    return { anchor, distance: 200, yaw: Math.atan2(-0.72, -0.7), pitch: 16 * DEG2RAD };
  }
  return { anchor, distance: 210, yaw: Math.atan2(side * 0.75, end * 0.66), pitch: 30 * DEG2RAD };
}

/** How the hangar camera frames each hotspot. */
export const HOTSPOT_FRAMING: Readonly<Record<HotspotId, HotspotFraming>> = Object.fromEntries(
  HOTSPOTS.map((h) => [h.id, frameHotspot(h.id, h.anchor)]),
) as Record<HotspotId, HotspotFraming>;
