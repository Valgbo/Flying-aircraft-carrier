/**
 * Sounds made in code, for everything no free recording covers: explosions, 30 mm impacts,
 * the crack of supersonic rounds, fire, rocket motors, and the airframe response that turns
 * the gun's pulse train into the "BRRRT" the pilot feels. Plain Float32Array generators,
 * seeded (the same buffer every time), no Web Audio: unit-testable, and the engine wraps them
 * in AudioBuffers once.
 */
import { mulberry32 } from '../../engine';
import type { ImpactKind } from './propagation';

export type Rng = () => number;

/** RBJ-cookbook biquad run in place over `x` (state carried across the call). */
export function biquadInPlace(
  x: Float32Array,
  sr: number,
  type: 'lowpass' | 'highpass' | 'bandpass',
  f0: number,
  q = Math.SQRT1_2,
  from = 0,
  to = x.length,
): Float32Array {
  const w0 = (2 * Math.PI * Math.min(f0, sr * 0.45)) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0: number;
  let b1: number;
  let b2: number;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = from; i < to; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    x[i] = v;
  }
  return x;
}

/**
 * A band-pass whose centre frequency follows `freqAt(t)` (s → Hz), retuned every 32 samples
 * with its state carried over (so the sweep is smooth, with no restart transients).
 */
export function sweptBandpass(
  x: Float32Array,
  sr: number,
  freqAt: (t: number) => number,
  q: number,
): Float32Array {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let b0 = 0;
  let b2 = 0;
  let a0 = 1;
  let a1 = 0;
  let a2 = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % 32 === 0) {
      const w0 = (2 * Math.PI * Math.min(freqAt(i / sr), sr * 0.45)) / sr;
      const alpha = Math.sin(w0) / (2 * q);
      b0 = alpha;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * Math.cos(w0);
      a2 = 1 - alpha;
    }
    const v = (b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    x[i] = v;
  }
  return x;
}

/**
 * Filter a loop so that it stays seamless: run the filter over two periods and keep the second,
 * whose start sees the state the end of the first left (steady state for any filter that decays
 * well within one period).
 */
export function loopFilter(
  x: Float32Array,
  sr: number,
  type: 'lowpass' | 'highpass' | 'bandpass',
  f0: number,
  q?: number,
): Float32Array {
  const n = x.length;
  const two = new Float32Array(2 * n);
  two.set(x, 0);
  two.set(x, n);
  biquadInPlace(two, sr, type, f0, q);
  x.set(two.subarray(n));
  return x;
}

export function peakOf(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}

export function rmsOf(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Scale to a peak of `peak` (default 0.9, about −1 dBFS). */
export function normalise(x: Float32Array, peak = 0.9): Float32Array {
  const p = peakOf(x);
  if (p > 0) {
    const g = peak / p;
    for (let i = 0; i < x.length; i++) x[i] *= g;
  }
  return x;
}

function whiteNoise(n: number, rng: Rng, amp = 1): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (rng() * 2 - 1) * amp;
  return x;
}

/** Brown noise (leaky integrated white noise), DC-free, peak ≈ 1. */
function brownNoise(n: number, rng: Rng): Float32Array {
  const x = new Float32Array(n);
  let w = 0;
  for (let i = 0; i < n; i++) {
    w = w * 0.998 + (rng() * 2 - 1) * 0.05;
    x[i] = w;
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= Math.max(1, n);
  for (let i = 0; i < n; i++) x[i] -= mean;
  return normalise(x, 1);
}

/** Add a·exp(−t/τ) · sin(phase(t)) for a frequency gliding exponentially from f0 to f1. */
function addSweptDecay(
  out: Float32Array,
  sr: number,
  start: number,
  f0: number,
  f1: number,
  tau: number,
  amp: number,
  glide = tau,
): void {
  const n = Math.min(out.length - start, Math.ceil(tau * 9 * sr));
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / glide);
    phase += (2 * Math.PI * f) / sr;
    out[start + i] += amp * Math.exp(-t / tau) * Math.sin(phase);
  }
}

