/**
 * The three full-screen passes that turn a sensor's render of the world into its picture
 * (SensorRenderer.ts). The per-pixel physics transcribes radiometry.ts; the statistics encoding
 * matches agc.ts.
 *
 *   SIGNAL   (effective resolution) scene colour + depth → the sensor's signal per detector
 *            pixel: infrared = apparent temperature in kelvin above the ambient air (the haze of
 *            radiometry.ts from each sample's depth, the cold sky, smoke and flames over the sky),
 *            television = luminance, each averaged over the pixel's SS × SS scene samples (the
 *            detector integrates its area: no moiré from detail finer than a pixel); plus the
 *            detector's noise (temporal, fixed pattern, photon shot noise).
 *   DISPLAY  (picture resolution) the signal upsampled with a cubic B-spline (the electronic
 *            zoom's blur when the detector has fewer pixels than the picture), the AGC (infrared:
 *            its transfer curve over [lo, hi]; television: exposure, black level and gamma), the
 *            polarity, video noise; written as LINEAR values into an sRGB render target, so
 *            whoever samples it the three.js way shows the intended grey levels.
 *   STATS    (64 × 64) the signal packed in 16 bits for the AGC's asynchronous readback.
 */
import {
  BufferGeometry,
  Float32BufferAttribute,
  Matrix3,
  ShaderMaterial,
  Vector2,
  type Texture,
} from 'three';
import { STATS_IR_OFFSET, STATS_IR_RANGE, STATS_TV_LOG_MIN, STATS_TV_LOG_RANGE } from './agc';

