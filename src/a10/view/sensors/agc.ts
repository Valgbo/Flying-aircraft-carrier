/**
 * Automatic gain and level control of a sensor picture (pure, allocation-free).
 *
 * The renderer draws a small statistics image of the picture's SIGNAL (before any gain): the
 * infrared signal is the apparent temperature in kelvin, the television signal the luminance.
 * It reads it back asynchronously a few times a second and hands the bytes here. This module sets
 * targets from them and the loop moves toward the targets with the AGC's time constant (a real
 * imager's AGC settles in about a second: a fire coming into view changes the whole picture, a
 * uniform scene shows its noise).
 *
 *   infrared    PLATEAU HISTOGRAM EQUALIZATION, as modern thermal imagers do it: the signal
 *               range [lo, hi] spans the 0.2 to 99.8 percentiles (at least `minSpan` wide: the
 *               maximum gain, set by the detector's noise), and a transfer curve (LUT) gives each
 *               part of that range display levels in proportion to how many pixels it holds,
 *               each histogram bin capped at a plateau so that a few hot pixels still get their
 *               own levels and a large uniform background cannot take them all. The curve is
 *               mixed with a straight line so that temperature steps keep their proportions. The
 *               bulk of the scene (fields, roads, woods) fills the mid-greys with its texture,
 *               hot engines and fires go white, cold hulls and the sky dark; the mapping is
 *               monotonic, so hotter is always brighter (white-hot).
 *   television  the camera's auto-exposure: the 98th percentile at 90 % of full scale within
 *               the camera's range (very bright scenes saturate, dim ones reach the gain limit
 *               and darken), and a black level that removes most of the 2nd percentile (haze
 *               penetration: it stretches the contrast the haze left, and the noise with it).
 */
import { SENSOR_AGC, SENSOR_NOISE } from './sensorViewData';

export type SensorBand = 'IR' | 'TV';

/** Statistics encoding (shared with the GLSL): IR kelvin and TV log2 luminance onto 0..1. */
export const STATS_IR_OFFSET = 128;
export const STATS_IR_RANGE = 256;
export const STATS_TV_LOG_MIN = -20;
export const STATS_TV_LOG_RANGE = 28;

/** Histogram bins of the statistics (16-bit samples >> 4). */
export const AGC_BINS = 4096;
/** Entries of the infrared transfer curve (and bins of its histogram). */
export const LUT_SIZE = 64;

export interface AgcState {
  band: SensorBand;
  /** Infrared: the signal range the transfer curve spans, K. */
  lo: number;
  hi: number;
  /** Infrared: the smallest range (the maximum gain), K. */
  minSpan: number;
  /** Infrared transfer curve: display fraction (0..1) at LUT_SIZE points across [lo, hi]. */
  lut: Float32Array;
  /** Television exposure (signal per unit luminance) and black level (signal units). */
  exposure: number;
  black: number;
  /** Targets from the latest statistics. */
  targetLo: number;
  targetHi: number;
  targetLut: Float32Array;
  targetExposure: number;
  targetBlack: number;
  /** Statistics have arrived since the last reset. */
  hasTarget: boolean;
  /** The loop has reached its targets (within a few per cent). */
  settled: boolean;
  /** Bumped whenever `lut` changes (the renderer re-uploads it). */
  version: number;
}

const IR_DEFAULT_LO = -8;
const IR_DEFAULT_HI = 25;

/** Exposure limits of the television AGC. */
export function tvExposureRange(): [number, number] {
  const day = SENSOR_NOISE.daylightLuminance;
  return [0.9 / (SENSOR_AGC.tvMinScene * day), SENSOR_AGC.tvMaxGain / day];
}

/** A straight transfer curve. */
function linearLut(out: Float32Array): void {
  for (let i = 0; i < out.length; i++) out[i] = (i + 0.5) / out.length;
}

