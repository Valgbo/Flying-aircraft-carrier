/**
 * Ground decals: craters, scorch marks and small dirt marks, aligned to the ground normal at the
 * point of the explosion or impact. One instanced draw call; a ring buffer of fixed capacity that
 * overwrites the oldest. Each decal fades in and out from its own birth time and life (shader
 * side), so nothing is uploaded per frame unless a decal is added or the render origin moves.
 *
 * Decals sit on the analytic ground (`heightAt`); the rendered terrain mesh may lie a little
 * above or below between its vertices, so the quad is biased toward the camera by a distance-
 * dependent amount instead of using a fixed polygon offset.
 */
import {
  BufferAttribute,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector3,
  type Camera,
} from 'three';
import { a10Env } from '../environment/env';
import { fxRandom } from './noise';

export const DECAL = {
  /** Soot: a dark ragged patch (HEI, small bursts, burnt ground). */
  scorch: 0,
  /** Crater: charred centre and a rim of thrown soil (bombs, rockets, missiles). */
  crater: 1,
  /** A small mark of disturbed soil (30 mm ground impacts). */
  dirt: 2,
  /** A wide, faint blast mark of scattered soil and soot around a crater. */
  blast: 3,
} as const;

const VERTEX = /* glsl */ `
  attribute vec4 iA;
  attribute vec4 iB;
  attribute vec4 iC;
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform float uHazeDensity;
  varying vec2 vUv;
  varying vec4 vInfo;
  varying vec3 vLight;
  varying float vFog;
  void main() {
    vec3 n = normalize(iB.xyz);
    vec3 t = abs(n.y) < 0.99 ? normalize(cross(vec3(0.0, 1.0, 0.0), n)) : vec3(1.0, 0.0, 0.0);
    vec3 b = cross(n, t);
    float c = cos(iB.w);
    float s = sin(iB.w);
    vec3 tt = t * c + b * s;
    vec3 bb = b * c - t * s;
    vec3 p = iA.xyz + (tt * position.x + bb * position.y) * (2.0 * iA.w) + n * 0.06;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = length(mv.xyz);
    float bias = min(0.05 + 0.0025 * dist, 8.0);
    mv.xyz *= 1.0 - bias / max(dist, 0.001);
    gl_Position = projectionMatrix * mv;
    vUv = position.xy * 2.0;
    float age = uTime - iC.y;
    float alpha = smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(iC.w * 0.7, iC.w, age));
    vInfo = vec4(iC.x, iC.z, alpha, 0.0);
    vLight = (uAmbient + uSunColor * max(0.0, dot(n, uSunDir))) * RECIPROCAL_PI;
    float f = uHazeDensity * dist;
    vFog = 1.0 - exp(-f * f);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uHaze;
  varying vec2 vUv;
  varying vec4 vInfo;
  varying vec3 vLight;
  varying float vFog;
  float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm2(vec2 p) {
    return 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.1 + 3.7) + 0.15 * vnoise(p * 4.3 - 1.9);
  }
  void main() {
    float type = vInfo.x;
    vec2 sp = vUv + vInfo.y * 17.0;
    float r = length(vUv);
    float n = fbm2(sp * 2.2);
    vec3 albedo;
    float a;
    if (type < 0.5) {
      // scorch: soot, ragged edge
      float edge = r + (n - 0.5) * 0.55;
      a = (1.0 - smoothstep(0.35, 0.95, edge)) * (0.65 + 0.35 * n);
      albedo = mix(vec3(0.012, 0.011, 0.01), vec3(0.06, 0.05, 0.04), n);
    } else if (type < 1.5) {
      // crater: charred pit, a rim of fresh soil, then scattered clods
      float edge = r + (n - 0.5) * 0.3;
      float pit = 1.0 - smoothstep(0.32, 0.5, edge);
      float rim = smoothstep(0.3, 0.5, edge) * (1.0 - smoothstep(0.62, 0.95, edge));
      float spatter = (1.0 - smoothstep(0.7, 1.0, edge)) * step(0.62, fbm2(sp * 7.0));
      albedo = mix(vec3(0.05, 0.04, 0.032), vec3(0.012, 0.01, 0.009), pit * (0.6 + 0.4 * n));
      albedo = mix(albedo, vec3(0.11, 0.08, 0.055) * (0.75 + 0.5 * n), rim * 0.85);
      a = max(max(pit * 0.97, rim * 0.9), spatter * 0.7);
    } else if (type < 2.5) {
      // small dirt mark
      float edge = r + (n - 0.5) * 0.7;
      a = (1.0 - smoothstep(0.2, 0.9, edge)) * 0.75;
      albedo = vec3(0.075, 0.055, 0.04) * (0.7 + 0.6 * n);
    } else {
      // blast mark: scattered soil and soot fading out, streaked radially
      float ang = atan(vUv.y, vUv.x);
      float rays = fbm2(vec2(ang * 3.0, r * 1.5) + vInfo.y * 9.0);
      float edge = r + (rays - 0.5) * 0.5;
      a = (1.0 - smoothstep(0.15, 0.95, edge)) * (0.35 + 0.4 * n) * 0.8;
      albedo = mix(vec3(0.03, 0.026, 0.022), vec3(0.1, 0.075, 0.05), n);
    }
    a *= vInfo.z;
    vec3 col = mix(albedo * vLight, uHaze, vFog);
    a *= 1.0 - vFog * 0.6;
    if (a < 0.003) discard;
    #ifdef TONE_MAPPING
      col = toneMapping(col);
    #endif
    col = linearToOutputTexel(vec4(col, 1.0)).rgb;
    gl_FragColor = vec4(col * a, a);
  }
`;

