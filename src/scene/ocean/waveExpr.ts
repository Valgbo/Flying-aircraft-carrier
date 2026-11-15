/**
 * The wave maths of the ocean surface, written ONCE and evaluated two ways.
 *
 * `waveDisplacementExpr` (vertex stage) and `waveSurfaceExpr` (fragment stage) describe the
 * surface as expression trees over an abstract backend. The GLSL backend turns them into the
 * shader functions the ocean material compiles; the numeric backend evaluates the very same
 * trees in TypeScript (`evalWaveDisplacement`, `evalWaveSurface`). Because both come from one
 * definition and one table (`WAVES` in src/config/waves.ts), the GPU surface cannot drift away
 * from what tests/unit/waves.test.ts checks against `waveHeightAt`.
 *
 * Coordinates are OCEAN-LOCAL: world axes, origin at the (snapped) centre of the ocean mesh.
 * The world offset and the time live in the per-wave phase uniforms, computed in double
 * precision on the CPU (`computeWavePhases`), so the shader never sees a large number however
 * far the ship has flown or however long the session has run.
 *
 * Surface model (per component i, θ = k·(d·p) + phase):
 *   height      Σ aᵢ sin θᵢ                      — identical to waveHeightAt
 *   horizontal  Σ sᵢ aᵢ dᵢ cos θᵢ                — Gerstner sway (sᵢ = steepness), pulls water
 *                                                   toward the crests and sharpens them
 * APPROXIMATION: because of the sway, the surface above a world point p is the height of a
 * rest point up to Σ sᵢaᵢ (≈ 1.2 m) away. With slopes of a few percent that changes the height
 * above p by at most Σ sᵢ aᵢ · kᵢ aᵢ ≈ 3 cm (`GERSTNER_HEIGHT_ERROR`), far inside the 0.3 m
 * the hull needs to look seated in the water.
 */
import { WAVES, waveOmega } from '../../config/waves';

export const WAVE_COUNT = WAVES.length;

/**
 * A wave component is drawn at full amplitude while the mesh gives it at least this many cells
 * per wavelength, and not at all below `VERTEX_MIN_SAMPLES` (just above Nyquist). In between
 * it fades, so coarse far-away cells never try to carry a wave they would alias.
 */
export const VERTEX_FULL_SAMPLES = 6;
export const VERTEX_MIN_SAMPLES = 2.5;

/**
 * Fragment-stage band limit: a component keeps its full slope while the pixel footprint along
 * its direction of travel is under this fraction of a wavelength and is gone at
 * `PIXEL_FADE_END` wavelengths (where a box filter over the pixel has its first zero).
 */
export const PIXEL_FADE_START = 0.25;
export const PIXEL_FADE_END = 1;

export interface WaveTerm {
  dirX: number;
  dirZ: number;
  wavelength: number;
  amplitude: number;
  /** Wave-vector components, rad/m. */
  kx: number;
  kz: number;
  /** Angular frequency, rad/s. */
  omega: number;
  /** Amplitude of the horizontal Gerstner sway, m. */
  sway: number;
  /** Share of this component in the whitecap crest measure (the weights sum to 1). */
  crestWeight: number;
}

function buildTerms(): WaveTerm[] {
  const raw = WAVES.map((w) => {
    const k = (2 * Math.PI) / w.wavelength;
    return {
      dirX: w.dirX,
      dirZ: w.dirZ,
      wavelength: w.wavelength,
      amplitude: w.amplitude,
      kx: k * w.dirX,
      kz: k * w.dirZ,
      omega: waveOmega(w.wavelength),
      sway: w.steepness * w.amplitude,
      // the surface compression at a crest is proportional to steepness · k · a
      crestWeight: w.steepness * k * w.amplitude,
    };
  });
  const total = raw.reduce((sum, t) => sum + t.crestWeight, 0);
  return raw.map((t) => ({ ...t, crestWeight: t.crestWeight / total }));
}

export const WAVE_TERMS: readonly WaveTerm[] = buildTerms();

/** Upper bound of the height error the Gerstner sway introduces above a fixed world point, m. */
export const GERSTNER_HEIGHT_ERROR = WAVE_TERMS.reduce(
  (sum, t) => sum + t.sway * Math.hypot(t.kx, t.kz) * t.amplitude,
  0,
);

const TAU = Math.PI * 2;

/**
 * Phase of every component at the ocean-local origin: kᵢ·centre − ωᵢ·t, wrapped to [-π, π).
 * Evaluated in double precision; the result is what the `uWavePhase` uniform array carries.
 */
export function computeWavePhases(
  centerX: number,
  centerZ: number,
  time: number,
  out: Float32Array | number[],
): void {
  for (let i = 0; i < WAVE_COUNT; i++) {
    const t = WAVE_TERMS[i];
    const phase = t.kx * centerX + t.kz * centerZ - t.omega * time;
    out[i] = phase - TAU * Math.floor(phase / TAU + 0.5);
  }
}

// ---------------------------------------------------------------------------------------------
// Expression backends
// ---------------------------------------------------------------------------------------------

