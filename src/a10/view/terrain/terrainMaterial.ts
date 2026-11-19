/**
 * The terrain shader: one program draws every part of a tile (tileBuilder.ts KIND) —
 * ground, skirts, roads with markings, the river with sky reflection and sun glint, airbase
 * pavements with runway markings, and the forest canopy shell.
 *
 *   albedo    the tile's baked texture (sRGB, filtered) × close-range detail from a generated
 *             texture array chosen by the baked class (crop rows and furrows turned to each
 *             field's row direction), with bump, a micro layer for speed cues and a mid layer
 *             against blur in the middle distance; the bump's slope is taken over the pixel's
 *             footprint and fades out before rows and furrows alias (no moiré)
 *   light     exactly as three.js lights built-in materials (sun + hemisphere + ambient, /π),
 *             with the sun dimmed under the clouds' shadows
 *   haze      the environment's one law: 1 − exp(−(density·d)²) toward the horizon colour
 *   thermal   uThermal 0 visible / 1 white-hot / 2 black-hot (for the sensors module): ground
 *             temperature from surface class (blended across texel edges, no staircase along
 *             hedgerows and field edges), sun exposure and time of day; the close detail's
 *             facets warm toward the sun by a share of their slope, with no change of the mean
 *   geomorph  by the distance over uLodScale (1; a magnifying sensor's picture draws its own
 *             tiles, selected and morphed as the outside view's would be that much closer)
 *
 * Shared uniforms live in `terrainUniforms` (updated once per frame by TerrainView from
 * a10Env); each tile's material adds its texture and its geomorph range.
 */
import {
  Color,
  DataArrayTexture,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
} from 'three';
import { DETAIL_SCALE, DETAIL_SIZE, MICRO_LAYER } from './detailTextures';

/**
 * The close detail's bump fades out between these many detail texels per pixel. Its slope is a
 * difference over the pixel's footprint, so it is the slope of the height the pixel sees; the
 * crop rows and furrows are 32 and 21 texels apart and would alias from about 11 texels per
 * pixel on, so by 16 the bump is gone (their colour stays, filtered by the texture's mipmaps).
 */
export const BUMP_FADE_TEXELS = [4, 16] as const;

/**
 * Share of the close detail's slope that warms or cools its facets in a thermal picture. The
 * bump is drawn steep for the eye (furrow flanks up to ≈ 77°, crop rows ≈ 63°), and on the drawn
 * normal a midday sun warms hardly any facet but cools every one that leans away: crop and
 * ploughed fields read 3–7 K colder than the seekers' contrast model has the same ground, with
 * stripes from −13 to +2 K. The thermal picture instead changes the sun term LINEARLY in a fifth
 * of the slope — the flanks of real furrows, ≈ 40° — so a field keeps its mean (the seekers'
 * level), with ±3–4 K across crop rows and ±6–8 K across furrows where the pixels resolve them
 * (rows across the sun at 13:00; tests/unit/a10/terrainViewBump.test.ts).
 */
export const THERMAL_BUMP = 0.2;

/** Uniforms every terrain, tree and water material shares (by reference). */
export const terrainUniforms = {
  uDetail: { value: null as DataArrayTexture | null },
  uDetailScale: { value: [...DETAIL_SCALE] as number[] },
  uSunDir: { value: new Vector3(0.4, 0.8, 0.4) },
  uSunColor: { value: new Color(2.5, 2.4, 2.2) },
  uHemiSky: { value: new Color(0.6, 0.66, 0.75) },
  uHemiGround: { value: new Color(0.15, 0.16, 0.1) },
  uAmbient: { value: new Color(0.1, 0.1, 0.1) },
  uHazeColor: { value: new Color(0.6, 0.7, 0.8) },
  uHazeDensity: { value: 5e-5 },
  uZenithColor: { value: new Color(0.1, 0.25, 0.6) },
  uCloudShadow: { value: null as Texture | null },
  /** tile size, mid height of the layer, drift x, drift z */
  uCloudParams: { value: new Vector4(32000, 2200, 0, 0) },
  /** fade start, fade end (horizontal distance from the camera), strength */
  uCloudFade: { value: new Vector3(10000, 14000, 0) },
  /** 0 visible, 1 white-hot, 2 black-hot */
  uThermal: { value: 0 },
  /** x solar heating 0..1 (time of day), y ambient temperature 0..1, z picture gain, w unused */
  uThermalParams: { value: new Vector4(0.7, 0.4, 1, 0) },
  uTime: { value: 0 },
  /** Distance over which close-range ground detail fades out, m. */
  uDetailDistance: { value: 1600 },
  /**
   * Distance divisor of the geomorph: 1 in the outside view; a magnifying sensor's picture draws
   * its own tiles (terrainFocus.ts) as the outside view would that many times closer.
   */
  uLodScale: { value: 1 },
  /** Depth bias of ribbons: Δ = x + y·d² (m toward the camera at distance d). */
  uDepthBias: { value: new Vector2(0.25, 2.4e-7) },
  /** Angle of one pixel of the view, rad (minimum on-screen width of roads). */
  uPixelAngle: { value: 0.0015 },
};