/** Multiply in place by an attack-then-exponential-decay envelope (attack s, decay τ s). */
function envelope(x: Float32Array, sr: number, attack: number, tau: number, delay = 0): void {
  const d = Math.round(delay * sr);
  const a = Math.max(1, Math.round(attack * sr));
  for (let i = 0; i < x.length; i++) {
    const k = i - d;
    if (k < 0) x[i] = 0;
    else if (k < a) x[i] *= k / a;
    else x[i] *= Math.exp(-(k - a) / sr / tau);
  }
}

/** A sharp N-wave (the pressure signature of a shock), `ms` long, added at `start`. */
function addNWave(out: Float32Array, sr: number, start: number, ms: number, amp: number): void {
  const n = Math.max(2, Math.round((ms / 1000) * sr));
  for (let i = 0; i < n && start + i < out.length; i++)
    out[start + i] += amp * (1 - (2 * i) / (n - 1));
}

function mix(out: Float32Array, src: Float32Array, gain: number, offset = 0): void {
  const n = Math.min(src.length, out.length - offset);
  for (let i = 0; i < n; i++) out[offset + i] += src[i] * gain;
}

// ---- the gun ------------------------------------------------------------------------------

/**
 * Fourier coefficients (cosine series) of a band-limited pulse for a PeriodicWave: one click
 * per cycle, so an oscillator at the firing rate gives one pulse per round. Harmonics roll off
 * above the 24th (≈1.5 kHz at 65 rounds/s): the airframe filter does the rest.
 */
export function pulseWaveCoefficients(harmonics = 96): { real: Float32Array; imag: Float32Array } {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) real[k] = 1 / (1 + (k / 24) * (k / 24));
  return { real, imag };
}

/**
 * Coefficients of the low growl heard from afar: one cycle per round, only the first six
 * harmonics (65–390 Hz at full rate), so after normalisation the energy sits where distance
 * leaves it.
 */
export function growlWaveCoefficients(): { real: Float32Array; imag: Float32Array } {
  const real = new Float32Array(7);
  const imag = new Float32Array(7);
  for (let k = 1; k <= 6; k++) real[k] = 1 / Math.pow(k, 0.7);
  return { real, imag };
}

/** Airframe modes the gun excites: frequency (Hz), decay time constant (s), amplitude. */
export const AIRFRAME_MODES: readonly (readonly [number, number, number])[] = [
  [31, 0.11, 1.0],
  [47, 0.09, 0.85],
  [66, 0.08, 0.95],
  [89, 0.06, 0.6],
  [128, 0.045, 0.5],
  [171, 0.035, 0.38],
  [236, 0.025, 0.28],
  [330, 0.018, 0.2],
  [470, 0.012, 0.12],
];

/**
 * Impulse response of the airframe between the gun and the pilot: a knock (a short noise burst)
 * and the ringing of a few structural modes, 0.35 s. Convolved with the pulse train it gives
 * each round its thump and the 65 Hz growl its body. Normalised to unit energy.
 */
export function airframeImpulse(sr: number, seed = 0xa10f): Float32Array {
  const rng = mulberry32(seed);
  const n = Math.round(0.35 * sr);
  const ir = new Float32Array(n);
  for (const [f, tau, amp] of AIRFRAME_MODES) {
    const phase = rng() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      ir[i] += amp * Math.exp(-t / tau) * Math.sin(2 * Math.PI * f * t + phase);
    }
  }
  const knock = Math.round(0.004 * sr);
  for (let i = 0; i < knock; i++) ir[i] += (rng() * 2 - 1) * 0.6 * Math.exp(-i / (0.0012 * sr));
  // a 1 ms fade-in so the response itself never clicks
  const fade = Math.round(0.001 * sr);
  for (let i = 0; i < fade; i++) ir[i] *= i / fade;
  let e = 0;
  for (let i = 0; i < n; i++) e += ir[i] * ir[i];
  const g = 1 / Math.sqrt(e || 1);
  for (let i = 0; i < n; i++) ir[i] *= g;
  return ir;
}

/**
 * The echo of open ground and tree lines that a burst heard from outside rolls off into: a few
 * discrete reflections between 70 and 300 ms and a dull diffuse tail, 1.4 s. Unit energy.
 */