export function createAgc(band: SensorBand, minSpan: number = SENSOR_AGC.irMinSpan): AgcState {
  const s: AgcState = {
    band,
    lo: 0,
    hi: 0,
    minSpan,
    lut: new Float32Array(LUT_SIZE),
    exposure: 1,
    black: 0,
    targetLo: 0,
    targetHi: 0,
    targetLut: new Float32Array(LUT_SIZE),
    targetExposure: 1,
    targetBlack: 0,
    hasTarget: false,
    settled: false,
    version: 0,
  };
  resetAgc(s, band);
  return s;
}

/** Back to the defaults of a band (power-on, a new band): the next statistics snap. */
export function resetAgc(s: AgcState, band: SensorBand): void {
  s.band = band;
  s.lo = s.targetLo = IR_DEFAULT_LO;
  s.hi = s.targetHi = IR_DEFAULT_HI;
  linearLut(s.lut);
  linearLut(s.targetLut);
  s.exposure = s.targetExposure = 0.9 / (4 * SENSOR_NOISE.daylightLuminance);
  s.black = s.targetBlack = 0.1;
  s.hasTarget = false;
  s.settled = false;
  s.version++;
}

/** Value (0..1) of statistics texel `i` (16 bits packed in R and G). */
function sample(bytes: Uint8Array, i: number): number {
  return (bytes[i * 4] * 256 + bytes[i * 4 + 1]) / 65535;
}

/** The q-quantile of a histogram of `total` samples, as a value 0..1. */
function quantile(hist: Int32Array, total: number, q: number): number {
  const target = q * total;
  let acc = 0;
  for (let b = 0; b < hist.length; b++) {
    const n = hist[b];
    if (acc + n >= target && n > 0) {
      const f = (target - acc) / n;
      return (b + Math.min(1, Math.max(0, f))) / hist.length;
    }
    acc += n;
  }
  return 1;
}

/** Kelvin of a statistics value. */
function irKelvin(v: number): number {
  return v * STATS_IR_RANGE - STATS_IR_OFFSET;
}

/**
 * The infrared transfer curve for samples over [lo, hi]: plateau-clipped cumulative histogram,
 * mixed with a straight line (pure; `counts` is scratch of LUT_SIZE entries).
 */
export function equalize(
  bytes: Uint8Array,
  count: number,
  lo: number,
  hi: number,
  counts: Float32Array,
  out: Float32Array,
): void {
  const n = out.length;
  counts.fill(0);
  const span = Math.max(1e-6, hi - lo);
  for (let i = 0; i < count; i++) {
    const k = irKelvin(sample(bytes, i));
    const b = Math.min(n - 1, Math.max(0, Math.floor(((k - lo) / span) * n)));
    counts[b]++;
  }
  const plateau = Math.max(1, (SENSOR_AGC.irPlateau * count) / n);
  let total = 0;
  for (let b = 0; b < n; b++) {
    counts[b] = Math.min(counts[b], plateau);
    total += counts[b];
  }
  const w = SENSOR_AGC.irEqualization;
  let acc = 0;
  for (let b = 0; b < n; b++) {
    // the cumulative share at the bin's centre
    const c = total > 0 ? (acc + 0.5 * counts[b]) / total : (b + 0.5) / n;
    acc += counts[b];
    out[b] = (1 - w) * ((b + 0.5) / n) + w * c;
  }
}

/**
 * New targets from `count` statistics texels (RGBA bytes). `hist` is the caller's scratch
 * (AGC_BINS entries) and `counts` (LUT_SIZE). The first statistics after a reset snap the loop
 * to them.
 */
