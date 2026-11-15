/**
 * GLSL of the ocean material, generated from the wave table (waveExpr.ts) and the tunables
 * (oceanConfig.ts) so no number is typed twice.
 *
 * All positions are OCEAN-LOCAL (world axes, origin at the snapped mesh centre); the CPU keeps
 * world offsets and time inside wrapped phase / offset uniforms (oceanFrame.ts), so the shader
 * only ever sees small numbers.
 *
 * Shading model, in one paragraph: the surface slope is the sum of the analytic waves (band-
 * limited per pixel), the turbine ripple rings and up to three mip-mapped ripple octaves.
 * Whatever slope a pixel cannot resolve is not dropped but accounted for as slope VARIANCE,
 * which widens the sun's specular lobe, lowers the mean Fresnel reflectance and lifts the
 * reflected sky direction (after Cox–Munk / Bruneton). That is what keeps the sea free of
 * sparkle aliasing at distance while still glittering up close.
 */
import { DECK, HULL } from '../../config/layout';
import { waveOmega } from '../../config/waves';
import type { QualityLevel } from '../../state/types';
import { DETAIL_SLOPE_RMS, RIPPLE_FALLOFF, RIPPLE_K_MAX, RIPPLE_K_MIN } from './detailTexture';
import { DETAIL_OCTAVES, OCEAN, textureLayers } from './oceanConfig';
import type { TextureLayer } from './oceanConfig';
import {
  VERTEX_FULL_SAMPLES,
  VERTEX_MIN_SAMPLES,
  WAVE_COUNT,
  glslFloat as f,
  waveDisplacementGLSL,
  waveSurfaceGLSL,
} from './waveExpr';

const D = OCEAN.downwash;
const S = OCEAN.splash;
const TAU = Math.PI * 2;

/** Angular frequencies of the two downwash ripple trains (deep-water dispersion), rad/s. */
export const RING_OMEGA = waveOmega(D.ringWavelength);
export const FINE_RING_OMEGA = waveOmega(D.fineRingWavelength);

/**
 * The ripple slope energy below a cut-off wave number kc (cycles per tile) grows as
 * kc^RIPPLE_ENERGY_EXPONENT: height amplitude ∝ k^-falloff → slope power ∝ k^(2 − 2·falloff),
 * integrated over the 2D lattice (· k dk).
 */
const RIPPLE_ENERGY_EXPONENT = 4 - 2 * RIPPLE_FALLOFF;
const RIPPLE_ENERGY_LOW = RIPPLE_K_MIN ** RIPPLE_ENERGY_EXPONENT;
const RIPPLE_ENERGY_HIGH = RIPPLE_K_MAX ** RIPPLE_ENERGY_EXPONENT;

/**
 * A ripple octave is drawn from its texture only while one tile spans at least this many filter
 * widths on screen; below that its repeats would line up into a visible lattice in the glitter,
 * so it fades into the unresolved variance instead (gone at TILE_WIDTHS_GONE).
 */
const TILE_WIDTHS_FULL = 80;
const TILE_WIDTHS_GONE = 30;

/** Mip bias the swirl fields are sampled with: only their broad shapes bend the wave trains. */
const SWIRL_MIP_BIAS = 3;

function vec3(c: readonly [number, number, number]): string {
  return `vec3(${f(c[0])}, ${f(c[1])}, ${f(c[2])})`;
}

/** GLSL expression: texture coordinate of layer `index` at ocean-local point `point`. */
function layerUv(index: number, layer: TextureLayer, point = 'rest'): string {
  const c = Math.cos(layer.angle) / layer.tile;
  const s = Math.sin(layer.angle) / layer.tile;
  return `(vec2(dot(${point}, vec2(${f(c)}, ${f(s)})), dot(${point}, vec2(${f(-s)}, ${f(c)}))) + uLayerOffset[${index}])`;
}

