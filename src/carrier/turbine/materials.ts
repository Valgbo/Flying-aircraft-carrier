/**
 * Materials of the turbine nacelle. All of them are shared by the four turbines; the custom
 * shader materials take their per-turbine values through `onBeforeRender` (see Turbine.tsx),
 * which copies them into the shared uniforms and sets `uniformsNeedUpdate`.
 */
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  MeshStandardMaterial,
  ShaderMaterial,
  type Texture,
} from 'three';
import { PALETTE } from '../../config/palette';

/** Duct, internals, trunnions and rotor: the paint atlas tinted by vertex colours. */
export function createNacelleMaterial(paint: Texture): MeshStandardMaterial {
  return new MeshStandardMaterial({
    map: paint,
    vertexColors: true,
    roughness: 0.62,
    metalness: 0.2,
  });
}

/**
 * Fan blades. Always in the transparent pass (with depth write) so the opacity can follow the
 * fan speed without switching shader programs; each turbine owns a clone for its own opacity.
 */
export function createBladeMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: '#56616b',
    roughness: 0.4,
    metalness: 0.3,
    transparent: true,
  });
}

/** Stencilled turbine number: cut out by alpha test and held off the skin by polygon offset. */
export function createDecalMaterial(numbers: Texture): MeshStandardMaterial {
  return new MeshStandardMaterial({
    map: numbers,
    alphaTest: 0.5,
    roughness: 0.7,
    metalness: 0.1,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

const GLOW_VERTEX = /* glsl */ `
  varying vec2 vWeights;
  varying vec3 vLocal;
  void main() {
    vWeights = color.rg;
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GLOW_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform vec3 uCoreColor;
  uniform float uCore;
  uniform float uTime;
  varying vec2 vWeights;
  varying vec3 vLocal;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    // slow roil of the burning gas, drifting around the ring
    float roil = 0.8 + 0.4 * noise(vLocal.xz * 0.42 + vec2(uTime * 1.7, -uTime * 1.1));
    vec3 glow = uColor * (uIntensity * vWeights.x * roil) + uCoreColor * (uCore * vWeights.y);
    gl_FragColor = vec4(glow, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Additive combustion glow; weights come from the colour attribute (r = glow, g = hot core). */
export function createGlowMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(PALETTE.glowCool) },
      uIntensity: { value: 0 },
      uCoreColor: { value: new Color('#fff3e2') },
      uCore: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    vertexColors: true,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    // additive: no need for the two-pass back / front draw of transparent double-sided meshes
    forceSinglePass: true,
    toneMapped: false,
  });
}

const DISC_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DISC_FRAGMENT = /* glsl */ `
  uniform sampler2D uStreaks;
  uniform vec3 uBladeColor;
  uniform vec3 uLightAbove;
  uniform vec3 uLightBelow;
  uniform vec3 uGlow;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec4 streak = texture2D(uStreaks, vUv);
    // lit by the sky from above; from below by what bounces up plus the combustion glow,
    // a little of which also shines through to the intake side
    vec3 light = gl_FrontFacing ? uLightAbove + uGlow * 0.25 : uLightBelow + uGlow;
    vec3 colour = uBladeColor * light * (0.55 + 0.9 * streak.r);
    float edge = smoothstep(0.0, 0.03, vUv.y) * smoothstep(1.0, 0.985, vUv.y);
    gl_FragColor = vec4(colour, uOpacity * streak.a * edge);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** The motion-blurred fan: an unlit disc shaded from the environment so it sits in the scene. */
export function createBlurDiscMaterial(streaks: Texture): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uStreaks: { value: streaks },
      uBladeColor: { value: new Color('#56616b') },
      uLightAbove: { value: new Color(1, 1, 1) },
      uLightBelow: { value: new Color(0.3, 0.3, 0.3) },
      uGlow: { value: new Color(0, 0, 0) },
      uOpacity: { value: 0 },
    },
    vertexShader: DISC_VERTEX,
    fragmentShader: DISC_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    // a flat disc never overlaps itself: one pass, shaded per side through gl_FrontFacing
    forceSinglePass: true,
  });
}