/** The handful of operations the wave expressions need. `T` is a number or a GLSL snippet. */
export interface ExprBackend<T> {
  num(value: number): T;
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  mul(a: T, b: T): T;
  div(a: T, b: T): T;
  sin(a: T): T;
  cos(a: T): T;
  abs(a: T): T;
  /** 1 − smoothstep(edge0, edge1, x): 1 below edge0, 0 above edge1. */
  fadeOut(edge0: number, edge1: number, x: T): T;
  /** Name an intermediate value so it is evaluated once (a local variable in GLSL). */
  bind(name: string, value: T): T;
}

const numeric: ExprBackend<number> = {
  num: (value) => value,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  sin: Math.sin,
  cos: Math.cos,
  abs: Math.abs,
  fadeOut: (edge0, edge1, x) => {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return 1 - t * t * (3 - 2 * t);
  },
  bind: (_name, value) => value,
};

/** Format a number as a GLSL float literal. */
export function glslFloat(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`cannot write ${value} as a GLSL float`);
  let text = String(Number(value.toPrecision(9)));
  if (!/[.e]/.test(text)) text += '.0';
  return value < 0 ? `(${text})` : text;
}

class GlslBackend implements ExprBackend<string> {
  private readonly statements: string[] = [];

  num(value: number): string {
    return glslFloat(value);
  }
  add(a: string, b: string): string {
    return `(${a} + ${b})`;
  }
  sub(a: string, b: string): string {
    return `(${a} - ${b})`;
  }
  mul(a: string, b: string): string {
    return `(${a} * ${b})`;
  }
  div(a: string, b: string): string {
    return `(${a} / ${b})`;
  }
  sin(a: string): string {
    return `sin(${a})`;
  }
  cos(a: string): string {
    return `cos(${a})`;
  }
  abs(a: string): string {
    return `abs(${a})`;
  }
  fadeOut(edge0: number, edge1: number, x: string): string {
    return `(1.0 - smoothstep(${glslFloat(edge0)}, ${glslFloat(edge1)}, ${x}))`;
  }
  bind(name: string, value: string): string {
    this.statements.push(`  float ${name} = ${value};`);
    return name;
  }
  body(): string {
    return this.statements.join('\n');
  }
}

// ---------------------------------------------------------------------------------------------
// Vertex stage: displacement of a rest point
// ---------------------------------------------------------------------------------------------

export interface DisplacementInputs<T> {
  /** Rest position, ocean-local, m. */
  x: T;
  z: T;
  /** Size of the mesh cells around the vertex, m (0 = infinitely fine). */
  cell: T;
  phase(index: number): T;
}

export interface Displacement<T> {
  /** Horizontal Gerstner sway, m. */
  offsetX: T;
  offsetZ: T;
  /** Height above mean sea level, m. */
  height: T;
}

export function waveDisplacementExpr<T>(
  b: ExprBackend<T>,
  input: DisplacementInputs<T>,
): Displacement<T> {
  let offsetX = b.num(0);
  let offsetZ = b.num(0);
  let height = b.num(0);
  WAVE_TERMS.forEach((w, i) => {
    const theta = b.bind(
      `theta${i}`,
      b.add(b.add(b.mul(b.num(w.kx), input.x), b.mul(b.num(w.kz), input.z)), input.phase(i)),
    );
    const keep = b.bind(
      `keep${i}`,
      b.fadeOut(w.wavelength / VERTEX_FULL_SAMPLES, w.wavelength / VERTEX_MIN_SAMPLES, input.cell),
    );
    height = b.add(height, b.mul(b.mul(b.num(w.amplitude), keep), b.sin(theta)));
    const sway = b.bind(`sway${i}`, b.mul(b.mul(b.num(w.sway), keep), b.cos(theta)));
    offsetX = b.add(offsetX, b.mul(b.num(w.dirX), sway));
    offsetZ = b.add(offsetZ, b.mul(b.num(w.dirZ), sway));
  });
  return { offsetX, offsetZ, height };
}

/** TypeScript evaluation of exactly what the vertex shader computes for a rest point. */
export function evalWaveDisplacement(
  x: number,
  z: number,
  cell: number,
  phases: ArrayLike<number>,
): Displacement<number> {
  return waveDisplacementExpr(numeric, { x, z, cell, phase: (i) => phases[i] });
}

/**
 * GLSL: `vec3 oceanWaveDisplacement(vec2 p, float cell)` → (sway x, height, sway z).
 * Needs `uniform float uWavePhase[WAVE_COUNT]`.
 */
