#!/usr/bin/env node
/**
 * Sound conversion for the A-10 app (PLAN_A10.md §13, docs/a10/ARCHITECTURE.md §9).
 *
 *   node scripts/a10/sounds.mjs [--from <FlightGear A-10 checkout>] [--only gun-loop,wind]
 *
 * 1. With --from, copies the FlightGear files listed in SOURCES, unchanged, into
 *    third_party/flightgear-a10/Sounds/ and checks each against the SHA-256 recorded below
 *    (the files of github.com/l0k1/A-10 at commit 72da115). Without --from the copies already
 *    in third_party/ are used, so the conversion is repeatable from the repository alone.
 * 2. Converts them into web-ready files in public/a10/sounds/: mono, 16-bit PCM WAV, resampled
 *    with ffmpeg's SoX resampler, then cleaned here (DC removal, de-clipping, band limits),
 *    trimmed, looped with a correlation-matched crossfade, normalised and dithered.
 * 3. Synthesises the "PULL UP" voice offline with CMU Flite (ffmpeg's `flite` source). When this
 *    ffmpeg has no Flite, the committed file is kept.
 * 4. Writes scripts/a10/sounds-credits.json (one entry per output file) and prints what it
 *    measured: length, peak, RMS, crest factor and, for loops, how clean the seam is.
 *
 * The outputs are committed, so ffmpeg (≥ 6, with soxr) is needed only to re-run this script.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const THIRD_PARTY = join(ROOT, 'third_party', 'flightgear-a10', 'Sounds');
const OUT_DIR = join(ROOT, 'public', 'a10', 'sounds');
const CREDITS_JSON = join(ROOT, 'scripts', 'a10', 'sounds-credits.json');

const FG_REPO = 'https://github.com/l0k1/A-10';
const FG_COMMIT = '72da115';
const FG_AUTHORS =
  'The FlightGear A-10 contributors (Lee Elliott, Alexis Bory, David Bastien, Pinto, Rudolf, ' +
  'JMaverick16, Zorka, SammySkycrafts)';
/** The package's COPYING is the GPL version 2; the sound files carry no notice of their own. */
const FG_LICENCE = 'GPL-2.0 (the FlightGear A-10 package COPYING)';

/** The original FlightGear files this script uses, with their SHA-256 at commit 72da115. */
const SOURCES = {
  'gau-8.wav': '8dbf326b2b44edd6ff8c990199c48162a3c7c813ff1fa3f74dd48123d9e0724b',
  'fan2.wav': 'e04f82057b0094086d3046bc29fd64a3a1fdac64eb5a7b2ed43e603c8840df7b',
  'fan3.wav': '464d67ed998e29771219afc1f72c253bd070c63c8c9ebdbbe5b69851fc259c5b',
  'whine.wav': '69cda98dacd826af2a6de07e57af525af68e271b7e0685dabca756609d035cfd',
  'whine2.wav': '70220c8a626ccce7d0d86c1f2f44683edc6201453b3a7573b6794aa3d6ad6ded',
  'jet.wav': '210f356636a6e73bf2df76cb87e60e412c3dbb57c90e438f20c77f71aea12491',
  'wind.wav': 'd50f9c9ef248226f64c8449ea40336959fabbb2ae23825199322f79e33eb4c38',
  'stall-600-continue.wav': '4011156af61fb8bdee7ce376e9522294516dd0637688e3d30855ebda9716f73f',
  'stall-600-chopped.wav': '6937b3bea7ec4f6278ec99af5d9f3479c1b0b764a1511dd2a4d2b034fe8d3330',
  'altitude.wav': 'ad2ba2bb120a223d58e9e1365645e7b89e0409300560d76a4a415f4f49b3ae3d',
  'bomb_release.wav': '2860201624533104644bf38400a5ed13260b9a976c5137babb9118ffb7cebc21',
  'click.wav': 'a797a293428afe1e9999a5ffccd1ad7b9b581d427189de02caf66f389a70a31b',
  'click2.wav': '4c9e0a0f9a4b75c56b714144da3532b4164b64dda8e152a9af8ac94d80fc2bf3',
};