/**
 * Radial profile of one turbine's blast, shared by both stages. Under a blast the drawn surface
 * deliberately leaves `waveHeightAt` (a bowl up to bowlDepth deep, waves ironed flat): the
 * patches sit outboard of the hull (|x| = 66 m), so the water the hull floats in is unaffected
 * apart from the last centimetres of the ripple rings.
 * u = distance from the impact point in patch radii. Returns
 * (height m, d height / d u, how much of the ambient waves is ironed flat) for the given strength.
 * `ringKeep` fades the ripple train where the mesh (vertex stage) or the pixel (fragment stage)
 * cannot carry it.
 */
const DOWNWASH_PROFILE_GLSL = /* glsl */ `
vec3 oceanDownwashProfile(float u, float radius, float strength, float ringKeep, float ringPhase) {
  float t = clamp((u - ${f(D.bowlFlat)}) / ${f(D.bowlEdge - D.bowlFlat)}, 0.0, 1.0);
  float bowl = ${f(-D.bowlDepth)} * (1.0 - t * t * (3.0 - 2.0 * t));
  float dBowl = ${f((D.bowlDepth * 6) / (D.bowlEdge - D.bowlFlat))} * t * (1.0 - t);
  float g = (u - ${f(D.rimPosition)}) / ${f(D.rimWidth)};
  float rim = ${f(D.rimHeight)} * exp(-g * g);
  float dRim = rim * g * ${f(-2 / D.rimWidth)};
  float envelope = ringKeep * smoothstep(${f(D.rimPosition - 0.2)}, ${f(D.rimPosition + 0.3)}, u)
    * exp(-max(u - ${f(D.rimPosition)}, 0.0) / ${f(D.ringReach)});
  float theta = ${f(TAU / D.ringWavelength)} * radius * u - ringPhase;
  float ring = ${f(D.ringAmplitude)} * envelope * sin(theta);
  // the envelope varies slowly next to the carrier wave, so its derivative is left out
  float dRing = ${f((D.ringAmplitude * TAU) / D.ringWavelength)} * radius * envelope * cos(theta);
  float calm = ${f(D.calm)} * (1.0 - smoothstep(0.5, 1.25, u));
  return strength * vec3(bowl + rim + ring, dBowl + dRim + dRing, calm);
}
`;

