/**
 * Tunables of the ocean look, in one place. Distances in metres, colours linear RGB.
 * The shader sources (oceanShader.ts) and the per-frame update (oceanFrame.ts) both read from
 * here, so a number is never typed twice.
 */
import type { QualityLevel } from '../../state/types';

export const OCEAN = {
  // ---- far field -------------------------------------------------------------------------
  /**
   * Beyond `farStart` (horizontal distance from the camera) the mesh stops being the sea itself
   * and becomes a proxy that ramps up to eye level at `farEnd`; the fragment shader intersects
   * each pixel's ray with the plane y = 0 instead. That turns the finite mesh into an exact
   * image of an infinite flat sea whose horizon coincides with the sky's at any altitude.
   */
  farStart: 26_000,
  farEnd: 33_000,
  /** Cap on how far beyond the proxy a reconstructed sea point may lie (× the proxy distance). */
  farMaxScale: 60,
  /** The mesh centre may sit this far from the camera at most (bias toward the ship). */
  maxCentreBias: 1_600,

  // ---- aerial perspective ----------------------------------------------------------------
  /** FogExp2-style density used when the scene has no fog of its own. */
  defaultFogDensity: 0.00007,
  /** Whatever the scene fog does, the sea is pure horizon colour between these distances. */
  horizonGuardStart: 16_000,
  horizonGuardEnd: 36_000,

  // ---- water -----------------------------------------------------------------------------
  /** Diffuse reflectance of deep water (what comes back out after scattering below the surface). */
  waterColor: [0.0045, 0.036, 0.078] as const,
  /** Extra forward-scattered light in thin, sun-facing crests and in aerated water. */
  scatterColor: [0.012, 0.115, 0.105] as const,
  foamColor: [0.82, 0.86, 0.88] as const,
  /** Slope variance per axis that is never resolved, however close the camera is. */
  roughnessMin: 0.0012,
  /** How far up the sky a rough surface reflects on average, in units of its RMS slope. */
  skyLift: 1.6,
  /** Scale of the sun's specular lobe and the cap that keeps single pixels from exploding. */
  glitterGain: 1.4,
  glitterMax: 9,
  /** Anisotropy the detail texture is filtered with (also assumed by the analytic fades). */
  anisotropy: 8,

  // ---- far-field irregularity --------------------------------------------------------------
  /**
   * Between these distances from the mesh centre the analytic waves start to wax, wane and bend
   * with a slow noise, so that from altitude the sea is not a regular weave of plane waves.
   * Inside `irregularStart` (the hull and its surroundings) the normals match the displaced
   * geometry exactly.
   */
  irregularStart: 250,
  irregularEnd: 900,
  /** Peak-to-peak sideways bend of the wave trains (and ripple tiles) by that noise, m. */
  irregularWarp: 160,

  // ---- whitecaps ---------------------------------------------------------------------------
  capStart: 0.55,
  capEnd: 0.8,
  /** Average foam cover that stands in for whitecaps too small to resolve. */
  capMeanCover: 0.012,

  // ---- turbine downwash ----------------------------------------------------------------------
  downwash: {
    /** Patch radius = radiusBase + radiusPerMetre · (distance from nozzle to water). */
    radiusBase: 22,
    radiusPerMetre: 0.22,
    /** Nothing is evaluated beyond this many patch radii. */
    reach: 4.5,
    bowlDepth: 2.2,
    /** The bowl is flat out to `bowlFlat` and has climbed back to sea level at `bowlEdge` (patch radii). */
    bowlFlat: 0.35,
    bowlEdge: 1.0,
    rimHeight: 0.7,
    /** Rim position and width in patch radii. */
    rimPosition: 1.1,
    rimWidth: 0.24,
    /** How much of the ambient waves the blast irons flat at the centre of the patch. */
    calm: 0.85,
    /** Concentric ripples leaving the rim: the train that is also displaced geometrically… */
    ringWavelength: 14,
    ringAmplitude: 0.42,
    /** …and a finer one that only exists in the shading. */
    fineRingWavelength: 5.5,
    fineRingSlope: 0.2,
    /** e-folding reach of both trains beyond the rim, in patch radii. */
    ringReach: 1.7,
    /** Peak speed of the surface outflow that carries the spray foam, m/s. */
    flowSpeed: 9,
    /** Period of the two-phase flow animation, s. */
    flowPeriod: 2.6,
  },

  // ---- hull, wake, shadow ----------------------------------------------------------------------
  /** Seconds of travel the turbulent wake stays visible for, and its cap in metres. */
  wakePersistence: 55,
  wakeMaxLength: 2_400,
  /** Hull speed (m/s) at which wake and bow wave are fully developed. */
  wakeFullSpeed: 9,
  /** Widening of the turbulent wake per metre astern. */
  wakeSpread: 0.07,
  /** Tangent of the half-angle of the diverging bow-wave arms (the Kelvin angle, 19.5°). */
  kelvinTan: 0.354,
  /** The hull outline narrows toward the bow from this distance ahead of midships, m. */
  bowTaperFrom: 60,
  /** Keel height above the water (m) over which the waterline foam fades out. */
  hullFoamEndHeight: 5,
  /** Keel height above the water (m) between which the contact shadow fades out. */
  shadowFullHeight: 40,
  shadowEndHeight: 150,
} as const;