/**
 * What to make. Every output is mono 16-bit PCM.
 *  rate       output sample rate (the gun keeps 44.1 kHz; engines and wind 16–32 kHz)
 *  hp / lp    zero-phase high-pass / low-pass corner, Hz (2nd-order Butterworth, run both ways)
 *  declip     rebuild flat-topped runs at full scale with cubic Hermite segments
 *  loop       { start, length, search, xfade } in seconds: a seamless loop of about `length` s
 *             starting near `start`; the exact length is searched within ±`search` s for the
 *             best match of the two crossfaded stretches. `period` restricts the search to whole
 *             periods of a known repetition (the gun's shot interval, a tone's cycle).
 *  trim       one-shots: cut leading/trailing silence below `trim` dBFS (keeps `pad` s)
 *  peak       normalisation target, dBFS
 */
const OUTPUTS = [
  {
    out: 'gun-loop.wav',
    src: 'gau-8.wav',
    rate: 44100,
    hp: 40,
    lp: 14000,
    declip: true,
    // The recording repeats at 69.7 shots/s (measured), but its harmonics drift in phase, so a
    // seam only matches where the waveform of one shot recurs: both ends are searched (ρ ≈ 0.67
    // over one shot near 1.34 s) and the crossfade spans exactly one shot.
    loop: {
      start: 0.0,
      startSearch: 0.12,
      length: 1.35,
      search: 0.1,
      xfade: 1 / 69.7,
    },
    peak: -1,
    use: 'GAU-8/A firing loop (played at 65/69.7 of its speed to match the real 65 rounds/s)',
  },
  {
    out: 'engine-fan.wav',
    src: 'fan2.wav',
    rate: 32000,
    hp: 30,
    loop: { start: 4.0, length: 4.0, search: 0.25, xfade: 0.2 },
    peak: -1,
    use: 'TF34 fan layer, outside',
  },
  {
    out: 'engine-fan-inside.wav',
    src: 'fan3.wav',
    rate: 16000,
    hp: 30,
    loop: { start: 3.0, length: 4.0, search: 0.25, xfade: 0.2 },
    peak: -1,
    use: 'TF34 fan layer heard in the cockpit',
  },
  {
    out: 'engine-whine.wav',
    src: 'whine.wav',
    rate: 32000,
    hp: 80,
    declip: true,
    loop: { start: 2.0, length: 3.0, search: 0.25, xfade: 0.15 },
    peak: -1,
    use: 'TF34 high whine (fan blade-passing tone), outside',
  },
  {
    out: 'engine-whine-low.wav',
    src: 'whine2.wav',
    rate: 22050,
    hp: 60,
    loop: { start: 3.0, length: 3.0, search: 0.25, xfade: 0.15 },
    peak: -1,
    use: 'TF34 core whine',
  },
  {
    out: 'engine-jet.wav',
    src: 'jet.wav',
    rate: 22050,
    hp: 25,
    declip: true,
    loop: { start: 8.0, length: 5.0, search: 0.3, xfade: 0.25 },
    peak: -1,
    use: 'TF34 exhaust roar',
  },
  {
    out: 'wind.wav',
    src: 'wind.wav',
    rate: 22050,
    hp: 25,
    declip: true,
    loop: { start: 0.05, length: 3.1, search: 0.15, xfade: 0.2 },
    peak: -1,
    use: 'Airflow over the canopy',
  },
  {
    out: 'stall-steady.wav',
    src: 'stall-600-continue.wav',
    rate: 22050,
    // a pure 600 Hz tone: the search lands on a whole number of cycles (ρ = 1)
    loop: { start: 0.0, length: 0.5, search: 0.01, xfade: 0.01 },
    peak: -1,
    use: 'Steady stall warning tone (approaching the stall)',
  },
  {
    out: 'stall-chopped.wav',
    src: 'stall-600-chopped.wav',
    rate: 22050,
    // already two whole 0.8 s chop periods that start and end in silence
    loop: { start: 0, length: 1.6, search: 0, xfade: 0 },
    peak: -1,
    use: 'Chopped stall warning tone (at the stall)',
  },
  {
    out: 'altitude.wav',
    src: 'altitude.wav',
    rate: 22050,
    hp: 80,
    trim: -50,
    pad: 0.01,
    peak: -1,
    use: 'Altitude alert voice ("ALTITUDE, ALTITUDE")',
  },
  {
    out: 'bomb-release.wav',
    src: 'bomb_release.wav',
    rate: 22050,
    // the original has most of its energy at 20 Hz, which speakers cannot play
    hp: 32,
    declip: true,
    trim: -60,
    pad: 0.005,
    peak: -1,
    use: 'Store release clunk (ejector rack)',
  },
  {
    out: 'click.wav',
    src: 'click.wav',
    rate: 22050,
    hp: 40,
    trim: -50,
    pad: 0.002,
    peak: -1,
    use: 'Cockpit switch (toggle)',
  },
  {
    out: 'click2.wav',
    src: 'click2.wav',
    rate: 22050,
    hp: 40,
    trim: -50,
    pad: 0.002,
    peak: -1,
    use: 'Cockpit switch (push button)',
  },
];