export function oceanVertexShader(): string {
  return /* glsl */ `
attribute float aCell;

uniform float uWavePhase[${WAVE_COUNT}];
uniform vec3 uCamLocal;
uniform vec4 uDownwash[4];
uniform vec2 uRingPhase;

varying vec2 vRest;
varying vec3 vPos;
varying float vFar;

${waveDisplacementGLSL()}
${DOWNWASH_PROFILE_GLSL}

void main() {
  vec2 rest = position.xz;

  // turbine downwash: bowl, rim and the first ripple train, where the mesh is fine enough
  float lift = 0.0;
  float calm = 0.0;
  float ringKeep = 1.0 - smoothstep(${f(D.ringWavelength / VERTEX_FULL_SAMPLES)}, ${f(
    D.ringWavelength / VERTEX_MIN_SAMPLES,
  )}, aCell);
  for (int i = 0; i < 4; i++) {
    vec4 blast = uDownwash[i];
    float u = length(rest - blast.xy) / blast.z;
    if (blast.w > 0.0 && u < ${f(D.reach)}) {
      vec3 profile = oceanDownwashProfile(u, blast.z, blast.w, ringKeep, uRingPhase.x);
      lift += profile.x;
      calm = max(calm, profile.z);
    }
  }

  vec3 wave = oceanWaveDisplacement(rest, aCell) * (1.0 - calm);
  vec3 p = vec3(rest.x + wave.x, wave.y + lift, rest.y + wave.z);

  // far proxy: beyond farStart the mesh climbs to eye level, so its rim projects exactly onto
  // the horizon line; the fragment stage intersects the view ray with the sea plane instead
  float far = smoothstep(${f(OCEAN.farStart)}, ${f(OCEAN.farEnd)}, length(rest - uCamLocal.xz));
  p.y = mix(p.y, max(uCamLocal.y, 1.0), far);

  vRest = rest;
  vPos = p;
  vFar = far;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;
}

/** One ripple octave: resolved slope from the texture, unresolved remainder into the variance. */
function octaveGLSL(index: number, level: QualityLevel): string {
  const octave = DETAIL_OCTAVES[level][index];
  const cos = Math.cos(octave.angle);
  const sin = Math.sin(octave.angle);
  const scale = octave.slopeRms / DETAIL_SLOPE_RMS;
  // cut-off wave number (cycles per tile) for a filter of width w metres: tile / (2 w)
  const energyAtUnitFilter = (octave.tile / 2) ** RIPPLE_ENERGY_EXPONENT;
  // the finest octave doubles as the streak pattern of the whitecaps (its height channel) and as
  // the close-up grain of all foam (its slope channels)
  const foamSource =
    index === 0 ? '\n    streaks = texel.b;\n    grain = texel.r + texel.g - 1.0;' : '';
  return /* glsl */ `
  {
    vec4 texel = texture2D(uDetail, ${layerUv(index, octave, 'warped')});${foamSource}
    vec2 s = texel.rg * 2.0 - 1.0;
    float shown = detailGain * smoothstep(${f(TILE_WIDTHS_GONE / octave.tile)}, ${f(TILE_WIDTHS_FULL / octave.tile)}, invFilter);
    slope += shown * vec2(dot(s, vec2(${f(cos * scale)}, ${f(-sin * scale)})), dot(s, vec2(${f(sin * scale)}, ${f(cos * scale)})));
    float resolved = clamp((${f(energyAtUnitFilter)} * filterEnergy - ${f(RIPPLE_ENERGY_LOW)}) / ${f(
      RIPPLE_ENERGY_HIGH - RIPPLE_ENERGY_LOW,
    )}, 0.0, 1.0);
    variance += ${f(octave.slopeRms ** 2)} * (detailGain * detailGain - shown * shown * resolved);
  }`;
}

export function oceanFragmentShader(level: QualityLevel): string {
  const layers = textureLayers(level);
  const octaveCount = DETAIL_OCTAVES[level].length;
  const foamIndex = octaveCount;
  const gustIndex = octaveCount + 1;
  const swirlIndex = octaveCount + 3;
  const foamLayer = layers[foamIndex];
  const halfLength = HULL.length / 2;
  const halfBeam = HULL.beam / 2;
  // spray foam is carried outward with a two-phase flow map; the Low preset keeps it static
  const flowFoam = level !== 'low';
  const octaves = DETAIL_OCTAVES[level].map((_, i) => octaveGLSL(i, level)).join('\n');

  return /* glsl */ `
uniform sampler2D uDetail;
uniform float uWavePhase[${WAVE_COUNT}];
uniform vec2 uLayerOffset[${layers.length}];
uniform float uAnisotropy;
uniform vec3 uCamLocal;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHorizonColor;
uniform vec3 uZenithColor;
uniform vec3 uFogColor;
uniform vec4 uFog;        // density (exp²), near, far (linear), 1 = linear fog
uniform vec4 uShip;       // hull centre x, z · unit forward x, z
uniform vec3 uShipState;  // waterline foam 0..1, wake speed m/s, wake length m
uniform vec2 uSplash;     // seconds since the last splashdown · its strength (0 = none)
uniform vec4 uShadow;     // shadow centre x, z · softness m · strength 0..1
uniform vec4 uDownwash[4]; // impact x, z · patch radius m · strength 0..1
uniform vec2 uRingPhase;
uniform float uFlowPhase;

varying vec2 vRest;
varying vec3 vPos;
varying float vFar;

const vec3 WATER_COLOR = ${vec3(OCEAN.waterColor)};
const vec3 SCATTER_COLOR = ${vec3(OCEAN.scatterColor)};
const vec3 FOAM_COLOR = ${vec3(OCEAN.foamColor)};

${waveSurfaceGLSL()}
${DOWNWASH_PROFILE_GLSL}

// lacy break-up noise (mean 0.5) from a detail texel: soft blobs cut up by the fine slope pattern
float lace(vec4 texel) {
  return 0.5 + 0.5 * (texel.b - 0.5) + 0.8 * (texel.r + texel.g - 1.0);
}

// share of the surface covered by foam for a coverage amount 0..1 and a break-up noise (mean 0.5)
float foamCover(float amount, float noise) {
  return smoothstep(0.95 - amount, 1.25 - amount, noise);
}

void main() {
  // ---- which point of the sea does this pixel show? ---------------------------------------
  vec3 toFragment = vPos - uCamLocal;
  float dist = length(toFragment);
  vec3 dir = toFragment / dist;
  vec2 rest = vRest;
  if (vFar > 0.0) {
    float t = min(max(uCamLocal.y, 1.0) / max(-dir.y, 1e-6), dist * ${f(OCEAN.farMaxScale)});
    rest = uCamLocal.xz + dir.xz * t;
    dist = t;
  }
  vec2 du = dFdx(rest);
  vec2 dv = dFdy(rest);
  float major = max(length(du), length(dv));
  float minor = abs(du.x * dv.y - du.y * dv.x) / max(major, 1e-6);
  // width of the (anisotropic) texture filter, and the ripple energy a unit tile keeps under it
  float filterWidth = max(max(minor, major / uAnisotropy), 1e-3);
  float invFilter = 1.0 / filterWidth;
  float filterEnergy = pow(filterWidth, ${f(-RIPPLE_ENERGY_EXPONENT)});

  // ---- large, slow wind field ---------------------------------------------------------------
  float gustA = texture2D(uDetail, ${layerUv(gustIndex, layers[gustIndex])}).a;
  float gustB = texture2D(uDetail, ${layerUv(gustIndex + 1, layers[gustIndex + 1])}).a;
  float gust = clamp(gustA + gustB - 0.5, 0.0, 1.0);
  // Away from the camera the wave trains wax, wane and bend with that field and with a pair of
  // mid-scale ones, like the groups of a real sea: a handful of plane waves and repeating ripple
  // tiles would otherwise weave a regular lattice across the water. The swirl fields are read
  // from a coarse mip so they bend the crests smoothly, and they leave the ripple tiles alone.
  vec2 gusts = vec2(gustA, gustB);
  vec2 swirl = vec2(
    texture2D(uDetail, ${layerUv(swirlIndex, layers[swirlIndex])}, ${f(SWIRL_MIP_BIAS)}).a,
    texture2D(uDetail, ${layerUv(swirlIndex + 1, layers[swirlIndex + 1])}, ${f(SWIRL_MIP_BIAS)}).a);
  float irregular = smoothstep(${f(OCEAN.irregularStart)}, ${f(OCEAN.irregularEnd)}, dist);
  vec2 groups = max(1.0 + 1.6 * (gusts + swirl.yx - 1.0), 0.15);
  vec3 waveGain = vec3(mix(vec2(1.0), groups, irregular), 1.0 - 0.85 * irregular);
  vec2 warped = rest + ${f(OCEAN.irregularWarp)} * irregular * (gusts - 0.5);
  vec2 swirled = warped + ${f(OCEAN.irregularSwirl)} * irregular * (swirl - 0.5);

  // ---- ship: hull outline, wake, contact shadow ------------------------------------------------
  vec2 fwd = uShip.zw;
  vec2 side = vec2(-fwd.y, fwd.x);
  vec2 rel = rest - uShip.xy;
  float along = -dot(rel, fwd);      // + toward the stern
  float across = abs(dot(rel, side));
  float bow = clamp((-along - ${f(OCEAN.bowTaperFrom)}) / ${f(halfLength - OCEAN.bowTaperFrom)}, 0.0, 1.0);
  vec2 hullEdge = vec2(across - ${f(halfBeam)} * (1.0 - 0.88 * bow * bow), abs(along) - ${f(halfLength)});
  float hullDist = length(max(hullEdge, 0.0)) + min(max(hullEdge.x, hullEdge.y), 0.0);
  float speedK = clamp(uShipState.y / ${f(OCEAN.wakeFullSpeed)}, 0.0, 1.0);
  // a hull lying still only has a thin, broken wash; the solid belt belongs to a hull under way
  float hullFoam = uShipState.x * mix(${f(OCEAN.hullFoamAtRest)}, 1.0, speedK)
    * (1.0 - smoothstep(0.5, ${f(OCEAN.hullFoamWidth)} + ${f(OCEAN.hullFoamSpeedWidth)} * speedK, hullDist));

  float astern = along - ${f(halfLength)};
  float wakeFade = 1.0 - clamp(astern / max(uShipState.z, 1.0), 0.0, 1.0);
  float wakeHalf = ${f(halfBeam * 0.85)} + max(astern, 0.0) * ${f(OCEAN.wakeSpread)};
  float wakeCore = speedK * wakeFade * sqrt(wakeFade)
    * smoothstep(${f(-0.3 * halfLength)}, ${f(halfLength)}, along)
    * (1.0 - smoothstep(0.55 * wakeHalf, wakeHalf, across));
  float fromBow = along + ${f(halfLength)};
  float armOffset = (across - ${f(halfBeam * 0.4)} - fromBow * ${f(OCEAN.kelvinTan)}) / (2.5 + fromBow * 0.03);
  float arms = speedK * smoothstep(0.0, 20.0, fromBow) * exp(-armOffset * armOffset)
    * exp(-fromBow / max(uShipState.z, 1.0));

  vec2 shadowRel = rest - uShadow.xy;
  float shadowDist = max(abs(dot(shadowRel, side)) - ${f(DECK.halfWidth)}, abs(dot(shadowRel, fwd)) - ${f(halfLength)});
  float shadow = uShadow.w * (1.0 - smoothstep(-0.5 * uShadow.z, uShadow.z, shadowDist));

  // ---- turbine downwash ---------------------------------------------------------------------------
  vec2 ringSlope = vec2(0.0);
  vec2 flow = vec2(0.0);
  float calm = 0.0;
  float spray = 0.0;
  float blast = 0.0;
  float ringZone = 0.0;
  float ringKeep = 1.0 - smoothstep(${f(0.25 * D.ringWavelength)}, ${f(D.ringWavelength)}, major);
  float fineKeep = 1.0 - smoothstep(${f(0.25 * D.fineRingWavelength)}, ${f(D.fineRingWavelength)}, major);
  for (int i = 0; i < 4; i++) {
    vec4 hit = uDownwash[i];
    vec2 offset = rest - hit.xy;
    float rho = length(offset);
    float u = rho / hit.z;
    if (hit.w > 0.0 && u < ${f(D.reach)}) {
      vec2 radial = offset / max(rho, 1e-3);
      vec3 profile = oceanDownwashProfile(u, hit.z, hit.w, ringKeep, uRingPhase.x);
      float outside = exp(-max(u - ${f(D.rimPosition)}, 0.0) / ${f(D.ringReach)});
      float fine = ${f(D.fineRingSlope)} * hit.w * fineKeep * smoothstep(0.25, 0.9, u) * outside
        * cos(${f(TAU / D.fineRingWavelength)} * rho - uRingPhase.y);
      ringSlope += radial * (profile.y / hit.z + fine);
      calm = max(calm, profile.z);
      // spray thrown off the rim, plus foam riding the crests of the ripple rings beyond it
      float rings = hit.w * smoothstep(0.7, 1.3, u) * outside;
      float ringCrest = smoothstep(0.1, 0.9, sin(${f(TAU / D.ringWavelength)} * rho - uRingPhase.x));
      spray += hit.w * smoothstep(0.3, 0.95, u) * (1.0 - smoothstep(1.15, 2.4, u))
        + 0.5 * rings * ringKeep * ringCrest;
      ringZone += rings;
      blast += hit.w * (1.0 - smoothstep(0.2, 1.3, u));
      flow += radial * (hit.w * smoothstep(0.1, 0.8, u) * outside);
    }
  }
  spray = min(spray, 1.0);
  ringZone = min(ringZone, 1.0);
  blast = min(blast, 1.0);

  // ---- foam break-up noise ------------------------------------------------------------------------
  vec4 foamTexel = texture2D(uDetail, ${layerUv(foamIndex, foamLayer)});
  float foamNoise = lace(foamTexel);
${
  flowFoam
    ? /* glsl */ `
  // two samples carried outward by the blast, cross-faded so neither is ever seen snapping back
  vec2 carried = flow * ${f(D.flowSpeed * D.flowPeriod)};
  vec2 restA = rest - carried * uFlowPhase;
  vec2 restB = rest - carried * fract(uFlowPhase + 0.5) + vec2(13.7, 7.3);
  float sprayNoise = mix(
    lace(texture2D(uDetail, ${layerUv(foamIndex, foamLayer, 'restA')})),
    lace(texture2D(uDetail, ${layerUv(foamIndex, foamLayer, 'restB')})),
    abs(1.0 - 2.0 * uFlowPhase));`
    : /* glsl */ `
  float sprayNoise = foamNoise;`
}

  // ---- surface slope and what the pixel cannot resolve of it ---------------------------------
  vec3 wave = oceanWaveSurface(swirled, du, dv, waveGain) * (1.0 - calm);
  vec2 slope = wave.xy + ringSlope;
  float crest = wave.z;
  // gusts roughen the water in patches; the churned wake is smoother than the sea around it and
  // the blast sweeps the small ripples aside, so its rings read clearly
  float detailGain = mix(0.8, 1.15, gust) * (1.0 - 0.5 * wakeCore) * (1.0 - 0.55 * ringZone);
  float variance = ${f(OCEAN.roughnessMin)} + 0.03 * blast;
  float streaks = 0.5;
  float grain = 0.0;
${octaves}
  float sigma = sqrt(variance);
  vec3 normal = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 view = -dir;

  // ---- foam ----------------------------------------------------------------------------------------
  // whitecaps: streaks of broken foam where the wave components crest together, more in gusts
  float capField = 0.6 * crest + 1.4 * (streaks - 0.5) + 0.25 * (gust - 0.5);
  float laceNoise = foamNoise + 0.6 * grain;
  float caps = foamCover(0.8 * smoothstep(${f(OCEAN.capStart)}, ${f(OCEAN.capEnd)}, capField), laceNoise);
  // whitecaps too small for the pixel survive as their average cover instead of sparkling
  caps = mix(caps, ${f(OCEAN.capMeanCover)} * (0.4 + 1.2 * gust), smoothstep(1.5, 7.0, major));
  // splashdown: a surge of foam runs out from the hull side, ragged and densest at its front,
  // and dissolves
  float splashFront = ${f(S.reach)} * sqrt(uSplash.y) * (1.0 - exp(-uSplash.x / ${f(S.rise)}));
  float splashOffset = (hullDist + ${f(S.ragged)} * (laceNoise - 0.5) - splashFront) / ${f(S.frontWidth)};
  float splash = min(uSplash.y, 1.0) * (1.0 - smoothstep(0.3, 1.0, uSplash.x / ${f(S.duration)}))
    * (0.75 * (1.0 - smoothstep(0.0, splashFront + 1.0, hullDist)) + 0.9 * exp(-splashOffset * splashOffset));
  float shipFoam = foamCover(max(max(hullFoam, splash), max(0.9 * wakeCore, 0.75 * arms)), laceNoise);
  float sprayFoam = foamCover(0.95 * spray, sprayNoise + 0.6 * grain) + 0.3 * blast;
  float foam = clamp(caps + shipFoam + sprayFoam, 0.0, 1.0);
  float aerated = clamp(0.7 * wakeCore + 0.4 * hullFoam + 0.5 * splash + 0.5 * blast + 0.3 * spray, 0.0, 1.0);

  // ---- light ---------------------------------------------------------------------------------------
  float sunUp = max(uSunDir.y, 0.0);
  vec3 sunLight = uSunColor * (1.0 - shadow) * smoothstep(-0.02, 0.03, uSunDir.y);
  vec3 ambient = mix(uHorizonColor, uZenithColor, 0.6) * (1.0 - 0.35 * shadow);

  // mean Fresnel reflectance of a rough sea (Bruneton et al.)
  float cosView = clamp(dot(normal, view), 0.02, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosView, 5.0 * exp(-2.69 * sigma)) / (1.0 + 22.7 * pow(sigma, 1.5));

  // reflected sky: a rough surface sees, on average, a patch higher up the sky
  vec3 reflected = reflect(dir, normal);
  float elevation = clamp(max(reflected.y, 0.0) + ${f(OCEAN.skyLift)} * sigma * (1.0 - max(reflected.y, 0.0)), 0.0, 1.0);
  float skyBlend = 1.0 - (1.0 - elevation) * (1.0 - elevation) * (1.0 - elevation);
  vec3 sky = mix(uHorizonColor, uZenithColor, skyBlend) * (1.0 - 0.5 * shadow);

  // light scattered back out of the water; more of it where the water is thin or full of bubbles
  vec3 body = WATER_COLOR * (ambient + 0.5 * sunUp * sunLight);
  vec2 sunAzimuth = uSunDir.xz / max(length(uSunDir.xz), 1e-4);
  float towardSun = clamp(0.5 + 0.5 * dot(normalize(dir.xz + vec2(1e-5)), sunAzimuth), 0.0, 1.0);
  float thin = smoothstep(-0.3, 0.6, crest + streaks - 0.5) * (0.2 + 0.8 * towardSun * towardSun);
  body += SCATTER_COLOR * sunLight * thin * 0.22;
  body += SCATTER_COLOR * (ambient + sunUp * sunLight) * aerated * 1.6;

  // sun (or moon) glitter: probability that a facet has the slope that mirrors the light at us
  vec3 halfway = normalize(uSunDir + view);
  float halfUp = max(halfway.y, 0.05);
  vec2 miss = -halfway.xz / halfUp - slope;
  float facets = exp(-0.5 * dot(miss, miss) / variance) / (${f(TAU)} * variance);
  float halfFresnel = 0.02 + 0.98 * pow(1.0 - max(dot(view, halfway), 0.0), 5.0);
  float glitter = halfFresnel * facets / (4.0 * halfUp * halfUp * halfUp * halfUp * (max(view.y, 0.0) + 0.6 * sigma + 0.02));
  // soft shoulder instead of a clip: the brightest glints stay distinct from their neighbours
  vec3 glint = sunLight * (${f(OCEAN.glitterGain)} * glitter);
  vec3 sun = glint / (1.0 + max(glint.r, max(glint.g, glint.b)) / ${f(OCEAN.glitterMax)});

  vec3 color = body + fresnel * sky + sun;

  // foam is a diffuse white: lit by the whole sky and the sun, it outshines grazing reflections
  vec3 foamLit = FOAM_COLOR * (0.95 * ambient + sunLight * (0.05 + 0.3 * max(dot(normal, uSunDir), 0.0)));
  color = mix(color, foamLit, foam);

  // ---- aerial perspective, in step with the scene fog -------------------------------------------
  float density = uFog.x * dist;
  float fog = mix(1.0 - exp(-density * density), clamp((dist - uFog.y) / (uFog.z - uFog.y), 0.0, 1.0), uFog.w);
  fog = max(fog, smoothstep(${f(OCEAN.horizonGuardStart)}, ${f(OCEAN.horizonGuardEnd)}, dist));
  color = mix(color, uFogColor, fog);

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
}