export type TerrainUniforms = typeof terrainUniforms;

const COMMON = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHemiSky;
uniform vec3 uHemiGround;
uniform vec3 uAmbient;
uniform vec3 uHazeColor;
uniform float uHazeDensity;
uniform float uThermal;
uniform vec4 uThermalParams;

float hazeFactor(float d) {
  float x = uHazeDensity * d;
  return 1.0 - exp(-x * x);
}

vec3 lightLambert(vec3 albedo, vec3 n, float sunVisible) {
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 irradiance = uSunColor * (ndl * sunVisible) + mix(uHemiGround, uHemiSky, 0.5 * n.y + 0.5) + uAmbient;
  return albedo * irradiance * RECIPROCAL_PI;
}

/** Thermal picture: temperature 0..1 → grey (white-hot) or inverted (black-hot), hazed. */
vec3 thermalOut(float temperature, float haze) {
  float t = mix(temperature, 0.12, haze * 0.7);
  t = clamp(0.5 + (t - 0.5) * uThermalParams.z, 0.0, 1.0);
  if (uThermal > 1.5) t = 1.0 - t;
  return vec3(t);
}
`;

export const TERRAIN_COMMON_GLSL = COMMON;

const vertexShader = /* glsl */ `
attribute vec4 aNormal;
attribute float aMorph;
attribute vec4 aInfo;
attribute vec2 aRibbon;
attribute vec3 aSide;

uniform vec4 uTile;
uniform vec2 uDepthBias;
uniform float uPixelAngle;
uniform float uLodScale;

varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying vec4 vInfo;
varying vec2 vDims;
varying float vCoverage;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  float d = distance(world.xyz, cameraPosition);
  // geomorph toward the parent's surface as the tile nears the end of its range (at the distance
  // the selection used: a magnifying sensor's is uLodScale times shorter)
  float k = clamp((d / uLodScale - uTile.z) / max(uTile.w - uTile.z, 1.0), 0.0, 1.0);
  float morph = aMorph * k;
  world.y += morph;
  // roads far away: keep them about 1.5 px wide, and let the fragment blend them by coverage
  vec3 shift = vec3(0.0);
  vCoverage = 1.0;
  if (aInfo.x > 1.5 && aInfo.x < 2.5 && aSide.z > 0.0) {
    float hw = aSide.z;
    float w = max(hw, d * uPixelAngle * 0.75);
    shift = vec3(aSide.x, 0.0, aSide.y) * ((w - hw) * (aRibbon.x * 2.0 - 1.0));
    vCoverage = hw / w;
    world.xyz += shift;
  }
  vWorld = world.xyz;
  vNormal = aNormal.xyz;
  vUv = position.xz / uTile.x + 0.5;
  vInfo = vec4(aInfo.x, aInfo.y, aRibbon.x, aRibbon.y);
  vDims = aInfo.zw;
  // view space from the float64-built modelView matrix (precise far from the origin)
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.xyz += (viewMatrix * vec4(shift.x, morph, shift.z, 0.0)).xyz;
  // ribbons (roads, water, pavements) lie on the ground: pull them toward the camera in depth
  if (aInfo.x > 1.5 && aInfo.x < 4.5) {
    float dv = length(mv.xyz);
    float bias = uDepthBias.x + uDepthBias.y * dv * dv;
    mv.xyz *= max(0.0, 1.0 - bias / max(dv, 1.0));
  }
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */ `
precision highp sampler2DArray;
#include <common>
${COMMON}
uniform sampler2D uSplat;
uniform sampler2DArray uDetail;
uniform float uDetailScale[${DETAIL_SCALE.length}];
uniform vec4 uTile;
uniform vec3 uZenithColor;
uniform sampler2D uCloudShadow;
uniform vec4 uCloudParams;
uniform vec3 uCloudFade;
uniform float uTime;
uniform float uDetailDistance;

varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying vec4 vInfo;
varying vec2 vDims;
varying float vCoverage;

const float MICRO = ${MICRO_LAYER}.0;
/** Detail texels per pixel over which the bump fades out (BUMP_FADE_TEXELS). */
const vec2 BUMP_FADE = vec2(${BUMP_FADE_TEXELS[0].toFixed(1)}, ${BUMP_FADE_TEXELS[1].toFixed(1)});
/** Share of the close detail's slope a thermal picture warms its facets by (THERMAL_BUMP). */
const float THERMAL_BUMP = ${THERMAL_BUMP.toFixed(3)};

float cloudShadow(vec3 p) {
  if (uCloudFade.z <= 0.0) return 1.0;
  float above = uCloudParams.y - p.y;
  if (above <= 0.0) return 1.0;
  vec2 q = p.xz + uSunDir.xz / max(uSunDir.y, 0.12) * above;
  float c = texture2D(uCloudShadow, (q - uCloudParams.zw) / uCloudParams.x).r;
  float fade = 1.0 - smoothstep(uCloudFade.x, uCloudFade.y, length(q - cameraPosition.xz));
  return 1.0 - c * fade * uCloudFade.z;
}

/** A thin painted line: 1 on it, anti-aliased, faded out when thinner than a pixel. */
float paint(float x, float halfWidth) {
  float fw = max(fwidth(x), 1e-4);
  float l = 1.0 - smoothstep(halfWidth - fw, halfWidth + fw, abs(x));
  return l * clamp(halfWidth * 2.0 / fw, 0.0, 1.0);
}

/** Size of one repeat of the crown pattern on the canopy shell (≈10 m crowns), m. */
const float CROWN_SCALE = 59.0;
/** Canopy colour where a tile's texel was not classified forest (linear). */
const vec3 CANOPY_ALBEDO = vec3(0.042, 0.071, 0.026);

/** Beyond this distance a forest's shadow band on the ground is under a pixel wide, m. */
const float FOREST_SHADOW_RANGE = 6000.0;

/**
 * Sun left on open ground at tile coordinate uv by the trees toward the sun: three probes
 * along the sun's direction, at the horizontal distances where trees of 4, 9 and 14 m would
 * reach the line to the sun, look for forest in the tile's class texture — a soft band of shade
 * along the anti-sun side of every stand and hedgerow (the canopy has no shadow map).
 */
float forestShadow(vec2 uv) {
  float elev = max(uSunDir.y, 0.1);
  vec2 toSun = normalize(uSunDir.xz + vec2(1e-5, 0.0)) / (elev / sqrt(1.0 - elev * elev));
  float shade = 0.0;
  for (int k = 0; k < 3; k++) {
    float h = 4.0 + 5.0 * float(k);
    vec2 q = uv + toSun * (h / uTile.x);
    ivec2 tc = clamp(ivec2(floor(q * uTile.y + 0.5)), ivec2(0), ivec2(int(uTile.y)));
    float c = mod(floor(texelFetch(uSplat, tc, 0).a * 255.0 + 0.5), 8.0);
    shade += c == 5.0 ? 1.0 / 3.0 : 0.0;
  }
  return 1.0 - 0.82 * shade;
}

/** Ground class (0..7) of the tile texel `tc` (the bake's code in the alpha channel). */
float classAt(ivec2 tc) {
  return mod(floor(texelFetch(uSplat, tc, 0).a * 255.0 + 0.5), 8.0);
}

/** Thermal level and heat uptake of a ground class (the contrast model's GROUND_THERMAL). */
vec2 groundThermal(float cls) {
  float temperature = cls == 3.0 ? 0.52 : cls == 4.0 ? 0.5 : cls == 2.0 ? 0.47 : cls == 5.0 ? 0.33 : cls == 6.0 ? 0.55 : 0.4;
  float heatUptake = cls == 5.0 ? 0.25 : cls == 3.0 || cls == 6.0 ? 0.85 : 0.6;
  return vec2(temperature, heatUptake);
}

/**
 * The ground's thermal level and heat uptake at tile coordinate uv, blended bilinearly between
 * the four nearest texels: classes meet along texel edges, which a magnified thermal picture
 * would show as a staircase of texels along every hedgerow and field edge.
 */
vec2 groundThermalAt(vec2 uv) {
  vec2 f = uv * uTile.y;
  vec2 w = fract(f);
  ivec2 i0 = ivec2(floor(f));
  ivec2 hi = ivec2(int(uTile.y));
  vec2 a = groundThermal(classAt(clamp(i0, ivec2(0), hi)));
  vec2 b = groundThermal(classAt(clamp(i0 + ivec2(1, 0), ivec2(0), hi)));
  vec2 c = groundThermal(classAt(clamp(i0 + ivec2(0, 1), ivec2(0), hi)));
  vec2 d = groundThermal(classAt(clamp(i0 + ivec2(1, 1), ivec2(0), hi)));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

/** paint() with the pixel footprint given (for coordinates that wrap). */
float paintW(float x, float halfWidth, float fw) {
  float l = 1.0 - smoothstep(halfWidth - fw, halfWidth + fw, abs(x));
  return l * clamp(halfWidth * 2.0 / fw, 0.0, 1.0);
}

/** Detail sample (rgb modulation, a height) of a class layer at world-plane coordinates p. */
vec4 detail(vec2 p, float layer) {
  return texture(uDetail, vec3(p / uDetailScale[int(layer)], layer));
}

/**
 * Slope of a detail layer's height at uv (in repeats, per repeat) for a pixel "texels" texels
 * of the layer wide. The difference spans the pixel's footprint (at least a texel): on the coarse
 * mip level the pixel samples it is the smoothed height's slope, continuous, instead of a step
 * per mip texel whose grid beats against the pixels (broad moiré arcs over fields; ±8 K stripes
 * in a thermal picture). It fades out before rows and furrows alias (BUMP_FADE).
 */
vec2 heightSlope(vec2 uv, float layer, float texels) {
  float e = max(1.0, texels) / ${DETAIL_SIZE}.0;
  float fade = 1.0 - smoothstep(BUMP_FADE.x, BUMP_FADE.y, texels);
  float h0 = texture(uDetail, vec3(uv, layer)).a;
  float hx = texture(uDetail, vec3(uv + vec2(e, 0.0), layer)).a;
  float hy = texture(uDetail, vec3(uv + vec2(0.0, e), layer)).a;
  return vec2(hx - h0, hy - h0) / e * fade;
}

/**
 * World-plane slope (x, z) of a detail layer's bump at p (p's axes are ax, ay in world x/z),
 * for a pixel "footprint" metres wide on the ground.
 */
vec2 bumpSlope(vec2 p, float layer, vec2 ax, vec2 ay, float footprint, float strength) {
  float sc = uDetailScale[int(layer)];
  vec2 g = heightSlope(p / sc, layer, footprint / sc * ${DETAIL_SIZE}.0) / sc * strength;
  return g.x * ax + g.y * ay;
}

/** Bumped normal from a detail layer's height at p (p's axes are ax, ay in world x/z). */
vec3 bumped(vec3 n, vec2 p, float layer, vec2 ax, vec2 ay, float footprint, float strength) {
  vec2 gw = bumpSlope(p, layer, ax, ay, footprint, strength);
  return normalize(n - vec3(gw.x, 0.0, gw.y));
}

/** Bumped normal from a detail layer's height sampled at an explicit repeat size (world x/z axes). */
vec3 bumpedAt(vec3 n, vec2 p, float layer, float sc, float footprint, float strength) {
  vec2 g = heightSlope(p / sc, layer, footprint / sc * ${DETAIL_SIZE}.0) / sc * strength;
  return normalize(n - vec3(g.x, 0.0, g.y));
}

void main() {
  float kind = floor(vInfo.x + 0.5);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-3);
  vec3 N = normalize(vNormal);
  // the pixel's footprint on the ground, m (taken here, in uniform control flow, for the bump)
  vec2 wx = dFdx(vWorld.xz);
  vec2 wy = dFdy(vWorld.xz);
  float footprint = max(length(wx), length(wy));
  // thermal: the normal the sun warms, and the close detail's slope on top of it (ground)
  vec3 Nsun = N;
  vec2 facet = vec2(0.0);
  vec2 st = (vUv * uTile.y + 0.5) / (uTile.y + 1.0);
  vec3 albedo = texture2D(uSplat, st).rgb;
  float near = 1.0 - smoothstep(uDetailDistance * 0.35, uDetailDistance, dist);
  float haze = hazeFactor(dist);
  float sunVisible = cloudShadow(vWorld);
  vec3 color;
  float temperature = 0.42;
  float heatUptake = 0.6;

  if (kind < 1.5) {
    // ---- ground (and skirts) ----
    ivec2 tc = clamp(ivec2(floor(vUv * uTile.y + 0.5)), ivec2(0), ivec2(int(uTile.y)));
    float code = floor(texelFetch(uSplat, tc, 0).a * 255.0 + 0.5);
    float cls = mod(code, 8.0);
    if (near > 0.0) {
      vec2 ax = vec2(1.0, 0.0);
      vec2 ay = vec2(0.0, 1.0);
      if (cls == 1.0 || cls == 2.0) {
        float a = floor(code / 8.0) / 32.0 * PI;
        ax = vec2(sin(a), -cos(a));
        ay = vec2(-ax.y, ax.x);
      }
      vec2 p = vec2(dot(vWorld.xz, ax), dot(vWorld.xz, ay));
      vec4 d = detail(p, cls);
      albedo *= mix(vec3(1.0), d.rgb * 2.0, near * 0.8);
      if (cls == 1.0) {
        // tramlines: a pair of wheel tracks every 24 m along the rows — scale from the air
        float fw = max(fwidth(p.y), 1e-4);
        float q = mod(p.y, 24.0);
        float tracks = max(paintW(q - 0.4, 0.22, fw), paintW(q - 2.2, 0.22, fw));
        albedo *= 1.0 - 0.38 * tracks * near;
      }
      float bumpK = cls == 2.0 ? 1.4 : cls == 3.0 ? 1.0 : 0.5;
      facet = bumpSlope(p, cls, ax, ay, footprint, bumpK * near * near);
      N = normalize(N - vec3(facet.x, 0.0, facet.y));
      // micro detail: speed and height cues close to the ground
      float micro = 1.0 - smoothstep(40.0, 260.0, dist);
      if (micro > 0.0) {
        float m = texture(uDetail, vec3(vWorld.xz / uDetailScale[int(MICRO)], MICRO)).r;
        albedo *= mix(1.0, m * 2.0, micro * 0.45);
      }
    }
    // the middle distance: a soft mottling the tile texture is too coarse to carry
    float midK = 1.0 - smoothstep(2500.0, 9000.0, dist);
    if (midK > 0.0) {
      float m = texture(uDetail, vec3(vWorld.xz / 41.0, MICRO)).g;
      albedo *= mix(1.0, 0.88 + 0.24 * m, midK);
    }
    // the shadow a forest edge or hedgerow casts on the open ground beside it
    if (cls != 5.0 && dist < FOREST_SHADOW_RANGE) sunVisible *= forestShadow(vUv);
    color = lightLambert(albedo, N, sunVisible);
    // thermal: the class's level and uptake, blended across texel edges
    vec2 ground = uThermal > 0.5 ? groundThermalAt(vUv) : groundThermal(cls);
    temperature = ground.x;
    heatUptake = ground.y;
  } else if (kind < 2.5) {
    // ---- roads: highway, road, track ----
    float sub = floor(vInfo.y + 0.5);
    float width = max(vDims.x * 0.1, 2.0);
    float x = (vInfo.z - 0.5) * width;
    float v = vInfo.w;
    vec3 ground = albedo;
    vec4 d = detail(vWorld.xz, 6.0);
    if (sub < 1.5) {
      vec3 asphalt = sub < 0.5 ? vec3(0.095, 0.095, 0.1) : vec3(0.115, 0.112, 0.108);
      albedo = asphalt * mix(vec3(1.0), d.rgb * 2.0, 0.6);
      // centre dashes (3 m paint, 9 m gap) and edge lines
      float dash = step(fract(v / 12.0), 0.25);
      float paintK = paint(x, 0.07) * dash + paint(abs(x) - (width * 0.5 - 0.35), 0.075) * (sub < 0.5 ? 1.0 : 0.0);
      albedo = mix(albedo, vec3(0.62), paintK * 0.85);
      // dusty edges
      albedo = mix(albedo, vec3(0.16, 0.14, 0.11), smoothstep(width * 0.5 - 0.6, width * 0.5, abs(x)) * 0.6);
      temperature = 0.58;
      heatUptake = 0.95;
    } else {
      // dirt track: two worn ruts, grass in the middle
      vec4 g = detail(vWorld.xz, 7.0);
      albedo = vec3(0.2, 0.16, 0.115) * mix(vec3(1.0), g.rgb * 2.0, 0.7);
      float ruts = paint(abs(x) - 0.85, 0.35);
      albedo *= 1.0 - 0.18 * ruts;
      vec3 grassy = vec3(0.12, 0.16, 0.075);
      albedo = mix(albedo, grassy, (1.0 - smoothstep(0.25, 0.5, abs(x))) * 0.7);
      albedo = mix(albedo, grassy, smoothstep(width * 0.5 - 0.5, width * 0.5, abs(x)) * 0.8);
      temperature = 0.48;
    }
    // a road thinner than a pixel covers only part of it: the rest is the ground beside it
    albedo = mix(ground, albedo, vCoverage);
    // roads through woods and along hedgerows run in their shade
    if (dist < FOREST_SHADOW_RANGE) sunVisible *= forestShadow(vUv);
    color = lightLambert(albedo, N, sunVisible);
  } else if (kind < 3.5) {
    // ---- the river: dark water reflecting the sky, sun glint, shallow edges ----
    vec2 q = vWorld.xz;
    float t = uTime;
    float r1 = texture(uDetail, vec3(q / 7.0 + vec2(t * 0.045, t * 0.03), MICRO)).r;
    float r2 = texture(uDetail, vec3(q / 19.0 - vec2(t * 0.02, -t * 0.035), MICRO)).g;
    float r3 = texture(uDetail, vec3(q / 7.0 + vec2(0.37, 0.71) + vec2(-t * 0.03, t * 0.04), MICRO)).b;
    vec2 slope = (vec2(r1, r3) + vec2(r2) - 1.0) * mix(0.05, 0.12, near);
    vec3 Nw = normalize(vec3(-slope.x, 1.0, -slope.y));
    vec3 R = reflect(-V, Nw);
    float cosV = max(dot(Nw, V), 0.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
    vec3 sky = mix(uHazeColor, uZenithColor, pow(max(R.y, 0.0), 0.5));
    vec3 body = lightLambert(vec3(0.025, 0.038, 0.032), vec3(0.0, 1.0, 0.0), sunVisible);
    float glint = pow(max(dot(R, uSunDir), 0.0), 900.0) * 900.0 * 0.012;
    color = mix(body, sky, fresnel) + uSunColor * glint * sunVisible;
    // shallow edges show the bank through the water
    float edge = 1.0 - smoothstep(0.0, 0.14, min(vInfo.z, 1.0 - vInfo.z));
    color = mix(color, lightLambert(albedo, N, sunVisible), edge * 0.7);
    temperature = 0.2;
    heatUptake = 0.1;
  } else if (kind < 4.5) {
    // ---- airbase pavements ----
    float sub = floor(vInfo.y + 0.5);
    float across = vInfo.z;
    float along = vInfo.w;
    vec4 d = detail(vWorld.xz, 6.0);
    vec3 concrete = vec3(0.3, 0.295, 0.28);
    albedo = (sub < 0.5 ? vec3(0.085, 0.085, 0.088) : concrete) * mix(vec3(1.0), d.rgb * 2.0, 0.5);
    float paintK = 0.0;
    vec3 paintColor = vec3(0.7);
    if (sub < 0.5) {
      // dimensions ride in the vertex info: width (m), length / 20 (m)
      float halfLen = max(vDims.y * 10.0, 100.0);
      float hw = max(vDims.x * 0.5, 10.0);
      // centre line dashes 30 m / 20 m, edge stripes, threshold bars at both ends
      paintK += paint(across, 0.45) * step(fract(along / 50.0), 0.6);
      paintK += paint(abs(across) - (hw - 1.2), 0.45);
      float fromEnd = halfLen - abs(along);
      float bars = step(6.0, fromEnd) * step(fromEnd, 36.0) * step(abs(across), hw - 3.0) * step(fract(across / 3.6), 0.5);
      paintK += bars;
      float tdz = step(150.0, fromEnd) * step(fromEnd, 172.0) * step(abs(abs(across) - 9.0), 3.0);
      paintK += tdz;
    } else if (sub < 1.5) {
      paintK = paint(across, 0.12);
      paintColor = vec3(0.65, 0.5, 0.08);
    } else {
      // apron slab joints every 5 m
      float jx = paint(fract(across / 5.0) - 0.5, 0.04);
      float jz = paint(fract(along / 5.0) - 0.5, 0.04);
      albedo *= 1.0 - 0.25 * max(jx, jz);
    }
    albedo = mix(albedo, paintColor, clamp(paintK, 0.0, 1.0) * 0.85);
    color = lightLambert(albedo, N, sunVisible);
    temperature = 0.56;
    heatUptake = 0.9;
  } else {
    // ---- forest canopy shell: crowns from above, dark foliage walls along the edges ----
    // the stand's baked colour where the bake saw forest (coarse texels classify roughly)
    ivec2 tc = clamp(ivec2(floor(vUv * uTile.y + 0.5)), ivec2(0), ivec2(int(uTile.y)));
    float cls = mod(floor(texelFetch(uSplat, tc, 0).a * 255.0 + 0.5), 8.0);
    if (cls != 5.0) albedo = CANOPY_ALBEDO;
    // crown clusters (≈10 m) and stands (≈230 m): the canopy keeps a texture at every range
    float crowns = texture(uDetail, vec3(vWorld.xz / CROWN_SCALE, 5.0)).r * 2.0;
    float stands = texture(uDetail, vec3(vWorld.xz / 233.0, MICRO)).g;
    albedo *= mix(1.0, crowns, 0.6) * (0.74 + 0.52 * stands);
    if (kind < 5.5) {
      vec4 d = detail(vWorld.xz, 5.0);
      N = bumpedAt(N, vWorld.xz, 5.0, CROWN_SCALE, footprint, 1.2);
      N = bumped(N, vWorld.xz, 5.0, vec2(1.0, 0.0), vec2(0.0, 1.0), footprint, 1.6 * near);
      Nsun = N; // crowns are real shapes: their sunny sides are warmer
      albedo *= mix(vec3(1.0), d.rgb * 2.0, 0.9 * near);
    } else {
      // foliage side-on along the wall, darker toward the shaded understorey
      vec2 t = normalize(vec2(-vNormal.z, vNormal.x) + vec2(1e-5, 0.0));
      vec2 p = vec2(dot(vWorld.xz, t), vWorld.y * 1.3);
      vec4 d = texture(uDetail, vec3(p / CROWN_SCALE, 5.0));
      albedo *= mix(vec3(1.0), d.rgb * 2.0, 0.8) * (0.35 + 0.65 * vInfo.z * vInfo.z);
    }
    color = lightLambert(albedo, N, sunVisible);
    temperature = 0.3;
    heatUptake = 0.25;
  }

  if (uThermal > 0.5) {
    // the sun on the macro slope; the ground's close-detail facets lean toward or away from it by
    // THERMAL_BUMP of their drawn slope, to first order (a field's mean stays the seekers' level)
    float sun = max(max(dot(Nsun, uSunDir), 0.0) - THERMAL_BUMP * dot(facet, uSunDir.xz), 0.0) * sunVisible;
    float t = temperature + (uThermalParams.x * heatUptake * sun - 0.15) * 0.35 + (uThermalParams.y - 0.4) * 0.3;
    gl_FragColor = vec4(thermalOut(t, haze), 1.0);
    return;
  }

  color = mix(color, uHazeColor, haze);
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * The ONE material all terrain tiles share. Each tile sets its own texture and ranges right
 * before it is drawn (`bindTile`), so the program is never re-keyed and tiles sort front to
 * back without material switches.
 */
export function createTerrainMaterial(): ShaderMaterial {
  const uniforms: Record<string, IUniform> = {
    ...(terrainUniforms as unknown as Record<string, IUniform>),
    uSplat: { value: null },
    uTile: { value: new Vector4(1, 1, 1e9, 2e9) },
  };
  return new ShaderMaterial({
    name: 'TerrainTile',
    uniforms,
    vertexShader,
    fragmentShader,
    fog: false,
  });
}

/** Point the shared material at one tile's texture and parameters (onBeforeRender). */
export function bindTile(material: ShaderMaterial, texture: Texture, tile: Vector4): void {
  material.uniforms.uSplat.value = texture;
  (material.uniforms.uTile.value as Vector4).copy(tile);
  material.uniformsNeedUpdate = true;
}
