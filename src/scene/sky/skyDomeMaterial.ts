/**
 * Sky dome shader: the whole sky in one draw call on a camera-centred inverted sphere.
 *
 *   - zenith → horizon gradient with a haze band that ends EXACTLY in the horizon colour at
 *     eye level and stays that colour below it (the ocean fades to the same colour, so there
 *     is no seam);
 *   - a warm band along the horizon around the azimuth of the low sun;
 *   - the sun disc (HDR, so it blooms) with a three-lobe halo; the moon with maria and a glow;
 *   - procedural stars that come out with darkness;
 *   - a white-out toward the fog colour while the camera is inside a cloud.
 *
 * The dome is drawn first with depth test and depth write off, so everything else simply
 * draws over it; it ignores the scene fog (it IS the far end of the fog).
 */
import { BackSide, Color, ShaderMaterial, Vector3 } from 'three';
import { MOON_ANGULAR_RADIUS, SUN_ANGULAR_RADIUS } from './timeOfDay';

const vertexShader = /* glsl */ `
varying vec3 vDirection;

void main() {
  // the dome is never rotated or scaled non-uniformly: its local position is the view direction
  vDirection = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
#include <common>
#include <dithering_pars_fragment>

uniform vec3 uSunDirection;
uniform vec3 uMoonDirection;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uHazeColor;
uniform vec3 uGlowColor;
uniform vec3 uSunDiscColor;
uniform vec3 uSunHaloColor;
uniform vec3 uMoonDiscColor;
uniform float uSunRadius;
uniform float uMoonRadius;
uniform float uStarVisibility;
uniform float uWhiteout;
uniform float uTime;

varying vec3 vDirection;

float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

// Stars: a 3D grid cut by the unit sphere. A few cells hold a star at a jittered point; the
// sphere passes it at a random distance, which gives a natural spread of apparent sizes.
vec3 starField(vec3 dir) {
  vec3 p = dir * 150.0;
  vec3 cell = floor(p);
  float h = hash31(cell);
  if (h < 0.9) return vec3(0.0);
  vec3 jitter = vec3(hash31(cell + 17.0), hash31(cell + 41.0), hash31(cell + 73.0));
  float d = length(p - cell - 0.5 - 0.3 * (jitter - 0.5));
  float magnitude = fract(h * 97.0);
  float twinkle = 0.85 + 0.15 * sin(uTime * (1.5 + 3.0 * jitter.x) + h * 400.0);
  float core = smoothstep(0.24, 0.0, d);
  vec3 tint = mix(vec3(1.0, 0.86, 0.7), vec3(0.74, 0.85, 1.0), jitter.y);
  return tint * (core * core * (0.5 + 2.6 * magnitude * magnitude * magnitude) * twinkle);
}

void main() {
  vec3 dir = normalize(vDirection);
  float up = max(dir.y, 0.0);

  // ---- gradient + haze band (weight 1 at and below the horizon) ----
  float haze = exp(-pow(up * 6.5, 1.35));
  vec3 color = mix(uZenithColor, uHorizonColor, haze);

  // ---- warm band toward the low sun; it starts just above the horizon line so the line
  //      itself keeps the plain horizon colour the sea fades into ----
  vec2 sunAzimuth = normalize(uSunDirection.xz + vec2(1e-5, 0.0));
  float facing = 0.5 + 0.5 * dot(normalize(dir.xz + vec2(1e-5, 0.0)), sunAzimuth);
  float band = smoothstep(0.0, 0.05, up) * exp(-up * 5.5);
  color += uGlowColor * (band * (0.12 + 0.88 * facing * facing * facing));

  // discs and halos sink into the haze at the horizon instead of being cut by it
  float aboveHorizon = smoothstep(-0.004, 0.022, dir.y);

  // ---- stars ----
  if (uStarVisibility > 0.001) {
    color += starField(dir) * (uStarVisibility * smoothstep(0.02, 0.22, dir.y));
  }

  // ---- moon ----
  float moonChord = length(dir - uMoonDirection);
  float moonDisc = 1.0 - smoothstep(uMoonRadius * 0.94, uMoonRadius * 1.04, moonChord);
  if (moonChord < 0.6) {
    vec3 mx = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDirection));
    vec3 my = cross(uMoonDirection, mx);
    vec2 mp = vec2(dot(dir, mx), dot(dir, my)) / uMoonRadius;
    float maria = valueNoise(mp * 1.7 + 3.1) * 0.65 + valueNoise(mp * 4.3 + 9.7) * 0.35;
    float limb = sqrt(max(1.0 - dot(mp, mp), 0.0));
    vec3 moon = uMoonDiscColor * (0.62 + 0.38 * limb) * (1.0 - 0.42 * smoothstep(0.42, 0.72, maria));
    float glow = 0.1 * exp(-moonChord * 38.0) + 0.028 * exp(-moonChord * 7.0);
    color = mix(color, color * 0.35 + moon, moonDisc * aboveHorizon);
    color += uMoonDiscColor * (glow * aboveHorizon * (1.0 - moonDisc));
  }

  // ---- sun ----
  float sunChord = length(dir - uSunDirection);
  float sunDisc = 1.0 - smoothstep(uSunRadius * 0.9, uSunRadius * 1.08, sunChord);
  float halo = 1.5 * exp(-sunChord * 52.0) + 0.42 * exp(-sunChord * 9.0) + 0.12 * exp(-sunChord * 2.4);
  color += (uSunDiscColor * sunDisc + uSunHaloColor * halo) * aboveHorizon;

  // ---- inside a cloud the sky disappears in the murk ----
  color = mix(color, uHazeColor, uWhiteout);

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <dithering_fragment>
}
`;

