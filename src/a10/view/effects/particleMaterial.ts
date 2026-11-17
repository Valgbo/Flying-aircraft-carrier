/**
 * The one material every particle is drawn with: camera-facing soft quads from the atlas,
 * premultiplied-alpha blending so one draw call mixes alpha smoke (alpha = coverage) and
 * additive light (alpha = 0, emissive > 0), lit like a sphere by the sun and the sky, faded into
 * the haze with the environment's horizon colour and density (a10Env), tone-mapped and encoded
 * here (docs/a10/ARCHITECTURE.md §6).
 *
 * Tricks that keep it soft without a depth texture: the quad is pulled toward the camera by a
 * part of its size (dust spurts do not cut a straight line into the ground), particles fade as
 * the camera gets inside them, and a minimum on-screen size keeps distant ones from flickering.
 */
import { Color, NormalBlending, ShaderMaterial, Vector3, type Texture } from 'three';
import { thermalUniforms } from '../vehicles/thermal';
import { ATLAS_TILES_PER_ROW } from './atlas';

const VERTEX = /* glsl */ `
  attribute vec4 iPos;
  attribute vec4 iCol;
  attribute vec4 iEmi;
  attribute vec4 iMisc;
  attribute vec4 iVel;

  uniform float uScreenH;
  uniform float uHazeDensity;

  varying vec2 vUv;
  varying vec2 vQuad;
  varying vec4 vCol;
  varying vec4 vEmi;
  varying float vFog;
  varying float vHeat;
  varying float vBias;

  const float TILES = ${ATLAS_TILES_PER_ROW.toFixed(1)};

  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
    float depth = max(-mv.z, 0.001);
    float size = iPos.w;
    // metres per pixel at this depth: the minimum on-screen size
    float metresPerPx = 2.0 * depth / (projectionMatrix[1][1] * uScreenH);
    float s = max(size, iMisc.w * metresPerPx);
    float cover = size / s;

    // stretch along the screen-space direction of motion (sparks, ejecta), else rotate
    vec3 dirV = normalize(mv.xyz);
    vec3 velV = (modelViewMatrix * vec4(iVel.xyz, 0.0)).xyz;
    vec3 perp = velV - dot(velV, dirV) * dirV;
    float L = length(perp) * iMisc.z;
    vec2 axis;
    float rot = iMisc.y;
    if (L > 0.02 * s) {
      axis = normalize(perp.xy + vec2(1e-6, 0.0));
    } else if (rot > 500.0) {
      // upright (flames): align the quad's up with the world's up as seen on screen
      vec2 up = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xy;
      up = length(up) > 1e-4 ? normalize(up) : vec2(0.0, 1.0);
      axis = vec2(up.y, -up.x);
      L = 0.0;
    } else {
      axis = vec2(cos(rot), sin(rot));
      L = 0.0;
    }
    vec2 side = vec2(-axis.y, axis.x);
    vec2 c = position.xy;
    // the head of a streak sits at the particle; the tail trails behind it
    vec2 offset = axis * (c.x * (s + L) - 0.5 * L) + side * (c.y * s);
    mv.xy += offset;
    vQuad = axis * (c.x * 2.0) + side * (c.y * 2.0);

    // soft intersection with the ground and with solid objects
    float pull = min(0.4 * s, 0.45 * depth);
    mv.xyz -= dirV * pull;
    gl_Position = projectionMatrix * mv;

    float tile = iMisc.x;
    vec2 tileXY = vec2(mod(tile, TILES), floor(tile / TILES + 0.001));
    vUv = (tileXY + c + 0.5) / TILES;

    // fade as the camera gets inside the particle, and right at the near plane
    float near = smoothstep(0.2 * s, 1.0 * s, depth) * smoothstep(0.6, 2.0, depth);
    // a soft sprite only a few pixels wide is mip-averaged down to a fraction of its core
    // density: give dust and smoke their body back, and let light sample a sharper level, so a
    // spurt or a spark 1–2 km away still shows as a solid dot
    float small = 1.0 - smoothstep(2.0, 16.0, s / metresPerPx);
    vCol = vec4(iCol.rgb, iCol.a * cover * near * (1.0 + 1.6 * small));
    vBias = -3.0 * small * (1.0 - iEmi.a);
    // light enlarged to the minimum size keeps most of its brightness (it must stay visible)
    vEmi = vec4(iEmi.rgb * sqrt(cover) * near * (1.0 + 1.5 * small), iEmi.a);
    float f = uHazeDensity * length(mv.xyz);
    vFog = 1.0 - exp(-f * f);
    vHeat = iVel.w;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform vec3 uSunView;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform vec3 uHaze;
  uniform float uThermal;
  uniform float uThermalLevel;

  varying vec2 vUv;
  varying vec2 vQuad;
  varying vec4 vCol;
  varying vec4 vEmi;
  varying float vFog;
  varying float vHeat;
  varying float vBias;

  void main() {
    vec4 t = texture2D(uAtlas, vUv, vBias);
    float dens = t.a;
    float a = clamp(dens * vCol.a, 0.0, 1.0);

    // a sphere's normal across the sprite, in view space
    float r2 = min(dot(vQuad, vQuad), 1.0);
    vec3 n = vec3(vQuad, sqrt(1.0 - r2));
    float ndl = dot(n, uSunView);
    // wrapped, and half of it isotropic: light scattered many times inside dust and smoke
    // brightens the whole cloud, so a puff lit from the side or behind is not a dark ball
    float diff = 0.5 * clamp((ndl + 0.6) / 1.6, 0.0, 1.0) + 0.4;
    // thick centres shade a little darker, the detail channel breaks up flat areas
    float shade = (0.78 + 0.4 * t.r) * (1.0 - 0.3 * t.g * dens);
    // thin smoke glows when the sun is behind it
    float fwd = pow(max(0.0, -uSunView.z), 6.0) * (1.0 - dens) * 0.8;
    // lit like the environment lights every surface (irradiance · albedo / π); a cloud scatters
    // less toward the eye than a matte surface facing the sun
    vec3 light = (uAmbient * (0.75 + 0.25 * t.r) + uSunColor * (1.05 * diff * shade + fwd)) * 0.31830989;
    vec3 albedo = vCol.rgb * mix(vec3(1.0), light, vEmi.a);
    vec3 col = mix(albedo, uHaze, vFog);
    // light comes from the dense core: dimmer, redder edges instead of a bright outline
    vec3 emis = vEmi.rgb * dens * dens * (0.45 + 1.1 * t.r) * (1.0 - vFog);

    if (uThermal > 0.5) {
      float lum = dot(emis, vec3(0.3, 0.55, 0.15));
      float heat = clamp(uThermalLevel + vHeat * 0.75 + lum * 0.1, 0.0, 1.0);
      float g = uThermal > 1.5 ? 1.0 - heat : heat;
      float at = clamp(max(a, lum * 0.4), 0.0, 1.0);
      gl_FragColor = vec4(vec3(g) * at, at);
      return;
    }

    if (a < 0.002 && max(emis.r, max(emis.g, emis.b)) < 0.002) discard;
    #ifdef TONE_MAPPING
      col = toneMapping(col);
      emis = toneMapping(emis);
    #endif
    col = linearToOutputTexel(vec4(col, 1.0)).rgb;
    emis = linearToOutputTexel(vec4(emis, 1.0)).rgb;
    gl_FragColor = vec4(col * a + emis, a);
  }
`;

export interface ParticleUniforms {
  [name: string]: { value: unknown };
  uAtlas: { value: Texture | null };
  uScreenH: { value: number };
  uHazeDensity: { value: number };
  uSunView: { value: Vector3 };
  uSunColor: { value: Color };
  uAmbient: { value: Color };
  uHaze: { value: Color };
  uThermal: { value: number };
  uThermalLevel: { value: number };
}

export function createParticleMaterial(atlas: Texture): ShaderMaterial {
  const uniforms: ParticleUniforms = {
    uAtlas: { value: atlas },
    uScreenH: { value: 720 },
    uHazeDensity: { value: 4.5e-5 },
    uSunView: { value: new Vector3(0, 1, 0) },
    uSunColor: { value: new Color(2.4, 2.25, 2.0) },
    uAmbient: { value: new Color(0.55, 0.62, 0.72) },
    uHaze: { value: new Color(0.62, 0.72, 0.82) },
    uThermal: thermalUniforms.uThermal,
    uThermalLevel: thermalUniforms.uThermalLevel,
  };
  return new ShaderMaterial({
    name: 'a10-particles',
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    premultipliedAlpha: true,
  });
}
