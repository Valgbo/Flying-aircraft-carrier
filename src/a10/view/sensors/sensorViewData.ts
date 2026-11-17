/**
 * Numbers of the sensor pictures (targeting pod and Maverick seeker video), with their sources
 * (docs/a10/ARCHITECTURE.md §5: every real-world constant names a source and a confidence).
 * OWNED BY THE SENSOR-VIEW MODULE. The pods' and seekers' own numbers — fields of view, zoom
 * steps, detector formats, warm-up and alignment, the contrast model — belong to the sensors
 * module (data/sensors.ts) and are read from there, so the pictures and the trackers agree. This
 * file holds only what the PICTURE adds: optics blur, the infrared sky, noise, the automatic
 * gain control, and where the camera sits when the sensor state does not say.
 *
 * Several values have no public primary source (the pod's optics, detector noise, AGC tuning):
 * they are engineering estimates, marked so, and easy to change here.
 */
import type { SourceNote } from '../../data/sources';

/**
 * Where the sensor windows sit on the aircraft (store frame: origin at the lugs, −Z forward), for
 * when the sensor state carries no head position (`tgp.head`, `seeker.head` of the sensors
 * module are used whenever they are set).
 */
export const SENSOR_MOUNTS = {
  /**
   * The Litening's sensor head is the nose of the pod: 1.0 m ahead of the suspension lugs and
   * 0.2 m below them (the converted pod model is 2.24 m long, its front at −1.12 m, its axis
   * 0.20 m under the lugs).
   */
  podHead: { x: 0, y: -0.2, z: -1.0 },
  /**
   * A Maverick's seeker window, from its launcher's suspension lugs: the missile nose 1.45 m
   * ahead of the missile's own lug (model bounds) and about 0.45 m under the pylon (the missile
   * hangs under the LAU-117 rail, 0.27 m deep, its axis 0.18 m under its lug).
   */
  maverickSeeker: { x: 0, y: -0.45, z: -1.45 },
} as const;

export const SENSOR_MOUNTS_NOTES: Record<keyof typeof SENSOR_MOUNTS, SourceNote> = {
  podHead: {
    source: 'flightgearA10',
    confidence: 'approximate',
    note: 'measured on the converted aaq28 store model (a10-meta.json stores.aaq28 bounds)',
  },
  maverickSeeker: {
    source: 'flightgearA10',
    confidence: 'approximate',
    note: 'agm65 and lau117 store models (a10-meta.json); within 0.3 m',
  },
};

/**
 * Optics (what limits the picture's sharpness besides the detector). The detector formats and
 * the fields of view are the sensors module's (data/sensors.ts TGP, MAVERICK): the picture uses
 * the very numbers the trackers use.
 */
export const SENSOR_OPTICS = {
  /** Mid-wave infrared band centre, µm (the pod's 3–5 µm FLIR). */
  podFlirWavelengthUm: 4,
  /** CCD band centre, µm (visible and near infrared). */
  ccdWavelengthUm: 0.7,
  /** Long-wave band centre, µm (the AGM-65D/G imaging-infrared seeker, 8–12 µm). */
  maverickIrWavelengthUm: 10,
  /**
   * Clear aperture of the pod's optics, m. No public figure: chosen so the narrow field is
   * matched to its detector (diffraction 1.22 λ / D ≈ 1.2 detector pixels of the 1° field at
   * 4 µm), as imaging pods are designed — the electronic zoom beyond ×2 then only enlarges.
   */
  podApertureM: 0.15,
  /** Clear aperture of a Maverick seeker, m (inside the 0.30 m body). */
  maverickApertureM: 0.12,
  /** Rayleigh criterion: one resolvable angle = 1.22 λ / D. */
  rayleigh: 1.22,
  /** The Airy disc's core as a Gaussian: σ ≈ 0.42 λ / D. */
  airyGaussian: 0.42,
  /**
   * Further blur of the picture, rad rms: the line of sight's residual jitter (the stabilized
   * gimbal) and the turbulence of a slant path through the boundary layer. Pod: a stabilized
   * gimbal; Maverick: a seeker vibrating on its rail under the wing.
   */
  podBlurRad: 12e-6,
  maverickBlurRad: 30e-6,
} as const;

export const SENSOR_OPTICS_NOTES: Record<keyof typeof SENSOR_OPTICS, SourceNote> = {
  podFlirWavelengthUm: {
    source: 'wikiLitening',
    confidence: 'confirmed',
    note: 'mid-wave FLIR (USAF fact sheet: "mid-wave third generation FLIR")',
  },
  ccdWavelengthUm: { source: 'wikiLitening', confidence: 'estimate' },
  maverickIrWavelengthUm: {
    source: 'wikiAgm65',
    confidence: 'approximate',
    note: 'Hughes tri-service imaging-infrared seeker, long-wave',
  },
  podApertureM: {
    source: 'plan',
    confidence: 'estimate',
    note: 'no public figure; matched to a 640-pixel 1° mid-wave field (D ≥ 1.22 λ / IFOV ≈ 0.18 m)',
  },
  maverickApertureM: { source: 'wikiAgm65', confidence: 'estimate', note: '0.30 m body' },
  rayleigh: {
    source: 'plan',
    confidence: 'confirmed',
    note: 'diffraction limit of a circular aperture',
  },
  airyGaussian: {
    source: 'plan',
    confidence: 'confirmed',
    note: 'best Gaussian fit to the Airy intensity pattern: σ ≈ 0.42 λ N in the image plane',
  },
  podBlurRad: {
    source: 'plan',
    confidence: 'estimate',
    note: 'stabilized pod LOS jitter ~5–10 µrad plus MWIR slant-path turbulence',
  },
  maverickBlurRad: { source: 'plan', confidence: 'estimate' },
};

