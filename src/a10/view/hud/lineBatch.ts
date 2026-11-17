/**
 * The HUD's line renderer: every stroke of the symbology in ONE instanced draw call.
 *
 * Each instance is a segment between two HUD-plane points (gnomonic coordinates on the body
 * plane z = −1, see hudMath.ts). The vertex shader projects both ends with the HUD camera and
 * expands a screen-space quad around them, so lines keep a constant width in pixels at any
 * zoom; the fragment shader shades a capsule (round caps, so joints between strokes are
 * seamless) with analytic anti-aliasing. Blending is premultiplied "over" with a partial
 * alpha: overlapping strokes do not double up, and the background shows through a little,
 * as through a combiner glass.
 *
 * Optional ANALYTIC GLASS CLIP: when the target has no stencil buffer, each fragment's view
 * ray (from the head position, along the symbol's direction) is intersected with the combiner
 * glass and discarded outside it — the same result as the stencil mask, without occlusion by
 * the cockpit structure.
 *
 * COLOURS: each stroke carries an index into a small palette (`PALETTE_SIZE` linear colours).
 * The HUD draws everything in colour 0 (its green, from the style); the multifunction displays
 * (view/mfd) use the others. Set `color` before writing strokes: it is a register, so the
 * `SegmentSink` interface (and the stroke font) stay as they are.
 */
import {
  CustomBlending,
  EqualStencilFunc,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  KeepStencilOp,
  Matrix4,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Uint16BufferAttribute,
  Vector2,
  Vector3,
  Color,
  BufferAttribute,
  AddEquation,
  DynamicDrawUsage,
  type Camera,
} from 'three';
import type { SegmentSink } from './strokeFont';
import type { GlassCorners } from './hudMath';

/** Floats per segment: x0, y0, x1, y1, width scale, intensity, colour index. */
const STRIDE = 7;

/** Colours in the palette (index 0 is the style's colour). */
export const PALETTE_SIZE = 8;

const VERTEX = /* glsl */ `
attribute vec4 aSeg;
attribute vec3 aStyle;
uniform vec2 uViewport;
uniform float uLineWidth;
uniform mat4 uInvViewProj;
uniform vec3 uPalette[${PALETTE_SIZE}];
varying vec2 vLocal;
varying float vLen;
varying float vHalfWidth;
varying vec3 vColor;
varying vec3 vDir;

void main() {
  vec4 c0 = projectionMatrix * modelViewMatrix * vec4(aSeg.xy, -1.0, 1.0);
  vec4 c1 = projectionMatrix * modelViewMatrix * vec4(aSeg.zw, -1.0, 1.0);
  vLen = 0.0;
  vHalfWidth = 0.0;
  vColor = vec3(0.0);
  vLocal = vec2(0.0);
  vDir = vec3(0.0, 0.0, -1.0);
  if (c0.w < 1e-4 || c1.w < 1e-4) {
    // An end behind the eye (head turned far away): drop the segment.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec2 halfVp = 0.5 * uViewport;
  vec2 s0 = c0.xy / c0.w * halfVp;
  vec2 s1 = c1.xy / c1.w * halfVp;
  vec2 d = s1 - s0;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = 0.5 * uLineWidth * aStyle.x;
  float ext = hw + 1.0;
  float along = position.x * len + (position.x * 2.0 - 1.0) * ext;
  float across = position.y * ext;
  vec2 p = s0 + dir * along + nrm * across;
  vLocal = vec2(along, across);
  vLen = len;
  vHalfWidth = hw;
  // The palette is indexed in the vertex shader (dynamic indexing of a uniform array is allowed
  // there in every GLSL ES version).
  vColor = uPalette[int(aStyle.z + 0.5)] * aStyle.y;
  vec2 ndc = p / halfVp;
  vec4 w = uInvViewProj * vec4(ndc, 0.5, 1.0);
  vDir = w.xyz / w.w;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uOpacity;
uniform float uClip;
uniform vec3 uEye;
uniform vec3 uGlassO;
uniform vec3 uGlassU;
uniform vec3 uGlassV;
uniform vec3 uGlassN;
varying vec2 vLocal;
varying float vLen;
varying float vHalfWidth;
varying vec3 vColor;
varying vec3 vDir;

void main() {
  float dist = length(vec2(vLocal.x - clamp(vLocal.x, 0.0, vLen), vLocal.y));
  float cov = clamp(vHalfWidth + 0.5 - dist, 0.0, 1.0);
  if (cov <= 0.002) discard;
  if (uClip > 0.5) {
    float denom = dot(uGlassN, vDir);
    if (abs(denom) < 1e-9) discard;
    float t = dot(uGlassN, uGlassO - uEye) / denom;
    if (t <= 0.0) discard;
    vec3 r = uEye + vDir * t - uGlassO;
    float u = dot(r, uGlassU) / dot(uGlassU, uGlassU);
    float v = dot(r, uGlassV) / dot(uGlassV, uGlassV);
    if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) discard;
  }
  gl_FragColor = vec4(vColor, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * cov, cov * uOpacity);
}
`;

export interface LineStyle {
  /** Linear HUD colour (may exceed 1 for bloom). */
  color: Color;
  /** Stroke width, drawing-buffer pixels. */
  lineWidth: number;
  /** How much a stroke hides what is behind it, 0 (purely additive) … 1 (opaque). */
  opacity: number;
}

