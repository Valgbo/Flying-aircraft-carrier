/**
 * The vehicle material: three.js MeshStandardMaterial (lit by the environment's lights and fog,
 * like the aircraft) extended in its shaders so that ONE instanced draw per kind and level of
 * detail animates and shades every vehicle from per-instance attributes:
 *
 *   iAnim  (turret yaw, gun elevation, distance driven, flags)
 *   iState (charring, scorch, fire, paint seed)
 *   iHeat  (engine deck, exhaust, running gear, hull: kelvin above ambient, fire included)
 *   iSpot  (vehicle-local position of the latest heavy hit, radius) — a scorched patch
 *   iWear  (rust, dust, fade, unused)
 *
 * Flags: 1/2 left/right track thrown, 4 turret gone (thrown), 8 draw only the turret (the thrown
 * turret's own instance), 16 canvas burnt away, 32 gun bent.
 *
 * Thermal: `uThermal` (shared with the particles, see thermal.ts) switches the output to a heat
 * grey level from the part's heat zones (aZone · iHeat).
 */
import { MeshDepthMaterial, MeshStandardMaterial, RGBADepthPacking } from 'three';
import { thermalUniforms } from './thermal';

export const FLAG = {
  trackLeft: 1,
  trackRight: 2,
  turretGone: 4,
  turretOnly: 8,
  tarpGone: 16,
  gunBent: 32,
} as const;

/** Shared animated uniforms (simulated time for the fire flicker). */
export const vehicleUniforms = {
  uVehicleTime: { value: 0 },
};

const VERTEX_PARS = /* glsl */ `
  attribute vec4 aZone;
  attribute vec4 aAux;
  attribute vec4 iAnim;
  attribute vec4 iState;
  attribute vec4 iHeat;
  attribute vec4 iSpot;
  attribute vec4 iWear;

  const float BEND_AT = 2.0;

  bool vxIsPart(float p, float id) { return abs(p - id) < 0.5; }

  // Animate one vertex of the vehicle model in its local frame (+X right, +Y up, -Z forward).
  void vehicleAnimate(inout vec3 p, inout vec3 n) {
    float part = aAux.w;
    int flags = int(iAnim.w + 0.5);
    bool turretGroup = vxIsPart(part, 1.0) || vxIsPart(part, 2.0) || vxIsPart(part, 9.0);
    bool thrownLeft = (flags & 1) != 0;
    bool thrownRight = (flags & 2) != 0;
    bool offSide = (p.x < 0.0 && thrownLeft) || (p.x > 0.0 && thrownRight);
    bool hide = false;
    if (vxIsPart(part, 4.0) && offSide) hide = true;
    if (vxIsPart(part, 5.0) && !offSide) hide = true;
    if (turretGroup && (flags & 4) != 0) hide = true;
    if (!turretGroup && (flags & 8) != 0) hide = true;
    if (vxIsPart(part, 6.0) && (flags & 16) != 0) hide = true;
    if (hide) {
      p = vec3(0.0);
      return;
    }
    if (vxIsPart(part, 3.0)) {
      // wheels roll about their axles: angle = -distance / radius
      float a = -iAnim.z / max(aAux.z, 0.05);
      float c = cos(a);
      float s = sin(a);
      vec2 q = p.yz - aAux.xy;
      p.yz = aAux.xy + vec2(q.x * c - q.y * s, q.x * s + q.y * c);
      n.yz = vec2(n.y * c - n.z * s, n.y * s + n.z * c);
    }
    if (vxIsPart(part, 2.0)) {
      vec2 piv = aAux.yz;
      if ((flags & 32) != 0) {
        // bent by the blast: the outer barrel droops and kinks sideways
        float d = piv.y - p.z;
        if (d > BEND_AT) {
          vec2 kink = vec2(piv.x, piv.y - BEND_AT);
          float a = -0.3;
          float c = cos(a);
          float s = sin(a);
          vec2 q = p.yz - kink;
          p.yz = kink + vec2(q.x * c - q.y * s, q.x * s + q.y * c);
          n.yz = vec2(n.y * c - n.z * s, n.y * s + n.z * c);
          p.x += (d - BEND_AT) * 0.07;
        }
      }
      // elevation about the trunnion, + up
      float e = iAnim.y;
      float c = cos(e);
      float s = sin(e);
      vec2 q = p.yz - piv;
      p.yz = piv + vec2(q.x * c - q.y * s, q.x * s + q.y * c);
      n.yz = vec2(n.y * c - n.z * s, n.y * s + n.z * c);
    }
    if (turretGroup) {
      // turret yaw, + clockwise from the bow seen from above, about the ring centre (0, *, aAux.x)
      float a = -iAnim.x;
      float c = cos(a);
      float s = sin(a);
      vec2 q = vec2(p.x, p.z - aAux.x);
      p.x = q.x * c + q.y * s;
      p.z = aAux.x - q.x * s + q.y * c;
      n.xz = vec2(n.x * c + n.z * s, -n.x * s + n.z * c);
    }
  }
`;