/**
 * The infrared picture's sky. Everything else in the thermal picture follows the contrast model
 * of the sensors module (data/sensors.ts CONTRAST, mirrored in radiometry.ts), so that what
 * looks hot is what the seekers can lock; the sky above the horizon is this module's addition.
 */
export const RADIOMETRY = {
  /** In-band apparent temperature of the clear sky at the zenith relative to the air, K. */
  skyZenithClear: -45,
  /** ... and in thick haze (wetter, warmer sky). */
  skyZenithHazy: -25,
  /** Zenith emissivity of the sky in the window band (Bliss's slant-path law). */
  skyZenithEmissivity: 0.3,
  /** Specific heat of air at constant pressure, J/(kg·K) (skin recovery temperature). */
  airCp: 1005,
  /** Recovery factor of a turbulent boundary layer (airframe skin temperature). */
  recoveryFactor: 0.89,
} as const;

export const RADIOMETRY_NOTES: Record<keyof typeof RADIOMETRY, SourceNote> = {
  skyZenithClear: {
    source: 'plan',
    confidence: 'estimate',
    note: 'window-band sky, clear and dry',
  },
  skyZenithHazy: { source: 'plan', confidence: 'estimate' },
  skyZenithEmissivity: {
    source: 'bliss1961',
    confidence: 'estimate',
    note: 'Bliss (1961): ε(θ) = 1 − (1 − ε_z)^(1/cos θ)',
  },
  airCp: { source: 'usStandardAtmosphere1976', confidence: 'confirmed' },
  recoveryFactor: {
    source: 'plan',
    confidence: 'approximate',
    note: 'turbulent flow, r ≈ Pr^(1/3)',
  },
};

/** Detector, sensor and video noise. */
export const SENSOR_NOISE = {
  /** Pod FLIR temporal noise (noise-equivalent temperature difference), K rms: cooled array. */
  podNetd: 0.05,
  /**
   * Pod FLIR residual fixed-pattern (column) non-uniformity after correction, K rms: well under
   * the temporal noise (a two-point corrected staring array).
   */
  podFpn: 0.02,
  /** Maverick IIR temporal noise, K rms (an older scanned seeker). */
  maverickIrNetd: 0.15,
  /** Maverick IIR line-to-line non-uniformity (scanned detector: streaks along the rows), K rms. */
  maverickIrFpn: 0.05,
  /** Photo-electrons per pixel per frame from daylit ground: pod CCD and Maverick TV seeker. */
  podCcdElectrons: 30000,
  maverickTvElectrons: 12000,
  /** Read noise, electrons rms. */
  readNoise: 20,
  /** Luminance of daylit open ground in the rendered scene (linear units). */
  daylightLuminance: 0.06,
  /** Video link noise on the display, display units rms (≈48 dB). */
  video: 0.004,
} as const;

export const SENSOR_NOISE_NOTES: Record<keyof typeof SENSOR_NOISE, SourceNote> = {
  podNetd: { source: 'plan', confidence: 'estimate', note: 'cooled mid-wave arrays: 20–50 mK' },
  podFpn: { source: 'plan', confidence: 'estimate', note: 'residual NUC error ~1/3 of NETD' },
  maverickIrNetd: { source: 'plan', confidence: 'estimate' },
  maverickIrFpn: { source: 'plan', confidence: 'estimate' },
  podCcdElectrons: { source: 'plan', confidence: 'estimate' },
  maverickTvElectrons: { source: 'plan', confidence: 'estimate' },
  readNoise: { source: 'plan', confidence: 'estimate' },
  daylightLuminance: {
    source: 'plan',
    confidence: 'estimate',
    note: 'albedo ≈ 0.06 under the environment sun and sky, ÷ π',
  },
  video: { source: 'plan', confidence: 'estimate' },
};

