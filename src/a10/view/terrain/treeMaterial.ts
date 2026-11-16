/**
 * Trees near the aircraft as ray-cast impostors: ONE instanced draw call of camera-facing
 * quads; each fragment intersects its tree's real shape — a lumpy ellipsoid crown (broadleaf,
 * poplar) or a cone (conifer) on a trunk — lights it like the terrain (sun, sky, bounce,
 * translucency against the light), and writes the hit's true depth, so trees look solid from
 * every angle (straight down from 3,000 m or side-on on a strafing pass), stand in the ground
 * correctly and occlude each other. Two triangles per tree.
 *
 * Instance data (treeCells.ts, TREE_STRIDE = 8 floats): x, y, z, height, crown radius,
 * species, colour variation, rank. A tree is drawn while its rank is below the density at its
 * distance: (uTreeFade.x / d)² capped at 1, fading out toward uTreeFade.y — smooth thinning
 * with distance, no CPU work per frame.
 */
import { Color, ShaderMaterial, Vector2, type IUniform } from 'three';
import { TERRAIN_COMMON_GLSL, terrainUniforms } from './terrainMaterial';

const vertexShader = /* glsl */ `
attribute vec4 iA; // x, y, z, height
attribute vec4 iB; // radius, species, colour variation, rank

uniform vec2 uTreeFade; // full-density distance, max distance

varying vec3 vRayEnd;
varying vec4 vTree;    // base x, y, z, height
varying vec4 vShape;   // radius, species, colour, visibility

void main() {
  float h = iA.w;
  float r = iB.x;
  vec3 base = iA.xyz;
  vec3 centre = base + vec3(0.0, h * 0.5, 0.0);
  vec3 toCam = cameraPosition - centre;
  float dist = length(toCam);
  float full = uTreeFade.x / max(dist, 1.0);
  float density = min(1.0, full * full);
  float visible = clamp((density - iB.w) * 12.0 + 0.5, 0.0, 1.0)
    * (1.0 - smoothstep(uTreeFade.y * 0.8, uTreeFade.y, dist));
  if (visible <= 0.01) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // outside the clip volume: nothing drawn
    return;
  }
  vec3 view = toCam / max(dist, 1e-3);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), view) + vec3(1e-4, 0.0, 0.0));
  vec3 up = cross(view, right);
  // cover the projected bounding ellipsoid (radius r across, h/2 vertically), with room for
  // perspective when close
  float halfH = h * 0.5;
  float ext = sqrt(halfH * halfH * (1.0 - view.y * view.y) + r * r * view.y * view.y);
  float margin = 1.12 + 2.0 * max(h / max(dist, 1.0) - 0.05, 0.0);
  vec3 corner = centre + (right * position.x * r + up * position.y * max(ext, r)) * margin;
  vRayEnd = corner;
  vTree = vec4(base, h);
  vShape = vec4(r, iB.y, iB.z, visible);
  gl_Position = projectionMatrix * viewMatrix * vec4(corner, 1.0);
}
`;