/** The "PULL UP" voice, made with CMU Flite (no recording with a usable licence was at hand). */
const VOICE = {
  out: 'pull-up.wav',
  text: 'Pull up.',
  voice: 'slt',
  rate: 22050,
  // a cockpit voice-warning channel: telephone band, a little presence
  hp: 280,
  lp: 3600,
  trim: -45,
  pad: 0.005,
  peak: -1,
  use: 'Ground-collision voice warning ("PULL UP")',
};

// ---- command line --------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

// ---- ffmpeg I/O ----------------------------------------------------------------------------

function ffmpeg(args, input) {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...args], {
    input,
    maxBuffer: 1 << 30,
  });
  if (r.error) throw new Error(`ffmpeg could not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr.toString()}`);
  return r.stdout;
}

/** Decode any input ffmpeg reads to mono float64 at `rate` (SoX resampler, 28-bit precision). */
function decodeFile(path, rate, inputArgs = []) {
  const buf = ffmpeg([
    ...inputArgs,
    '-i',
    path,
    '-ac',
    '1',
    '-af',
    `aresample=${rate}:resampler=soxr:precision=28`,
    '-f',
    'f64le',
    '-',
  ]);
  const view = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
  return Float64Array.from(view);
}

function hasFlite() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { maxBuffer: 1 << 24 });
  return r.status === 0 && /\sflite\s/.test(r.stdout.toString());
}

// ---- DSP -------------------------------------------------------------------------------------

/** RBJ-cookbook 2nd-order Butterworth biquad, applied forward then backward (zero phase). */
function biquad(x, sr, type, f0) {
  const w0 = (2 * Math.PI * f0) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  let b0, b1, b2;
  if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const run = (input) => {
    const y = new Float64Array(input.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < input.length; i++) {
      const v = (b0 * input[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1;
      x1 = input[i];
      y2 = y1;
      y1 = v;
      y[i] = v;
    }
    return y;
  };
  return run(run(x).reverse()).reverse();
}

/**
 * Rebuild clipped runs (|x| ≥ 0.999 of full scale, same sign) as a cubic Hermite segment
 * through the neighbouring samples with their slopes, never below the clipped value. It cannot
 * recover what clipping destroyed, but it rounds the flat tops off again, which takes the edge
 * off the harshness and restores some crest factor.
 */
function declip(x, threshold = 0.999) {
  const y = Float64Array.from(x);
  const n = x.length;
  let runs = 0;
  let i = 2;
  while (i < n - 2) {
    if (Math.abs(x[i]) < threshold) {
      i++;
      continue;
    }
    const sign = Math.sign(x[i]);
    let j = i;
    while (j < n - 2 && Math.abs(x[j]) >= threshold && Math.sign(x[j]) === sign) j++;
    const a = i - 1;
    const b = j;
    const L = b - a;
    const ya = x[a];
    const yb = x[b];
    const ma = x[a] - x[a - 1];
    const mb = x[b + 1] - x[b];
    for (let k = i; k < j; k++) {
      const t = (k - a) / L;
      const t2 = t * t;
      const t3 = t2 * t;
      const v =
        (2 * t3 - 3 * t2 + 1) * ya +
        (t3 - 2 * t2 + t) * L * ma +
        (-2 * t3 + 3 * t2) * yb +
        (t3 - t2) * L * mb;
      y[k] = sign > 0 ? Math.max(v, x[k]) : Math.min(v, x[k]);
    }
    runs++;
    i = j;
  }
  return { y, runs };
}

function countClipped(x, threshold = 0.999) {
  let c = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= threshold) c++;
  return c;
}

/** Normalised correlation of x[a..a+n) and x[b..b+n). */
function correlation(x, a, b, n) {
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const p = x[a + i];
    const q = x[b + i];
    sab += p * q;
    saa += p * p;
    sbb += q * q;
  }
  return sab / Math.sqrt(saa * sbb + 1e-30);
}

