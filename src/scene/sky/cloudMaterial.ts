/**
 * Cloud sprite shader: every puff of the layer is one instanced, camera-facing quad.
 *
 * Vertex stage — wraps the instance to the copy of the tile nearest the camera (the layer is
 * endless), builds a billboard that faces the camera POSITION (so turning the camera does not
 * make the puffs swim) and works camera-relative, which keeps full precision tens of
 * kilometres from the origin.
 *
 * Fragment stage — carves an irregular outline out of a soft disc with tiling noise, cuts a
 * flat base, and shades each pixel by where it sits in its CLOUD (so the cluster reads as one
 * volume, not as a bunch of balls) plus a little per-puff relief: bright toward the dominant
 * light, darker and bluer underneath, a silver lining along the cloud's silhouette when the
 * light is behind it, and aerial perspective into the horizon haze. Opacity fades out near the camera (no hard
 * clipping when flying through; the fog white-out takes over) and toward the edge of the tile.
 */
import { Color, NormalBlending, ShaderMaterial, Vector2, Vector3, type Texture } from 'three';

/** Sprites are invisible closer than NEAR_FADE_START and fully opaque beyond NEAR_FADE_END, m. */
export const NEAR_FADE_START = 110;
export const NEAR_FADE_END = 520;

const vertexShader = /* glsl */ `
attribute vec3 aCenter;
attribute vec4 aShape;
attribute vec3 aLocal;
attribute vec3 aCloud;

uniform vec2 uShift;
uniform float uTile;
uniform vec2 uEdgeFade;
uniform vec2 uNearFade;
uniform vec3 uLightDirection;
uniform float uFogDensity;

varying vec2 vCorner;
varying vec2 vNoiseUv;
varying vec3 vLight;
varying vec3 vCloudPosition;
varying float vHeight;
varying float vBehindLight;
varying float vFog;
varying float vFade;

void main() {
  // camera-relative centre of the nearest periodic copy
  vec2 wrapped = mod(aCenter.xz + uShift + 0.5 * uTile, uTile) - 0.5 * uTile;
  vec3 rel = vec3(wrapped.x, aCenter.y - cameraPosition.y, wrapped.y);
  float dist = max(length(rel), 1.0);
  vec3 toCamera = -rel / dist;

  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCamera) + vec3(1e-4, 0.0, 0.0));
  vec3 up = cross(toCamera, right);
  vec3 offset = (right * position.x + up * position.y) * aShape.x;

  vCorner = position.xy * 2.0;
  float c = cos(aShape.y);
  float s = sin(aShape.y);
  vNoiseUv = mat2(c, s, -s, c) * position.xy * 0.46 + aShape.zw;

  // the light in the billboard's own frame, for the per-pixel "rough sphere" shading
  vLight = vec3(dot(uLightDirection, right), dot(uLightDirection, up), dot(uLightDirection, toCamera));
  // position inside the cloud, each axis normalised to the cloud's half-extent
  vCloudPosition = aLocal + offset * vec3(aCloud.z, 2.0 * aCloud.y, aCloud.z);
  vHeight = (aCenter.y + offset.y - aCloud.x) * aCloud.y;
  vBehindLight = max(-dot(toCamera, uLightDirection), 0.0);

  float fog = uFogDensity * dist;
  vFog = 1.0 - exp(-fog * fog);
  vFade = smoothstep(uNearFade.x, uNearFade.y, dist) *
    (1.0 - smoothstep(uEdgeFade.x, uEdgeFade.y, length(wrapped)));

  vec4 viewPosition = vec4(mat3(viewMatrix) * (rel + offset), 1.0);
  gl_Position = projectionMatrix * viewPosition;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uNoise;
uniform vec3 uLitColor;
uniform vec3 uShadeColor;
uniform vec3 uLightColor;
uniform vec3 uFogColor;
uniform vec3 uLightDirection;

varying vec2 vCorner;
varying vec2 vNoiseUv;
varying vec3 vLight;
varying vec3 vCloudPosition;
varying float vHeight;
varying float vBehindLight;
varying float vFog;
varying float vFade;

void main() {
  if (vFade < 0.003) discard;
  float r = length(vCorner);
  if (r > 1.0) discard;
  vec4 noise = texture2D(uNoise, vNoiseUv);

  // outline: a soft disc eroded by the billowy noise channel (and a little by the fine one)
  float density = (1.0 - r) * 1.25 - noise.r * 0.58 - noise.g * 0.16;
  float alpha = smoothstep(0.02, 0.27, density);
  // flat base
  alpha *= smoothstep(-0.05, 0.14, vHeight) * vFade;
  if (alpha < 0.004) discard;

  // cloud-scale relief: the outward direction from the middle of the cloud, biased upward
  float fromCentre = length(vCloudPosition);
  vec3 cloudNormal = normalize(vCloudPosition + vec3(0.0, 0.3, 0.0));
  // puff-scale relief: a rough sphere in the billboard frame, bumped by the detail channels
  vec2 bump = (noise.gb - 0.5) * 0.9;
  vec3 puffNormal = normalize(vec3(vCorner + bump, sqrt(max(1.0 - r * r, 0.0)) + 0.35));
  float lit = 0.5 + 0.4 * dot(cloudNormal, uLightDirection) + 0.2 * dot(puffNormal, vLight);
  lit = smoothstep(0.1, 0.92, lit);

  // darker, bluer underside
  float underside = 1.0 - smoothstep(0.0, 0.5, vHeight);
  vec3 shade = uShadeColor * mix(vec3(1.0), vec3(0.62, 0.68, 0.8), underside);
  vec3 color = mix(shade, uLitColor, lit * (1.0 - 0.7 * underside));

  // light from behind: the body of the cloud goes dull while its thin silhouette lights up
  // (only the outline of the CLOUD — a lining around every puff would look like bubbles)
  float behind = pow(vBehindLight, 4.0);
  float silhouette = smoothstep(0.7, 1.15, fromCentre) * (1.0 - smoothstep(0.1, 0.75, density));
  color *= 1.0 - 0.22 * behind * (1.0 - silhouette);
  color += uLightColor * (0.5 * behind * silhouette);

  color = mix(color, uFogColor, vFog);

  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface CloudUniforms {
  uNoise: { value: Texture };
  /** (wind drift − camera position) in X / Z, wrapped into one tile. */
  uShift: { value: Vector2 };
  uTile: { value: number };
  uEdgeFade: { value: Vector2 };
  uNearFade: { value: Vector2 };
  uLightDirection: { value: Vector3 };
  uLitColor: { value: Color };
  uShadeColor: { value: Color };
  uLightColor: { value: Color };
  uFogColor: { value: Color };
  uFogDensity: { value: number };
}

export type CloudMaterial = ShaderMaterial & { uniforms: CloudUniforms };

/** Create the cloud material around a noise texture. The caller owns both and must dispose them. */
export function createCloudMaterial(noise: Texture): CloudMaterial {
  const uniforms: CloudUniforms = {
    uNoise: { value: noise },
    uShift: { value: new Vector2() },
    uTile: { value: 1 },
    uEdgeFade: { value: new Vector2(1, 2) },
    uNearFade: { value: new Vector2(NEAR_FADE_START, NEAR_FADE_END) },
    uLightDirection: { value: new Vector3(0, 1, 0) },
    uLitColor: { value: new Color(1, 1, 1) },
    uShadeColor: { value: new Color(0.5, 0.5, 0.5) },
    uLightColor: { value: new Color(1, 1, 1) },
    uFogColor: { value: new Color(1, 1, 1) },
    uFogDensity: { value: 0 },
  };
  const material = new ShaderMaterial({
    name: 'CloudSprites',
    uniforms: uniforms as unknown as ShaderMaterial['uniforms'],
    vertexShader,
    fragmentShader,
    transparent: true,
    blending: NormalBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  return material as CloudMaterial;
}
