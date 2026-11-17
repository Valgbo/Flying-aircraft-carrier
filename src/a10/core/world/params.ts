/**
 * Real-world constants of the world model: the standard atmosphere, the wind profile, low-level
 * turbulence and the dimensions of the generated range (runway, roads, river, trees).
 *
 * Owned by the WORLD module. They live here (not in src/a10/data/) because the world module owns
 * no data file; each has a *_NOTES entry with its source id (src/a10/data/sources.ts) and
 * confidence like the data modules. Sources not yet listed in sources.ts are recorded as 'plan'
 * with the real reference in the note (see the world module's report).
 */
import type { SourceNote } from '../../data/sources';

/** International Standard Atmosphere (ICAO Doc 7488 / U.S. Standard Atmosphere 1976), SI. */
export const ISA = {
  /** Sea-level temperature, K. */
  seaLevelTemperature: 288.15,
  /** Sea-level pressure, Pa. */
  seaLevelPressure: 101325,
  /** Sea-level density, kg/m³. */
  seaLevelDensity: 1.225,
  /** Tropospheric lapse rate, K per geopotential metre. */
  lapseRate: 0.0065,
  /** Specific gas constant of dry air, J/(kg·K). */
  gasConstant: 287.05287,
  /** Ratio of specific heats of air. */
  gamma: 1.4,
  /** Standard gravity, m/s². */
  gravity: 9.80665,
  /** Tropopause, geopotential m. */
  tropopause: 11000,
  /** Earth radius used to convert geometric to geopotential height, m. */
  earthRadius: 6356766,
} as const;

export const ISA_NOTES: Record<keyof typeof ISA, SourceNote> = {
  seaLevelTemperature: {
    source: 'usStandardAtmosphere1976',
    confidence: 'confirmed',
    note: 'ISA (ICAO Doc 7488)',
  },
  seaLevelPressure: {
    source: 'usStandardAtmosphere1976',
    confidence: 'confirmed',
    note: 'ISA (ICAO Doc 7488)',
  },
  seaLevelDensity: {
    source: 'usStandardAtmosphere1976',
    confidence: 'confirmed',
    note: 'ISA (ICAO Doc 7488)',
  },
  lapseRate: {
    source: 'usStandardAtmosphere1976',
    confidence: 'confirmed',
    note: 'ISA troposphere',
  },
  gasConstant: {
    source: 'usStandardAtmosphere1976',
    confidence: 'confirmed',
    note: 'US Standard Atmosphere 1976',
  },
  gamma: { source: 'plan', confidence: 'confirmed', note: 'diatomic ideal gas' },
  gravity: { source: 'plan', confidence: 'confirmed', note: 'standard gravity (CGPM 1901)' },
  tropopause: { source: 'usStandardAtmosphere1976', confidence: 'confirmed', note: 'ISA' },
  earthRadius: {
    source: 'usStandardAtmosphere1976',
    confidence: 'confirmed',
    note: 'US Standard Atmosphere 1976 r0',
  },
};

/**
 * Mean wind profile of the atmospheric boundary layer. The 10 m wind (WorldState.surfaceWind) is
 * the standard meteorological wind over open terrain. Below `surfaceLayerTop` the speed follows
 * the logarithmic law u(z) ∝ ln((z - d) / z0) with the local roughness length z0 and displacement
 * d (forest); above it a 1/7 power law up to the boundary-layer top; the direction veers with
 * height (Ekman spiral).
 */
export const WIND = {
  /** Height of the reference (surface) wind, m. */
  referenceHeight: 10,
  /** Roughness length of open farmland, m (Davenport class "open"). */
  roughnessOpen: 0.03,
  /** Roughness length over closed forest, m. */
  roughnessForest: 1.0,
  /** Roughness length over water, m. */
  roughnessWater: 0.0002,
  /** Zero-plane displacement over a forest as a fraction of the canopy height. */
  displacementFraction: 0.7,
  /** Top of the logarithmic surface layer, m above ground. */
  surfaceLayerTop: 100,
  /** Power-law exponent above the surface layer (Hellmann, neutral stability). */
  powerExponent: 1 / 7,
  /** Default boundary-layer depth, m. */
  boundaryLayerHeight: 1000,
  /** Default turning of the wind between 10 m and the boundary-layer top, rad (veer). */
  veer: (20 * Math.PI) / 180,
} as const;

