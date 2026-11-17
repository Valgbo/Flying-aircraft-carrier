/**
 * Sensors reference data (PLAN_A10.md §6.4, §6.6, §7, §8, §10, §19): the AN/AAQ-28 Litening
 * targeting pod and its laser, the AGM-65 Maverick seekers before launch, and the contrast model
 * the seekers and the sensor pictures share. SI units (m, s, rad, K). Owned by the SENSORS module.
 * Every number has a *_NOTES entry (source id + confidence).
 *
 * Public data on these sensors is thin: the fields of view, the gimbal limits and the lock ranges
 * come from encyclopaedias, fact pages and hobbyist simulator documentation (web-search summaries;
 * the pages themselves could not be opened from the build machine). The contrast model MIRRORS the
 * thermal and haze laws the renderer draws with (view/terrain/terrainMaterial.ts,
 * view/terrain/terrainSystem.ts, view/vehicles/thermal.ts, view/environment/haze.ts,
 * src/scene/sky/timeOfDay.ts), so what looks hot on a display is what a seeker can lock. If one of
 * those shaders changes, change the matching number here (each note names its file).
 */
import { DEG, NM } from '../core/units';
import type { StoreType } from '../core/weapons/types';
import type { SurfaceKind } from '../core/world/types';
import type { SourceNote } from './sources';

// ---- Targeting pod: AN/AAQ-28 Litening ------------------------------------------------------------

export const TGP = {
  /** Wide field of view (full angle), rad. */
  fovWide: 4 * DEG,
  /** Narrow field of view (full angle), rad. */
  fovNarrow: 1 * DEG,
  /** Electronic zoom steps applied to either field of view (×1 … ×8). */
  zoomLevels: [1, 2, 4, 8] as readonly number[],
  /** Picture width in detector pixels (third-generation 640 × 512 FLIR). */
  imagePixels: 640,
  /** FLIR cool-down after power-on before the pod gives a picture ("NOT TIMED OUT"), s. */
  warmupTime: 120,
  /**
   * Largest angle between the line of sight and the pod's forward axis, rad. The head pitches
   * +45° / −150° and the nose section rolls ±400°, so every direction within 150° of the axis can
   * be reached; a 30° cone straight aft is blind (the pod's own body).
   */
  gimbalMaxOffAxis: 150 * DEG,
  /**
   * Centre of the optical head (the window of the rolling nose section) in the pod's store frame
   * (origin at the top of the suspension lugs, body-aligned, −Z forward), m: the narrow window
   * section between the nose cap and the body of the 2.24 m pod model, 0.62–0.92 m ahead of the
   * lugs, on the pod's axis.
   */
  headOffset: { x: 0, y: -0.2, z: -0.77 },
  /** Slew rate at full deflection, fields of view per second (the picture moves at one rate). */
  slewFovPerSecond: 0.8,
  /** Slew response exponent: rate ∝ |deflection|^n (fine control near the centre). */
  slewExpo: 2,
  /** Slew acceleration: held at full deflection the rate grows to this many times… */
  slewAccelMax: 4,
  /** …over this time, s. */
  slewAccelTime: 1.5,
  /** Deflection counted as "full" for the acceleration. */
  slewAccelThreshold: 0.9,
  /** Point-track capture gate: half-angle as a fraction of the field of view. */
  pointGateFraction: 1 / 16,
  /** Smallest target the point tracker acquires, pixels across (√(projected area) / pixel). */
  minTrackPixels: 3,
  /** A held track survives down to this fraction of the acquisition size and contrast. */
  trackHoldFraction: 0.75,
  /** Contrast (0..1, `targetContrast`) the point tracker needs to acquire. */
  contrastThreshold: 0.15,
  /** A point track that loses its target coasts on its last motion this long, s. */
  coastTime: 1.0,
  /** Rate of the point-track visibility and contrast checks, Hz. */
  pointCheckHz: 15,
  /** Rate of the area-track occlusion check, Hz. */
  areaCheckHz: 5,
  /** Slant range the area/inertial point is searched to (raycast), m. */
  maxPointRange: 40000,
  /** Line of sight held this far out when it meets no ground (looking above the horizon), m. */
  skyRange: 40000,
} as const;

