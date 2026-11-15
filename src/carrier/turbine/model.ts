/**
 * Turbine model — pure numbers only (no three.js objects, no DOM), so everything here is unit
 * testable: nacelle dimensions derived from the layout, the duct lathe profile, blade sections
 * and the response curves that turn engine state into fan blur, glow and exhaust.
 *
 * NACELLE FRAME (the tilting frame of one turbine, origin at the tilt pivot):
 *   +Y = thrust axis (intake on top, nozzle at the bottom), X = tilt axis, exhaust along -Y.
 * Lathe convention used by every body of revolution: point(r, y, phi) = (r sin phi, y, r cos phi).
 */
import { TURBINE } from '../../config/layout';
import { DEG2RAD, TAU, clamp01, lerp, smoothstep } from '../../utils/math';

export const DUCT_HALF_HEIGHT = TURBINE.ductHeight / 2;
/** Local y of the nozzle exit plane. */
export const NOZZLE_Y = -DUCT_HALF_HEIGHT;
/** Local y of the fan disc (mid-chord of the blades). */
export const FAN_Y = 1;
/** Inner radius of the duct at the fan: just clear of the blade tips. */
export const THROAT_RADIUS = TURBINE.fanRadius + 0.4;
export const EXIT_INNER_RADIUS = 18.4;
export const EXIT_OUTER_RADIUS = 20.2;
/** Fan speed at full power, rad/s (2.5 revolutions per second). */
export const MAX_SPIN = 2.5 * TAU;
/** Fan speed fraction of a running engine at zero throttle (see turbineRpmFraction). */
export const IDLE_RPM = 0.1;

export interface ProfilePoint {
  r: number;
  y: number;
}

/**
 * Outer skin of the duct from the inner edge of the nozzle exit, across the exit lip, up the
 * tapering nozzle and the thick mid-section to the crest of the intake lip. Counter-clockwise
 * in the (r, y) plane, so the surface normal is on the right of the direction of travel.
 */
export const DUCT_OUTER_PROFILE: readonly ProfilePoint[] = [
  { r: EXIT_INNER_RADIUS, y: NOZZLE_Y },
  { r: EXIT_OUTER_RADIUS, y: NOZZLE_Y },
  { r: 21.5, y: -3.4 },
  { r: TURBINE.ductOuterRadius, y: -1 },
  { r: TURBINE.ductOuterRadius, y: 4 },
  { r: 21.75, y: 5.3 },
  { r: 21.25, y: 6.15 },
  { r: 20.7, y: DUCT_HALF_HEIGHT },
];

/** Inner wall from the crest of the intake lip down the bellmouth and throat to the nozzle exit. */
export const DUCT_INNER_PROFILE: readonly ProfilePoint[] = [
  { r: 20.7, y: DUCT_HALF_HEIGHT },
  { r: 20.15, y: 6.3 },
  { r: 19.75, y: 5.5 },
  { r: 19.5, y: 4 },
  { r: THROAT_RADIUS, y: 1.5 },
  { r: THROAT_RADIUS, y: -0.6 },
  { r: 19.1, y: -3.2 },
  { r: EXIT_INNER_RADIUS, y: NOZZLE_Y },
];

/** Radius of a profile at height y (linear between profile points; clamped at the ends). */
export function profileRadiusAt(profile: readonly ProfilePoint[], y: number): number {
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    if (hi - lo < 1e-6 || y < lo || y > hi) continue;
    return lerp(a.r, b.r, (y - a.y) / (b.y - a.y));
  }
  const first = profile[0];
  const last = profile[profile.length - 1];
  return Math.abs(y - first.y) < Math.abs(y - last.y) ? first.r : last.r;
}

/**
 * Cumulative arc length along a profile as a fraction 0..1, measured from `fromEnd`
 * (true = from the last point backwards). Used to lay the paint texture along the skin.
 */
export function profileArcFractions(profile: readonly ProfilePoint[], fromEnd = false): number[] {
  const lengths = [0];
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1];
    const b = profile[i];
    lengths.push(lengths[i - 1] + Math.hypot(b.r - a.r, b.y - a.y));
  }
  const total = lengths[lengths.length - 1];
  return lengths.map((l) => (fromEnd ? (total - l) / total : l / total));
}

// ---- paint atlas layout (shared by the texture painter and the geometry UVs) ----

/** The skin tile repeats this many times around the duct. Duct segment counts are multiples of it. */
export const SKIN_TILES = 12;
/** Fractions of the atlas height: outer skin rows, inner liner rows; the rest is plain white. */
export const ATLAS_SKIN_ROWS = 0.6875;
export const ATLAS_LINER_ROWS = 0.15625;
/** v of the plain white band (parts coloured by vertex colour sample here). */
export const ATLAS_WHITE_V = (1 - ATLAS_SKIN_ROWS - ATLAS_LINER_ROWS) / 2;

/** Atlas v for a position on the outer skin: f = 0 at the lip crest, 1 at the inner exit edge. */
export function skinV(f: number): number {
  return 1 - ATLAS_SKIN_ROWS * lerp(0.004, 0.996, clamp01(f));
}

/** Atlas v for a position on the inner wall: f = 0 at the lip crest, 1 at the nozzle exit. */
export function linerV(f: number): number {
  return 1 - ATLAS_SKIN_ROWS - ATLAS_LINER_ROWS * lerp(0.04, 0.96, clamp01(f));
}

// ---- level of detail ----

