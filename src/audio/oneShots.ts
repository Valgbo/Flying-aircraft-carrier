/**
 * One-shot sound effects for the game events. Each recipe is a handful of short "bursts":
 * a looped noise or an oscillator through a filter and an envelope gain. The nodes live only
 * for the duration of the effect; the engine disconnects them when the last source ends.
 */
import { NOISE_SECONDS } from './audioGraph';

export type OneShotKind =
  | 'catapultHook'
  | 'catapultLaunch'
  | 'trap'
  | 'waveOff'
  | 'liftOff'
  | 'splashdown'
  | 'engineOn'
  | 'engineOff'
  | 'assistOn'
  | 'assistOff';

export const ONE_SHOT_KINDS: readonly OneShotKind[] = [
  'catapultHook',
  'catapultLaunch',
  'trap',
  'waveOff',
  'liftOff',
  'splashdown',
  'engineOn',
  'engineOff',
  'assistOn',
  'assistOff',
];

/** What a scheduled one-shot consists of, for the engine to clean up. */
export interface ScheduledShot {
  /** Every node created for the effect. */
  nodes: AudioNode[];
  /** The source that stops last; its `ended` event marks the end of the effect. */
  last: AudioScheduledSourceNode;
}

interface Kit {
  ctx: BaseAudioContext;
  out: AudioNode;
  noise: AudioBuffer;
  /** Context time the effect starts at. */
  t0: number;
  /** Overall loudness 0..1 of this instance. */
  level: number;
  /** Where in the shared noise loop the next burst starts reading (decorrelates bursts). */
  noiseOffset: number;
  nodes: AudioNode[];
  last: AudioScheduledSourceNode | null;
  lastEnd: number;
}

/** Envelope floor: exponential ramps cannot reach 0; -80 dB is inaudible. */
const FLOOR = 1e-4;

/** Attack to `peak`, then an exponential decay to silence at `end`. Never steps, so never clicks. */
function envelope(gain: AudioParam, start: number, attack: number, peak: number, end: number) {
  gain.setValueAtTime(0, start);
  gain.linearRampToValueAtTime(Math.max(peak, FLOOR), start + attack);
  gain.exponentialRampToValueAtTime(FLOOR, end);
}

function sweep(param: AudioParam, from: number, to: number, start: number, end: number) {
  param.setValueAtTime(from, start);
  if (to !== from) param.exponentialRampToValueAtTime(to, end);
}

/** Schedule the stop of a started source and remember the one that ends last. */
function finish(kit: Kit, source: AudioScheduledSourceNode, end: number) {
  source.stop(end + 0.02);
  if (!kit.last || end > kit.lastEnd) {
    kit.last = source;
    kit.lastEnd = end;
  }
}

interface NoiseBurst {
  delay?: number;
  dur: number;
  attack: number;
  peak: number;
  type: BiquadFilterType;
  /** Filter frequency at the start and at the end of the burst, Hz. */
  f0: number;
  f1?: number;
  q?: number;
}

function noiseBurst(kit: Kit, o: NoiseBurst) {
  const start = kit.t0 + (o.delay ?? 0);
  const end = start + o.dur;
  const source = kit.ctx.createBufferSource();
  source.buffer = kit.noise;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = NOISE_SECONDS;
  const filter = kit.ctx.createBiquadFilter();
  filter.type = o.type;
  filter.Q.value = o.q ?? 0.7;
  sweep(filter.frequency, o.f0, o.f1 ?? o.f0, start, end);
  const gain = kit.ctx.createGain();
  envelope(gain.gain, start, o.attack, o.peak * kit.level, end);
  source.connect(filter).connect(gain).connect(kit.out);
  kit.nodes.push(source, filter, gain);
  kit.noiseOffset = (kit.noiseOffset + 0.731) % (NOISE_SECONDS - 0.1);
  source.start(start, kit.noiseOffset);
  finish(kit, source, end);
}

interface ToneBurst {
  delay?: number;
  dur: number;
  attack: number;
  peak: number;
  wave: OscillatorType;
  /** Pitch at the start and at the end of the burst, Hz. */
  f0: number;
  f1?: number;
}

function toneBurst(kit: Kit, o: ToneBurst) {
  const start = kit.t0 + (o.delay ?? 0);
  const end = start + o.dur;
  const osc = kit.ctx.createOscillator();
  osc.type = o.wave;
  sweep(osc.frequency, o.f0, o.f1 ?? o.f0, start, end);
  const gain = kit.ctx.createGain();
  envelope(gain.gain, start, o.attack, o.peak * kit.level, end);
  osc.connect(gain).connect(kit.out);
  kit.nodes.push(osc, gain);
  osc.start(start);
  finish(kit, osc, end);
}

