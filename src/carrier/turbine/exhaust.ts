/**
 * Exhaust effects of a turbine — geometry and shader materials, shared by all four turbines
 * (per-turbine values go through the uniforms in `onBeforeRender`, see TurbineExhaust.tsx).
 *
 *   plume     — the hot core: two nested additive shells of revolution along -Y whose shape is
 *               computed in the vertex shader (length, taper, shock cells, bend in the airflow).
 *   particles — instanced camera-facing quads, animated entirely in the vertex shader from a
 *               per-particle seed and the time uniform (stateless and looping): sparks and
 *               vapour shot out of the nozzle, spreading, slowing and trailing in the airflow.
 *   spray     — the same technique in WORLD space: a ring of mist thrown outward and upward
 *               from the point where the exhaust hits the sea.
 *
 * The plume and particle meshes sit at the centre of the nozzle exit plane (local y = 0 is
 * the exit); the spray mesh sits at the impact point on the water.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import { PALETTE } from '../../config/palette';
import { TAU, mulberry32 } from '../../utils/math';
import { EXIT_INNER_RADIUS, FAN_Y, NOZZLE_Y, THROAT_RADIUS, type TurbineDetail } from './model';

const NOISE_GLSL = /* glsl */ `
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  // value noise that tiles in x with the given period (x is an angle around the plume)
  float ringNoise(vec2 p, float period) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float x0 = mod(i.x, period);
    float x1 = mod(i.x + 1.0, period);
    return mix(mix(hash(vec2(x0, i.y)), hash(vec2(x1, i.y)), f.x),
               mix(hash(vec2(x0, i.y + 1.0)), hash(vec2(x1, i.y + 1.0)), f.x), f.y);
  }
`;

// ---------------------------------------------------------------------------------------------
// Plume core
// ---------------------------------------------------------------------------------------------

/**
 * Two unit shells: position = (sin phi, s, cos phi) with s = 0 at the nozzle and 1 at the tip
 * (denser rings near the nozzle for the shock cells), aShell = 0 outer sheath / 1 inner core,
 * aAngle = phi / 2π with a duplicated seam so noise can tile around the plume.
 */