export const TGP_NOTES: Record<keyof typeof TGP, SourceNote> = {
  fovWide: {
    source: 'wikiLitening',
    confidence: 'approximate',
    note: 'Litening II wide FOV 4° (forum summary of the pod data; another summary says 12°); brief: ≈4°',
  },
  fovNarrow: {
    source: 'wikiLitening',
    confidence: 'approximate',
    note: 'narrow FOV ≈1° (forum summary: "max FOV of 1 degree"; 1/3° at the highest zoom)',
  },
  zoomLevels: {
    source: 'plan',
    confidence: 'estimate',
    note: 'electronic zoom ×1–×8 in doubling steps (brief); ×8 on 1° ≈ 0.13°',
  },
  imagePixels: {
    source: 'wikiLitening',
    confidence: 'approximate',
    note: 'Litening AT / G4: 640 × 512 FLIR',
  },
  warmupTime: {
    source: 'dcsA10Manual',
    confidence: 'estimate',
    note: 'Stirling-cooled FLIR: a couple of minutes to cool ("NOT TIMED OUT")',
  },
  gimbalMaxOffAxis: {
    source: 'wikiLitening',
    confidence: 'approximate',
    note: 'Litening III field of regard: pitch +45° / −150°, roll ±400° (SAAF fact page, web summary)',
  },
  headOffset: {
    source: 'flightgearA10',
    confidence: 'estimate',
    note: 'pod model aaq28.glb: window section z −0.92…−0.62 m, axis 0.2 m below the lugs',
  },
  slewFovPerSecond: { source: 'plan', confidence: 'estimate' },
  slewExpo: { source: 'plan', confidence: 'estimate' },
  slewAccelMax: { source: 'plan', confidence: 'estimate', note: 'brief: slew with acceleration' },
  slewAccelTime: { source: 'plan', confidence: 'estimate' },
  slewAccelThreshold: { source: 'plan', confidence: 'estimate' },
  pointGateFraction: { source: 'plan', confidence: 'estimate' },
  minTrackPixels: {
    source: 'plan',
    confidence: 'estimate',
    note: 'a centroid tracker needs a few resolution cells on the target',
  },
  trackHoldFraction: { source: 'plan', confidence: 'estimate', note: 'acquire/hold hysteresis' },
  contrastThreshold: { source: 'plan', confidence: 'estimate' },
  coastTime: { source: 'plan', confidence: 'estimate', note: 'tracker memory (coast) mode' },
  pointCheckHz: { source: 'plan', confidence: 'estimate', note: 'cost: checks at a video rate' },
  areaCheckHz: { source: 'plan', confidence: 'estimate' },
  maxPointRange: { source: 'plan', confidence: 'estimate' },
  skyRange: { source: 'plan', confidence: 'estimate' },
};

// ---- Laser designator and ranger --------------------------------------------------------------------

export const LASER = {
  /** Default pulse code (PLAN §6.6: the pod and the GBU-12 use 1688 unless set). */
  defaultCode: 1688,
  /** Code digits: four digits, the first 1–2, the others 1–8 (PRF codes). */
  codeDigitMin: [1, 1, 1, 1] as readonly number[],
  codeDigitMax: [2, 8, 8, 8] as readonly number[],
  /** Farthest the beam is traced (designation and ranging), m. */
  maxRange: 25000,
  /**
   * Pulse rate, Hz. The spot and the laser range are measured once per pulse (PRF codes are
   * ≈8–20 Hz); a laser-guided bomb's seeker sees the spot at this rate.
   */
  pulseHz: 10,
  /** Tallest tree canopy the beam may meet, m (the world grows 12–22 m stands). */
  canopyMax: 25,
  /** Step of the canopy search near the ground hit, m. */
  canopyStep: 1.5,
} as const;

export const LASER_NOTES: Record<keyof typeof LASER, SourceNote> = {
  defaultCode: { source: 'plan', confidence: 'approximate', note: 'PLAN §19: 1688 by default' },
  codeDigitMin: {
    source: 'plan',
    confidence: 'approximate',
    note: 'PRF codes, as data/avionics.ts',
  },
  codeDigitMax: {
    source: 'plan',
    confidence: 'approximate',
    note: 'PRF codes, as data/avionics.ts',
  },
  maxRange: { source: 'wikiLitening', confidence: 'estimate' },
  pulseHz: {
    source: 'plan',
    confidence: 'approximate',
    note: 'NATO PRF codes correspond to roughly 8–20 pulses per second',
  },
  canopyMax: {
    source: 'plan',
    confidence: 'estimate',
    note: 'core/world/params.ts canopyMax 22 m',
  },
  canopyStep: { source: 'plan', confidence: 'estimate' },
};