const VARYINGS = /* glsl */ `
  varying vec3 vLocal;
  varying vec4 vA;
  varying vec4 vS;
  varying vec4 vSpot;
  varying vec4 vW;
`;

const FRAGMENT_PARS = /* glsl */ `
  uniform float uThermal;
  uniform float uThermalLevel;
  uniform float uThermalGain;
  uniform float uVehicleTime;
  float vh13(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(vh13(i), vh13(i + vec3(1, 0, 0)), f.x), mix(vh13(i + vec3(0, 1, 0)), vh13(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(vh13(i + vec3(0, 0, 1)), vh13(i + vec3(1, 0, 1)), f.x), mix(vh13(i + vec3(0, 1, 1)), vh13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  bool fxIsPart(float p, float id) { return abs(p - id) < 0.5; }
`;

/** Weathering, track links, bullseye, scorch and charring (replaces the vertex-colour chunk). */
const COLOR_FRAGMENT = /* glsl */ `
  #if defined( USE_COLOR )
    diffuseColor.rgb *= vColor;
  #endif
  float vPart = vA.x;
  vec3 lp = vLocal;
  float seed = vS.w;
  float n1 = vnoise3(lp * 1.6 + seed * 13.0);
  float n2 = vnoise3(lp * 5.5 + seed * 7.0);
  float n3 = vnoise3(lp * 17.0 + 3.0);
  bool painted = vPart < 3.5 || fxIsPart(vPart, 6.0);
  if (painted) {
    diffuseColor.rgb *= (0.86 + 0.24 * n1) * (0.93 + 0.14 * seed);
    // dust and mud splashed on the lower hull and running gear
    float dust = vW.y * smoothstep(1.3, 0.1, lp.y) * (0.3 + 0.7 * n2 * n2);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.13, 0.105, 0.075), clamp(dust, 0.0, 0.55));
    // rust (hulks) and sun-faded paint
    // rust spreads from edges and low areas; only patches of faded paint remain on a hulk
    float rust = vW.x * smoothstep(0.25, 0.55, n1 * 0.8 + n2 * 0.25 + 0.2 * smoothstep(1.8, 0.4, lp.y));
    vec3 rustCol = mix(vec3(0.085, 0.042, 0.02), vec3(0.045, 0.026, 0.015), n3);
    diffuseColor.rgb = mix(diffuseColor.rgb, rustCol, clamp(rust, 0.0, 0.95));
    float lum = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum) * vec3(1.08, 1.04, 0.98), vW.z * 0.5);
  } else {
    diffuseColor.rgb *= 0.9 + 0.2 * n2;
    float dust = vW.y * smoothstep(0.8, 0.0, lp.y) * n2 * n2;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.085, 0.065), clamp(dust, 0.0, 0.35));
  }
  if (fxIsPart(vPart, 4.0)) {
    // track links (≈0.14 m pitch) moving with the belt
    float link = fract(vA.y * 7.2);
    float groove = smoothstep(0.0, 0.14, link) * smoothstep(1.0, 0.8, link);
    diffuseColor.rgb *= 0.45 + 0.65 * groove;
  }
  if (fxIsPart(vPart, 7.0)) {
    // strafe panel: white with a black bullseye and rings
    float r = length(vA.zw);
    float ink = 0.0;
    if (r < 0.15) ink = 1.0;
    if (r > 0.4 && r < 0.48) ink = 1.0;
    if (r > 0.72 && r < 0.79) ink = 1.0;
    if (r < 1.42 && max(abs(vA.z), abs(vA.w)) > 0.95) ink = 1.0;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012), ink * (0.92 + 0.08 * n3));
  }
  // the latest heavy hit leaves a scorched, chipped patch
  if (vSpot.w > 0.0) {
    float d = distance(lp, vSpot.xyz) + (n2 - 0.5) * 0.35 * vSpot.w;
    float sc = 1.0 - smoothstep(vSpot.w * 0.25, vSpot.w, d);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02, 0.018, 0.016), sc * 0.9);
  }
  // general scorching of a damaged vehicle
  float soot = vS.y * smoothstep(0.5, 0.75, n1 + 0.25 * n2);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.022, 0.02), soot * 0.85);
  // charred: burnt paint, black soot with patches of grey ash and heat-rusted steel
  float charAmt = vS.x * (0.85 + 0.15 * n2);
  vec3 charCol = vec3(0.018, 0.016, 0.014) * (0.8 + 0.5 * n1);
  charCol = mix(charCol, vec3(0.05, 0.034, 0.024), smoothstep(0.7, 0.95, n2) * 0.6);
  diffuseColor.rgb = mix(diffuseColor.rgb, charCol, clamp(charAmt, 0.0, 1.0));
`;