const fragmentShader = /* glsl */ `
#include <common>
${TERRAIN_COMMON_GLSL}
uniform mat4 projectionMatrix;
uniform vec3 uLeaf[3];
uniform float uTime;

varying vec3 vRayEnd;
varying vec4 vTree;
varying vec4 vShape;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vRayEnd - cameraPosition);
  vec3 base = vTree.xyz;
  float h = vTree.w;
  float r = vShape.x;
  float species = floor(vShape.y + 0.5);
  float tHit = 1e20;
  vec3 nHit = vec3(0.0, 1.0, 0.0);
  float part = 0.0; // 0 crown, 1 trunk
  float crownBottom;

  if (species == 1.0) {
    // ---- conifer: cone from the crown bottom (radius r) to the tip ----
    crownBottom = base.y + h * 0.14;
    vec3 tip = base + vec3(0.0, h, 0.0);
    float hc = tip.y - crownBottom;
    float k = r / hc;
    vec3 co = ro - tip;
    // cone along −y from the tip: x² + z² = k² y²,  y ≤ 0
    float k2 = k * k;
    float a = rd.x * rd.x + rd.z * rd.z - k2 * rd.y * rd.y;
    float b = 2.0 * (co.x * rd.x + co.z * rd.z - k2 * co.y * rd.y);
    float c = co.x * co.x + co.z * co.z - k2 * co.y * co.y;
    float disc = b * b - 4.0 * a * c;
    if (disc >= 0.0 && abs(a) > 1e-6) {
      float sq = sqrt(disc);
      float t0 = (-b - sq) / (2.0 * a);
      float t1 = (-b + sq) / (2.0 * a);
      if (t0 > t1) { float tt = t0; t0 = t1; t1 = tt; }
      for (int q = 0; q < 2; q++) {
        float t = q == 0 ? t0 : t1;
        if (t <= 0.0) continue;
        vec3 p = co + rd * t;
        if (p.y <= 0.0 && p.y >= -hc) {
          // ragged branch tiers
          float tier = fract(-p.y / (hc * 0.16));
          float ragged = noise3((ro + rd * t) * 1.3) * 0.5 + tier * 0.5;
          if (length(p.xz) > k * -p.y * (0.72 + 0.28 * ragged) && q == 0) continue;
          tHit = t;
          vec3 radial = normalize(vec3(p.x, 0.0, p.z) + vec3(1e-5));
          nHit = normalize(radial + vec3(0.0, k, 0.0));
          break;
        }
      }
    }
  } else {
    // ---- broadleaf / poplar: lumpy ellipsoid crown ----
    float crownH = species == 2.0 ? h * 0.42 : h * 0.36;
    crownBottom = base.y + h - 2.0 * crownH;
    vec3 c = base + vec3(0.0, h - crownH, 0.0);
    vec3 scale = vec3(r, crownH, r);
    vec3 o = (ro - c) / scale;
    vec3 d = rd / scale;
    float a = dot(d, d);
    float b = dot(o, d);
    float cc = dot(o, o) - 1.0;
    float disc = b * b - a * cc;
    if (disc >= 0.0) {
      float sq = sqrt(disc);
      float t = (-b - sq) / a;
      float tFar = (-b + sq) / a;
      if (t < 0.0) t = tFar;
      if (t > 0.0) {
        vec3 p = ro + rd * t;
        // leafy silhouette: grazing rays through thin, noisy edges miss
        float edge = sq / sqrt(a);
        float clump = noise3(p * (1.6 / max(r * 0.25, 1.0)) + vShape.z * 17.0);
        if (edge < 0.18 * clump + 0.02) {
          t = 1e20;
        } else {
          tHit = t;
          vec3 local = (p - c) / scale;
          nHit = normalize(local / scale);
          // clumps of foliage bump the normal
          vec3 bump = vec3(noise3(p * 0.9), noise3(p * 0.9 + 11.0), noise3(p * 0.9 + 23.0)) - 0.5;
          nHit = normalize(nHit + bump * 0.9);
        }
      }
    }
  }

  // ---- trunk: a vertical cylinder from the ground into the crown ----
  float tr = max(0.12, h * 0.022);
  vec2 oc = ro.xz - base.xz;
  float ta = dot(rd.xz, rd.xz);
  float tb = dot(oc, rd.xz);
  float tc = dot(oc, oc) - tr * tr;
  float tdisc = tb * tb - ta * tc;
  if (tdisc >= 0.0 && ta > 1e-8) {
    float t = (-tb - sqrt(tdisc)) / ta;
    float y = ro.y + rd.y * t;
    if (t > 0.0 && t < tHit && y >= base.y - 0.5 && y <= crownBottom + h * 0.1) {
      tHit = t;
      vec2 sideN = normalize(oc + rd.xz * t);
      nHit = vec3(sideN.x, 0.0, sideN.y);
      part = 1.0;
    }
  }
  if (tHit > 1e19) discard;

  vec3 p = ro + rd * tHit;
  float dist = tHit;
  // depth of the real hit
  vec4 clip = projectionMatrix * viewMatrix * vec4(p, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);

  float haze = hazeFactor(dist);
  if (uThermal > 0.5) {
    float sun = max(dot(nHit, uSunDir), 0.0);
    float t = (part > 0.5 ? 0.36 : 0.3) + (uThermalParams.x * 0.2 * sun - 0.04) * 0.35 + (uThermalParams.y - 0.4) * 0.3;
    gl_FragColor = vec4(thermalOut(t, haze), 1.0);
    return;
  }

  vec3 albedo;
  if (part > 0.5) {
    albedo = vec3(0.05, 0.04, 0.03);
  } else {
    albedo = uLeaf[int(species)] * (0.78 + 0.44 * vShape.z);
    // the inside and underside of a crown is darker (self-shadowing)
    float inner = clamp((p.y - crownBottom) / max(base.y + h - crownBottom, 1.0), 0.0, 1.0);
    albedo *= 0.55 + 0.45 * inner;
    albedo *= 0.85 + 0.3 * noise3(p * 2.3);
  }
  vec3 color = lightLambert(albedo, nHit, 1.0);
  // light through the leaves when the sun is behind the crown
  if (part < 0.5) {
    float back = max(dot(rd, uSunDir), 0.0);
    color += albedo * uSunColor * pow(back, 6.0) * 0.18;
  }
  color = mix(color, uHazeColor, haze);
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Foliage colours (linear): broadleaf, conifer, poplar. */
export const LEAF_COLORS = [
  new Color(0.055, 0.085, 0.032),
  new Color(0.032, 0.05, 0.03),
  new Color(0.07, 0.1, 0.038),
];

export const treeUniforms = {
  /** Distance of full density, distance where trees end, m. */
  uTreeFade: { value: new Vector2(900, 3000) },
  uLeaf: { value: LEAF_COLORS },
};

export function createTreeMaterial(): ShaderMaterial {
  const uniforms: Record<string, IUniform> = {
    ...(terrainUniforms as unknown as Record<string, IUniform>),
    ...(treeUniforms as unknown as Record<string, IUniform>),
  };
  return new ShaderMaterial({
    name: 'TreeImpostors',
    uniforms,
    vertexShader,
    fragmentShader,
    fog: false,
  });
}