export const WIND_NOTES: Record<keyof typeof WIND, SourceNote> = {
  referenceHeight: {
    source: 'wmoCimo',
    confidence: 'confirmed',
    note: 'WMO CIMO Guide: 10 m wind',
  },
  roughnessOpen: {
    source: 'wmoCimo',
    confidence: 'approximate',
    note: 'WMO CIMO Guide Annex (Davenport–Wieringa roughness classes): open 0.03 m',
  },
  roughnessForest: {
    source: 'wmoCimo',
    confidence: 'approximate',
    note: 'Davenport–Wieringa: closed forest ≥ 1 m',
  },
  roughnessWater: { source: 'wmoCimo', confidence: 'approximate', note: 'Davenport–Wieringa: sea' },
  displacementFraction: {
    source: 'stull1988',
    confidence: 'approximate',
    note: 'd ≈ 2/3–0.7 h (Stull, Introduction to Boundary Layer Meteorology)',
  },
  surfaceLayerTop: {
    source: 'stull1988',
    confidence: 'approximate',
    note: 'surface layer ≈ lowest 10 % of the boundary layer (Stull)',
  },
  powerExponent: { source: 'plan', confidence: 'approximate', note: 'Hellmann 1/7 law' },
  boundaryLayerHeight: { source: 'plan', confidence: 'estimate', note: 'daytime, 0.5–2 km' },
  veer: { source: 'plan', confidence: 'estimate', note: 'Ekman turning 15–30° over land' },
};

/**
 * Low-level turbulence after the Dryden model of MIL-F-8785C §3.7 (MIL-HDBK-1797): below 1,000 ft
 * σw = 0.1·W20, σu = σv = σw / (0.177 + 0.000823 h)^0.4 and Lw = h, Lu = Lv = h / (0.177 +
 * 0.000823 h)^1.2 (h, L in feet); above 2,000 ft isotropic with L = 1,750 ft. WorldState.turbulence
 * scales a "moderate" intensity and adds to the wind-driven part.
 */
export const TURBULENCE = {
  /** σw per unit of the 20 ft wind speed at low altitude. */
  sigmaPerW20: 0.1,
  /** Low-altitude model ceiling, m (1,000 ft). */
  lowAltitudeTop: 304.8,
  /** Medium/high-altitude model floor, m (2,000 ft). */
  highAltitudeBottom: 609.6,
  /** Medium/high-altitude length scale, m (1,750 ft). */
  highAltitudeScale: 533.4,
  /** RMS gust at turbulence = 1 near the ground, m/s ("moderate", ≈ 3 m/s, 10 ft/s). */
  moderateSigma: 3.0,
  /** RMS gust above the boundary layer at turbulence = 1, m/s. */
  moderateSigmaAloft: 1.5,
  /** Shortest length scale used near the ground, m (10 m). */
  minScale: 10,
} as const;

export const TURBULENCE_NOTES: Record<keyof typeof TURBULENCE, SourceNote> = {
  sigmaPerW20: { source: 'milF8785c', confidence: 'confirmed', note: 'MIL-F-8785C §3.7.3.4' },
  lowAltitudeTop: { source: 'milF8785c', confidence: 'confirmed' },
  highAltitudeBottom: { source: 'milF8785c', confidence: 'confirmed' },
  highAltitudeScale: { source: 'milF8785c', confidence: 'confirmed', note: 'Dryden, 1,750 ft' },
  moderateSigma: {
    source: 'milF8785c',
    confidence: 'approximate',
    note: 'moderate ≈ 10 ft/s at low level',
  },
  moderateSigmaAloft: { source: 'plan', confidence: 'estimate' },
  minScale: { source: 'plan', confidence: 'estimate', note: 'keeps the field smooth near 0 ft' },
};

/**
 * The fictional live-fire range (PLAN_A10.md §10): geometry of the generated features.
 */
