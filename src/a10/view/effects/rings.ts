/**
 * Pressure-ring shells: the quick expanding shock front of an explosion, drawn as a sphere whose
 * edge (seen edge-on) brightens and slightly fogs the air for a fraction of a second. A handful
 * of instances in one draw call; the ground hides the lower half.
 */
import {
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Camera,
} from 'three';
import { a10Env } from '../environment/env';

const VERTEX = /* glsl */ `
  attribute vec4 iA;
  attribute vec4 iB;
  uniform float uHazeDensity;
  varying vec3 vN;
  varying vec3 vV;
  varying vec4 vB;
  varying float vFog;
  void main() {
    vec3 p = iA.xyz + position * iA.w;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    vB = iB;
    float f = uHazeDensity * length(mv.xyz);
    vFog = 1.0 - exp(-f * f);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uHaze;
  uniform vec3 uLight;
  varying vec3 vN;
  varying vec3 vV;
  varying vec4 vB;
  varying float vFog;
  void main() {
    float facing = abs(dot(normalize(vN), normalize(vV)));
    float rim = pow(1.0 - facing, 3.5);
    float a = rim * vB.x;
    vec3 col = mix(vB.yzw * uLight, uHaze, vFog);
    a *= 1.0 - vFog;
    if (a < 0.002) discard;
    #ifdef TONE_MAPPING
      col = toneMapping(col);
    #endif
    col = linearToOutputTexel(vec4(col, 1.0)).rgb;
    gl_FragColor = vec4(col * a, a);
  }
`;

export class RingPool {
  readonly capacity: number;
  readonly mesh: Mesh;
  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly aA: InstancedBufferAttribute;
  private readonly aB: InstancedBufferAttribute;
  /** Per ring: x, y, z, birth, duration, radius, strength, r, g, b. */
  private readonly data: Float64Array;
  private readonly live: Uint8Array;
  time = 0;

  constructor(capacity = 24) {
    this.capacity = capacity;
    this.data = new Float64Array(capacity * 10);
    this.live = new Uint8Array(capacity);
    const sphere = new SphereGeometry(1, 28, 14);
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', sphere.getAttribute('position'));
    g.setAttribute('normal', sphere.getAttribute('normal'));
    g.setIndex(sphere.getIndex());
    const inst = (name: string) => {
      const a = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      a.setUsage(DynamicDrawUsage);
      g.setAttribute(name, a);
      return a;
    };
    this.aA = inst('iA');
    this.aB = inst('iB');
    g.instanceCount = 0;
    this.geometry = g;
    this.material = new ShaderMaterial({
      name: 'a10-shock-rings',
      uniforms: {
        uHaze: { value: new Color() },
        uLight: { value: new Color(1, 1, 1) },
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
    this.mesh.name = 'a10-shock-rings';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
  }

  /** A shell growing to `radius` (m) in `duration` (s); strength 0..1; colour linear. */
  add(
    x: number,
    y: number,
    z: number,
    radius: number,
    duration: number,
    strength: number,
    color: Vector3,
  ): void {
    let i = 0;
    let oldest = Infinity;
    let pick = 0;
    for (; i < this.capacity; i++) {
      if (!this.live[i]) {
        pick = i;
        break;
      }
      const birth = this.data[i * 10 + 3];
      if (birth < oldest) {
        oldest = birth;
        pick = i;
      }
    }
    const d = this.data;
    const o = pick * 10;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = this.time;
    d[o + 4] = duration;
    d[o + 5] = radius;
    d[o + 6] = strength;
    d[o + 7] = color.x;
    d[o + 8] = color.y;
    d[o + 9] = color.z;
    this.live[pick] = 1;
  }

  clear(): void {
    this.live.fill(0);
    this.geometry.instanceCount = 0;
  }

  update(dt: number, camera: Camera): void {
    this.time += dt;
    const ox = Math.round(camera.position.x / 256) * 256;
    const oy = Math.round(camera.position.y / 256) * 256;
    const oz = Math.round(camera.position.z / 256) * 256;
    this.mesh.position.set(ox, oy, oz);
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    const d = this.data;
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.live[i]) continue;
      const o = i * 10;
      const t = (this.time - d[o + 3]) / d[o + 4];
      if (t >= 1) {
        this.live[i] = 0;
        continue;
      }
      if (t < 0) continue;
      const q = 1 - t;
      const r = d[o + 5] * (1 - q * q * q);
      A[n * 4] = d[o] - ox;
      A[n * 4 + 1] = d[o + 1] - oy;
      A[n * 4 + 2] = d[o + 2] - oz;
      A[n * 4 + 3] = Math.max(0.05, r);
      B[n * 4] = d[o + 6] * q * q;
      B[n * 4 + 1] = d[o + 7];
      B[n * 4 + 2] = d[o + 8];
      B[n * 4 + 3] = d[o + 9];
      n++;
    }
    const u = this.material.uniforms;
    u.uHaze.value.copy(a10Env.horizonColor);
    u.uHazeDensity.value = a10Env.hazeDensity;
    // ambient plus some sun, as a pale shell of disturbed air and dust (irradiance / π)
    const light = u.uLight.value as Color;
    light
      .copy(a10Env.sunColor)
      .multiplyScalar(0.6)
      .add(a10Env.ambientColor)
      .multiplyScalar(1 / Math.PI);
    this.geometry.instanceCount = n;
    if (n > 0) {
      this.aA.needsUpdate = true;
      this.aB.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