export function agcFromStats(
  s: AgcState,
  bytes: Uint8Array,
  count: number,
  hist: Int32Array,
  counts: Float32Array,
): void {
  if (count <= 0) return;
  hist.fill(0);
  for (let i = 0; i < count; i++) {
    const b = Math.min(AGC_BINS - 1, Math.floor(sample(bytes, i) * AGC_BINS));
    hist[b]++;
  }
  if (s.band === 'IR') {
    let lo = irKelvin(quantile(hist, count, SENSOR_AGC.irLowQuantile));
    let hi = irKelvin(quantile(hist, count, SENSOR_AGC.irHighQuantile));
    if (hi - lo < s.minSpan) {
      const mid = irKelvin(quantile(hist, count, 0.5));
      lo = Math.min(lo, mid - 0.5 * s.minSpan);
      hi = lo + s.minSpan;
    } else if (hi - lo > SENSOR_AGC.irMaxSpan) {
      lo = hi - SENSOR_AGC.irMaxSpan;
    }
    s.targetLo = lo;
    s.targetHi = hi;
    equalize(bytes, count, lo, hi, counts, s.targetLut);
  } else {
    const logLo =
      quantile(hist, count, SENSOR_AGC.tvLowQuantile) * STATS_TV_LOG_RANGE + STATS_TV_LOG_MIN;
    const logHi =
      quantile(hist, count, SENSOR_AGC.tvHighQuantile) * STATS_TV_LOG_RANGE + STATS_TV_LOG_MIN;
    const [eMin, eMax] = tvExposureRange();
    const e = Math.min(eMax, Math.max(eMin, 0.9 / 2 ** logHi));
    s.targetExposure = e;
    s.targetBlack = Math.min(0.8, Math.max(0, SENSOR_AGC.tvBlackStretch * 2 ** logLo * e));
  }
  if (!s.hasTarget) {
    s.lo = s.targetLo;
    s.hi = s.targetHi;
    s.lut.set(s.targetLut);
    s.exposure = s.targetExposure;
    s.black = s.targetBlack;
    s.hasTarget = true;
    s.version++;
  }
  updateSettled(s);
}

function updateSettled(s: AgcState): void {
  if (!s.hasTarget) {
    s.settled = false;
    return;
  }
  if (s.band === 'IR') {
    const span = Math.max(1e-3, s.targetHi - s.targetLo);
    let lutErr = 0;
    for (let i = 0; i < s.lut.length; i++) lutErr = Math.max(lutErr, Math.abs(s.lut[i] - s.targetLut[i]));
    s.settled =
      Math.abs(s.lo - s.targetLo) < 0.03 * span &&
      Math.abs(s.hi - s.targetHi) < 0.03 * span &&
      lutErr < 0.03;
  } else {
    s.settled =
      Math.abs(Math.log(s.exposure / s.targetExposure)) < 0.03 &&
      Math.abs(s.black - s.targetBlack) < 0.01;
  }
}

/** Move the gain and level toward their targets over `dt` seconds. */
export function stepAgc(s: AgcState, dt: number): void {
  if (!(dt > 0)) return;
  const k = 1 - Math.exp(-dt / SENSOR_AGC.timeConstant);
  s.lo += (s.targetLo - s.lo) * k;
  s.hi += (s.targetHi - s.hi) * k;
  if (s.band === 'IR') {
    for (let i = 0; i < s.lut.length; i++) s.lut[i] += (s.targetLut[i] - s.lut[i]) * k;
    s.version++;
  }
  s.exposure *= Math.exp(Math.log(s.targetExposure / s.exposure) * k);
  s.black += (s.targetBlack - s.black) * k;
  updateSettled(s);
}

/** Display grey (0..1, before polarity) of an infrared signal under the AGC (as the shader). */
export function irDisplay(s: AgcState, kelvin: number): number {
  const n = s.lut.length;
  const u = Math.min(1, Math.max(0, (kelvin - s.lo) / Math.max(1e-6, s.hi - s.lo)));
  // linear interpolation between the entries, clamped at the end entries' centres
  const x = Math.min(n - 1, Math.max(0, u * n - 0.5));
  const i = Math.min(n - 2, Math.floor(x));
  const f = x - i;
  const lut = s.lut[i] * (1 - f) + s.lut[i + 1] * f;
  return SENSOR_AGC.displayLow + lut * (SENSOR_AGC.displayHigh - SENSOR_AGC.displayLow);
}

/** Display grey (0..1) of a television luminance under the AGC's exposure and black level. */
export function tvDisplay(s: AgcState, luminance: number): number {
  const x = luminance * s.exposure;
  const v = Math.max(0, x - s.black) / Math.max(1e-6, 1 - s.black);
  return Math.min(1, v ** SENSOR_AGC.tvGamma);
}