// ---- AGM-65 Maverick seekers (before launch) -----------------------------------------------------

export const MAVERICK = {
  /** Wide field of view (×3 optics), full angle, rad. */
  fovWide: 2.5 * DEG,
  /** Narrow field of view (×6 optics), full angle, rad. */
  fovNarrow: 1.25 * DEG,
  /** Picture width in resolution cells (the lock-size rule below). */
  imagePixels: 256,
  /** Seeker gimbal: largest angle between the line of sight and the missile's axis, rad. */
  gimbalLimit: 30 * DEG,
  /** Gyro run-up (and IIR detector cool-down) after power-on before there is video, s. */
  alignTime: 180,
  /**
   * Smallest target the seeker locks: √(projected area) / range ≥ minLockPixels × FOV / imagePixels.
   * A tank (√A ≈ 3.4–4.2 m) then locks out to ≈2.7–3.3 nmi in WIDE and ≈5.4–6.6 nmi in NARROW.
   */
  minLockPixels: 4,
  /** A lock holds down to this fraction of the acquisition size and contrast (hysteresis). */
  lockHoldFraction: 0.75,
  /** Tracking gate: half-angle as a fraction of the field of view. */
  gateFraction: 1 / 16,
  /** realism.largeGate: the gate is this many times larger. */
  largeGateFactor: 2.5,
  /** Contrast (0..1, `targetContrast` in the seeker's band) needed to lock. */
  contrastThreshold: 0.25,
  /** An IR lock jumps to a burning object in its gate whose heat contrast is this many times larger. */
  captureRatio: 1.5,
  /** The track gate is at least this many times the target's angular radius. */
  trackGateTargetFactor: 1.5,
  /** Rate of the lock checks (line of sight, contrast, capture), Hz. */
  lockCheckHz: 10,
  /** Launch zone: slant range window, m. */
  minLaunchRange: 0.5 * NM,
  maxLaunchRange: 22000,
  /** Launch zone: the line of sight must be this far inside the gimbal limit, rad. */
  launchGimbalMargin: 2 * DEG,
  /** Seeker window (missile nose) in the missile's store frame (origin at the lugs), m. */
  seekerOffset: { x: 0, y: -0.18, z: -1.3 },
  /** Slew rate at full deflection, fields of view per second; response exponent. */
  slewFovPerSecond: 0.6,
  slewExpo: 2,
} as const;

export const MAVERICK_NOTES: Record<keyof typeof MAVERICK, SourceNote> = {
  fovWide: {
    source: 'wikiAgm65',
    confidence: 'approximate',
    note: 'AGM-65H: 2.5° and 1.25°; the D (IIR) has the same ×3 / ×6 steps (DCS forum)',
  },
  fovNarrow: { source: 'wikiAgm65', confidence: 'approximate', note: 'AGM-65H narrow 1.25°' },
  imagePixels: { source: 'plan', confidence: 'estimate' },
  gimbalLimit: {
    source: 'dcsMaverick',
    confidence: 'approximate',
    note: 'hobbyist documentation: seeker gimbal ≈30° either side',
  },
  alignTime: {
    source: 'dcsMaverick',
    confidence: 'approximate',
    note: 'PLAN §19: about 3 minutes (gyro run-up and detector cool-down)',
  },
  minLockPixels: {
    source: 'plan',
    confidence: 'estimate',
    note: 'tuned to PLAN §6.4: a tank locks at roughly 3 to 7 nmi',
  },
  lockHoldFraction: { source: 'plan', confidence: 'estimate' },
  gateFraction: { source: 'plan', confidence: 'estimate' },
  largeGateFactor: { source: 'plan', confidence: 'estimate', note: 'PLAN §2 Standard preset' },
  contrastThreshold: { source: 'plan', confidence: 'estimate' },
  captureRatio: {
    source: 'plan',
    confidence: 'estimate',
    note: 'PLAN §6.4: an IR seeker can be captured by a burning wreck',
  },
  trackGateTargetFactor: { source: 'plan', confidence: 'estimate' },
  lockCheckHz: { source: 'plan', confidence: 'estimate' },
  minLaunchRange: {
    source: 'flightgearA10',
    confidence: 'estimate',
    note: 'A-10-payload.xml agm-65b min-fire-range-nm 0.5',
  },
  maxLaunchRange: { source: 'wikiAgm65', confidence: 'approximate', note: 'range beyond 22 km' },
  launchGimbalMargin: { source: 'plan', confidence: 'estimate' },
  seekerOffset: {
    source: 'flightgearA10',
    confidence: 'estimate',
    note: 'agm65.glb: nose 1.45 m ahead of the lugs',
  },
  slewFovPerSecond: { source: 'plan', confidence: 'estimate' },
  slewExpo: { source: 'plan', confidence: 'estimate' },
};