export function terrainEchoImpulse(sr: number, seed = 0xec40): Float32Array {
  const rng = mulberry32(seed);
  const n = Math.round(1.4 * sr);
  const ir = new Float32Array(n);
  for (const [t, a] of [
    [0.072, 0.55],
    [0.118, 0.4],
    [0.171, 0.35],
    [0.236, 0.28],
    [0.302, 0.22],
  ]) {
    const at = Math.round(t * sr);
    const len = Math.round(0.006 * sr);
    for (let i = 0; i < len; i++) ir[at + i] += a * (rng() * 2 - 1) * Math.exp(-i / (len * 0.3));
  }
  const tail = whiteNoise(n, rng);
  envelope(tail, sr, 0.15, 0.32, 0.06);
  mix(ir, tail, 0.12);
  biquadInPlace(ir, sr, 'lowpass', 1800, 0.6);
  biquadInPlace(ir, sr, 'highpass', 60);
  let e = 0;
  for (let i = 0; i < n; i++) e += ir[i] * ir[i];
  const g = 1 / Math.sqrt(e || 1);
  for (let i = 0; i < n; i++) ir[i] *= g;
  return ir;
}

/**
 * The crack of a supersonic 30 mm round passing nearby: a 0.5 ms N-wave, its echo off the
 * ground a few milliseconds later, and a short hiss of air. 80 ms.
 */
export function renderCrack(sr: number, seed = 0xc4ac): Float32Array {
  const rng = mulberry32(seed);
  const out = new Float32Array(Math.round(0.08 * sr));
  addNWave(out, sr, Math.round(0.001 * sr), 0.5, 1);
  addNWave(out, sr, Math.round(0.0062 * sr), 0.6, -0.45);
  const tail = whiteNoise(out.length, rng, 0.25);
  biquadInPlace(tail, sr, 'highpass', 1800);
  envelope(tail, sr, 0.0008, 0.012, 0.001);
  mix(out, tail, 1);
  return normalise(out);
}

// ---- impacts ------------------------------------------------------------------------------

/**
 * One 30 mm impact, by what was hit:
 *  armour    API on steel: a sharp metallic crack and the ring of the plate
 *  hei       HEI burst: a small, hard bang
 *  ground    a thud and a spray of dirt
 *  water     a splash
 *  ricochet  a crack and the whirr of a round tumbling away
 */
export function renderImpact(sr: number, kind: ImpactKind, seed = 1): Float32Array {
  const rng = mulberry32(0x1a9c7 + seed * 7919);
  switch (kind) {
    case 'armour': {
      const out = new Float32Array(Math.round(0.3 * sr));
      addNWave(out, sr, 1, 0.25, 1);
      const partials = [1180, 2140, 3330, 4760, 6420, 8150];
      partials.forEach((f, k) => {
        addSweptDecay(
          out,
          sr,
          1,
          f * (0.97 + 0.06 * rng()),
          f,
          0.06 / (1 + k * 0.5),
          0.35 / (1 + k * 0.3),
        );
      });
      const hiss = whiteNoise(out.length, rng, 0.8);
      biquadInPlace(hiss, sr, 'highpass', 1500);
      envelope(hiss, sr, 0.0003, 0.012);
      mix(out, hiss, 1);
      return normalise(out);
    }
    case 'hei':
      return renderExplosion(sr, 'small', seed);
    case 'water': {
      const out = whiteNoise(Math.round(0.55 * sr), rng);
      biquadInPlace(out, sr, 'bandpass', 900, 0.5);
      biquadInPlace(out, sr, 'lowpass', 4000);
      envelope(out, sr, 0.006, 0.12);
      // the plume falling back: a second, softer wash
      const back = whiteNoise(out.length, rng, 0.4);
      biquadInPlace(back, sr, 'bandpass', 1600, 0.7);
      envelope(back, sr, 0.05, 0.12, 0.18);
      mix(out, back, 1);
      return normalise(out);
    }
    case 'ricochet': {
      const out = new Float32Array(Math.round(0.4 * sr));
      addNWave(out, sr, 1, 0.3, 0.8);
      const f0 = 2600 + 1200 * rng();
      let phase = 0;
      for (let i = Math.round(0.004 * sr); i < out.length; i++) {
        const t = i / sr;
        const f = f0 * (0.55 + 0.45 * Math.exp(-t / 0.15));
        phase += (2 * Math.PI * f) / sr;
        const wobble = 0.75 + 0.25 * Math.sin(2 * Math.PI * 38 * t);
        out[i] += 0.45 * wobble * Math.exp(-t / 0.09) * Math.sin(phase);
      }
      return normalise(out);
    }
    case 'ground':
    default: {
      const out = new Float32Array(Math.round(0.5 * sr));
      addNWave(out, sr, 1, 0.4, 0.5);
      const thud = whiteNoise(out.length, rng);
      biquadInPlace(thud, sr, 'lowpass', 700);
      envelope(thud, sr, 0.001, 0.035);
      mix(out, thud, 1.6);
      addSweptDecay(out, sr, 1, 140, 70, 0.03, 0.7);
      // dirt and stones coming down
      const grains = Math.round(14 + rng() * 10);
      for (let g = 0; g < grains; g++) {
        const at = Math.round((0.06 + 0.35 * Math.pow(rng(), 1.6)) * sr);
        const len = Math.round((0.002 + 0.006 * rng()) * sr);
        const amp = 0.25 * (1 - at / out.length) * (0.3 + rng());
        for (let i = 0; i < len && at + i < out.length; i++) {
          out[at + i] += amp * (rng() * 2 - 1) * Math.exp(-i / (len * 0.3));
        }
      }
      biquadInPlace(out, sr, 'highpass', 40);
      return normalise(out);
    }
  }
}

