/**
 * Vision under g: grey-out, tunnel vision and black-out from sustained positive g, red-out from
 * negative g, drawn as a screen-space overlay over the cockpit view (render pass order 450).
 * OWNED BY THE COCKPIT MODULE. The model is pure (tests/unit/a10/cockpitVision.test.ts).
 *
 * Positive g: the eye has a few seconds of oxygen reserve. Above the onset (≈6.5 g) blood flow
 * to the retina falls short and the reserve drains, faster the higher the load; only as it
 * runs out does vision fade — colour first, then the periphery closes in (tunnel vision), and
 * at ≈8.5 g sustained it goes black. So a brief pull through 8 g greys the edges a little,
 * while a long 7.5 g turn slowly greys and narrows the view; the HUD in the middle of the
 * screen is the last thing to go. Below −2.5 g the view reddens (red-out) without a delay.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  Vector2,
} from 'three';
import type { RenderPass } from '../pipeline';

export const VISION = {
  /** Sustained load where vision starts to suffer, and where it is completely lost, g. */
  onsetG: 6.5,
  fullG: 8.5,
  /** Seconds of oxygen reserve at the full-loss load (longer at lower loads). */
  reserveTime: 4,
  /** Seconds to refill the reserve below the onset. */
  refillTime: 3,
  /** Vision level time constants, s: fading and recovering. */
  fadeTau: 0.6,
  recoverTau: 1.2,
  /** Red-out: begins below this load, complete at the second, g. */
  redOnsetG: -2.5,
  redFullG: -4,
  redTau: 0.8,
  redRecoverTau: 1.5,
} as const;

export interface VisionState {
  /** Oxygen reserve of the eye, 1 full … 0 used up. */
  reserve: number;
  /** Loss of vision from positive g: 0 clear … ≈0.6 grey with a narrowing tunnel … 1 black. */
  level: number;
  /** Red-out 0..1. */
  red: number;
}

export function createVisionState(): VisionState {
  return { reserve: 1, level: 0, red: 0 };
}

export function resetVision(v: VisionState): void {
  v.reserve = 1;
  v.level = 0;
  v.red = 0;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** How hard a load starves the eye: 0 at the onset … 1 at the full-loss load. */
export function visionLoad(g: number): number {
  return clamp01((g - VISION.onsetG) / (VISION.fullG - VISION.onsetG));
}

/** Advance the vision model by dt sim seconds at load factor g. */
export function stepVision(v: VisionState, g: number, dt: number): void {
  if (!(dt > 0)) return;
  const load = Number.isFinite(g) ? g : 1;
  const L = visionLoad(load);
  if (L > 0) v.reserve = clamp01(v.reserve - (L / VISION.reserveTime) * dt);
  else v.reserve = clamp01(v.reserve + dt / VISION.refillTime);
  const target = L * (1 - v.reserve);
  const tau = target > v.level ? VISION.fadeTau : VISION.recoverTau;
  v.level += (target - v.level) * (1 - Math.exp(-dt / tau));
  if (v.level < 1e-4) v.level = 0;

  const R = clamp01((VISION.redOnsetG - load) / (VISION.redOnsetG - VISION.redFullG));
  const rt = R > v.red ? VISION.redTau : VISION.redRecoverTau;
  v.red += (R - v.red) * (1 - Math.exp(-dt / rt));
  if (v.red < 1e-4) v.red = 0;
}

/**
 * Radius of the clear centre of vision (screen half-heights from the centre) for a level: the
 * whole screen up to a level of 0.15, closing to a small spot at 0.95.
 */
export function tunnelRadius(level: number): number {
  const t = clamp01((level - 0.15) / 0.8);
  const s = t * t * (3 - 2 * t);
  return 1.9 + (0.1 - 1.9) * s;
}

// ---------------------------------------------------------------------------------------------
// The overlay pass
// ---------------------------------------------------------------------------------------------

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float uLevel;
uniform float uRed;
uniform float uRadius;
uniform vec2 uAspect;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0 * uAspect;
  float r = length(p);
  // grey-out: the colours wash out toward grey everywhere, the periphery darkens and closes in
  float wash = 0.42 * smoothstep(0.0, 0.7, uLevel);
  float tunnel = smoothstep(uRadius, uRadius + 0.55 + 0.4 * uRadius, r);
  float black = smoothstep(0.86, 1.0, uLevel);
  vec3 grey = vec3(0.16);
  float a = max(wash, tunnel);
  vec3 c = mix(grey, vec3(0.0), tunnel / max(a, 1e-3));
  a = mix(a, 1.0, black);
  c = mix(c, vec3(0.0), black);
  // red-out: a red veil, darker toward the edges
  float ra = uRed * (0.55 + 0.35 * smoothstep(0.3, 1.6, r));
  vec3 rc = vec3(0.32, 0.0, 0.0);
  float outA = 1.0 - (1.0 - a) * (1.0 - ra);
  vec3 outC = (c * a * (1.0 - ra) + rc * ra) / max(outA, 1e-3);
  gl_FragColor = vec4(outC, outA);
  #include <colorspace_fragment>
}`;

/** The full-screen overlay, drawn after the HUD (pipeline order 450) while vision suffers. */
export class VisionOverlay {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new BufferGeometry();
  private readonly material: ShaderMaterial;

  constructor() {
    // one triangle covering the screen
    this.geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.material = new ShaderMaterial({
      name: 'vision-overlay',
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uLevel: { value: 0 },
        uRed: { value: 0 },
        uRadius: { value: 2 },
        uAspect: { value: new Vector2(16 / 9, 1) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  /** Whether anything shows for this state. */
  static visible(v: VisionState): boolean {
    return v.level > 0.002 || v.red > 0.002;
  }

  render(pass: Parameters<RenderPass['render']>[0], v: VisionState): void {
    const u = this.material.uniforms;
    u.uLevel.value = v.level;
    u.uRed.value = v.red;
    u.uRadius.value = tunnelRadius(v.level);
    const target = pass.target;
    const w = target ? target.width : pass.width;
    const h = target ? target.height : pass.height;
    (u.uAspect.value as Vector2).set(h > 0 ? w / h : 16 / 9, 1);
    const gl = pass.gl;
    gl.setRenderTarget(target);
    const auto = gl.autoClear;
    gl.autoClear = false;
    gl.render(this.scene, this.camera);
    gl.autoClear = auto;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
