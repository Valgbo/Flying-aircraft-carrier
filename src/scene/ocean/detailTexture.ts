/**
 * The ocean's only texture: a small tileable RGBA map generated in code (no image assets).
 *
 *   R, G  slope of a ripple height field along u and v, as 0.5 + 0.5·s with RMS(s) = DETAIL_SLOPE_RMS
 *   B     the ripple height itself, as 0.5 + 0.5·h with RMS(h) = DETAIL_HEIGHT_RMS (foam break-up, crests)
 *   A     an independent, smoother cloud-like noise, mean 0.5 (gusts, foam patches)
 *
 * The fields are synthesised in the frequency domain — a band of random plane waves on the
 * integer wave-number lattice, transformed with a small inverse FFT — so they tile perfectly,
 * the slopes are the exact derivatives of the height, and mip-mapping averages them toward
 * "flat" exactly the way distance should. Deterministic: the same texture on every run.
 */
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
} from 'three';
import { mulberry32 } from '../../utils/math';

export const DETAIL_TEXTURE_SIZE = 256;
/** RMS of each decoded slope channel (2·texel − 1). */
export const DETAIL_SLOPE_RMS = 0.25;
/** RMS of the decoded height channel (2·texel − 1). */
export const DETAIL_HEIGHT_RMS = 1 / 3;
/**
 * Band of the ripple field in cycles per tile and the exponent of its height spectrum
 * (amplitude ∝ |k|^-falloff). The ocean shader derives from these how much of the ripple slope
 * a given pixel footprint still resolves.
 */
export const RIPPLE_K_MIN = 2.5;
export const RIPPLE_K_MAX = 46;
export const RIPPLE_FALLOFF = 1.7;

/** In-place inverse FFT of one complex row of length n (a power of two); unscaled. */
function inverseFft(re: Float64Array, im: Float64Array, cosT: Float64Array, sinT: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k++) {
        const wr = cosT[k * step];
        const wi = sinT[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** Real part of the 2D inverse FFT of an n×n complex spectrum (row-major, overwritten). */
function inverseFft2Real(re: Float64Array, im: Float64Array, n: number): Float64Array {
  const cosT = new Float64Array(n / 2);
  const sinT = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / n);
    sinT[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rowRe = new Float64Array(n);
  const rowIm = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    const o = y * n;
    rowRe.set(re.subarray(o, o + n));
    rowIm.set(im.subarray(o, o + n));
    inverseFft(rowRe, rowIm, cosT, sinT);
    re.set(rowRe, o);
    im.set(rowIm, o);
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      rowRe[y] = re[y * n + x];
      rowIm[y] = im[y * n + x];
    }
    inverseFft(rowRe, rowIm, cosT, sinT);
    for (let y = 0; y < n; y++) re[y * n + x] = rowRe[y];
  }
  return re;
}

interface Spectrum {
  re: Float64Array;
  im: Float64Array;
}

/**
 * Random spectrum on the integer lattice: amplitude ∝ |k|^-falloff inside [kMin, kMax]
 * (cycles per tile, soft edges), with crests preferring to lie across the u axis by
 * `directionality` (0 = isotropic, 1 = strongly aligned).
 */
function randomSpectrum(
  n: number,
  random: () => number,
  kMin: number,
  kMax: number,
  falloff: number,
  directionality: number,
): Spectrum {
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  const reach = Math.ceil(kMax * 1.25);
  for (let ky = -reach; ky <= reach; ky++) {
    for (let kx = -reach; kx <= reach; kx++) {
      const k = Math.hypot(kx, ky);
      if (k < 0.5 || k > kMax * 1.25) continue;
      const low = Math.min(1, Math.max(0, (k - kMin * 0.6) / (kMin * 0.4)));
      const high = Math.min(1, Math.max(0, (kMax * 1.25 - k) / (kMax * 0.25)));
      const along = kx / k;
      const spread = 1 - directionality + directionality * along * along;
      const amplitude = k ** -falloff * low * low * high * high * spread;
      // Box–Muller: a complex Gaussian coefficient
      const radius = Math.sqrt(-2 * Math.log(1 - random())) * amplitude;
      const angle = 2 * Math.PI * random();
      const index = ((ky + n) % n) * n + ((kx + n) % n);
      re[index] = radius * Math.cos(angle);
      im[index] = radius * Math.sin(angle);
    }
  }
  return { re, im };
}

/** The spectrum multiplied by i·k along one axis: the transform of that partial derivative. */
function derivativeSpectrum(source: Spectrum, n: number, axis: 'u' | 'v'): Spectrum {
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    const ky = y < n / 2 ? y : y - n;
    for (let x = 0; x < n; x++) {
      const kx = x < n / 2 ? x : x - n;
      const k = axis === 'u' ? kx : ky;
      const i = y * n + x;
      re[i] = -k * source.im[i];
      im[i] = k * source.re[i];
    }
  }
  return { re, im };
}

function rms(...fields: Float64Array[]): number {
  let sum = 0;
  let count = 0;
  for (const field of fields) {
    for (let i = 0; i < field.length; i++) sum += field[i] * field[i];
    count += field.length;
  }
  return Math.sqrt(sum / count);
}

function encode(value: number): number {
  return Math.round((Math.min(1, Math.max(-1, value)) * 0.5 + 0.5) * 255);
}

/** RGBA8 pixels of the detail map (size × size, row-major). Pure; exported for tests. */
export function generateDetailPixels(size = DETAIL_TEXTURE_SIZE): Uint8Array {
  const random = mulberry32(0x0cea9);
  const ripples = randomSpectrum(size, random, RIPPLE_K_MIN, RIPPLE_K_MAX, RIPPLE_FALLOFF, 0.5);
  const slopeU = derivativeSpectrum(ripples, size, 'u');
  const slopeV = derivativeSpectrum(ripples, size, 'v');
  const height = inverseFft2Real(ripples.re, ripples.im, size);
  const du = inverseFft2Real(slopeU.re, slopeU.im, size);
  const dv = inverseFft2Real(slopeV.re, slopeV.im, size);
  const cloudSpectrum = randomSpectrum(size, random, 1, 22, 1.9, 0);
  const cloud = inverseFft2Real(cloudSpectrum.re, cloudSpectrum.im, size);

  const slopeScale = DETAIL_SLOPE_RMS / rms(du, dv);
  const heightScale = DETAIL_HEIGHT_RMS / rms(height);
  const cloudScale = 0.4 / rms(cloud);
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = encode(du[i] * slopeScale);
    pixels[i * 4 + 1] = encode(dv[i] * slopeScale);
    pixels[i * 4 + 2] = encode(height[i] * heightScale);
    pixels[i * 4 + 3] = encode(cloud[i] * cloudScale);
  }
  return pixels;
}

/** Create the mip-mapped, repeating detail texture. The caller disposes it. */
export function createDetailTexture(): DataTexture {
  const texture = new DataTexture(
    generateDetailPixels(),
    DETAIL_TEXTURE_SIZE,
    DETAIL_TEXTURE_SIZE,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}