// ---- explosions ---------------------------------------------------------------------------

export type BlastSize = 'small' | 'medium' | 'large' | 'huge';

interface BlastRecipe {
  seconds: number;
  /** Initial shock (N-wave) length, ms. */
  shockMs: number;
  /** Thump: start and end frequency (Hz), decay τ (s). */
  thump: [number, number, number];
  /** Body: low-pass (Hz), decay τ (s). */
  body: [number, number];
  /** Rolling rumble: low-pass (Hz), decay τ (s), level. */
  rumble: [number, number, number];
  /** Debris pops. */
  debris: number;
}

const BLASTS: Record<BlastSize, BlastRecipe> = {
  // a 30 mm HEI shell (≈50 g of explosive)
  small: {
    seconds: 0.45,
    shockMs: 0.5,
    thump: [190, 95, 0.035],
    body: [3500, 0.05],
    rumble: [300, 0.12, 0.25],
    debris: 0,
  },
  // a rocket warhead (≈4 kg)
  medium: {
    seconds: 1.8,
    shockMs: 1.4,
    thump: [115, 45, 0.11],
    body: [1600, 0.2],
    rumble: [160, 0.55, 0.5],
    debris: 10,
  },
  // a Mk-82 or a Maverick (50–100 kg)
  large: {
    seconds: 4.2,
    shockMs: 3.5,
    thump: [72, 27, 0.28],
    body: [700, 0.55],
    rumble: [120, 1.3, 0.75],
    debris: 26,
  },
  // an ammunition or fuel truck going up
  huge: {
    seconds: 5.8,
    shockMs: 5.5,
    thump: [58, 22, 0.42],
    body: [480, 0.85],
    rumble: [100, 1.9, 0.9],
    debris: 40,
  },
};

/**
 * An explosion as heard nearby (distance is added at play time: absorption, delay, level).
 * A shock (N-wave), a falling thump, a noisy body, a rolling rumble that swells and fades like
 * the echoes of a real blast, and debris pops. Bigger blasts are lower, longer and rumblier.
 */