/** Deep-water phase speed of a wave of the given length, m/s. */
function phaseSpeed(wavelength: number): number {
  return Math.sqrt((9.81 * wavelength) / (2 * Math.PI));
}

export interface TextureLayer {
  /** World size of one repeat of the detail texture, m. */
  tile: number;
  /** Rotation of the texture's u axis from world +X toward +Z, rad. */
  angle: number;
  /** World drift along the u axis, m/s. */
  speed: number;
}

export interface DetailOctave extends TextureLayer {
  /** RMS slope per axis this octave adds when fully resolved. */
  slopeRms: number;
}

const DEG = Math.PI / 180;

function octave(tile: number, angleDeg: number, slopeRms: number): DetailOctave {
  // the texture's dominant ripples are about a twelfth of a tile long; let them run at their own
  // phase speed so short ripples crawl and long ones stride, like the real thing
  return { tile, angle: angleDeg * DEG, speed: phaseSpeed(tile / 12), slopeRms };
}

/**
 * Ripple octaves per quality level, finest first. The finest one doubles as the whitecap
 * streak pattern and the close-up grain of all foam. Tiles are mutually irrational and each octave has its own heading, so no repeat lines up.
 */
export const DETAIL_OCTAVES: Record<QualityLevel, readonly DetailOctave[]> = {
  low: [octave(31, 26, 0.12), octave(173, -31, 0.085)],
  medium: [octave(19, 31, 0.105), octave(67, -38, 0.085), octave(241, 9, 0.06)],
  high: [octave(19, 31, 0.105), octave(67, -38, 0.085), octave(241, 9, 0.06)],
};

/** Foam break-up pattern (B channel). */
export const FOAM_LAYER: TextureLayer = { tile: 27, angle: 74 * DEG, speed: 0.5 };
/** Large, slow noise fields (A channel): wind gusts and far-field wave irregularity. */
export const GUST_LAYERS: readonly [TextureLayer, TextureLayer] = [
  { tile: 3_700, angle: 17 * DEG, speed: 7 },
  { tile: 2_300, angle: -64 * DEG, speed: 5 },
];

/** All texture layers of a quality level in uniform order: octaves…, foam, gust A, gust B. */
export function textureLayers(level: QualityLevel): readonly TextureLayer[] {
  return [...DETAIL_OCTAVES[level], FOAM_LAYER, ...GUST_LAYERS];
}

/**
 * Texture-space offset of each layer at the ocean-local origin: R(angle)·centre / tile minus the
 * drift, wrapped to [0, 1). Double precision here keeps the shader's coordinates small.
 */
export function computeLayerOffsets(
  layers: readonly TextureLayer[],
  centerX: number,
  centerZ: number,
  time: number,
  out: Float32Array,
): void {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const cos = Math.cos(layer.angle);
    const sin = Math.sin(layer.angle);
    const u = (cos * centerX + sin * centerZ - layer.speed * time) / layer.tile;
    const v = (-sin * centerX + cos * centerZ) / layer.tile;
    out[i * 2] = u - Math.floor(u);
    out[i * 2 + 1] = v - Math.floor(v);
  }
}