export function waveDisplacementGLSL(): string {
  const g = new GlslBackend();
  const d = waveDisplacementExpr(g, {
    x: 'p.x',
    z: 'p.y',
    cell: 'cell',
    phase: (i) => `uWavePhase[${i}]`,
  });
  return [
    'vec3 oceanWaveDisplacement(vec2 p, float cell) {',
    g.body(),
    `  return vec3(${d.offsetX}, ${d.height}, ${d.offsetZ});`,
    '}',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Fragment stage: slope of the displaced surface and the whitecap crest measure
// ---------------------------------------------------------------------------------------------

export interface SurfaceInputs<T> {
  /** Rest position, ocean-local, m. */
  x: T;
  z: T;
  phase(index: number): T;
  /** Change of the rest position across one pixel horizontally (du) and vertically (dv), m. */
  dux: T;
  duz: T;
  dvx: T;
  dvz: T;
  /** Extra amplitude factor per component (far-field irregularity, calm patches); 1 = none. */
  gain(index: number): T;
}

export interface Surface<T> {
  /** World-space slope of the surface, ∂height/∂x and ∂height/∂z, sway included. */
  slopeX: T;
  slopeZ: T;
  /** −1..1: how close the components are to cresting together here (drives whitecaps). */
  crest: T;
}

export function waveSurfaceExpr<T>(b: ExprBackend<T>, input: SurfaceInputs<T>): Surface<T> {
  // Derivatives of the displaced point P(x0, z0) with respect to the rest coordinates:
  //   ∂P/∂x0 = (1 − jxx, hx, −jxz)      ∂P/∂z0 = (−jxz, hz, 1 − jzz)
  let hx = b.num(0);
  let hz = b.num(0);
  let jxx = b.num(0);
  let jzz = b.num(0);
  let jxz = b.num(0);
  let crest = b.num(0);
  WAVE_TERMS.forEach((w, i) => {
    const theta = b.bind(
      `theta${i}`,
      b.add(b.add(b.mul(b.num(w.kx), input.x), b.mul(b.num(w.kz), input.z)), input.phase(i)),
    );
    const footprint = b.add(
      b.abs(b.add(b.mul(b.num(w.dirX), input.dux), b.mul(b.num(w.dirZ), input.duz))),
      b.abs(b.add(b.mul(b.num(w.dirX), input.dvx), b.mul(b.num(w.dirZ), input.dvz))),
    );
    const gain = b.bind(
      `gain${i}`,
      b.mul(
        b.fadeOut(PIXEL_FADE_START * w.wavelength, PIXEL_FADE_END * w.wavelength, footprint),
        input.gain(i),
      ),
    );
    const s = b.bind(`s${i}`, b.mul(gain, b.sin(theta)));
    const c = b.bind(`c${i}`, b.mul(gain, b.cos(theta)));
    hx = b.add(hx, b.mul(b.num(w.amplitude * w.kx), c));
    hz = b.add(hz, b.mul(b.num(w.amplitude * w.kz), c));
    jxx = b.add(jxx, b.mul(b.num(w.sway * w.kx * w.dirX), s));
    jzz = b.add(jzz, b.mul(b.num(w.sway * w.kz * w.dirZ), s));
    jxz = b.add(jxz, b.mul(b.num(w.sway * w.kx * w.dirZ), s));
    crest = b.add(crest, b.mul(b.num(w.crestWeight), s));
  });
  const hxB = b.bind('hx', hx);
  const hzB = b.bind('hz', hz);
  const jxzB = b.bind('jxz', jxz);
  const ax = b.bind('ax', b.sub(b.num(1), jxx));
  const az = b.bind('az', b.sub(b.num(1), jzz));
  // normal ∝ ∂P/∂z0 × ∂P/∂x0; dividing its horizontal parts by −(its vertical part) gives the slope
  const det = b.bind('det', b.sub(b.mul(ax, az), b.mul(jxzB, jxzB)));
  return {
    slopeX: b.div(b.add(b.mul(hxB, az), b.mul(hzB, jxzB)), det),
    slopeZ: b.div(b.add(b.mul(hzB, ax), b.mul(hxB, jxzB)), det),
    crest,
  };
}

/** TypeScript evaluation of the fragment-stage surface at full resolution (no pixel filter). */
export function evalWaveSurface(x: number, z: number, phases: ArrayLike<number>): Surface<number> {
  return waveSurfaceExpr(numeric, {
    x,
    z,
    phase: (i) => phases[i],
    dux: 0,
    duz: 0,
    dvx: 0,
    dvz: 0,
    gain: () => 1,
  });
}

/**
 * GLSL: `vec3 oceanWaveSurface(vec2 p, vec2 du, vec2 dv, vec2 gain)` → (slope x, slope z, crest).
 * `gain.x` scales the even components and `gain.y` the odd ones, so two independent noise
 * values can make neighbouring wavelengths wax and wane separately.
 * Needs `uniform float uWavePhase[WAVE_COUNT]`.
 */
export function waveSurfaceGLSL(): string {
  const g = new GlslBackend();
  const s = waveSurfaceExpr(g, {
    x: 'p.x',
    z: 'p.y',
    phase: (i) => `uWavePhase[${i}]`,
    dux: 'du.x',
    duz: 'du.y',
    dvx: 'dv.x',
    dvz: 'dv.y',
    gain: (i) => (i % 2 === 0 ? 'gain.x' : 'gain.y'),
  });
  return [
    'vec3 oceanWaveSurface(vec2 p, vec2 du, vec2 dv, vec2 gain) {',
    g.body(),
    `  return vec3(${s.slopeX}, ${s.slopeZ}, ${s.crest});`,
    '}',
  ].join('\n');
}