export function renderExplosion(sr: number, size: BlastSize, seed = 1): Float32Array {
  const r = BLASTS[size];
  const rng = mulberry32(0xb1a57 + seed * 104729 + size.length * 31);
  const n = Math.round(r.seconds * sr);
  const out = new Float32Array(n);
  addNWave(out, sr, Math.round(0.0005 * sr), r.shockMs, 1);
  addSweptDecay(
    out,
    sr,
    Math.round(0.001 * sr),
    r.thump[0],
    r.thump[1],
    r.thump[2],
    1.1,
    r.thump[2] * 0.6,
  );
  const body = whiteNoise(n, rng);
  biquadInPlace(body, sr, 'lowpass', r.body[0], 0.6);
  biquadInPlace(body, sr, 'lowpass', r.body[0] * 1.5, 0.6);
  envelope(body, sr, 0.002, r.body[1]);
  mix(out, body, 1.4);
  const rumble = brownNoise(n, rng);
  biquadInPlace(rumble, sr, 'lowpass', r.rumble[0], 0.7);
  // slow random swells: the rolling echo of a blast over ground
  let swell = 0.6;
  let target = 1;
  const step = Math.max(1, Math.round(0.08 * sr));
  for (let i = 0; i < n; i++) {
    if (i % step === 0) target = 0.35 + 0.9 * rng();
    swell += (target - swell) * (1 / (0.15 * sr));
    const t = i / sr;
    const env = (1 - Math.exp(-t / 0.03)) * Math.exp(-t / r.rumble[1]);
    rumble[i] *= env * swell;
  }
  mix(out, normalise(rumble, 1), r.rumble[2]);
  for (let k = 0; k < r.debris; k++) {
    const at = Math.round((0.15 + Math.pow(rng(), 1.8) * (r.seconds - 0.4)) * sr);
    const len = Math.round((0.002 + 0.01 * rng()) * sr);
    const amp = 0.18 * (0.3 + rng()) * Math.exp(-at / sr / (r.seconds * 0.45));
    for (let i = 0; i < len && at + i < n; i++) {
      out[at + i] += amp * (rng() * 2 - 1) * Math.exp(-i / (len * 0.25));
    }
  }
  biquadInPlace(out, sr, 'highpass', 18);
  // no click at the end
  const fade = Math.round(0.05 * sr);
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  return normalise(out);
}

// ---- continuous sources -------------------------------------------------------------------

/**
 * Fire: the low roar of burning fuel and the pops and crackle of what burns. A seamless loop of
 * `seconds`.
 */
export function renderCrackle(sr: number, seconds = 2.5, seed = 0xf12e): Float32Array {
  const rng = mulberry32(seed);
  const n = Math.round(seconds * sr);
  const roar = brownNoise(n, rng);
  loopFilter(roar, sr, 'lowpass', 380, 0.6);
  normalise(roar, 0.35);
  const out = new Float32Array(n);
  mix(out, roar, 1);
  const pops = Math.round(seconds * 28);
  for (let k = 0; k < pops; k++) {
    const at = Math.floor(rng() * n);
    const len = Math.round((0.0008 + 0.004 * rng()) * sr);
    const amp = 0.08 + 0.6 * Math.pow(rng(), 3);
    for (let i = 0; i < len; i++) {
      // wraps around the loop end, so the seam is as busy as the rest
      out[(at + i) % n] += amp * (rng() * 2 - 1) * Math.exp(-i / (len * 0.3));
    }
  }
  loopFilter(out, sr, 'highpass', 50);
  return normalise(out);
}

/** A rocket motor burning: a rough, bright roar. A seamless loop of `seconds`. */
export function renderMotor(sr: number, seconds = 1.5, seed = 0x307e): Float32Array {
  const rng = mulberry32(seed);
  const n = Math.round(seconds * sr);
  const out = whiteNoise(n, rng);
  loopFilter(out, sr, 'bandpass', 900, 0.5);
  loopFilter(out, sr, 'lowpass', 5000);
  // roughness: a random amplitude flutter at 30–80 Hz, generated periodic over the loop
  const flutter = whiteNoise(n, rng);
  loopFilter(flutter, sr, 'lowpass', 60, 0.7);
  normalise(flutter, 1);
  for (let i = 0; i < n; i++) out[i] *= 0.7 + 0.3 * flutter[i];
  return normalise(out);
}