/** Maverick launchers: rail positions (store frame of the launcher), filled in this order. */
export const MAVERICK_RAILS: Partial<Record<StoreType, readonly { x: number; y: number }[]>> = {
  'LAU-88': [
    { x: -0.48, y: -0.135 },
    { x: 0.48, y: -0.135 },
    { x: 0, y: -0.505 },
  ],
  'LAU-117': [{ x: 0, y: -0.1 }],
};

export const MAVERICK_RAILS_NOTES: SourceNote = {
  source: 'flightgearA10',
  confidence: 'approximate',
  note: 'a10-meta.json racks.lau88 mounts (trirack-2.xml); LAU-117 single rail estimated',
};

/** Seeker band of each Maverick: imaging infrared (D, G) or television (H, K). */
export const MAVERICK_BAND: Partial<Record<StoreType, 'IR' | 'TV'>> = {
  'AGM-65D': 'IR',
  'AGM-65G': 'IR',
  'AGM-65H': 'TV',
  'AGM-65K': 'TV',
};

export const MAVERICK_BAND_NOTES: SourceNote = {
  source: 'wikiAgm65',
  confidence: 'confirmed',
  note: 'D and G imaging infrared; H and K television (CCD)',
};

// ---- Contrast model (shared with the sensor pictures) ------------------------------------------

export const CONTRAST = {
  // Sun and daylight: src/scene/sky/timeOfDay.ts (sunDirectionAt, daylightFromSunY).
  /** Sun elevation at noon (the daily arc's culmination), rad. */
  sunCulmination: 62 * DEG,
  /** Daylight = smoothstep(low, high, sin(sun elevation)). */
  daylightLow: -0.16,
  daylightHigh: 0.16,

  // Ground heating by time of day: view/terrain/terrainSystem.ts (uThermalParams.x and .y).
  /** Solar heating = max(0, sin((h − start) / span · π)) · daylight. */
  solarStartHour: 6.5,
  solarSpanHours: 13,
  /** Ambient level = base + swing · max(0, sin((h − start) / span · π)) (lags the sun). */
  ambientStartHour: 8.5,
  ambientSpanHours: 13,
  ambientBase: 0.3,
  ambientSwing: 0.25,

  // Ground temperature level: view/terrain/terrainMaterial.ts (thermal branch).
  /** level = class + (solar · uptake · sun − sunOffset) · sunGain + (ambient − ambientRef) · ambientGain */
  groundSunGain: 0.35,
  groundSunOffset: 0.15,
  groundAmbientGain: 0.3,
  groundAmbientRef: 0.4,

  // Vehicles: view/vehicles/thermal.ts (uThermalLevel, uThermalGain) and VehicleRenderer.ts.
  /** Thermal picture level of a surface at ambient temperature (0..1). */
  ambientLevel: 0.3,
  /** Kelvin per unit of thermal level (the picture gain is 1/75 per K). */
  kelvinPerLevel: 75,
  /** Extra heat of each zone in a full fire, K (engine deck, exhaust, running gear, hull). */
  fireEngine: 320,
  fireExhaust: 320,
  fireRunning: 160,
  fireHull: 260,
  /** Share of the visible area of each heat zone (hull, engine deck, running gear, exhaust). */
  zoneHull: 0.5,
  zoneEngine: 0.2,
  zoneRunning: 0.2,
  zoneExhaust: 0.1,

  // Haze: view/environment/haze.ts and src/scene/sky/atmosphere.ts (FogExp2 law).
  /** Contrast left at the meteorological visibility. */
  visibilityContrast: 0.02,
  /** Haze density halves this far above the haze floor (terrain.minHeight), m. */
  hazeAltitudeScale: 4000,
  /** Visibility clamp, km. */
  minVisibilityKm: 2,
  /** Thermal picture: the level a hazed path tends to (cold sky) and the share of haze it takes. */
  skyLevel: 0.12,
  irHazeShare: 0.7,

  // Contrast scales (0..1 outputs).
  /** IR contrast = 1 − exp(−ΔT / irScaleK), ΔT the apparent temperature difference, K. */
  irScaleK: 10,
  /** TV contrast = 1 − exp(−C / tvScale), C the apparent Weber contrast. */
  tvScale: 0.25,
  /** Horizon (airlight) to ground luminance ratio in Koschmieder's law. */
  skyGroundRatio: 4,
  /** TV light factor = smoothstep(low, high, sin(sun elevation)). */
  tvLightLow: -0.05,
  tvLightHigh: 0.25,
  /** Linear luminance of the vehicles' grey-green paint, charred wrecks, white scoring panels. */
  paintLuminance: 0.063,
  charredLuminance: 0.025,
  panelLuminance: 0.78,
  /** Visible fraction of a fire's light/smoke that raises a burning wreck's TV contrast. */
  fireTvContrast: 1.5,
} as const;

