/**
 * Audio sandbox: /a10/?sandbox=audio (dev server). MEASURES what nobody can hear here.
 *
 * Each scenario renders the real audio engine (src/a10/audio) into an OfflineAudioContext,
 * stepping it once per 1/60 s frame (OfflineAudioContext.suspend) with a small stand-in
 * simulation: a GAU-8 that spins up and down as data/gun.ts says, engines at a set N1/N2, a
 * listener in the cockpit or outside, impacts and a bomb placed in the world. Every bus, the
 * sum before the limiter and the output are tapped into separate channels and measured: peak,
 * RMS, crest factor, clipped samples, octave-band spectrum, the 600 Hz band (stall tone) and the
 * moment a sound first arrives.
 *
 *   node scripts/shot.mjs --url "http://127.0.0.1:5315/a10/?sandbox=audio" --out .shots/audio/sandbox.png \
 *     --console --ready "document.body.dataset.audioDone === '1'" --wait 300 --timeout 600000
 *
 * Results are printed as `[audio-measure] {json}` lines and kept in window.__A10_AUDIO_MEASURE__.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { Quaternion, Vector3 } from 'three';
import { A10AudioEngine } from '../../audio/audioEngine';
import { GUN_LEVELS } from '../../audio/gun';
import { BUS_IDS } from '../../audio/mappings';
import { loadSamples, samplesLoaded, SAMPLE_IDS } from '../../audio/samples';
import type { Sim, SimEvent } from '../../core/types';
import { createRoundPool, RoundType } from '../../core/weapons';
import { GAU8 } from '../../data/gun';

const SR = 48000;
const FRAME = 1 / 60;
const STEP = 1 / 120;
const TAPS = ['output', 'preLimiter', ...BUS_IDS] as const;
type Tap = (typeof TAPS)[number];

// ---- a stand-in simulation -------------------------------------------------------------------

function fakeSim(): Sim {
  const engine = () => ({
    lever: 1,
    n1: 1,
    n2: 1,
    thrust: 0,
    itt: 0,
    fuelFlow: 0,
    running: true,
    igniters: false,
  });
  const warnings = {
    stall: false,
    stallChopped: false,
    overG: false,
    altitude: false,
    pullUp: false,
    overspeed: false,
    lowFuel: false,
    masterCaution: false,
  };
  return {
    time: 0,
    events: [],
    aircraft: {
      position: new Vector3(0, 1000, 0),
      velocity: new Vector3(0, 0, -150),
      orientation: new Quaternion(),
      engines: [engine(), engine()],
      ias: 130,
      alpha: 0.05,
      gLoad: 1,
      surfaces: { speedBrake: 0 },
      gearDown: false,
      warnings,
      crashed: false,
    },
    gun: { firing: false, rate: 0, spin: 0 },
    projectiles: { rounds: createRoundPool(64), bodies: [] },
    targets: { vehicles: [] },
  } as unknown as Sim;
}

/** The GAU-8 as data/gun.ts describes it: linear spin-up, rounds from the first moment. */
class GunModel {
  trigger = false;
  private acc = 0;

  step(sim: Sim, dt: number, events: SimEvent[], onRound?: (t: number) => void): void {
    const g = sim.gun;
    g.spin = this.trigger
      ? Math.min(1, g.spin + dt / GAU8.spinUpTime)
      : Math.max(0, g.spin - dt / GAU8.spinDownTime);
    const firing = this.trigger && g.spin > 0;
    if (firing && !g.firing) events.push({ type: 'gunStart', t: sim.time });
    if (!firing && g.firing) events.push({ type: 'gunStop', t: sim.time, rounds: 0, duration: 0 });
    g.firing = firing;
    g.rate = firing ? GAU8.rate * g.spin : 0;
    this.acc += g.rate * dt;
    while (this.acc >= 1) {
      this.acc -= 1;
      onRound?.(sim.time + dt * (1 - this.acc / Math.max(1e-9, g.rate * dt)));
    }
  }
}

interface Window_ {
  label: string;
  from: number;
  to: number;
}