const _m = new Matrix4();

export class HudLineBatch implements SegmentSink {
  readonly capacity: number;
  readonly data: Float32Array;
  readonly geometry: InstancedBufferGeometry;
  readonly material: ShaderMaterial;
  readonly mesh: Mesh;
  /** Segments written since `begin()`. */
  count = 0;
  /** Segments that did not fit this frame (should stay 0). */
  dropped = 0;
  /** Palette index of the strokes written next (0: the style's colour). */
  color = 0;
  private readonly buffer: InstancedInterleavedBuffer;
  private readonly range = { start: 0, count: 0 };

  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);

    const g = new InstancedBufferGeometry();
    // Quad corners: x = 0 at the start, 1 at the end; y = side (−1, +1).
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3),
    );
    g.setIndex(new Uint16BufferAttribute([0, 1, 2, 0, 2, 3], 1));
    g.setAttribute('aSeg', new InterleavedBufferAttribute(this.buffer, 4, 0));
    g.setAttribute('aStyle', new InterleavedBufferAttribute(this.buffer, 3, 4));
    g.instanceCount = 0;
    this.geometry = g;

    this.material = new ShaderMaterial({
      name: 'hud-lines',
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uViewport: { value: new Vector2(1280, 720) },
        uLineWidth: { value: 1.5 },
        uInvViewProj: { value: new Matrix4() },
        uPalette: { value: Array.from({ length: PALETTE_SIZE }, () => new Color(0.03, 1.2, 0.08)) },
        uOpacity: { value: 0.75 },
        uClip: { value: 0 },
        uEye: { value: new Vector3() },
        uGlassO: { value: new Vector3() },
        uGlassU: { value: new Vector3(1, 0, 0) },
        uGlassV: { value: new Vector3(0, -1, 0) },
        uGlassN: { value: new Vector3(0, 0, 1) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      // Stencil test against the glass mask (enabled per frame by `setStencilClip`).
      stencilWrite: true,
      stencilWriteMask: 0,
      stencilFunc: EqualStencilFunc,
      stencilRef: 1,
      stencilFuncMask: 0xff,
      stencilFail: KeepStencilOp,
      stencilZFail: KeepStencilOp,
      stencilZPass: KeepStencilOp,
    });

    this.mesh = new Mesh(g, this.material);
    this.mesh.name = 'hud-lines';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  begin(): void {
    this.count = 0;
    this.dropped = 0;
    this.color = 0;
  }

  seg(x0: number, y0: number, x1: number, y1: number, width = 1, intensity = 1): void {
    if (this.count >= this.capacity) {
      this.dropped++;
      return;
    }
    const o = this.count * STRIDE;
    const d = this.data;
    d[o] = x0;
    d[o + 1] = y0;
    d[o + 2] = x1;
    d[o + 3] = y1;
    d[o + 4] = width;
    d[o + 5] = intensity;
    d[o + 6] = this.color;
    this.count++;
  }

  /** Upload this frame's segments. */
  end(): void {
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count === 0) return;
    // Upload only what was written (a persistent range object: no allocation).
    this.range.start = 0;
    this.range.count = this.count * STRIDE;
    this.buffer.updateRanges.length = 0;
    this.buffer.updateRanges.push(this.range);
    this.buffer.needsUpdate = true;
  }

  /** Per-frame uniforms: viewport (px), style, and the camera's inverse view-projection. */
  setFrame(width: number, height: number, style: LineStyle, camera: Camera): void {
    const u = this.material.uniforms;
    (u.uViewport.value as Vector2).set(width, height);
    u.uLineWidth.value = style.lineWidth;
    (u.uPalette.value as Color[])[0].copy(style.color);
    u.uOpacity.value = style.opacity;
    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    (u.uInvViewProj.value as Matrix4).copy(_m);
  }

  /**
   * Clip with the stencil mask of the glass (true), or with the analytic glass test from the
   * head position `eye` (false; for targets without a stencil buffer).
   */
  setClip(useStencil: boolean, eye: Vector3, glass: GlassCorners): void {
    const u = this.material.uniforms;
    this.material.stencilWrite = useStencil;
    u.uClip.value = useStencil ? 0 : 1;
    if (useStencil) return;
    (u.uEye.value as Vector3).copy(eye);
    const o = glass[0];
    (u.uGlassO.value as Vector3).set(o.x, o.y, o.z);
    (u.uGlassU.value as Vector3).set(glass[1].x - o.x, glass[1].y - o.y, glass[1].z - o.z);
    (u.uGlassV.value as Vector3).set(glass[3].x - o.x, glass[3].y - o.y, glass[3].z - o.z);
    (u.uGlassN.value as Vector3)
      .crossVectors(u.uGlassU.value as Vector3, u.uGlassV.value as Vector3)
      .normalize();
  }

  /** Palette colour `index` (linear; 1..PALETTE_SIZE-1 for the displays' colours). */
  setPaletteColor(index: number, color: Color): void {
    (this.material.uniforms.uPalette.value as Color[])[index].copy(color);
  }

  /** No clipping at all (the displays draw into their own render target). */
  setNoClip(): void {
    this.material.stencilWrite = false;
    this.material.uniforms.uClip.value = 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