export const RANGE_WORLD = {
  /** Height-grid samples per edge (spacing 62.5 m over 64 km). */
  gridResolution: 1025,
  /** Valley floor at the downstream and upstream map edges, m ASL. */
  floorLow: 105,
  floorHigh: 235,
  /** Highest ridges, m ASL. */
  ridgeTop: 900,
  /** Runway length and width, m (one 2,400 m runway). */
  runwayLength: 2400,
  runwayWidth: 45,
  /** Parallel and link taxiway width, m. */
  taxiwayWidth: 23,
  /** Apron length and depth, m. */
  apronLength: 380,
  apronWidth: 150,
  /** Paved width of the valley highway, secondary roads and dirt tracks, m. */
  highwayWidth: 11,
  roadWidth: 7,
  trackWidth: 4,
  /** Steepest grade each road kind is built to. */
  highwayMaxGrade: 0.05,
  roadMaxGrade: 0.08,
  trackMaxGrade: 0.12,
  /** Width over which a road bed blends into the natural ground (cut/fill), m. */
  highwayBlend: 26,
  roadBlend: 18,
  trackBlend: 9,
  /** River water width, upstream and downstream, m. */
  riverWidthUp: 34,
  riverWidthDown: 62,
  /** Water depth at the centre line, m. */
  riverDepth: 3,
  /** Sand/gravel bank width either side, m. */
  riverBank: 9,
  /** Meander wavelength (along the valley) per channel width. */
  meanderPerWidth: 12,
  /** Flood plain above the water, m. */
  floodPlainRise: 2.2,
  /** Forest canopy height range, m. */
  canopyMin: 12,
  canopyMax: 22,
  /** Hedgerow / field tree-line height range and half width, m. */
  hedgeMin: 8,
  hedgeMax: 15,
  hedgeHalfWidth: 4.5,
  /** Riverside tree band width, m. */
  riparianWidth: 18,
} as const;

export const RANGE_WORLD_NOTES: Record<keyof typeof RANGE_WORLD, SourceNote> = {
  gridResolution: { source: 'plan', confidence: 'estimate', note: 'performance budget §14' },
  floorLow: { source: 'plan', confidence: 'estimate', note: 'PLAN §10 / world brief' },
  floorHigh: { source: 'plan', confidence: 'estimate', note: 'PLAN §10 / world brief' },
  ridgeTop: { source: 'plan', confidence: 'estimate', note: 'PLAN §10: ridges to about 900 m' },
  runwayLength: { source: 'plan', confidence: 'estimate', note: 'world brief: one 2,400 m runway' },
  runwayWidth: {
    source: 'icaoAnnex14',
    confidence: 'confirmed',
    note: 'ICAO Annex 14 code 4 runway',
  },
  taxiwayWidth: {
    source: 'icaoAnnex14',
    confidence: 'confirmed',
    note: 'ICAO Annex 14 code E taxiway',
  },
  apronLength: { source: 'plan', confidence: 'estimate' },
  apronWidth: { source: 'plan', confidence: 'estimate' },
  highwayWidth: {
    source: 'aashtoGreenBook',
    confidence: 'approximate',
    note: 'two 3.65 m lanes + shoulders (AASHTO Green Book)',
  },
  roadWidth: { source: 'plan', confidence: 'approximate', note: 'two-lane rural road' },
  trackWidth: { source: 'plan', confidence: 'approximate', note: 'single-lane farm/forest track' },
  highwayMaxGrade: {
    source: 'aashtoGreenBook',
    confidence: 'approximate',
    note: 'AASHTO rolling terrain',
  },
  roadMaxGrade: {
    source: 'aashtoGreenBook',
    confidence: 'approximate',
    note: 'AASHTO rural collector',
  },
  trackMaxGrade: { source: 'plan', confidence: 'approximate', note: 'forest road practice' },
  highwayBlend: { source: 'plan', confidence: 'estimate', note: 'cut/fill slopes ≈ 1:2–1:3' },
  roadBlend: { source: 'plan', confidence: 'estimate' },
  trackBlend: { source: 'plan', confidence: 'estimate' },
  riverWidthUp: { source: 'plan', confidence: 'estimate' },
  riverWidthDown: { source: 'plan', confidence: 'estimate' },
  riverDepth: { source: 'plan', confidence: 'estimate' },
  riverBank: { source: 'plan', confidence: 'estimate' },
  meanderPerWidth: {
    source: 'leopoldWolman1960',
    confidence: 'approximate',
    note: 'meander wavelength ≈ 10–14 channel widths (Leopold & Wolman 1960)',
  },
  floodPlainRise: {
    source: 'plan',
    confidence: 'estimate',
    note: 'bankfull height of a lowland river',
  },
  canopyMin: { source: 'plan', confidence: 'estimate', note: 'world brief: canopy 12–22 m' },
  canopyMax: { source: 'plan', confidence: 'estimate', note: 'world brief: canopy 12–22 m' },
  hedgeMin: { source: 'plan', confidence: 'estimate' },
  hedgeMax: { source: 'plan', confidence: 'estimate' },
  hedgeHalfWidth: { source: 'plan', confidence: 'estimate' },
  riparianWidth: { source: 'plan', confidence: 'estimate' },
};