export const CONTRAST_NOTES: Record<keyof typeof CONTRAST, SourceNote> = {
  sunCulmination: { source: 'plan', confidence: 'estimate', note: 'mirrors sky timeOfDay.ts' },
  daylightLow: { source: 'plan', confidence: 'estimate', note: 'mirrors sky timeOfDay.ts' },
  daylightHigh: { source: 'plan', confidence: 'estimate', note: 'mirrors sky timeOfDay.ts' },
  solarStartHour: { source: 'plan', confidence: 'estimate', note: 'mirrors terrainSystem.ts' },
  solarSpanHours: { source: 'plan', confidence: 'estimate', note: 'mirrors terrainSystem.ts' },
  ambientStartHour: { source: 'plan', confidence: 'estimate', note: 'mirrors terrainSystem.ts' },
  ambientSpanHours: { source: 'plan', confidence: 'estimate', note: 'mirrors terrainSystem.ts' },
  ambientBase: { source: 'plan', confidence: 'estimate', note: 'mirrors terrainSystem.ts' },
  ambientSwing: { source: 'plan', confidence: 'estimate', note: 'mirrors terrainSystem.ts' },
  groundSunGain: { source: 'plan', confidence: 'estimate', note: 'mirrors terrainMaterial.ts' },
  groundSunOffset: { source: 'plan', confidence: 'estimate', note: 'mirrors terrainMaterial.ts' },
  groundAmbientGain: { source: 'plan', confidence: 'estimate', note: 'mirrors terrainMaterial.ts' },
  groundAmbientRef: { source: 'plan', confidence: 'estimate', note: 'mirrors terrainMaterial.ts' },
  ambientLevel: { source: 'plan', confidence: 'estimate', note: 'mirrors vehicles thermal.ts' },
  kelvinPerLevel: {
    source: 'plan',
    confidence: 'estimate',
    note: 'vehicles thermal.ts gain 1/75 per K; makes sunlit grass ≈+16 K, asphalt ≈+22 K at noon',
  },
  fireEngine: { source: 'plan', confidence: 'estimate', note: 'mirrors VehicleRenderer.ts' },
  fireExhaust: { source: 'plan', confidence: 'estimate', note: 'mirrors VehicleRenderer.ts' },
  fireRunning: { source: 'plan', confidence: 'estimate', note: 'mirrors VehicleRenderer.ts' },
  fireHull: { source: 'plan', confidence: 'estimate', note: 'mirrors VehicleRenderer.ts' },
  zoneHull: { source: 'plan', confidence: 'estimate' },
  zoneEngine: { source: 'plan', confidence: 'estimate' },
  zoneRunning: { source: 'plan', confidence: 'estimate' },
  zoneExhaust: { source: 'plan', confidence: 'estimate' },
  visibilityContrast: {
    source: 'plan',
    confidence: 'confirmed',
    note: 'meteorological visibility: 2 % contrast left (sky atmosphere.ts)',
  },
  hazeAltitudeScale: {
    source: 'plan',
    confidence: 'estimate',
    note: 'mirrors environment haze.ts',
  },
  minVisibilityKm: { source: 'plan', confidence: 'estimate', note: 'mirrors environment haze.ts' },
  skyLevel: {
    source: 'plan',
    confidence: 'estimate',
    note: 'mirrors terrainMaterial.ts thermalOut',
  },
  irHazeShare: {
    source: 'plan',
    confidence: 'estimate',
    note: 'mirrors terrainMaterial.ts thermalOut: the 8–12 µm band loses less to haze than visible light',
  },
  irScaleK: { source: 'plan', confidence: 'estimate', note: 'a few K of contrast against clutter' },
  tvScale: { source: 'plan', confidence: 'estimate' },
  skyGroundRatio: {
    source: 'plan',
    confidence: 'estimate',
    note: "Koschmieder's law (Middleton, Vision through the Atmosphere, 1952): sky/ground ratio 2–5",
  },
  tvLightLow: { source: 'plan', confidence: 'estimate', note: 'CCD video fails toward dusk' },
  tvLightHigh: { source: 'plan', confidence: 'estimate' },
  paintLuminance: {
    source: 'plan',
    confidence: 'estimate',
    note: 'view/vehicles/palette.ts paint #424a35 (linear luminance)',
  },
  charredLuminance: { source: 'plan', confidence: 'estimate' },
  panelLuminance: {
    source: 'plan',
    confidence: 'estimate',
    note: 'view/vehicles/palette.ts panelWhite #e7e5dc',
  },
  fireTvContrast: { source: 'plan', confidence: 'estimate' },
};