/** Automatic gain and level control (the pod's and seekers' AGC). */
export const SENSOR_AGC = {
  /** Time constant of the gain and level loop, s. */
  timeConstant: 0.6,
  /** Seconds between two picture statistics (readbacks) per sensor. */
  updateInterval: 0.2,
  /** Infrared: the transfer curve spans these quantiles of the picture. */
  irLowQuantile: 0.002,
  irHighQuantile: 0.998,
  /**
   * Infrared range limits, K: maximum gain (the narrowest range: a uniform scene shows its noise)
   * and minimum gain (the widest range).
   */
  irMinSpan: 1.5,
  irMaxSpan: 150,
  /**
   * The narrowest range is also at least this many times the detector's total noise (rms), so
   * at the maximum gain a uniform scene's noise is 1/20 of the display range: visible grain, not
   * snow.
   */
  irNoiseSpan: 20,
  /**
   * Level control: the range is widened on one side until the picture's median is at least this
   * share of the range above the low end as below the high end (1 = the median mid-range): the
   * bulk of the scene sits in the mid-greys, as a thermal imager's mean output level does.
   */
  irLevelBalance: 1,
  /** Plateau of the histogram equalization, in mean bin counts. */
  irPlateau: 2.5,
  /** Share of the equalized curve in the transfer curve (the rest is a straight line). */
  irEqualization: 0.7,
  /** Display grey levels the window maps to. */
  displayLow: 0.05,
  displayHigh: 0.95,
  /** Television: quantiles for the black level and the highlights. */
  tvLowQuantile: 0.02,
  tvHighQuantile: 0.98,
  /**
   * Television: the picture's median at this share of full scale (linear light): mid-grey on the
   * display, as an average-metering auto-exposure sets it.
   */
  tvMidLevel: 0.3,
  /** Share of the darkest level the black-level control removes (haze penetration). */
  tvBlackStretch: 0.5,
  /** Most of full scale the black level may take (a stretch of at most 1 / (1 − this)). */
  tvMaxBlack: 0.6,
  /** Exposure range relative to daylit ground: brightest scene and the gain limit (low light). */
  tvMinScene: 16,
  tvMaxGain: 64,
  /** Video gamma (camera transfer exponent). */
  tvGamma: 0.45,
  /** Blur after a field-of-view change while the optics refocus, s. */
  refocusTime: 0.35,
} as const;

export const SENSOR_AGC_NOTES: Record<keyof typeof SENSOR_AGC, SourceNote> = {
  timeConstant: { source: 'plan', confidence: 'estimate' },
  updateInterval: { source: 'plan', confidence: 'estimate' },
  irLowQuantile: { source: 'plan', confidence: 'estimate' },
  irHighQuantile: { source: 'plan', confidence: 'estimate' },
  irMinSpan: { source: 'plan', confidence: 'estimate' },
  irMaxSpan: { source: 'plan', confidence: 'estimate' },
  irNoiseSpan: {
    source: 'zuiderveld1994',
    confidence: 'estimate',
    note: 'the contrast limit of the equalization (as in CLAHE): no bin steeper than the gain this span allows',
  },
  irLevelBalance: {
    source: 'flirCoreAgc',
    confidence: 'estimate',
    note: 'the mean-output-level (ITT mean) control of plateau-equalizing thermal cores',
  },
  irPlateau: {
    source: 'vickers1996',
    confidence: 'estimate',
    note: 'plateau histogram equalization (Vickers, 1996), the usual thermal-imager AGC',
  },
  irEqualization: { source: 'plan', confidence: 'estimate' },
  displayLow: { source: 'plan', confidence: 'estimate' },
  displayHigh: { source: 'plan', confidence: 'estimate' },
  tvLowQuantile: { source: 'plan', confidence: 'estimate' },
  tvHighQuantile: { source: 'plan', confidence: 'estimate' },
  tvMidLevel: {
    source: 'plan',
    confidence: 'estimate',
    note: 'average metering: a median near 18–30 % linear reads mid-grey',
  },
  tvBlackStretch: {
    source: 'plan',
    confidence: 'estimate',
    note: 'dark-object subtraction (remote-sensing haze correction), partial',
  },
  tvMaxBlack: { source: 'plan', confidence: 'estimate' },
  tvMinScene: { source: 'plan', confidence: 'estimate' },
  tvMaxGain: { source: 'plan', confidence: 'estimate' },
  tvGamma: {
    source: 'ituBt709',
    confidence: 'confirmed',
    note: 'ITU-R BT.709 camera transfer (0.45)',
  },
  refocusTime: { source: 'plan', confidence: 'estimate' },
};

/** How the pictures are rendered (design values, not real-world numbers). */
export const SENSOR_RENDER = {
  /** Near plane = this share of the window's height above the ground, within [nearMin, nearMax]. */
  nearAglShare: 0.3,
  /** m: beyond the whole airframe seen from any station (span 17.5 m), so it never shows. */
  nearMin: 20,
  nearMax: 300,
  far: 90000,
  /** The Maverick picture's size relative to the quality's sensor resolution. */
  maverickScale: 0.75,
  /**
   * Scene samples per detector pixel along each axis, per graphics preset. A detector integrates
   * the light over its pixel's area; one point sample per pixel instead aliases what is finer
   * than a pixel (jagged silhouettes and wires, crawling edges). 2 × 2 samples weighted by the
   * point-spread function integrate the area; Low keeps one sample per pixel (the scene pass's
   * fill cost is ×4 with 2 × 2: about 28 → 76 ms per pod picture in software WebGL).
   */
  supersample: { low: 1, medium: 2, high: 2 },
  /** Statistics grid of the AGC (samples per side). */
  statsSize: 64,
} as const;