interface Scenario {
  name: string;
  /** Only these gun layers sound (layer solos); default all. */
  gunLayers?: (keyof typeof GUN_LEVELS)[];
  seconds: number;
  /** Listener: position, velocity, yaw (rad, 0 = north), in the cockpit. */
  listener: [number, number, number, number, number, number, number, boolean];
  setup(sim: Sim): void;
  /** Advance the stand-in sim by one 1/120 s step; push this step's events. */
  step(sim: Sim, events: SimEvent[]): void;
  windows: Window_[];
}

function engines(sim: Sim, n1: number, n2: number): void {
  for (const e of sim.aircraft.engines) {
    e.n1 = n1;
    e.n2 = n2;
  }
}

function moveAircraft(sim: Sim): void {
  sim.aircraft.position.addScaledVector(sim.aircraft.velocity, STEP);
}

function gunScenario(name: string, inCockpit: boolean): Scenario {
  const gun = new GunModel();
  return {
    name,
    seconds: 3.6,
    // outside: a chase camera 30 m behind and 6 m above, flying along
    listener: inCockpit ? [0, 1000, 0, 0, 0, -150, 0, true] : [0, 1006, 30, 0, 0, -150, 0, false],
    setup(sim) {
      engines(sim, 1, 1);
      sim.aircraft.ias = 150;
    },
    step(sim, events) {
      gun.trigger = sim.time >= 0.5 && sim.time < 2.5;
      gun.step(sim, STEP, events);
      moveAircraft(sim);
    },
    windows: [
      { label: 'before', from: 0.1, to: 0.48 },
      { label: 'spinUp', from: 0.5, to: 0.96 },
      { label: 'firing', from: 1.0, to: 2.45 },
      { label: 'spinDown', from: 2.62, to: 3.2 },
    ],
  };
}

const GUN_LAYERS = ['loop', 'pulse', 'rumble', 'whine'] as const;