export interface SkyDomeUniforms {
  uSunDirection: { value: Vector3 };
  uMoonDirection: { value: Vector3 };
  uZenithColor: { value: Color };
  /** Clear-air horizon colour (the lower end of the gradient). */
  uHorizonColor: { value: Color };
  /** Current fog colour — what the dome whites out to inside a cloud. */
  uHazeColor: { value: Color };
  uGlowColor: { value: Color };
  uSunDiscColor: { value: Color };
  uSunHaloColor: { value: Color };
  uMoonDiscColor: { value: Color };
  uSunRadius: { value: number };
  uMoonRadius: { value: number };
  uStarVisibility: { value: number };
  uWhiteout: { value: number };
  uTime: { value: number };
}

export type SkyDomeMaterial = ShaderMaterial & { uniforms: SkyDomeUniforms };

/** Create the sky dome material. The caller owns it and must dispose it. */
export function createSkyDomeMaterial(): SkyDomeMaterial {
  const uniforms: SkyDomeUniforms = {
    uSunDirection: { value: new Vector3(0, 1, 0) },
    uMoonDirection: { value: new Vector3(0, -1, 0) },
    uZenithColor: { value: new Color() },
    uHorizonColor: { value: new Color() },
    uHazeColor: { value: new Color() },
    uGlowColor: { value: new Color() },
    uSunDiscColor: { value: new Color() },
    uSunHaloColor: { value: new Color() },
    uMoonDiscColor: { value: new Color() },
    // the discs are measured as chord lengths on the unit sphere (precise at small angles)
    uSunRadius: { value: 2 * Math.sin(SUN_ANGULAR_RADIUS / 2) },
    uMoonRadius: { value: 2 * Math.sin(MOON_ANGULAR_RADIUS / 2) },
    uStarVisibility: { value: 0 },
    uWhiteout: { value: 0 },
    uTime: { value: 0 },
  };
  const material = new ShaderMaterial({
    name: 'SkyDome',
    uniforms: uniforms as unknown as ShaderMaterial['uniforms'],
    vertexShader,
    fragmentShader,
    side: BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
    dithering: true,
  });
  return material as SkyDomeMaterial;
}