/** A launch: an ignition crack and a whoosh that rises and fades as the round leaves. 1.2 s. */
export function renderWhoosh(sr: number, seed = 0x5005): Float32Array {
  const rng = mulberry32(seed);
  const n = Math.round(1.2 * sr);
  const out = new Float32Array(n);
  addNWave(out, sr, 1, 0.8, 0.7);
  const noise = whiteNoise(n, rng);
  // a band-pass whose centre sweeps up with the motor and back down as it goes
  const swept = Float32Array.from(noise);
  sweptBandpass(swept, sr, (t) => 500 + 2200 * (1 - Math.exp(-t / 0.12)) * Math.exp(-t / 0.9), 0.9);
  mix(out, swept, 1.5);
  const body = new Float32Array(n);
  mix(body, noise, 1);
  biquadInPlace(body, sr, 'lowpass', 600);
  mix(out, body, 0.8);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] *= Math.min(1, t / 0.02) * Math.exp(-t / 0.45);
  }
  biquadInPlace(out, sr, 'lowpass', 7000);
  return normalise(out);
}

/**
 * A motor lighting, as heard nearby (the follower loop carries the burn after it): for a Hydra 70
 * a crack and a ripping hiss that rises in pitch and fades within a second as the rocket leaves
 * at 700 m/s; for a Maverick a deep thump and a heavier roar of its larger motor leaving the
 * rail, fading over two seconds. Seeded: the same buffer every time.
 */
export function renderLaunch(sr: number, kind: 'rocket' | 'missile', seed = 0x1a0c): Float32Array {
  const rocket = kind === 'rocket';
  const rng = mulberry32(seed + (rocket ? 1 : 2));
  const seconds = rocket ? 1.1 : 2.8;
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  // ignition: a short shock and a low thump
  addNWave(out, sr, 1, rocket ? 0.6 : 1.2, rocket ? 0.8 : 0.6);
  addSweptDecay(out, sr, 1, rocket ? 140 : 95, rocket ? 60 : 40, rocket ? 0.05 : 0.12, 0.7);
  // the motor's roar: noise through a band that rises as the gas speeds up, then falls away
  const noise = whiteNoise(n, rng);
  const roar = Float32Array.from(noise);
  const f0 = rocket ? 700 : 380;
  const f1 = rocket ? 3200 : 1400;
  const rise = rocket ? 0.05 : 0.12;
  const away = rocket ? 0.55 : 1.6;
  sweptBandpass(
    roar,
    sr,
    (t) => f0 + (f1 - f0) * (1 - Math.exp(-t / rise)) * Math.exp(-t / (away * 1.6)),
    rocket ? 0.8 : 0.6,
  );
  const body = brownNoise(n, rng);
  biquadInPlace(body, sr, 'lowpass', rocket ? 500 : 280, 0.7);
  normalise(body, 1);
  mix(roar, body, rocket ? 0.6 : 1.1);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // a rough, fluttering burn that fades as the motor goes away
    const flutter = 0.75 + 0.25 * Math.sin(2 * Math.PI * (37 + 11 * rng()) * t);
    roar[i] *= Math.min(1, t / (rocket ? 0.012 : 0.04)) * Math.exp(-t / away) * flutter;
  }
  mix(out, normalise(roar, 1), rocket ? 1.3 : 1.5);
  biquadInPlace(out, sr, 'highpass', 30);
  biquadInPlace(out, sr, 'lowpass', rocket ? 9000 : 6000);
  const fade = Math.round(0.05 * sr);
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  return normalise(out);
}

/** An airframe creak under load (aluminium working against rivets). 0.35 s. *//** An airframe creak under load (aluminium working against rivets). 0.35 s. */
export function renderCreak(sr: number, seed = 0xc2ea): Float32Array {
  const rng = mulberry32(seed);
  const n = Math.round(0.35 * sr);
  const out = new Float32Array(n);
  // a stick-slip: a train of tiny clicks at a wandering rate, through a woody resonance
  let t = 0;
  let rate = 90 + 60 * rng();
  while (t < 0.3) {
    const at = Math.round(t * sr);
    if (at < n) out[at] += (0.4 + 0.6 * rng()) * Math.sin(Math.PI * (t / 0.3));
    rate *= 0.97 + 0.08 * rng();
    t += 1 / rate;
  }
  biquadInPlace(out, sr, 'bandpass', 420 + 200 * rng(), 4);
  biquadInPlace(out, sr, 'bandpass', 900, 1.5);
  return normalise(out);
}