const SCENARIOS: (() => Scenario)[] = [
  () => gunScenario('gun-cockpit', true),
  ...GUN_LAYERS.map((layer) => () => ({
    ...gunScenario(`gun-cockpit-${layer}-only`, true),
    gunLayers: [layer] as (keyof typeof GUN_LEVELS)[],
  })),
  () => gunScenario('gun-outside', false),
  () => ({
    name: 'engines-idle',
    seconds: 2,
    listener: [0, 1000, 0, 0, 0, -150, 0, true],
    setup(sim) {
      engines(sim, 0.32, 0.6);
      sim.aircraft.ias = 110;
    },
    step: (sim) => moveAircraft(sim),
    windows: [{ label: 'steady', from: 0.6, to: 1.9 }],
  }),
  () => ({
    name: 'engines-max',
    seconds: 2,
    listener: [0, 1000, 0, 0, 0, -150, 0, true],
    setup(sim) {
      engines(sim, 1, 1);
      sim.aircraft.ias = 150;
    },
    step: (sim) => moveAircraft(sim),
    windows: [{ label: 'steady', from: 0.6, to: 1.9 }],
  }),
  () => {
    const gun = new GunModel();
    return {
      name: 'tones-over-gun',
      seconds: 3.2,
      listener: [0, 1000, 0, 0, 0, -150, 0, true],
      setup(sim) {
        engines(sim, 1, 1);
        sim.aircraft.ias = 150;
      },
      step(sim, events) {
        gun.trigger = sim.time >= 0.3;
        gun.step(sim, STEP, events);
        const w = sim.aircraft.warnings;
        const stall = sim.time >= 1.0 && sim.time < 2.0;
        const chopped = sim.time >= 2.0;
        if (stall !== w.stall)
          events.push({ type: 'warning', t: sim.time, warning: 'stall', on: stall });
        if (chopped !== w.stallChopped)
          events.push({ type: 'warning', t: sim.time, warning: 'stallChopped', on: chopped });
        w.stall = stall;
        w.stallChopped = chopped;
        moveAircraft(sim);
      },
      windows: [
        { label: 'gunOnly', from: 0.7, to: 0.98 },
        { label: 'steadyTone', from: 1.1, to: 1.95 },
        { label: 'choppedTone', from: 2.05, to: 3.15 },
      ],
    };
  },
  () => {
    let done = false;
    return {
      name: 'explosion-2km',
      seconds: 8,
      // on the ground, 2 km from a Mk-82
      listener: [0, 2, 0, 0, 0, 0, 0, false],
      setup(sim) {
        engines(sim, 0, 0);
        sim.aircraft.engines[0].running = false;
        sim.aircraft.engines[1].running = false;
        sim.aircraft.position.set(0, 3000, 8000);
        sim.aircraft.ias = 0;
      },
      step(sim, events) {
        if (!done && sim.time >= 0.5) {
          done = true;
          events.push({
            type: 'detonation',
            t: sim.time,
            position: { x: 0, y: 1, z: -2000 },
            charge: 87,
            kind: 'bomb',
            vehicleId: -1,
            surface: 'grass',
          });
        }
      },
      windows: [{ label: 'boom', from: 6.2, to: 7.9 }],
    };
  },
  () => {
    // a camera at the target: the aircraft fires from 1,200 m; the rounds (1.3 s time of flight)
    // land before the gun's growl (3.5 s at the speed of sound) arrives
    const gun = new GunModel();
    const pending: number[] = [];
    let n = 0;
    return {
      name: 'target-view',
      seconds: 6,
      listener: [12, 3, 12, 0, 0, 0, Math.PI, false],
      setup(sim) {
        engines(sim, 0.9, 0.95);
        sim.aircraft.position.set(0, 600, -1050);
        // diving toward the target at the origin
        sim.aircraft.velocity.set(0, -75, 130);
      },
      step(sim, events) {
        gun.trigger = sim.time >= 0.5 && sim.time < 1.5;
        gun.step(sim, STEP, events, (t) => pending.push(t + 1.3));
        while (pending.length && pending[0] <= sim.time) {
          const t = pending.shift()!;
          n++;
          events.push({
            type: 'roundImpact',
            t,
            round: n % 6 === 5 ? RoundType.HEI : RoundType.API,
            position: { x: (n % 7) - 3, y: 0, z: (n % 5) - 2 },
            velocity: { x: 0, y: -400, z: 600 },
            normal: { x: 0, y: 1, z: 0 },
            target: { kind: 'ground', surface: 'dirt' },
            outcome: 'ground',
          });
        }
        moveAircraft(sim);
      },
      windows: [
        { label: 'impacts', from: 1.8, to: 3.4 },
        { label: 'growl', from: 4.2, to: 5.2 },
      ],
    };
  },
];

// ---- measurement ---------------------------------------------------------------------------

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2];
        const ai = im[i + k + len / 2];
        const tr = ar * wr - ai * wi;
        const ti = ar * wi + ai * wr;
        re[i + k + len / 2] = re[i + k] - tr;
        im[i + k + len / 2] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
      }
    }
  }
}

const OCTAVES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const dB = (v: number) => (v > 0 ? 20 * Math.log10(v) : -200);
const round1 = (v: number) => Math.round(v * 10) / 10;

interface Measure {
  peakDb: number;
  rmsDb: number;
  crestDb: number;
  clipped: number;
  /** Octave-band levels, dBFS (RMS in the band). */
  bands: Record<string, number>;
  /** Third-octave band around 600 Hz, dBFS. */
  band600Db: number;
}

/** Power spectrum (averaged Hann segments of 8192) of a mono signal. */
function spectrum(x: Float32Array): Float64Array {
  const N = 8192;
  const power = new Float64Array(N / 2);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let segs = 0;
  let wsum = 0;
  for (let i = 0; i < N; i++) wsum += (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)) ** 2;
  for (let start = 0; start + N <= x.length; start += N / 2) {
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
      re[i] = x[start + i] * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    segs++;
  }
  // scale so that the band sums are mean-square values of the signal
  const scale = segs > 0 ? 2 / (segs * N * wsum) : 0;
  for (let k = 0; k < N / 2; k++) power[k] *= scale;
  return power;
}