export function buildPlumeGeometry(d: TurbineDetail): BufferGeometry {
  const positions: number[] = [];
  const shells: number[] = [];
  const angles: number[] = [];
  const indices: number[] = [];
  const columns = d.plumeSegments + 1;
  for (let shell = 0; shell < 2; shell++) {
    const base = positions.length / 3;
    for (let j = 0; j <= d.plumeRings; j++) {
      const s = Math.pow(j / d.plumeRings, 1.5);
      for (let i = 0; i < columns; i++) {
        const phi = (i / d.plumeSegments) * TAU;
        positions.push(Math.sin(phi), s, Math.cos(phi));
        shells.push(shell);
        angles.push(i / d.plumeSegments);
      }
    }
    for (let j = 0; j < d.plumeRings; j++) {
      for (let i = 0; i < d.plumeSegments; i++) {
        const a = base + j * columns + i;
        const b = a + 1;
        const c = a + columns;
        indices.push(a, b, c + 1, a, c + 1, c);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aShell', new Float32BufferAttribute(shells, 1));
  geometry.setAttribute('aAngle', new Float32BufferAttribute(angles, 1));
  geometry.setIndex(indices);
  return geometry;
}

const PLUME_VERTEX = /* glsl */ `
  uniform float uLength;
  uniform float uRadius;
  uniform vec3 uDrift;
  attribute float aShell;
  attribute float aAngle;
  varying float vS;
  varying float vShell;
  varying float vAngle;
  varying vec3 vNormal;
  varying vec3 vView;

  const float SHOCK_SPACING = 9.0;

  void main() {
    float s = position.y;
    float dist = s * uLength;
    // the outer sheath tapers gently, the inner core is a narrower and sharper cone
    float radius = uRadius * mix(1.0 - 0.42 * pow(s, 0.85), 0.56 * (1.0 - 0.8 * s), aShell);
    // shock cells pinch the core near the nozzle
    radius *= 1.0 + aShell * 0.16 * cos(6.2832 * dist / SHOCK_SPACING) * exp(-dist / 30.0);
    vec3 p = vec3(position.x * radius, -dist, position.z * radius);
    // the airflow past the ship bends the column, more and more toward the slow tip
    p += uDrift * pow(s, 1.6);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vNormal = normalMatrix * vec3(position.x, 0.2, position.z);
    vView = mv.xyz;
    vS = s;
    vShell = aShell;
    vAngle = aAngle;
    gl_Position = projectionMatrix * mv;
  }
`;

const PLUME_FRAGMENT = /* glsl */ `
  uniform float uLength;
  uniform float uTime;
  uniform float uPower;
  uniform float uIntensity;
  uniform vec3 uCool;
  uniform vec3 uHot;
  varying float vS;
  varying float vShell;
  varying float vAngle;
  varying vec3 vNormal;
  varying vec3 vView;

  const float SHOCK_SPACING = 9.0;
  ${NOISE_GLSL}

  void main() {
    float dist = vS * uLength;
    // soft silhouette: a shell seen edge-on contributes nothing, and eases into that
    float facing = abs(dot(normalize(vNormal), normalize(vView)));
    float soft = pow(facing, mix(3.2, 2.6, vShell));
    float fade = pow(1.0 - vS, 1.5);

    // streaks of turbulence scrolling downstream
    float flow = dist * 0.09 - uTime * (1.4 + 3.0 * uPower);
    float n = 0.65 * ringNoise(vec2(vAngle * 12.0, flow), 12.0)
            + 0.35 * ringNoise(vec2(vAngle * 24.0 + 3.0, flow * 2.3), 24.0);
    float streaks = 0.22 + 1.5 * n * n;

    // shock diamonds: bright standing cells in the core, dying away from the nozzle
    float cell = pow(0.5 + 0.5 * cos(6.2832 * dist / SHOCK_SPACING), 3.0);
    float diamonds = vShell * cell * exp(-dist / 34.0) * (0.3 + uPower);

    vec3 colour = mix(uCool, vec3(1.0), smoothstep(0.02, 0.36, vS) * 0.9 + 0.1 * vShell);
    colour = mix(colour, uHot, smoothstep(0.38, 0.95, vS));

    float amount = soft * (fade * streaks * mix(0.13, 0.4, vShell) + diamonds * 0.8);
    gl_FragColor = vec4(colour * (amount * uIntensity), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createPlumeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uLength: { value: 0 },
      uRadius: { value: EXIT_INNER_RADIUS - 0.5 },
      uDrift: { value: new Vector3() },
      uTime: { value: 0 },
      uPower: { value: 0 },
      uIntensity: { value: 0 },
      uCool: { value: new Color(PALETTE.glowCool) },
      uHot: { value: new Color(PALETTE.glowHot) },
    },
    vertexShader: PLUME_VERTEX,
    fragmentShader: PLUME_FRAGMENT,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    // additive shells: order does not matter, so skip the two-pass back / front draw
    forceSinglePass: true,
    toneMapped: false,
  });
}

// ---------------------------------------------------------------------------------------------
// Particles (exhaust and sea spray share the instanced quad layout)
// ---------------------------------------------------------------------------------------------

/** `count` camera-facing quads; aSeed holds four independent random numbers per particle. */
export function buildParticleGeometry(count: number, seed: number): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const rand = mulberry32(seed);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4));
  geometry.instanceCount = count;
  return geometry;
}

/**
 * Both particle shaders write a straight colour through the tone-mapping / colour-space
 * chunks and only then premultiply by coverage, so the blend (ONE, ONE_MINUS_SRC_ALPHA) is
 * right on both output paths. `vBlend` = (coverage, share of the coverage that occludes):
 * 0 = purely additive spark, 1 = ordinary translucent mist.
 */
const PARTICLE_FRAGMENT = /* glsl */ `
  varying vec2 vCorner;
  varying vec3 vColour;
  varying vec2 vBlend;
  void main() {
    float r2 = dot(vCorner, vCorner);
    float soft = max(0.0, exp(-3.2 * r2) - 0.0408) / 0.9592;
    gl_FragColor = vec4(vColour, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    float coverage = vBlend.x * soft;
    gl_FragColor = vec4(gl_FragColor.rgb * coverage, coverage * vBlend.y);
  }
`;

const EXHAUST_PARTICLE_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uSpeed;
  uniform float uOpacity;
  uniform vec3 uRelVel;
  uniform vec3 uTint;
  uniform vec3 uCool;
  uniform vec2 uAnnulus;
  uniform vec3 uEye;
  uniform vec2 uFan;
  attribute vec4 aSeed;
  varying vec2 vCorner;
  varying vec3 vColour;
  varying vec2 vBlend;

  const float DRAG = 2.0;

  void main() {
    // about one particle in seven is a short-lived spark, the rest is vapour
    float spark = step(0.86, aSeed.w);
    float jitter = fract(aSeed.x * 13.7);
    float life = mix(mix(1.7, 3.1, aSeed.y), mix(0.45, 1.0, aSeed.y), spark);
    float age = fract(uTime / life + aSeed.x);

    // born across the annulus of the nozzle exit, denser toward the axis so the column has
    // no hard flanks when seen from the side
    float ang = aSeed.z * 6.2832;
    vec2 dir = vec2(sin(ang), cos(ang));
    float r0 = mix(uAnnulus.x, uAnnulus.y, fract(aSeed.w * 7.3));

    // shot along -Y, slowing down against the air
    float dist = uSpeed * life * (1.0 - exp(-DRAG * age)) / DRAG;
    float speedNow = uSpeed * exp(-DRAG * age);
    float spread = 1.0 + mix(1.1, 0.3, spark) * pow(age, 0.8) * (0.4 + jitter);
    vec3 p = vec3(dir.x * r0 * spread, -dist, dir.y * r0 * spread);

    // turbulent wander of the vapour
    float wander = (1.0 - spark) * age * 3.0;
    p.x += sin(uTime * (0.8 + aSeed.y) + aSeed.z * 31.0) * wander;
    p.z += cos(uTime * (0.7 + jitter) + aSeed.x * 47.0) * wander;

    // left behind by the moving ship: the older the particle, the further it has drifted
    p -= uRelVel * (life * age * age);

    // looking down the intake, the line of sight to a particle crosses the fan disc: the
    // spinning blades hide the exhaust behind them
    float seen = 1.0;
    if (uEye.y > uFan.x && p.y < uFan.x) {
      vec2 crossing = mix(uEye.xz, p.xz, (uEye.y - uFan.x) / (uEye.y - p.y));
      seen = 0.08 + 0.92 * smoothstep(uFan.y - 2.5, uFan.y, length(crossing));
    }

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec3 axisView = (modelViewMatrix * vec4(0.0, -1.0, 0.0, 0.0)).xyz;
    float axisLen = length(axisView.xy);
    vec2 along = axisLen > 1e-4 ? axisView.xy / axisLen : vec2(0.0, 1.0);
    vec2 across = vec2(-along.y, along.x);
    float size = mix(mix(1.8, 10.0, pow(age, 0.7)) * (0.6 + 0.8 * jitter), mix(0.42, 0.2, age), spark);
    // sparks are drawn as streaks along their motion
    float stretch = 1.0 + spark * speedNow * 0.04 * axisLen;
    mv.xy += (across * position.x + along * position.y * stretch) * size;
    gl_Position = projectionMatrix * mv;
    vCorner = position.xy;

    float fadeIn = smoothstep(0.0, 0.06, age);
    // vapour leaves the nozzle glowing and cools to plain steam / haze
    float heat = exp(-age * 9.0);
    vec3 vapour = mix(uTint, uCool * 1.3, heat);
    float vapourCover = 0.11 * fadeIn * pow(1.0 - age, 1.4);
    vec3 sparks = mix(vec3(1.0), uCool, 0.45) * (2.4 - 1.8 * age);
    float sparkCover = 0.5 * fadeIn * (1.0 - age);

    vColour = mix(vapour, sparks, spark);
    vBlend = vec2(mix(vapourCover, sparkCover, spark) * uOpacity * seen, 1.0 - max(spark, heat));
  }
`;

export function createExhaustParticleMaterial(): ShaderMaterial {
  const inner = 3.5;
  const outer = EXIT_INNER_RADIUS - 1;
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSpeed: { value: 0 },
      uOpacity: { value: 0 },
      uRelVel: { value: new Vector3() },
      uTint: { value: new Color(1, 1, 1) },
      uCool: { value: new Color(PALETTE.glowCool) },
      uAnnulus: { value: new Vector2(inner, outer) },
      // camera position in the frame of the particle mesh (origin = centre of the nozzle exit)
      uEye: { value: new Vector3() },
      // fan disc in that frame: height above the nozzle exit, radius
      uFan: { value: new Vector2(FAN_Y - NOZZLE_Y, THROAT_RADIUS) },
    },
    vertexShader: EXHAUST_PARTICLE_VERTEX,
    fragmentShader: PARTICLE_FRAGMENT,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    toneMapped: false,
  });
}

const SPRAY_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;
  uniform float uRadius;
  uniform vec3 uTint;
  attribute vec4 aSeed;
  varying vec2 vCorner;
  varying vec3 vColour;
  varying vec2 vBlend;

  void main() {
    float jitter = fract(aSeed.w * 5.3);
    float life = mix(1.6, 3.4, aSeed.y);
    float age = fract(uTime / life + aSeed.x);
    float t = age * life;

    // thrown from a ring around the impact point: outward and up, then falling back
    float ang = aSeed.z * 6.2832;
    vec2 dir = vec2(sin(ang), cos(ang));
    float ring = uRadius * (0.78 + 0.36 * aSeed.w);
    float outward = (4.0 + 13.0 * uStrength) * (0.4 + aSeed.w);
    float upward = (5.0 + 16.0 * uStrength) * (0.2 + jitter);
    float radius = ring + outward * t * (1.0 - 0.35 * age);
    // ballistic arc that lands exactly at the end of the particle's life
    float height = upward * t * (1.0 - age);
    vec3 p = vec3(dir.x * radius, height + 0.5, dir.y * radius);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float size = mix(2.4, 9.0, age) * (0.6 + 0.8 * fract(aSeed.x * 9.1)) * (0.6 + 0.6 * uStrength);
    mv.xy += position.xy * size;
    gl_Position = projectionMatrix * mv;
    vCorner = position.xy;

    vColour = uTint;
    float cover = 0.3 * smoothstep(0.0, 0.1, age) * (1.0 - age) * smoothstep(0.0, 0.25, uStrength);
    vBlend = vec2(cover, 1.0);
  }
`;

export function createSprayMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uRadius: { value: 0 },
      uTint: { value: new Color(1, 1, 1) },
    },
    vertexShader: SPRAY_VERTEX,
    fragmentShader: PARTICLE_FRAGMENT,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
  });
}