const RECIPES: Record<OneShotKind, (kit: Kit) => void> = {
  // shuttle latching onto the nose gear, then the catapult charging with steam
  catapultHook(kit) {
    toneBurst(kit, { dur: 0.2, attack: 0.004, peak: 0.5, wave: 'triangle', f0: 95, f1: 50 });
    noiseBurst(kit, { dur: 0.09, attack: 0.002, peak: 0.3, type: 'bandpass', f0: 1800, q: 2 });
    noiseBurst(kit, {
      delay: 0.1,
      dur: 1.4,
      attack: 0.7,
      peak: 0.12,
      type: 'highpass',
      f0: 2400,
      f1: 4200,
    });
  },
  // the stroke: steam hiss, the release thump, deck rattle and the shuttle hitting its stop
  catapultLaunch(kit) {
    noiseBurst(kit, {
      dur: 1.8,
      attack: 0.03,
      peak: 0.5,
      type: 'bandpass',
      f0: 3200,
      f1: 1100,
      q: 0.7,
    });
    toneBurst(kit, { dur: 0.38, attack: 0.005, peak: 0.8, wave: 'sine', f0: 72, f1: 34 });
    noiseBurst(kit, { dur: 0.28, attack: 0.004, peak: 0.5, type: 'lowpass', f0: 420, f1: 180 });
    toneBurst(kit, {
      delay: 0.9,
      dur: 0.3,
      attack: 0.004,
      peak: 0.5,
      wave: 'sine',
      f0: 58,
      f1: 30,
    });
  },
  // main gear slamming onto the deck, then the arrestor cable paying out
  trap(kit) {
    toneBurst(kit, { dur: 0.32, attack: 0.004, peak: 0.8, wave: 'sine', f0: 82, f1: 38 });
    noiseBurst(kit, { dur: 0.22, attack: 0.003, peak: 0.5, type: 'lowpass', f0: 380, f1: 160 });
    toneBurst(kit, {
      delay: 0.05,
      dur: 0.7,
      attack: 0.05,
      peak: 0.1,
      wave: 'sawtooth',
      f0: 260,
      f1: 1500,
    });
    noiseBurst(kit, {
      delay: 0.05,
      dur: 0.85,
      attack: 0.06,
      peak: 0.28,
      type: 'bandpass',
      f0: 1400,
      f1: 5200,
      q: 4,
    });
  },
  // two descending notes
  waveOff(kit) {
    toneBurst(kit, { dur: 0.17, attack: 0.008, peak: 0.24, wave: 'triangle', f0: 932 });
    toneBurst(kit, {
      delay: 0.2,
      dur: 0.26,
      attack: 0.008,
      peak: 0.24,
      wave: 'triangle',
      f0: 698,
    });
  },
  // water cascading off the hull as it leaves the sea
  liftOff(kit) {
    noiseBurst(kit, { dur: 3, attack: 0.25, peak: 0.4, type: 'lowpass', f0: 3600, f1: 600 });
    noiseBurst(kit, {
      dur: 2.6,
      attack: 0.3,
      peak: 0.25,
      type: 'bandpass',
      f0: 900,
      f1: 300,
      q: 1,
    });
    noiseBurst(kit, { dur: 2.2, attack: 0.1, peak: 0.12, type: 'highpass', f0: 4000 });
  },
  // the hull hitting the water: boom, wall of water, falling spray
  splashdown(kit) {
    toneBurst(kit, { dur: 0.7, attack: 0.006, peak: 0.9, wave: 'sine', f0: 62, f1: 28 });
    noiseBurst(kit, { dur: 1.4, attack: 0.02, peak: 0.8, type: 'lowpass', f0: 900, f1: 200 });
    noiseBurst(kit, {
      dur: 1.2 + 1.3 * kit.level,
      attack: 0.08,
      peak: 0.45,
      type: 'bandpass',
      f0: 2500,
      f1: 1200,
      q: 0.6,
    });
    noiseBurst(kit, {
      delay: 0.25,
      dur: 2.2,
      attack: 0.4,
      peak: 0.15,
      type: 'highpass',
      f0: 3500,
    });
  },
  // igniter pop, then air and pitch rushing up
  engineOn(kit) {
    noiseBurst(kit, { dur: 0.16, attack: 0.003, peak: 0.4, type: 'lowpass', f0: 260 });
    noiseBurst(kit, {
      dur: 1.6,
      attack: 0.5,
      peak: 0.35,
      type: 'bandpass',
      f0: 300,
      f1: 2600,
      q: 1,
    });
    toneBurst(kit, { dur: 1.5, attack: 0.6, peak: 0.08, wave: 'triangle', f0: 80, f1: 480 });
  },
  // a long falling sigh
  engineOff(kit) {
    noiseBurst(kit, {
      dur: 2.2,
      attack: 0.08,
      peak: 0.3,
      type: 'bandpass',
      f0: 1800,
      f1: 250,
      q: 1.2,
    });
    toneBurst(kit, { dur: 2, attack: 0.05, peak: 0.1, wave: 'triangle', f0: 520, f1: 70 });
  },
  // rising pair = assist engaged
  assistOn(kit) {
    toneBurst(kit, { dur: 0.1, attack: 0.006, peak: 0.2, wave: 'sine', f0: 660 });
    toneBurst(kit, { delay: 0.11, dur: 0.16, attack: 0.006, peak: 0.2, wave: 'sine', f0: 990 });
  },
  // falling pair = assist released
  assistOff(kit) {
    toneBurst(kit, { dur: 0.1, attack: 0.006, peak: 0.2, wave: 'sine', f0: 880 });
    toneBurst(kit, { delay: 0.11, dur: 0.18, attack: 0.006, peak: 0.2, wave: 'sine', f0: 587 });
  },
};

/**
 * Build and schedule the nodes of one effect, feeding `out`, starting at context time `t0`.
 * `level` (0..1) scales the whole effect; `noiseOffset` picks the stretch of noise it reads.
 */
export function scheduleOneShot(
  ctx: BaseAudioContext,
  out: AudioNode,
  noise: AudioBuffer,
  kind: OneShotKind,
  level: number,
  t0: number,
  noiseOffset: number,
): ScheduledShot {
  const kit: Kit = { ctx, out, noise, t0, level, noiseOffset, nodes: [], last: null, lastEnd: 0 };
  RECIPES[kind](kit);
  // every recipe has at least one burst, so `last` is set
  return { nodes: kit.nodes, last: kit.last as AudioScheduledSourceNode };
}