function bandLevel(power: Float64Array, lo: number, hi: number): number {
  const N = power.length * 2;
  let s = 0;
  for (
    let k = Math.max(1, Math.floor((lo * N) / SR));
    k <= Math.min(power.length - 1, Math.ceil((hi * N) / SR));
    k++
  )
    s += power[k];
  return round1(10 * Math.log10(s + 1e-20));
}

function measure(L: Float32Array, R: Float32Array, from: number, to: number): Measure {
  const a = Math.max(0, Math.floor(from * SR));
  const b = Math.min(L.length, Math.floor(to * SR));
  let peak = 0;
  let ss = 0;
  let clipped = 0;
  const mono = new Float32Array(b - a);
  for (let i = a; i < b; i++) {
    const l = L[i];
    const r = R[i];
    const p = Math.max(Math.abs(l), Math.abs(r));
    if (p > peak) peak = p;
    if (p >= 0.9999) clipped++;
    ss += (l * l + r * r) / 2;
    mono[i - a] = (l + r) / 2;
  }
  const rms = Math.sqrt(ss / Math.max(1, b - a));
  const power = spectrum(mono);
  const bands: Record<string, number> = {};
  for (const c of OCTAVES) bands[String(c)] = bandLevel(power, c / Math.SQRT2, c * Math.SQRT2);
  return {
    peakDb: round1(dB(peak)),
    rmsDb: round1(dB(rms)),
    crestDb: round1(dB(peak) - dB(rms)),
    clipped,
    bands,
    band600Db: bandLevel(power, 600 / 2 ** (1 / 6), 600 * 2 ** (1 / 6)),
  };
}

/** First moment (s) the 5 ms RMS of a tap comes within 40 dB of its loudest 5 ms. */
function onset(L: Float32Array, R: Float32Array, from: number): number {
  const w = Math.round(0.005 * SR);
  const levels: number[] = [];
  for (let i = 0; i + w <= L.length; i += w) {
    let s = 0;
    for (let k = i; k < i + w; k++) s += (L[k] * L[k] + R[k] * R[k]) / 2;
    levels.push(Math.sqrt(s / w));
  }
  const max = Math.max(...levels);
  const start = Math.floor((from * SR) / w);
  for (let i = start; i < levels.length; i++)
    if (levels[i] > max * 0.01) return round1(((i * w) / SR) * 1000) / 1000;
  return NaN;
}

/** First moment (s) after `from` a tap comes within 60 dB of its own peak (the arrival). */
function firstSound(L: Float32Array, R: Float32Array, from: number): number {
  let peak = 0;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const threshold = peak * 1e-3;
  for (let i = Math.floor(from * SR); i < L.length; i++) {
    if (Math.abs(L[i]) > threshold || Math.abs(R[i]) > threshold) {
      return Math.round((i / SR) * 10000) / 10000;
    }
  }
  return NaN;
}

interface Result {
  scenario: string;
  windows: Record<string, Partial<Record<Tap, Measure>>>;
  onsets: Partial<Record<Tap, number>>;
  /** First sample of any sound on the gun and world buses (after 20 ms). */
  firstSound: Partial<Record<Tap, number>>;
  outputPeakDb: number;
  outputClipped: number;
  nodes: number;
  renderMs: number;
}