/**
 * Thermal level (0..1 picture units) and solar uptake of each surface class, exactly as the
 * terrain shader's classes draw them (view/terrain/terrainMaterial.ts; palette.ts DETAIL mapping:
 * dirt → ploughed, concrete → pavement, water → river).
 */
export const GROUND_THERMAL: Record<SurfaceKind, { level: number; uptake: number }> = {
  grass: { level: 0.4, uptake: 0.6 },
  field: { level: 0.4, uptake: 0.6 },
  dirt: { level: 0.47, uptake: 0.6 },
  sand: { level: 0.5, uptake: 0.6 },
  rock: { level: 0.52, uptake: 0.85 },
  forest: { level: 0.33, uptake: 0.25 },
  road: { level: 0.58, uptake: 0.95 },
  concrete: { level: 0.56, uptake: 0.9 },
  water: { level: 0.2, uptake: 0.1 },
  mud: { level: 0.4, uptake: 0.6 },
};

export const GROUND_THERMAL_NOTES: SourceNote = {
  source: 'plan',
  confidence: 'estimate',
  note: 'mirrors the terrain shader thermal classes (terrainMaterial.ts); ploughed fields 0.47',
};

/**
 * Linear luminance (albedo) of each surface class as the terrain is coloured
 * (view/terrain/palette.ts GROUND; roads: the shader's asphalt).
 */
export const GROUND_LUMINANCE: Record<SurfaceKind, number> = {
  grass: 0.15,
  field: 0.147,
  dirt: 0.157,
  sand: 0.355,
  rock: 0.182,
  forest: 0.0625,
  road: 0.095,
  concrete: 0.342,
  water: 0.05,
  mud: 0.077,
};

export const GROUND_LUMINANCE_NOTES: SourceNote = {
  source: 'plan',
  confidence: 'estimate',
  note: 'view/terrain/palette.ts GROUND colours converted to linear luminance',
};

/**
 * Smoke of burning vehicles (a crude obscurant for the seekers: PLAN §6.4 "the lock breaks when
 * terrain, trees or smoke come between"). A column rising from each fire and drifting downwind.
 */
export const SMOKE = {
  /** Fires below this intensity make no blocking smoke. */
  minFire: 0.25,
  /** Column radius at the base, m, and its growth per metre of height. */
  radius: 5,
  growth: 0.12,
  /** Column height, m, and rise speed (the drift per metre of height = wind / rise), m/s. */
  height: 150,
  riseSpeed: 4,
  /** Share of a thermal contrast that gets through the smoke (TV gets nothing through). */
  irTransmission: 0.3,
} as const;

export const SMOKE_NOTES: Record<keyof typeof SMOKE, SourceNote> = {
  minFire: { source: 'plan', confidence: 'estimate' },
  radius: { source: 'plan', confidence: 'estimate' },
  growth: { source: 'plan', confidence: 'estimate' },
  height: { source: 'plan', confidence: 'estimate' },
  riseSpeed: { source: 'plan', confidence: 'estimate' },
  irTransmission: {
    source: 'plan',
    confidence: 'estimate',
    note: 'black smoke is denser in the visible than in the 8–12 µm band',
  },
};

