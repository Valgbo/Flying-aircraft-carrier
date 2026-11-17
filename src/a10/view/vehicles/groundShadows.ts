/**
 * Soft contact shadows under every vehicle: one instanced quad each, darkening the ground under
 * the hull and a little toward the side away from the sun. They ground the vehicles visually from
 * altitude, where real shadow maps do not reach (the High preset adds real shadows near the camera).
 */
import {
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  NormalBlending,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { a10Env } from '../environment/env';

const VERTEX = /* glsl */ `
  attribute float iOpacity;
  uniform float uHazeDensity;
  varying vec2 vUv;
  varying float vO;
  varying float vFog;
  void main() {
    vUv = vec2(position.x, position.z) * 2.0;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    float dist = length(mv.xyz);
    float bias = min(0.06 + 0.0025 * dist, 6.0);
    mv.xyz *= 1.0 - bias / max(dist, 0.001);
    gl_Position = projectionMatrix * mv;
    vO = iOpacity;
    float f = uHazeDensity * dist;
    vFog = 1.0 - exp(-f * f);
  }
`;

const FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  varying float vO;
  varying float vFog;
  void main() {
    vec2 q = max(abs(vUv) - vec2(0.62), 0.0) / 0.38;
    float d = length(q);
    float a = (1.0 - smoothstep(0.0, 1.0, d)) * vO * (1.0 - vFog);
    if (a < 0.003) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
  }
`;

const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();
const _p = new Vector3();

export class GroundShadows {
  mesh: InstancedMesh;
  private capacity: number;
  private opacity: InstancedBufferAttribute;
  private readonly geometry: PlaneGeometry;
  private readonly material: ShaderMaterial;
  private n = 0;

  constructor(capacity = 96) {
    this.capacity = capacity;
    this.geometry = new PlaneGeometry(1, 1);
    this.geometry.rotateX(-Math.PI / 2);
    this.material = new ShaderMaterial({
      name: 'a10-vehicle-shadows',
      uniforms: { uHazeDensity: { value: 4.5e-5 }, uColor: { value: new Color(0, 0, 0) } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      premultipliedAlpha: true,
    });
    this.opacity = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.mesh = this.makeMesh();
  }

  private makeMesh(): InstancedMesh {
    this.opacity = new InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this.opacity.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('iOpacity', this.opacity);
    const mesh = new InstancedMesh(this.geometry, this.material, this.capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.name = 'a10-vehicle-shadows';
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.count = 0;
    return mesh;
  }

  begin(): void {
    this.n = 0;
  }

  /** One shadow: ground point, heading (rad), footprint (m), vehicle height (m), opacity. */
  add(
    x: number,
    y: number,
    z: number,
    heading: number,
    width: number,
    length: number,
    height: number,
    opacity: number,
  ): void {
    if (this.n >= this.capacity) {
      const parent = this.mesh.parent;
      this.capacity *= 2;
      this.mesh.removeFromParent();
      this.mesh.dispose();
      this.mesh = this.makeMesh();
      parent?.add(this.mesh);
      this.n = 0;
      return;
    }
    const sun = a10Env.sunDirection;
    const elev = Math.max(0.15, Math.asin(Math.min(1, Math.max(-1, sun.y))));
    const h = Math.hypot(sun.x, sun.z) || 1;
    const reach = Math.min(6, (height / Math.tan(elev)) * 0.45);
    _p.set(x - (sun.x / h) * reach, y + 0.05, z - (sun.z / h) * reach);
    _q.setFromAxisAngle(_s.set(0, 1, 0), -heading);
    _s.set(width * 1.25 + reach * 0.6, 1, length * 1.15 + reach * 0.6);
    _m.compose(_p, _q, _s);
    this.mesh.setMatrixAt(this.n, _m);
    (this.opacity.array as Float32Array)[this.n] = opacity;
    this.n++;
  }

  end(): void {
    const mesh = this.mesh;
    mesh.count = this.n;
    this.material.uniforms.uHazeDensity.value = a10Env.hazeDensity;
    if (this.n > 0) {
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, this.n * 16);
      mesh.instanceMatrix.needsUpdate = true;
      this.opacity.clearUpdateRanges();
      this.opacity.addUpdateRange(0, this.n);
      this.opacity.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
