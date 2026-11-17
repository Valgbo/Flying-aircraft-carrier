/**
 * Cockpit glass seen from the seat: the inner canopy glass and the HUD combiner. OWNED BY THE
 * COCKPIT MODULE.
 *
 * Both are nearly clear. What makes glass visible from inside is (a) a faint tint, (b) Fresnel
 * reflection at grazing angles (of the dim cockpit, not of the sky: the inside surface faces
 * the cockpit), (c) the sun's glint where it reflects toward the eye, and (d) veiling glare —
 * scratches and dust light up when you look toward the sun through the glass. The combiner has
 * the slight green-gold tint of its reflective coating (FlightGear: rgb 0.74, 0.83, 0 at 14 %).
 * The HUD symbology itself is drawn later by the HUD pass through a stencil of this glass, so
 * this material never writes depth.
 *
 * Straight alpha blending, like every three.js transparent material (the colour is tone-mapped
 * and encoded before blending): the glass covers the view behind it by its tint, by the Fresnel
 * reflection of the dark cockpit, and by the sun's glint and glare, each with its own colour.
 */
import { Color, DoubleSide, ShaderMaterial, Vector3 } from 'three';

const VERT = /* glsl */ `
varying vec3 vPos;
varying vec3 vNormal;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPos = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
uniform vec3 uTint;
uniform float uTintAlpha;
uniform vec3 uInterior;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uGlare;
uniform float uGlint;
varying vec3 vPos;
varying vec3 vNormal;
void main() {
  vec3 V = normalize(cameraPosition - vPos);
  vec3 N = normalize(vNormal);
  if (dot(N, V) < 0.0) N = -N;
  float cosT = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.04 + 0.96 * pow(1.0 - cosT, 5.0);
  vec3 R = reflect(-V, N);
  // the sun's reflection toward the eye: a sharp glint and a soft sheen around it
  float rs = max(dot(R, uSunDir), 0.0);
  float glint = (pow(rs, 900.0) * 6.0 + pow(rs, 60.0) * 0.12) * uGlint;
  // veiling glare: looking toward the sun through scratched glass
  float vs = max(dot(-V, uSunDir), 0.0);
  float glare = (pow(vs, 12.0) * 0.05 + pow(vs, 120.0) * 0.12) * uGlare;
  float aF = 0.5 * F;
  float aS = clamp(glint * F + glare, 0.0, 0.85);
  float a = clamp(uTintAlpha + aF + aS, 0.0, 0.95);
  vec3 rgb = (uTint * uTintAlpha + uInterior * aF + uSunColor * aS) / max(a, 1e-4);
  gl_FragColor = vec4(rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface GlassOptions {
  name: string;
  tint: Color;
  tintAlpha: number;
  glare: number;
  glint: number;
}

export function createGlassMaterial(o: GlassOptions): ShaderMaterial {
  const m = new ShaderMaterial({
    name: o.name,
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTint: { value: o.tint.clone() },
      uTintAlpha: { value: o.tintAlpha },
      uInterior: { value: new Color(0.035, 0.037, 0.04) },
      uSunDir: { value: new Vector3(0, 1, 0) },
      uSunColor: { value: new Color(1, 1, 1) },
      uGlare: { value: o.glare },
      uGlint: { value: o.glint },
    },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
  return m;
}

/** The inside of the canopy: barely blue-grey, glints and glare. */
export function createCanopyGlass(): ShaderMaterial {
  return createGlassMaterial({
    name: 'cockpit-canopy-glass',
    tint: new Color(0.55, 0.62, 0.68),
    tintAlpha: 0.035,
    glare: 1,
    glint: 1,
  });
}

/** The HUD combiner: a faint green-gold coating. */
export function createCombinerGlass(): ShaderMaterial {
  return createGlassMaterial({
    name: 'cockpit-hud-combiner',
    tint: new Color(0.6, 0.7, 0.32),
    tintAlpha: 0.075,
    glare: 0.6,
    glint: 0.8,
  });
}

/** Per-frame: the sun in the BODY frame, its colour, and the dim cockpit the glass reflects. */
export function updateGlass(
  m: ShaderMaterial,
  sunBody: Vector3,
  sunColor: Color,
  interior: Color,
): void {
  const u = m.uniforms;
  (u.uSunDir.value as Vector3).copy(sunBody);
  (u.uSunColor.value as Color).copy(sunColor);
  (u.uInterior.value as Color).copy(interior);
}