// ---- Airframe mask (what the pod cannot see through) ---------------------------------------------

/** An axis-aligned box in the BODY frame, m. */
export interface MaskBox {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  /** Mirrored to the left side (x → −x) as well. */
  mirror: boolean;
}

/**
 * The aircraft as the pod's line of sight meets it, BODY frame (m), measured by ray-casting the
 * converted FlightGear exterior model (public/a10/models/a10-exterior.glb) with the gear up:
 * fuselage sections, main-gear pods (with the retracted tyre standing out), engine nacelles,
 * tailplane, fins and the flat wing centre section as boxes; the outer wing panels (7° dihedral)
 * as `MASK_WING`.
 */
export const MASK_BOXES: readonly MaskBox[] = [
  // fuselage, nose to tail cone (bottom rises aft of the wing)
  { min: [-0.45, -0.75, -7.65], max: [0.45, 0.4, -6.5], mirror: false },
  { min: [-0.7, -0.72, -6.5], max: [0.7, 1.25, -1.0], mirror: false },
  { min: [-0.7, -0.9, -1.0], max: [0.7, 1.1, 1.0], mirror: false },
  { min: [-0.62, -0.52, 1.0], max: [0.62, 0.95, 3.0], mirror: false },
  { min: [-0.52, -0.42, 3.0], max: [0.52, 0.9, 6.0], mirror: false },
  { min: [-0.4, -0.24, 6.0], max: [0.4, 0.77, 8.45], mirror: false },
  // main-gear pod and the retracted tyre
  { min: [2.33, -1.0, -1.95], max: [2.85, -0.45, 2.2], mirror: true },
  { min: [2.54, -1.29, -1.71], max: [2.81, -0.95, -0.72], mirror: true },
  // engine nacelle (fan to nozzle)
  { min: [0.72, 0.2, 1.6], max: [2.24, 1.74, 5.3], mirror: true },
  // wing centre section (fuselage to the dihedral break), lower surface at y −0.5
  { min: [0.6, -0.52, -0.9], max: [3.0, -0.2, 2.22], mirror: true },
  // tailplane and fins
  { min: [-2.95, -0.02, 6.4], max: [2.95, 0.14, 8.3], mirror: false },
  { min: [2.76, -0.62, 6.2], max: [2.96, 2.46, 8.2], mirror: true },
];

/**
 * Outer wing panel (each side): its lower surface is the plane y = rootY + slope·(|x| − rootX)
 * between rootX and tipX, from the leading edge z = leRoot + leSlope·(|x| − rootX) to the
 * trailing edge z = teRoot + teSlope·(|x| − rootX) (flaps and ailerons included).
 */
export const MASK_WING = {
  rootX: 3.0,
  tipX: 8.95,
  rootY: -0.5,
  slope: 0.1155,
  leRoot: -0.8,
  leSlope: 0.1,
  teRoot: 2.2,
  teSlope: -0.07,
} as const;

/**
 * Wing pylons (stations 1–4 and 8–11; 5–7 hang under the fuselage): half-width and the front and
 * rear of the fairing (BODY z), from the pylon bottom up to the wing's lower surface, m. Index =
 * station. The pod's own pylon stands right over its head: the pod cannot look straight up.
 */
export const MASK_PYLONS: readonly ({ halfWidth: number; front: number; rear: number } | null)[] = [
  null,
  { halfWidth: 0.062, front: -0.87, rear: 1.17 },
  { halfWidth: 0.063, front: -0.85, rear: 1.1 },
  { halfWidth: 0.064, front: -0.85, rear: 1.09 },
  { halfWidth: 0.062, front: -0.97, rear: 0.99 },
  null,
  null,
  null,
  { halfWidth: 0.062, front: -0.97, rear: 0.99 },
  { halfWidth: 0.064, front: -0.85, rear: 1.09 },
  { halfWidth: 0.063, front: -0.85, rear: 1.1 },
  { halfWidth: 0.062, front: -0.87, rear: 1.17 },
];