const ROUGHNESS_FRAGMENT = /* glsl */ `
  float roughnessFactor = roughness;
  if (fxIsPart(vA.x, 10.0)) roughnessFactor = 0.12;
  else if (fxIsPart(vA.x, 4.0)) roughnessFactor = 0.6;
  roughnessFactor = mix(roughnessFactor, 1.0, vS.x * 0.8);
`;

const EMISSIVE_FRAGMENT = /* glsl */ `
  #include <emissivemap_fragment>
  if (vS.z > 0.01) {
    // embers glowing through the charred hull, flickering with the fire
    float t = uVehicleTime;
    float flick = 0.55 + 0.45 * sin(t * 11.0 + lp.x * 2.3 + lp.z * 1.7) * sin(t * 6.7 + seed * 40.0 + lp.y * 3.0);
    // only small spots glow, mostly round the engine deck and the hatches
    float hot = smoothstep(0.86, 0.97, n3 * 0.6 + n2 * 0.5) * (0.25 + 0.75 * vW.w) * smoothstep(0.4, 1.4, lp.y);
    totalEmissiveRadiance += vec3(1.0, 0.28, 0.04) * vS.z * hot * flick * 0.9;
  }
`;

const THERMAL_FRAGMENT = /* glsl */ `
  #include <dithering_fragment>
  if (uThermal > 0.5) {
    float heatK = fxIsPart(vA.x, 7.0) ? 0.0 : vA.z;
    float g = clamp(uThermalLevel + heatK * uThermalGain, 0.0, 1.0);
    if (fxIsPart(vA.x, 10.0)) g = clamp(uThermalLevel * 0.75, 0.0, 1.0);
    gl_FragColor = vec4(vec3(uThermal > 1.5 ? 1.0 - g : g), 1.0);
  }
`;

export function createVehicleMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.1 });
  m.name = 'a10-vehicle';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uThermal = thermalUniforms.uThermal;
    shader.uniforms.uThermalLevel = thermalUniforms.uThermalLevel;
    shader.uniforms.uThermalGain = thermalUniforms.uThermalGain;
    shader.uniforms.uVehicleTime = vehicleUniforms.uVehicleTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}\n${VARYINGS}`)
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 objectNormal = vec3( normal );
         vec3 vxPos = vec3( position );
         vehicleAnimate(vxPos, objectNormal);
         #ifdef USE_TANGENT
           vec3 objectTangent = vec3( tangent.xyz );
         #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vxPos;
         vLocal = vxPos;
         bool isTrack = abs(aAux.w - 4.0) < 0.5;
         bool isPanel = abs(aAux.w - 7.0) < 0.5;
         float heatK = dot(aZone, iHeat);
         // vA: part, track phase, then panel (u, v) or (heat K, 0)
         vA = vec4(aAux.w, isTrack ? aAux.x - iAnim.z : 0.0, isPanel ? aAux.x : heatK, isPanel ? aAux.y : 0.0);
         vS = iState;
         vSpot = iSpot;
         vW = vec4(iWear.xyz, aZone.x + aZone.y);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${VARYINGS}\n${FRAGMENT_PARS}`)
      .replace('#include <color_fragment>', COLOR_FRAGMENT)
      .replace('#include <roughnessmap_fragment>', ROUGHNESS_FRAGMENT)
      .replace('#include <emissivemap_fragment>', EMISSIVE_FRAGMENT)
      .replace('#include <dithering_fragment>', THERMAL_FRAGMENT);
  };
  m.customProgramCacheKey = () => 'a10-vehicle-1';
  return m;
}

/** Shadow-map depth material that animates the vehicle the same way (turrets, wheels, hiding). */
export function createVehicleDepthMaterial(): MeshDepthMaterial {
  const m = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  m.name = 'a10-vehicle-depth';
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3( position );
         vec3 vxDummyN = vec3(0.0, 1.0, 0.0);
         vehicleAnimate(transformed, vxDummyN);`,
      );
  };
  m.customProgramCacheKey = () => 'a10-vehicle-depth-1';
  return m;
}