async function runScenario(make: () => Scenario): Promise<Result> {
  const sc = make();
  const length = Math.round(sc.seconds * SR);
  const ctx = new OfflineAudioContext({
    numberOfChannels: TAPS.length * 2,
    length,
    sampleRate: SR,
  });
  const sink = ctx.createGain();
  const engine = new A10AudioEngine(ctx, { destination: sink });
  const merger = ctx.createChannelMerger(TAPS.length * 2);
  TAPS.forEach((tap, k) => {
    const node =
      tap === 'output'
        ? engine.mixer.output
        : tap === 'preLimiter'
          ? engine.mixer.preLimiter
          : engine.mixer.busOut[tap];
    // up-mix mono buses to L = R, then split L and R into two channels of the merger
    const stereo = ctx.createGain();
    stereo.channelCount = 2;
    stereo.channelCountMode = 'explicit';
    stereo.channelInterpretation = 'speakers';
    const split = ctx.createChannelSplitter(2);
    node.connect(stereo).connect(split);
    split.connect(merger, 0, 2 * k);
    split.connect(merger, 1, 2 * k + 1);
  });
  merger.connect(ctx.destination);

  const sim = fakeSim();
  sc.setup(sim);
  const [lx, ly, lz, lvx, lvy, lvz, yaw, inCockpit] = sc.listener;
  engine.listener.set(lx, ly, lz, lvx, lvy, lvz, yaw, inCockpit);
  const saved = { ...GUN_LEVELS };
  if (sc.gunLayers) {
    for (const k of Object.keys(GUN_LEVELS) as (keyof typeof GUN_LEVELS)[]) {
      if (k !== 'outside' && !sc.gunLayers.includes(k)) GUN_LEVELS[k] = 0;
    }
  }
  engine.start();
  // volume 1, gate open from the first sample (no fade-in to measure through)
  engine.setMix(1, false, true, 0, true);
  const frames = Math.floor(sc.seconds / FRAME);
  const events: SimEvent[] = [];
  for (let f = 1; f < frames; f++) {
    const at = f * FRAME;
    void ctx.suspend(at).then(() => {
      events.length = 0;
      // two 1/120 s steps per frame, like SimDriver at 60 fps
      for (let s = 0; s < 2; s++) {
        sc.step(sim, events);
        sim.time += STEP;
      }
      // the listener moves with its velocity (a chase camera flies along)
      engine.listener.set(
        lx + lvx * sim.time,
        ly + lvy * sim.time,
        lz + lvz * sim.time,
        lvx,
        lvy,
        lvz,
        yaw,
        inCockpit,
      );
      engine.step(events, sim, 2 * STEP);
      void ctx.resume();
    });
  }
  const t0 = performance.now();
  const rendered = await ctx.startRendering().finally(() => Object.assign(GUN_LEVELS, saved));
  const renderMs = Math.round(performance.now() - t0);
  const ch = (tap: Tap, side: 0 | 1) => rendered.getChannelData(2 * TAPS.indexOf(tap) + side);
  const windows: Result['windows'] = {};
  for (const w of sc.windows) {
    windows[w.label] = {};
    for (const tap of TAPS) windows[w.label][tap] = measure(ch(tap, 0), ch(tap, 1), w.from, w.to);
  }
  const onsets: Result['onsets'] = {};
  const first: Result['firstSound'] = {};
  for (const tap of ['gun', 'world', 'output'] as const) {
    onsets[tap] = onset(ch(tap, 0), ch(tap, 1), 0.02);
    first[tap] = firstSound(ch(tap, 0), ch(tap, 1), 0.02);
  }
  const whole = measure(ch('output', 0), ch('output', 1), 0, sc.seconds);
  const nodes = engine.nodeCount;
  engine.stop();
  engine.dispose();
  return {
    scenario: sc.name,
    windows,
    onsets,
    firstSound: first,
    outputPeakDb: whole.peakDb,
    outputClipped: whole.clipped,
    nodes,
    renderMs,
  };
}

declare global {
  interface Window {
    __A10_AUDIO_MEASURE__?: unknown;
  }
}

// ---- page ----------------------------------------------------------------------------------

const page: CSSProperties = {
  position: 'fixed',
  inset: 0,
  overflow: 'auto',
  padding: 20,
  background: '#10160f',
  color: '#d8e0d0',
  font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
};