/**
 * Choose the loop (start near `start`, length near `length`, seconds) whose two crossfaded
 * stretches match best, then build it: y[i] = s[i]·fadeIn + s[i+L]·fadeOut over the first C
 * samples, s[i] after. The seam y[L-1] → y[0] = s[L-1] → s[L] is then a step the original
 * itself made, and the fade joins two stretches that look alike.
 *
 * The crossfade law keeps the power constant for the measured correlation ρ of the two
 * stretches: (sin, cos)/√(1 + ρ·sin πt) is equal-power for ρ = 0 and constant-amplitude for ρ = 1.
 */
function makeLoop(x, sr, spec) {
  const C = Math.round(spec.xfade * sr);
  const nominal = Math.round(spec.length * sr);
  const search = Math.round(spec.search * sr);
  const first = Math.round(spec.start * sr);
  const lastStart = first + Math.round((spec.startSearch ?? 0) * sr);
  const startStep = 32;
  let start = first;
  let best = nominal;
  let bestScore = -Infinity;
  if (C === 0) bestScore = 1;
  else {
    for (let s0 = first; s0 <= lastStart; s0 += startStep) {
      for (let L = nominal - search; L <= nominal + search; L++) {
        if (s0 + L + C > x.length) break;
        const score = correlation(x, s0, s0 + L, C);
        if (score > bestScore) {
          bestScore = score;
          best = L;
          start = s0;
        }
      }
    }
  }
  const L = best;
  if (start + L + C > x.length)
    throw new Error(`loop does not fit: ${start + L + C} > ${x.length}`);
  const rho = C > 0 ? bestScore : 1;
  const r = Math.max(-0.5, Math.min(1, rho));
  const y = new Float64Array(L);
  for (let i = 0; i < L; i++) y[i] = x[start + i];
  for (let i = 0; i < C; i++) {
    const t = (i + 0.5) / C;
    const norm = 1 / Math.sqrt(1 + r * Math.sin(Math.PI * t));
    const gIn = Math.sin((t * Math.PI) / 2) * norm;
    const gOut = Math.cos((t * Math.PI) / 2) * norm;
    y[i] = x[start + i] * gIn + x[start + L + i] * gOut;
  }
  return {
    y,
    start,
    length: L,
    rho,
    xfade: C,
    law: C === 0 ? 'none' : 'matched',
  };
}