export interface TurbineDetail {
  ductSegments: number;
  hubSegments: number;
  bladeSpans: number;
  stators: number;
  guideVanes: number;
  discSegments: number;
  plumeSegments: number;
  plumeRings: number;
  atlasSize: number;
}

/** Geometry resolution per quality `detail` level (0 = Low … 2 = High). */
export function turbineDetail(detail: 0 | 1 | 2): TurbineDetail {
  if (detail === 0) {
    return {
      ductSegments: 2 * SKIN_TILES,
      hubSegments: 12,
      bladeSpans: 3,
      stators: 5,
      guideVanes: 0,
      discSegments: 32,
      plumeSegments: 14,
      plumeRings: 20,
      atlasSize: 256,
    };
  }
  return {
    ductSegments: 3 * SKIN_TILES,
    hubSegments: detail === 2 ? 24 : 16,
    bladeSpans: detail === 2 ? 6 : 4,
    stators: 7,
    guideVanes: detail === 2 ? 22 : 11,
    discSegments: 48,
    plumeSegments: detail === 2 ? 24 : 18,
    plumeRings: detail === 2 ? 40 : 28,
    atlasSize: 512,
  };
}

// ---- fan blades ----

export interface BladeSection {
  /** Distance from the fan axis, m. */
  radius: number;
  /** Chord length, m. */
  chord: number;
  /** Pitch: angle of the chord above the plane of rotation, rad (steep at the root, flat at the tip). */
  pitch: number;
  /** Angular offset of the section about the axis, rad (negative = swept back against the rotation). */
  sweep: number;
  /** Maximum thickness, m. */
  thickness: number;
}

/** Blade section at span fraction t (0 = root, hidden inside the hub; 1 = tip). */
export function bladeSection(t: number): BladeSection {
  const s = clamp01(t);
  return {
    radius: lerp(TURBINE.hubRadius - 0.3, TURBINE.fanRadius, s),
    chord: 4.2 + 1.6 * Math.sin(Math.PI * (0.05 + 0.85 * s)),
    pitch: lerp(62, 24, Math.pow(s, 0.8)) * DEG2RAD,
    sweep: -0.22 * s * s,
    thickness: lerp(0.5, 0.12, s),
  };
}

/** +1 for port turbines (FL, RL), -1 for starboard ones: the two sides counter-rotate. */
export function spinDirection(index: number): 1 | -1 {
  return index % 2 === 0 ? 1 : -1;
}

/**
 * Opacity of the solid blades versus fan speed fraction: fully visible at idle, fading as the
 * blades start to alias against the frame rate.
 */
export function bladeOpacity(rpm: number): number {
  return 1 - 0.88 * smoothstep(0.22, 0.6, rpm);
}

/** Opacity of the motion-blur disc that takes over from the blades. */
export function blurOpacity(rpm: number): number {
  return 0.72 * smoothstep(0.18, 0.6, rpm);
}

// ---- combustion glow and exhaust ----

/**
 * Engine "drive" 0..1 behind glow and exhaust: the fan speed fraction, except that the idle
 * floor follows `lit` (1 = burning, 0 = shut down) so a disabled engine fades out smoothly
 * instead of jumping when the master switch is thrown.
 */
export function driveLevel(throttle: number, lit: number): number {
  const t = clamp01(throttle);
  return t + IDLE_RPM * (1 - t) * clamp01(lit);
}

/** Emissive multiplier of the combustion ring (≈0.2 at idle, ≈2.4 at hover, 5 at full power). */
export function glowIntensity(drive: number): number {
  return 5 * Math.pow(clamp01(drive), 1.6);
}

/** How far the glow colour has moved from PALETTE.glowCool toward white, 0..1. */
export function glowWhiteness(drive: number): number {
  return 0.85 * smoothstep(0.5, 1, drive);
}

/** Emissive multiplier of the hot core around the tail cone: only lights up near full power. */
export function coreIntensity(drive: number): number {
  return 7 * smoothstep(0.68, 1, drive);
}

/**
 * Soft-knee compression for HDR emissive values when no bloom pass will handle them (Low
 * quality): keeps the ordering dark < idle < hover < full without clipping to flat white.
 */
export function compressGlow(value: number): number {
  return 1.6 * (1 - Math.exp(-0.5 * Math.max(0, value)));
}

/** Length of the hot exhaust core, m: ≈20 m at idle, 110 m at full power, 0 when shut down. */
export function plumeLength(drive: number): number {
  const d = clamp01(drive);
  return d < IDLE_RPM ? (d / IDLE_RPM) * 20 : lerp(20, 110, (d - IDLE_RPM) / (1 - IDLE_RPM));
}

/** Exhaust speed at the nozzle, m/s. */
export function exhaustSpeed(drive: number): number {
  return 20 + 125 * clamp01(drive);
}

/** Radius of the spray ring where the exhaust hits the sea, m. */
export function sprayRadius(strength: number): number {
  return 14 + 26 * clamp01(strength);
}

/** Particles in the sea-spray burst for a given exhaust particle budget. */
export function sprayParticleCount(exhaustParticles: number): number {
  return Math.max(80, Math.round(exhaustParticles * 0.24));
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Rotate a carrier-local vector into the tilting nacelle frame of a turbine at `tilt` rad
 * (the nacelle is rotated by -tilt about X, so the inverse is a rotation by +tilt).
 */
export function carrierToNacelle<T extends Vec3Like>(v: Vec3Like, tilt: number, out: T): T {
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  const y = v.y * c - v.z * s;
  const z = v.y * s + v.z * c;
  out.x = v.x;
  out.y = y;
  out.z = z;
  return out;
}
