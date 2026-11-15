/**
 * Fragment shader of the heat-distortion effect (a `postprocessing` Effect that only
 * transforms the UV the scene is sampled with).
 *
 * Each of the four exhaust plumes arrives as a screen-space line segment with a radius at
 * either end. A pixel inside that tapered capsule is displaced by smooth noise that scrolls
 * along the plume; the displacement fades toward the capsule's edge and toward its far end,
 * and is capped in screen units, so the image shimmers but never tears.
 *
 * Occlusion: the scene depth at the pixel is compared with the depth of the plume there.
 * Geometry in front of the plume's near surface is left alone, and a displaced sample that would
 * land on such geometry is cancelled, so foreground objects neither wobble nor smear into
 * the shimmer.
 *
 * `readDepth`, `getViewZ` and `aspect` are provided by the EffectPass shader the effect is
 * compiled into (the effect declares the DEPTH attribute).
 */
export const HEAT_PLUME_COUNT = 4;

export const heatFragmentShader = /* glsl */ `
uniform vec4 heatSegments[${HEAT_PLUME_COUNT}]; // xy = nozzle end, zw = far end (uv)
uniform vec4 heatRadii[${HEAT_PLUME_COUNT}];    // x, y = radius at either end (fraction of screen height); z, w = 1 / view distance at either end
uniform vec4 heatShape[${HEAT_PLUME_COUNT}];    // x = strength 0..1; y, z = plume radius at either end (m); w = noise seed
uniform float heatTime;
uniform float heatActive;
uniform float heatMaxOffset;
uniform float heatSpread; // plume radius gained per metre of length

float heatHash(const in vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float heatNoise(const in vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = heatHash(cell);
  float b = heatHash(cell + vec2(1.0, 0.0));
  float c = heatHash(cell + vec2(0.0, 1.0));
  float d = heatHash(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float heatRipple(const in vec2 p) {
  return (heatNoise(p) + 0.5 * heatNoise(p * 2.1 + 7.3)) / 0.75 - 1.0;
}

// 0 for geometry in front of the plume's near surface, 1 for geometry behind its axis region
float heatUnoccluded(const in float sceneDistance, const in float plumeDistance, const in float plumeRadius) {
  return smoothstep(plumeDistance - plumeRadius, plumeDistance - 0.35 * plumeRadius, sceneDistance);
}

void mainUv(inout vec2 uv) {
  if (heatActive > 0.5) {
    float sceneDistance = -getViewZ(readDepth(uv));
    vec2 offset = vec2(0.0);
    float strongest = 0.0;
    float strongestDistance = 0.0;
    float strongestRadius = 0.0;

    for (int i = 0; i < ${HEAT_PLUME_COUNT}; i++) {
      float strength = heatShape[i].x;
      if (strength > 0.0) {
        // work in units of screen height so distances are isotropic
        vec2 a = heatSegments[i].xy;
        vec2 ab = (heatSegments[i].zw - a) * vec2(aspect, 1.0);
        vec2 ap = (uv - a) * vec2(aspect, 1.0);
        float lengthSq = max(dot(ab, ab), 1e-8);
        float t = clamp(dot(ap, ab) / lengthSq, 0.0, 1.0);
        vec2 across = ap - ab * t;
        float radius = max(mix(heatRadii[i].x, heatRadii[i].y, t), 1e-5);
        float d = length(across) / radius;
        if (d < 1.0) {
          float plumeDistance = 1.0 / mix(heatRadii[i].z, heatRadii[i].w, t);
          float plumeRadius = mix(heatShape[i].y, heatShape[i].z, t);
          float weight = (1.0 - smoothstep(0.2, 1.0, d))
            * smoothstep(0.0, 0.07, t)
            * (1.0 - smoothstep(0.45, 1.0, t))
            * heatUnoccluded(sceneDistance, plumeDistance, plumeRadius);
          if (weight > 0.0) {
            vec2 axis = ab * inversesqrt(lengthSq);
            float side = (across.x * axis.y - across.y * axis.x) / radius;
            // noise cells of about 12 m, scrolling away from the nozzle
            float plumeLength = (heatShape[i].z - heatShape[i].y) / heatSpread;
            vec2 p = vec2(side * plumeRadius / 12.0, t * plumeLength / 12.0 - heatTime * 3.5)
              + heatShape[i].w;
            vec2 ripple = vec2(heatRipple(p), heatRipple(p + 31.7));
            float amplitude = strength * min(radius * 0.16, heatMaxOffset);
            offset += ripple * amplitude * weight;
            if (weight > strongest) {
              strongest = weight;
              strongestDistance = plumeDistance;
              strongestRadius = plumeRadius;
            }
          }
        }
      }
    }

    if (strongest > 0.0) {
      offset.x /= aspect;
      float sampleDistance = -getViewZ(readDepth(uv + offset));
      uv += offset * heatUnoccluded(sampleDistance, strongestDistance, strongestRadius);
    }
  }
}
`;