export class DecalPool {
  readonly capacity: number;
  readonly mesh: Mesh;
  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly world: Float64Array;
  private readonly aA: InstancedBufferAttribute;
  private readonly aB: InstancedBufferAttribute;
  private readonly aC: InstancedBufferAttribute;
  private next = 0;
  private used = 0;
  private dirty = false;
  private ox = NaN;
  private oy = NaN;
  private oz = NaN;
  time = 0;

  constructor(capacity = 384) {
    this.capacity = capacity;
    this.world = new Float64Array(capacity * 3);
    const g = new InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
    );
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const inst = (name: string) => {
      const a = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      a.setUsage(DynamicDrawUsage);
      g.setAttribute(name, a);
      return a;
    };
    this.aA = inst('iA');
    this.aB = inst('iB');
    this.aC = inst('iC');
    g.instanceCount = 0;
    this.geometry = g;
    this.material = new ShaderMaterial({
      name: 'a10-decals',
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: new Vector3(0, 1, 0) },
        uSunColor: { value: new Color() },
        uAmbient: { value: new Color() },
        uHaze: { value: new Color() },
        uHazeDensity: { value: 4.5e-5 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      premultipliedAlpha: true,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.name = 'a10-decals';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /**
   * Add a decal at a world point on the ground with the ground normal, radius (m), type
   * (DECAL.*) and life (s). Overwrites the oldest when full.
   */
  add(x: number, y: number, z: number, nx: number, ny: number, nz: number, radius: number, type: number, life: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    if (this.used < this.capacity) this.used++;
    this.world[i * 3] = x;
    this.world[i * 3 + 1] = y;
    this.world[i * 3 + 2] = z;
    const B = this.aB.array as Float32Array;
    const C = this.aC.array as Float32Array;
    const A = this.aA.array as Float32Array;
    A[i * 4 + 3] = radius;
    B[i * 4] = nx;
    B[i * 4 + 1] = ny;
    B[i * 4 + 2] = nz;
    B[i * 4 + 3] = fxRandom.next() * Math.PI * 2;
    C[i * 4] = type;
    C[i * 4 + 1] = this.time;
    C[i * 4 + 2] = fxRandom.next();
    C[i * 4 + 3] = life;
    this.writePosition(i);
    this.dirty = true;
  }

  private writePosition(i: number): void {
    const A = this.aA.array as Float32Array;
    A[i * 4] = this.world[i * 3] - this.ox;
    A[i * 4 + 1] = this.world[i * 3 + 1] - this.oy;
    A[i * 4 + 2] = this.world[i * 3 + 2] - this.oz;
  }

  clear(): void {
    this.next = 0;
    this.used = 0;
    this.geometry.instanceCount = 0;
  }

  update(dt: number, camera: Camera): void {
    this.time += dt;
    const u = this.material.uniforms;
    u.uTime.value = this.time;
    u.uSunDir.value.copy(a10Env.sunDirection);
    u.uSunColor.value.copy(a10Env.sunColor);
    u.uAmbient.value.copy(a10Env.ambientColor);
    u.uHaze.value.copy(a10Env.horizonColor);
    u.uHazeDensity.value = a10Env.hazeDensity;
    const ox = Math.round(camera.position.x / 512) * 512;
    const oy = Math.round(camera.position.y / 512) * 512;
    const oz = Math.round(camera.position.z / 512) * 512;
    if (ox !== this.ox || oy !== this.oy || oz !== this.oz) {
      this.ox = ox;
      this.oy = oy;
      this.oz = oz;
      for (let i = 0; i < this.used; i++) this.writePosition(i);
      this.dirty = true;
    }
    this.mesh.position.set(ox, oy, oz);
    if (this.dirty) {
      this.aA.needsUpdate = true;
      this.aB.needsUpdate = true;
      this.aC.needsUpdate = true;
      this.dirty = false;
    }
    this.geometry.instanceCount = this.used;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
