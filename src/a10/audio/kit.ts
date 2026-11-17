/**
 * What every voice builds with: the context and mixer, the shared noise loops, the synthesised
 * sounds (synth.ts) as AudioBuffers, and node factories that remember every node they make, for
 * the node count and the teardown.
 */
import { NOISE_SECONDS, createBrownNoise, createWhiteNoise } from '../../engine';
import type { Mixer } from './mixer';
import type { ImpactKind } from './propagation';
import {
  airframeImpulse,
  growlWaveCoefficients,
  pulseWaveCoefficients,
  renderCrack,
  renderCrackle,
  renderCreak,
  renderExplosion,
  renderImpact,
  renderLaunch,
  renderMotor,
  renderWhoosh,
  terrainEchoImpulse,
  type BlastSize,
} from './synth';

export const IMPACT_VARIANTS = 2;

export interface SynthBank {
  pulseWave: PeriodicWave;
  growlWave: PeriodicWave;
  airframeIR: AudioBuffer;
  echoIR: AudioBuffer;
  crack: AudioBuffer;
  impacts: Record<ImpactKind, AudioBuffer[]>;
  blasts: Record<BlastSize, AudioBuffer>;
  crackle: AudioBuffer;
  motor: AudioBuffer;
  whoosh: AudioBuffer;
  /** A Hydra 70 and a Maverick lighting (wave 2). */
  launches: Record<'rocket' | 'missile', AudioBuffer>;
  creak: AudioBuffer;
}

export function makeBuffer(ctx: BaseAudioContext, data: Float32Array): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.max(1, data.length), ctx.sampleRate);
  buffer.getChannelData(0).set(data);
  return buffer;
}

/** Render every synthesised sound once, at the context's sample rate (≈20–40 ms of work). */
export function buildSynthBank(ctx: BaseAudioContext): SynthBank {
  const sr = ctx.sampleRate;
  const { real, imag } = pulseWaveCoefficients();
  const growl = growlWaveCoefficients();
  const impacts = {} as Record<ImpactKind, AudioBuffer[]>;
  for (const kind of ['armour', 'ground', 'water', 'ricochet'] as ImpactKind[]) {
    impacts[kind] = [];
    for (let v = 0; v < IMPACT_VARIANTS; v++)
      impacts[kind].push(makeBuffer(ctx, renderImpact(sr, kind, v + 1)));
  }
  const blasts = {} as Record<BlastSize, AudioBuffer>;
  for (const size of ['small', 'medium', 'large', 'huge'] as BlastSize[]) {
    blasts[size] = makeBuffer(ctx, renderExplosion(sr, size, 1));
  }
  // an HEI shell is a small blast; a second variant keeps a burst from sounding like a loop
  impacts.hei = [blasts.small, makeBuffer(ctx, renderExplosion(sr, 'small', 2))];
  return {
    pulseWave: ctx.createPeriodicWave(real, imag, { disableNormalization: false }),
    growlWave: ctx.createPeriodicWave(growl.real, growl.imag, { disableNormalization: false }),
    airframeIR: makeBuffer(ctx, airframeImpulse(sr)),
    echoIR: makeBuffer(ctx, terrainEchoImpulse(sr)),
    crack: makeBuffer(ctx, renderCrack(sr)),
    impacts,
    blasts,
    crackle: makeBuffer(ctx, renderCrackle(sr)),
    motor: makeBuffer(ctx, renderMotor(sr)),
    whoosh: makeBuffer(ctx, renderWhoosh(sr)),
    launches: {
      rocket: makeBuffer(ctx, renderLaunch(sr, 'rocket')),
      missile: makeBuffer(ctx, renderLaunch(sr, 'missile')),
    },
    creak: makeBuffer(ctx, renderCreak(sr)),
  };
}

/** Shared building blocks and node bookkeeping for one engine instance. */
export class AudioKit {
  readonly white: AudioBuffer;
  readonly brown: AudioBuffer;
  readonly synth: SynthBank;
  /** Every node of the fixed graph. */
  readonly nodes: AudioNode[] = [];
  /** Sources that run for the engine's whole life (noise loops, oscillators). */
  readonly sources: AudioScheduledSourceNode[] = [];
  /** Nodes of one-shots still playing. */
  liveNodes = 0;
  private noiseOffset = 0;
  private started = false;

  constructor(
    readonly ctx: BaseAudioContext,
    readonly mixer: Mixer,
  ) {
    this.white = createWhiteNoise(ctx);
    this.brown = createBrownNoise(ctx);
    this.synth = buildSynthBank(ctx);
  }

  track<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  gain(value = 0): GainNode {
    const g = this.track(this.ctx.createGain());
    g.gain.value = value;
    return g;
  }

  filter(
    type: BiquadFilterType,
    frequency: number,
    q = Math.SQRT1_2,
    gainDb = 0,
  ): BiquadFilterNode {
    const f = this.track(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = q;
    f.gain.value = gainDb;
    return f;
  }

  panner(pan = 0): StereoPannerNode {
    const p = this.track(this.ctx.createStereoPanner());
    p.pan.value = pan;
    return p;
  }

  /** A looping noise source over a shared buffer, started with the engine, at its own phase. */
  noise(buffer: AudioBuffer, rate = 1): AudioBufferSourceNode {
    const src = this.track(this.ctx.createBufferSource());
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    this.persistent(src);
    return src;
  }

  /** A looping source over any buffer (a recording), started with the engine. */
  loop(buffer: AudioBuffer, rate = 1): AudioBufferSourceNode {
    const src = this.track(this.ctx.createBufferSource());
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    this.persistent(src);
    return src;
  }

  oscillator(type: OscillatorType, frequency: number): OscillatorNode {
    const osc = this.track(this.ctx.createOscillator());
    osc.type = type;
    osc.frequency.value = frequency;
    this.persistent(osc);
    return osc;
  }

  /**
   * A one-shot source playing `buffer` into `into` at `when`: disconnected when it ends. Only
   * the source node is created per sound; the chain it feeds is pooled by the caller.
   */
  playOnce(
    buffer: AudioBuffer,
    into: AudioNode,
    when: number,
    rate = 1,
    offset = 0,
  ): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(into);
    this.liveNodes++;
    src.addEventListener(
      'ended',
      () => {
        src.disconnect();
        this.liveNodes--;
      },
      { once: true },
    );
    src.start(when, offset);
    return src;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const now = this.ctx.currentTime;
    for (const src of this.sources) this.startSource(src, now);
  }

  stop(when: number): void {
    for (const src of this.sources) {
      try {
        src.stop(when);
      } catch {
        // never started
      }
    }
  }

  dispose(): void {
    for (const node of this.nodes) node.disconnect();
    this.nodes.length = 0;
  }

  private persistent(src: AudioScheduledSourceNode): void {
    this.sources.push(src);
    // sources added after start (a sample that arrived late) start right away
    if (this.started) this.startSource(src, this.ctx.currentTime);
  }

  private startSource(src: AudioScheduledSourceNode, now: number): void {
    if (src instanceof AudioBufferSourceNode && src.buffer) {
      // spread the read positions so no two voices play the same stretch
      this.noiseOffset = (this.noiseOffset + 0.377) % Math.max(0.5, NOISE_SECONDS - 0.5);
      src.start(now, this.noiseOffset % src.buffer.duration);
    } else {
      src.start(now);
    }
  }
}