/** A box in the BODY frame about a station's suspension point (data/geometry.ts stations), m. */
export interface MaskOffsetBox {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

/**
 * What hangs on a station, for the mask: a box around each store BODY (fins and wings left out:
 * thin), placed as the aircraft model draws it — a10-meta.json's placement of the rack (or store)
 * on the station with its few degrees of nose-down pitch, the rack's mounts, each store model's
 * body axis (a cross-section 25–35 % behind the nose) and a radius that is the larger of the
 * model's and data/munitions.ts STORES[*].diameter / 2. The racks are not mirrored on the left
 * wing (a rack's mount 0 is on its own left), so the boxes hold on every station.
 *
 * Racks and launchers: `mounts` in fill order (triple racks: left, right, centre — the order the
 * model draws the i-th store of a fill and the weapons module releases them), and the rack's own
 * `structure` (its silhouettes in a ray-cast of the rack model), which stays when it is empty.
 */
export const MASK_RACKS: Partial<
  Record<StoreType, { structure: MaskOffsetBox; mounts: readonly MaskOffsetBox[] }>
> = {
  'LAU-88': {
    structure: { min: [-0.2, -0.54, -0.81], max: [0.2, 0.07, 0.94] },
    mounts: [
      { min: [-0.63, -0.56, -1.53], max: [-0.32, -0.09, 0.97] },
      { min: [0.33, -0.56, -1.53], max: [0.64, -0.09, 0.97] },
      { min: [-0.15, -0.93, -1.51], max: [0.16, -0.46, 1.0] },
    ],
  },
  'LAU-117': {
    structure: { min: [-0.09, -0.31, -1.2], max: [0.09, 0.05, 1.01] },
    mounts: [{ min: [-0.16, -0.69, -1.59], max: [0.16, -0.25, 0.91] }],
  },
  'TER-9A': {
    structure: { min: [-0.12, -0.32, -0.84], max: [0.12, 0.09, 0.92] },
    mounts: [
      { min: [-0.43, -0.5, -1.08], max: [-0.04, 0.02, 1.15] },
      { min: [0.05, -0.5, -1.08], max: [0.43, 0.02, 1.15] },
      { min: [-0.13, -0.73, -1.06], max: [0.14, -0.32, 1.17] },
    ],
  },
  'LAU-114': {
    structure: { min: [-0.27, -0.15, -1.34], max: [0.27, 0.11, 0.96] },
    mounts: [
      { min: [-0.4, -0.25, -1.42], max: [-0.27, 0.08, 1.48] },
      { min: [0.26, -0.25, -1.42], max: [0.4, 0.08, 1.48] },
    ],
  },
};

/** A store hung directly on a pylon (no rack), for the mask: as MASK_RACKS. */
export const MASK_STORES: Partial<Record<StoreType, MaskOffsetBox>> = {
  'MK-82': { min: [-0.14, -0.35, -1.06], max: [0.13, 0.09, 1.17] },
  'MK-82AIR': { min: [-0.14, -0.36, -1.06], max: [0.13, 0.09, 1.17] },
  'GBU-12': { min: [-0.14, -0.43, -2.03], max: [0.13, 0.1, 1.26] },
  'CBU-97': { min: [-0.21, -0.49, -1.1], max: [0.19, 0.05, 1.25] },
  'LAU-131-M151': { min: [-0.16, -0.38, -0.86], max: [0.17, 0.08, 0.93] },
  'LAU-131-M156': { min: [-0.16, -0.38, -0.86], max: [0.17, 0.08, 0.93] },
  'LAU-68-M151': { min: [-0.16, -0.38, -0.86], max: [0.17, 0.08, 0.93] },
  'LAU-68-M156': { min: [-0.16, -0.38, -0.86], max: [0.17, 0.08, 0.93] },
  'AN/ALQ-184': { min: [-0.17, -0.51, -1.65], max: [0.16, 0.01, 2.32] },
  'AN/AAQ-28': { min: [-0.21, -0.43, -0.9], max: [0.2, 0.06, 1.36] },
};

export const MASK_NOTES: SourceNote = {
  source: 'flightgearA10',
  confidence: 'approximate',
  note: 'ray-cast of a10-exterior.glb (wing, fuselage, nacelles, tail, gear pods, pylons); stores: a10-meta.json placements and rack mounts, store-model body axes, STORES diameters; racks: ray-cast silhouettes of their models; boxes are envelopes',
};