function summary(results: Result[]): string[] {
  const get = (name: string) => results.find((r) => r.scenario === name);
  const lines: string[] = [];
  const gc = get('gun-cockpit');
  const idle = get('engines-idle');
  const max = get('engines-max');
  const tones = get('tones-over-gun');
  const boom = get('explosion-2km');
  const tv = get('target-view');
  if (gc) {
    const f = gc.windows.firing;
    lines.push(
      `GUN (cockpit, full rate): gun bus peak ${f.gun?.peakDb} dBFS, RMS ${f.gun?.rmsDb} dBFS; before the limiter peak ${f.preLimiter?.peakDb} dBFS, after it ${f.output?.peakDb} dBFS (unlimited: −0.3 dB); output peak over the whole run ${gc.outputPeakDb} dBFS, ${gc.outputClipped} clipped samples`,
      `  engines bus while firing (ducked) RMS ${f.engines?.rmsDb} dBFS; before firing ${gc.windows.before.engines?.rmsDb} dBFS`,
    );
  }
  const go = get('gun-outside');
  if (go) {
    const f = go.windows.firing;
    lines.push(
      `GUN (chase camera 30 m behind): gun bus peak ${f.gun?.peakDb} dBFS, RMS ${f.gun?.rmsDb} dBFS; engines RMS ${f.engines?.rmsDb} dBFS; first heard ${go.firstSound.gun} s (trigger 0.5 s + 30 m / c + 47 ms)`,
    );
  }
  if (gc && idle && max) {
    const gunRms = gc.windows.firing.gun?.rmsDb ?? 0;
    lines.push(
      `ENGINES (cockpit): idle RMS ${idle.windows.steady.engines?.rmsDb} dBFS, max RMS ${max.windows.steady.engines?.rmsDb} dBFS → ${round1(gunRms - (max.windows.steady.engines?.rmsDb ?? 0))} dB below the gun at max`,
    );
  }
  if (tones) {
    const g = tones.windows.gunOnly;
    const s = tones.windows.steadyTone;
    const c = tones.windows.choppedTone;
    lines.push(
      `TONES over the gun, 600 Hz band: steady tone ${s.cockpit?.band600Db} dB vs gun ${s.gun?.band600Db} dB (gun alone ${g.gun?.band600Db}); chopped ${c.cockpit?.band600Db} dB; tone RMS ${s.cockpit?.rmsDb} dBFS vs gun RMS ${s.gun?.rmsDb} dBFS`,
    );
  }
  if (boom) {
    lines.push(
      `EXPLOSION at 2 km: first sound at ${boom.firstSound.world} s, loud from ${boom.onsets.world} s (event at 0.5 s + 2000 m / c + 47 ms scheduling = 6.424 s), world peak ${boom.windows.boom.world?.peakDb} dBFS, bands ${JSON.stringify(boom.windows.boom.world?.bands)}`,
    );
  }
  if (tv) {
    lines.push(
      `TARGET VIEW: impacts first heard at ${tv.firstSound.world} s (loud ${tv.onsets.world} s), the gun's growl at ${tv.firstSound.gun} s (loud ${tv.onsets.gun} s); trigger at 0.5 s, 1,150 m away, rounds 1.3 s in flight`,
    );
  }
  return lines;
}

export default function AudioSandbox() {
  const [lines, setLines] = useState<string[]>(['Loading the sounds…']);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const decoder = new OfflineAudioContext(1, 1, SR);
      await loadSamples(decoder);
      const log: string[] = [`samples decoded: ${samplesLoaded()} of ${SAMPLE_IDS.length}`];
      setLines([...log]);
      const results: Result[] = [];
      for (const make of SCENARIOS) {
        if (cancelled) return;
        const r = await runScenario(make);
        results.push(r);
        console.log('[audio-measure]', JSON.stringify(r));
        log.push(
          `${r.scenario}: rendered in ${r.renderMs} ms, ${r.nodes} nodes, output peak ${r.outputPeakDb} dBFS`,
        );
        setLines([...log]);
      }
      const s = summary(results);
      for (const line of s) console.log('[audio-summary]', line);
      window.__A10_AUDIO_MEASURE__ = results;
      setLines([...log, '', ...s]);
      document.body.dataset.audioDone = '1';
    })().catch((err) => {
      console.error('[audio-measure] failed', err);
      setLines((l) => [...l, `FAILED: ${String(err)}`]);
      document.body.dataset.audioDone = '1';
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div style={page}>
      <h1 style={{ font: '600 16px system-ui', margin: '0 0 12px' }}>
        A-10 audio — offline measurements
      </h1>
      {lines.map((l, i) => (
        <div key={i} style={{ whiteSpace: 'pre-wrap' }}>
          {l || ' '}
        </div>
      ))}
    </div>
  );
}