function rmsOf(x, a = 0, b = x.length) {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

function peakOf(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

const dB = (v) => 20 * Math.log10(Math.max(v, 1e-12));

/** Cut leading and trailing stretches quieter than `thresholdDb` (5 ms windows), keep `pad` s. */
function trimSilence(x, sr, thresholdDb, pad) {
  const w = Math.max(1, Math.round(sr * 0.005));
  const thr = 10 ** (thresholdDb / 20);
  let first = 0;
  while (first + w < x.length && rmsOf(x, first, first + w) < thr) first += w;
  let last = x.length;
  while (last - w > first && rmsOf(x, last - w, last) < thr) last -= w;
  const a = Math.max(0, first - Math.round(pad * sr));
  const b = Math.min(x.length, last + Math.round(pad * sr));
  const y = x.slice(a, b);
  // 2 ms raised-cosine fades so the cut edges never click
  const f = Math.min(Math.round(sr * 0.002), Math.floor(y.length / 2));
  for (let i = 0; i < f; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / f);
    y[i] *= g;
    y[y.length - 1 - i] *= g;
  }
  return y;
}

function removeMean(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m += x[i];
  m /= x.length;
  for (let i = 0; i < x.length; i++) x[i] -= m;
  return x;
}

function normalisePeak(x, dbfs) {
  const g = 10 ** (dbfs / 20) / Math.max(peakOf(x), 1e-9);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

/** mulberry32: small seeded PRNG, so the dither (and the committed files) are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 16-bit PCM with triangular (TPDF) dither of ±1 LSB. */
function toPcm16(x, seed) {
  const random = mulberry32(seed);
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const d = random() - random();
    const v = Math.round(x[i] * 32767 + d);
    out[i] = Math.max(-32768, Math.min(32767, v));
  }
  return out;
}

function wavBytes(pcm, sr) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/**
 * How clean a loop's seam is: the wrap-around step against the 95th percentile of the signal's
 * own sample-to-sample steps (≤ 1 = nothing unusual), and the level over the crossfade (where a
 * badly matched fade would dip or swell) against the whole loop, dB.
 */
function seamQuality(x, sr, xfade) {
  const steps = new Float64Array(x.length - 1);
  for (let i = 1; i < x.length; i++) steps[i - 1] = Math.abs(x[i] - x[i - 1]);
  const sorted = Float64Array.from(steps).sort();
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1e-9;
  const wrap = Math.abs(x[0] - x[x.length - 1]);
  const n = Math.max(xfade, Math.round(sr * 0.01));
  return {
    stepRatio: wrap / p95,
    fadeDb: dB(rmsOf(x, 0, Math.min(n, x.length))) - dB(rmsOf(x)),
  };
}

function hashOf(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ---- main -------------------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
mkdirSync(THIRD_PARTY, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

if (typeof args.from === 'string') {
  const fromDir = join(resolve(String(args.from)), 'Sounds');
  for (const name of Object.keys(SOURCES)) {
    const src = join(fromDir, name);
    if (!existsSync(src)) throw new Error(`missing ${src}`);
    copyFileSync(src, join(THIRD_PARTY, name));
  }
  console.log(`copied ${Object.keys(SOURCES).length} original files into ${THIRD_PARTY}`);
}

const hashes = {};
for (const [name, expected] of Object.entries(SOURCES)) {
  const p = join(THIRD_PARTY, name);
  if (!existsSync(p)) {
    throw new Error(`${p} is missing: run with --from <FlightGear A-10 checkout> first`);
  }
  hashes[name] = hashOf(p);
  if (hashes[name] !== expected) {
    throw new Error(
      `${p} is not the FlightGear original of commit ${FG_COMMIT} (SHA-256 ${hashes[name]})`,
    );
  }
}

const credits = existsSync(CREDITS_JSON)
  ? JSON.parse(readFileSync(CREDITS_JSON, 'utf8'))
  : { files: {} };
credits.about =
  'Credits for public/a10/sounds/, written by scripts/a10/sounds.mjs. ' +
  'Merge into CREDITS.md (one line per file).';
credits.files = credits.files ?? {};

const rows = [];
let seed = 0x5a10;

function finish(name, y, sr, extra) {
  const pcm = toPcm16(y, seed++);
  const bytes = wavBytes(pcm, sr);
  const path = join(OUT_DIR, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  // measure what was written (after quantisation)
  const q = Float64Array.from(pcm, (v) => v / 32768);
  const peak = peakOf(q);
  const rms = rmsOf(q);
  const row = {
    file: name,
    seconds: +(q.length / sr).toFixed(3),
    rate: sr,
    kB: +(bytes.length / 1024).toFixed(1),
    peakDb: +dB(peak).toFixed(1),
    rmsDb: +dB(rms).toFixed(1),
    crestDb: +(dB(peak) - dB(rms)).toFixed(1),
    ...extra,
  };
  if (extra.loop) {
    const s = seamQuality(q, sr, extra.loop.xfade);
    row.seamStep = +s.stepRatio.toFixed(2);
    row.fadeDb = +s.fadeDb.toFixed(1);
  }
  rows.push(row);
  return row;
}

for (const spec of OUTPUTS) {
  if (only && !only.has(spec.out.replace(/\.wav$/, ''))) continue;
  const srcPath = join(THIRD_PARTY, spec.src);
  let x = decodeFile(srcPath, spec.rate);
  const clippedBefore = countClipped(x);
  let declipRuns = 0;
  if (spec.declip) {
    const d = declip(x);
    x = d.y;
    declipRuns = d.runs;
  }
  removeMean(x);
  if (spec.hp) x = biquad(x, spec.rate, 'highpass', spec.hp);
  if (spec.lp) x = biquad(x, spec.rate, 'lowpass', spec.lp);
  let y;
  let loopInfo = null;
  if (spec.loop) {
    const l = makeLoop(x, spec.rate, spec.loop);
    y = l.y;
    loopInfo = {
      start: l.start,
      samples: l.length,
      rho: +l.rho.toFixed(3),
      xfade: l.xfade,
      law: l.law,
    };
  } else {
    y = trimSilence(x, spec.rate, spec.trim ?? -60, spec.pad ?? 0.005);
  }
  normalisePeak(y, spec.peak);
  finish(spec.out, y, spec.rate, {
    src: spec.src,
    clippedIn: clippedBefore,
    declipRuns,
    loop: loopInfo,
  });
  credits.files[spec.out] = {
    title: spec.use,
    author: FG_AUTHORS,
    source: `${FG_REPO} (commit ${FG_COMMIT}), Sounds/${spec.src}`,
    original: `third_party/flightgear-a10/Sounds/${spec.src}`,
    originalSha256: hashes[spec.src],
    licence: FG_LICENCE,
    changes: describeChanges(spec, loopInfo),
  };
}

function describeChanges(spec, loopInfo) {
  const parts = [`converted to mono 16-bit ${spec.rate / 1000} kHz WAV`];
  if (spec.declip) parts.push('clipped peaks rebuilt (cubic de-clipping)');
  parts.push('DC removed');
  if (spec.hp) parts.push(`high-pass ${spec.hp} Hz`);
  if (spec.lp) parts.push(`low-pass ${spec.lp / 1000} kHz`);
  if (loopInfo) {
    parts.push(
      loopInfo.law === 'none'
        ? 'kept whole as a loop'
        : `cut to a ${(loopInfo.samples / spec.rate).toFixed(3)} s seamless loop (crossfaded seam)`,
    );
  } else parts.push('silence trimmed');
  parts.push(`peak-normalised to ${spec.peak} dBFS`);
  return parts.join('; ');
}

// ---- the PULL UP voice -----------------------------------------------------------------------

if (!only || only.has(VOICE.out.replace(/\.wav$/, ''))) {
  if (hasFlite()) {
    const raw = decodeFile(`flite=text='${VOICE.text}':voice=${VOICE.voice}`, VOICE.rate, [
      '-f',
      'lavfi',
    ]);
    let x = removeMean(raw);
    x = biquad(x, VOICE.rate, 'highpass', VOICE.hp);
    x = biquad(x, VOICE.rate, 'lowpass', VOICE.lp);
    const y = trimSilence(x, VOICE.rate, VOICE.trim, VOICE.pad);
    normalisePeak(y, VOICE.peak);
    finish(VOICE.out, y, VOICE.rate, { src: `flite:${VOICE.voice}`, loop: null });
    credits.files[VOICE.out] = {
      title: VOICE.use,
      author:
        'generated with CMU Flite by Carnegie Mellon University, https://github.com/festvox/flite, voice cmu_us_slt, via FFmpeg',
      source: `scripts/a10/sounds.mjs: flite text "${VOICE.text}", voice ${VOICE.voice}`,
      licence:
        'GPL-2.0-or-later (this project); the Flite engine and the cmu_us_slt voice (CMU ARCTIC) ' +
        'are under BSD-style free licences',
      changes: `telephone-band filter ${VOICE.hp}–${VOICE.lp} Hz; silence trimmed; peak-normalised to ${VOICE.peak} dBFS; mono 16-bit ${VOICE.rate / 1000} kHz`,
    };
  } else {
    console.warn('ffmpeg has no flite filter: keeping the committed pull-up.wav');
  }
}

writeFileSync(CREDITS_JSON, JSON.stringify(credits, null, 2) + '\n');

// ---- report ------------------------------------------------------------------------------------

let total = 0;
for (const r of rows) total += r.kB;
console.log(
  'file'.padEnd(24) +
    's'.padStart(7) +
    'Hz'.padStart(7) +
    'kB'.padStart(8) +
    'peak'.padStart(7) +
    'rms'.padStart(7) +
    'crest'.padStart(7) +
    '  loop / notes',
);
for (const r of rows) {
  const loop = r.loop
    ? `loop ${r.loop.samples} smp from ${r.loop.start}, ${r.loop.law} xfade (ρ ${r.loop.rho}), ` +
      `seam step ×${r.seamStep}, level over the fade ${r.fadeDb} dB`
    : 'one-shot';
  const clip = r.clippedIn ? `; ${r.clippedIn} clipped in, ${r.declipRuns} runs rebuilt` : '';
  console.log(
    r.file.padEnd(24) +
      String(r.seconds).padStart(7) +
      String(r.rate).padStart(7) +
      String(r.kB).padStart(8) +
      String(r.peakDb).padStart(7) +
      String(r.rmsDb).padStart(7) +
      String(r.crestDb).padStart(7) +
      '  ' +
      loop +
      clip,
  );
}
console.log(`total ${(total / 1024).toFixed(2)} MB of ${rows.length} files written to ${OUT_DIR}`);