/** One triangle covering the viewport (clip space positions, uv 0..1 over the viewport). */
export function createFullscreenTriangle(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  return g;
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const NOISE = /* glsl */ `
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
/** A standard normal deviate from three integers (Box–Muller on two hashed uniforms). */
float gaussian(uvec3 key) {
  uvec3 h = pcg3d(key);
  float u1 = max(float(h.x >> 8u) / 16777216.0, 1e-7);
  float u2 = float(h.y >> 8u) / 16777216.0;
  return sqrt(-2.0 * log(u1)) * cos(6.28318530718 * u2);
}
`;

/** The signal pass for `ss` × `ss` scene samples per detector pixel. */
const signalFragment = (ss: number): string => /* glsl */ `
precision highp float;
#include <packing>
${NOISE}
#define SS ${Math.max(1, Math.round(ss))}
#define TAPS ${2 * Math.max(1, Math.round(ss))}
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uRect;
uniform vec2 uSceneTexel;
uniform float uPsf;
uniform vec2 uPixels;
uniform int uBand;
uniform int uState;
uniform float uNear;
uniform float uFar;
uniform float uTanHalf;
uniform mat3 uCamRot;
uniform float uAmbient;
uniform float uKPerUnit;
uniform float uHazeRho;
uniform float uHazeShare;
uniform float uSkyHorizon;
uniform float uSkyZenith;
uniform float uSkyBase;
uniform float uMaskK;
uniform float uMaskLum;
uniform float uNetd;
uniform float uFpn;
uniform float uFpnRows;
uniform float uFpnSeed;
uniform float uElectrons;
uniform float uRead;
uniform float uFrame;
varying vec2 vUv;

/** Sky temperature at elevation sine s: the hazed horizon's level, colder up to the zenith. */
float skyKelvin(float s) {
  float w = s > 1e-3 ? pow(uSkyBase, 1.0 / min(s, 1.0) - 1.0) : 0.0;
  return uSkyHorizon + w * (uSkyZenith - uSkyHorizon);
}

/** Apparent temperature (K above the air) of the scene sample at st. */
float sampleKelvin(vec2 st, float rayLen, float sky) {
  vec4 c = texture2D(tScene, st);
  float z = texture2D(tDepth, st).r;
  if (z >= 0.999999) {
    // no surface: the cold sky, with smoke and flames drawn over it
    float a = clamp(c.a, 0.0, 1.0);
    float part = a > 1e-3 ? (c.r / a - uAmbient) * uKPerUnit : sky;
    return mix(sky, part, a);
  }
  // the surface's temperature behind the haze of its distance (radiometry.apparentKelvin)
  float viewZ = perspectiveDepthToViewZ(z, uNear, uFar);
  float x = uHazeRho * (-viewZ * rayLen);
  float k = uHazeShare * (1.0 - exp(-x * x));
  return (c.r - uAmbient) * uKPerUnit * (1.0 - k) + uSkyHorizon * k;
}

/**
 * Tap (i, j) of the TAPS × TAPS scene samples around a detector pixel (its own SS × SS and
 * half a pixel of its neighbours'): xy = the sample in the scene texture (clamped into the
 * rendered rectangle), z = its weight — the point-spread function, a Gaussian of uPsf detector
 * pixels (the optics, the line of sight's jitter, the pixel's own area).
 */
vec3 tap(vec2 st, int i, int j) {
  vec2 o = vec2(float(i), float(j)) - 0.5 * float(TAPS - 1);
  vec2 od = o / float(SS);
  float w = exp(-dot(od, od) / (2.0 * uPsf * uPsf));
  vec2 s = clamp(st + o * uSceneTexel, 0.5 * uSceneTexel, uRect - 0.5 * uSceneTexel);
  return vec3(s, w);
}

void main() {
  if (uState == 0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 dirCam = vec3(ndc * uTanHalf, -1.0);
  float rayLen = length(dirCam);
  vec3 dirW = uCamRot * (dirCam / rayLen);
  uvec2 pix = uvec2(vUv * uPixels);
  uvec3 key = uvec3(pix, uint(uFrame));
  // the detector pixel's centre in the scene texture, whose SS × SS samples it integrates
  vec2 st = vUv * uRect;
  float signal;
  if (uBand == 1) {
    float dT;
    if (uState == 1) {
      // the airframe a few metres away, far out of focus: a smooth field
      dT = uMaskK + 0.6 * ndc.y;
    } else {
      float sky = skyKelvin(dirW.y);
      dT = 0.0;
      float wsum = 0.0;
      for (int j = 0; j < TAPS; j++) {
        for (int i = 0; i < TAPS; i++) {
          vec3 t = tap(st, i, j);
          dT += t.z * sampleKelvin(t.xy, rayLen, sky);
          wsum += t.z;
        }
      }
      dT /= wsum;
    }
    // detector noise: temporal, and the array's residual fixed pattern (columns of a staring
    // array, rows of a scanned one)
    float line = uFpnRows > 0.5 ? float(pix.y) : float(pix.x);
    dT += uNetd * gaussian(key) + uFpn * gaussian(uvec3(uint(line), 977u, uint(uFpnSeed)));
    signal = dT;
  } else {
    float L;
    if (uState == 1) {
      L = uMaskLum * (1.0 + 0.15 * ndc.y);
    } else {
      L = 0.0;
      float wsum = 0.0;
      for (int j = 0; j < TAPS; j++) {
        for (int i = 0; i < TAPS; i++) {
          vec3 t = tap(st, i, j);
          vec3 c = texture2D(tScene, t.xy).rgb;
          L += t.z * max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0);
          wsum += t.z;
        }
      }
      L /= wsum;
    }
    // photon shot noise and read noise (electrons per unit luminance: uElectrons)
    float n = L * uElectrons;
    L += sqrt(n + uRead * uRead) / uElectrons * gaussian(key);
    signal = L;
  }
  gl_FragColor = vec4(signal, 0.0, 0.0, 1.0);
}
`;

const DISPLAY_FRAGMENT = /* glsl */ `
precision highp float;
${NOISE}
uniform sampler2D tSignal;
uniform sampler2D tLut;
uniform float uLutSize;
uniform vec2 uTexSize;
uniform vec2 uPixels;
uniform vec2 uOutPixels;
uniform int uBand;
uniform int uState;
uniform float uPolarity;
uniform float uLo;
uniform float uHi;
uniform float uDispLo;
uniform float uDispHi;
uniform float uExposure;
uniform float uBlack;
uniform float uGamma;
uniform float uVideo;
uniform float uFrame;
uniform float uBlur;
uniform float uSharp;
varying vec2 vUv;

/** Texel coordinate clamped into the effective rectangle (the rest of the texture is stale). */
vec2 clampTexel(vec2 t) {
  return clamp(t, vec2(0.5), uPixels - 0.5) / uTexSize;
}

/** Cubic B-spline sample from four bilinear taps (t: texel coordinates). */
float bspline(vec2 t) {
  vec2 st = t - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 / 6.0) * (-f3 + 3.0 * f2 - 3.0 * f + 1.0);
  vec2 w1 = (1.0 / 6.0) * (3.0 * f3 - 6.0 * f2 + 4.0);
  vec2 w2 = (1.0 / 6.0) * (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0);
  vec2 w3 = (1.0 / 6.0) * f3;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  // tap positions (texel coordinates) that give each pair its weights by bilinear filtering
  vec2 h0 = i - 0.5 + w1 / g0;
  vec2 h1 = i + 1.5 + w3 / g1;
  return g0.y * (g0.x * texture2D(tSignal, clampTexel(vec2(h0.x, h0.y))).r
               + g1.x * texture2D(tSignal, clampTexel(vec2(h1.x, h0.y))).r)
       + g1.y * (g0.x * texture2D(tSignal, clampTexel(vec2(h0.x, h1.y))).r
               + g1.x * texture2D(tSignal, clampTexel(vec2(h1.x, h1.y))).r);
}

/** The signal at picture coordinate uv (0..1), in effective texels. */
float signalAt(vec2 uv) {
  vec2 t = uv * uPixels;
  if (uSharp > 0.5) return texture2D(tSignal, clampTexel(t)).r;
  return bspline(t);
}

void main() {
  if (uState == 0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float s;
  if (uBlur > 0.01) {
    // the optics refocusing after a field-of-view change
    vec2 r = vec2(uBlur) / uPixels;
    s = 0.2 * (signalAt(vUv) + signalAt(vUv + vec2(r.x, r.y)) + signalAt(vUv + vec2(-r.x, r.y))
             + signalAt(vUv + vec2(r.x, -r.y)) + signalAt(vUv - r));
  } else {
    s = signalAt(vUv);
  }
  float v;
  if (uBand == 1) {
    // the AGC's transfer curve (agc.irDisplay): entries at bin centres, linear between them
    float u = clamp((s - uLo) / max(uHi - uLo, 1e-4), 0.0, 1.0);
    float x = clamp(u * uLutSize - 0.5, 0.0, uLutSize - 1.0);
    float curve = texture2D(tLut, vec2((x + 0.5) / uLutSize, 0.5)).r;
    v = clamp(uDispLo + curve * (uDispHi - uDispLo), 0.0, 1.0);
    if (uPolarity > 0.5) v = 1.0 - v;
  } else {
    float x = s * uExposure;
    v = pow(clamp((x - uBlack) / max(1.0 - uBlack, 1e-4), 0.0, 1.0), uGamma);
  }
  v = clamp(v + uVideo * gaussian(uvec3(uvec2(vUv * uOutPixels), uint(uFrame) + 7919u)), 0.0, 1.0);
  // the display shows v: store the linear value whose sRGB encoding is v
  float lin = v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4);
  gl_FragColor = vec4(vec3(lin), 1.0);
}
`;

const STATS_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tSignal;
uniform vec2 uRect;
uniform int uBand;
varying vec2 vUv;
void main() {
  float s = texture2D(tSignal, vUv * uRect).r;
  float v = uBand == 1
    ? (s + ${STATS_IR_OFFSET.toFixed(1)}) / ${STATS_IR_RANGE.toFixed(1)}
    : (log2(max(s, 1e-7)) - (${STATS_TV_LOG_MIN.toFixed(1)})) / ${STATS_TV_LOG_RANGE.toFixed(1)};
  float q = floor(clamp(v, 0.0, 1.0) * 65535.0 + 0.5);
  float hi = floor(q / 256.0);
  float lo = q - hi * 256.0;
  gl_FragColor = vec4(hi / 255.0, lo / 255.0, 0.0, 1.0);
}
`;

export interface SignalUniforms {
  [name: string]: { value: unknown };
  tScene: { value: Texture | null };
  tDepth: { value: Texture | null };
  uRect: { value: Vector2 };
  uSceneTexel: { value: Vector2 };
  uPsf: { value: number };
  uPixels: { value: Vector2 };
  uBand: { value: number };
  uState: { value: number };
  uNear: { value: number };
  uFar: { value: number };
  uTanHalf: { value: number };
  uCamRot: { value: Matrix3 };
  uAmbient: { value: number };
  uKPerUnit: { value: number };
  uHazeRho: { value: number };
  uHazeShare: { value: number };
  uSkyHorizon: { value: number };
  uSkyZenith: { value: number };
  uSkyBase: { value: number };
  uMaskK: { value: number };
  uMaskLum: { value: number };
  uNetd: { value: number };
  uFpn: { value: number };
  uFpnRows: { value: number };
  uFpnSeed: { value: number };
  uElectrons: { value: number };
  uRead: { value: number };
  uFrame: { value: number };
}

export interface DisplayUniforms {
  [name: string]: { value: unknown };
  tSignal: { value: Texture | null };
  tLut: { value: Texture | null };
  uLutSize: { value: number };
  uTexSize: { value: Vector2 };
  uPixels: { value: Vector2 };
  uOutPixels: { value: Vector2 };
  uBand: { value: number };
  uState: { value: number };
  uPolarity: { value: number };
  uLo: { value: number };
  uHi: { value: number };
  uDispLo: { value: number };
  uDispHi: { value: number };
  uExposure: { value: number };
  uBlack: { value: number };
  uGamma: { value: number };
  uVideo: { value: number };
  uFrame: { value: number };
  uBlur: { value: number };
  uSharp: { value: number };
}

export interface StatsUniforms {
  [name: string]: { value: unknown };
  tSignal: { value: Texture | null };
  uRect: { value: Vector2 };
  uBand: { value: number };
}

function material<U extends Record<string, { value: unknown }>>(
  name: string,
  uniforms: U,
  fragmentShader: string,
): ShaderMaterial & { uniforms: U } {
  const m = new ShaderMaterial({
    name,
    uniforms,
    vertexShader: VERTEX,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  return m as ShaderMaterial & { uniforms: U };
}

/** The signal pass's material for `ss` × `ss` scene samples per detector pixel. */
export function createSignalMaterial(ss: number): ShaderMaterial & { uniforms: SignalUniforms } {
  return material<SignalUniforms>(
    `a10-sensor-signal-${ss}`,
    {
      tScene: { value: null },
      tDepth: { value: null },
      uRect: { value: new Vector2(1, 1) },
      uSceneTexel: { value: new Vector2(1 / 512, 1 / 512) },
      uPsf: { value: 0.5 },
      uPixels: { value: new Vector2(256, 256) },
      uBand: { value: 1 },
      uState: { value: 0 },
      uNear: { value: 20 },
      uFar: { value: 90000 },
      uTanHalf: { value: 0.035 },
      uCamRot: { value: new Matrix3() },
      uAmbient: { value: 0.3 },
      uKPerUnit: { value: 75 },
      uHazeRho: { value: 0 },
      uHazeShare: { value: 0.7 },
      uSkyHorizon: { value: -13.5 },
      uSkyZenith: { value: -40 },
      uSkyBase: { value: 0.7 },
      uMaskK: { value: 0 },
      uMaskLum: { value: 0.01 },
      uNetd: { value: 0.05 },
      uFpn: { value: 0.03 },
      uFpnRows: { value: 0 },
      uFpnSeed: { value: 1 },
      uElectrons: { value: 1e5 },
      uRead: { value: 20 },
      uFrame: { value: 0 },
    },
    signalFragment(ss),
  );
}

export function createDisplayMaterial(): ShaderMaterial & { uniforms: DisplayUniforms } {
  return material<DisplayUniforms>(
    'a10-sensor-display',
    {
      tSignal: { value: null },
      tLut: { value: null },
      uLutSize: { value: 64 },
      uTexSize: { value: new Vector2(256, 256) },
      uPixels: { value: new Vector2(256, 256) },
      uOutPixels: { value: new Vector2(256, 256) },
      uBand: { value: 1 },
      uState: { value: 0 },
      uPolarity: { value: 0 },
      uLo: { value: -5 },
      uHi: { value: 15 },
      uDispLo: { value: 0.05 },
      uDispHi: { value: 0.95 },
      uExposure: { value: 1 },
      uBlack: { value: 0 },
      uGamma: { value: 0.45 },
      uVideo: { value: 0.004 },
      uFrame: { value: 0 },
      uBlur: { value: 0 },
      uSharp: { value: 1 },
    },
    DISPLAY_FRAGMENT,
  );
}

export function createStatsMaterial(): ShaderMaterial & { uniforms: StatsUniforms } {
  return material<StatsUniforms>(
    'a10-sensor-stats',
    {
      tSignal: { value: null },
      uRect: { value: new Vector2(1, 1) },
      uBand: { value: 1 },
    },
    STATS_FRAGMENT,
  );
}
