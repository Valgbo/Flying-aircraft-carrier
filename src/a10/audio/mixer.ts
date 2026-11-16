/**
 * The mixer: five buses, explicit ducking, and the master chain.
 *
 *   gun ───────────── trim ──────────┐
 *   engines ───────── trim ── duck ──┤
 *   airframe ──────── trim ── duck ──┼─ sum ─ high-pass 30 Hz ─ limiter ─ trim 0.85 ─ master ─ gate ─ out
 *   world ─────────── trim ── duck ──┤                                                (volume) (pause, mute,
 *   cockpit (tones) ─ trim ──────────┘                                                          hidden tab)
 *
 * Gain staging, not the limiter, makes the gun loud: the gun is the reference (about −6 to
 * −3 dBFS at the sum) and everything else sits well below it. While the gun fires in the cockpit
 * the engines, airframe and world are ducked explicitly (20 ms attack, 0.3 s release); the
 * cockpit bus (warning tones and voices) is never ducked. The limiter (−2 dB threshold, ratio 20,
 * hard knee) only catches what gets through: close explosions. The master volume and the gate
 * come after it, so the balance of the mix does not depend on the volume slider.
 *
 * Works on any BaseAudioContext, so the audio sandbox renders the same graph offline.
 */
import { SmoothParam } from '../../engine';
import { BUS_IDS, defaultTrims, sanitizeTrims, type BusId, type BusTrims } from './mappings';

/** Fade of the whole mix on pause, mute and hidden tab: about −40 dB after half a second. */
const TC_GATE = 0.11;
const TC_VOLUME = 0.08;
/** Ducking: ≈20 ms to settle on attack (3τ), ≈0.3 s on release. */
const TC_DUCK_ATTACK = 0.007;
const TC_DUCK_RELEASE = 0.1;
/** The compressor's automatic make-up gain (≈ +1.1 dB for these settings) is taken back here. */
export const LIMITER_TRIM = 0.85;
export const LIMITER_THRESHOLD = -2;
/** Sub-bass high-pass: below this, speakers only waste the limiter's headroom. */
export const SUB_BASS_HZ = 30;

/** How far each bus is ducked while the gun fires in the cockpit (linear gain). */
export const DUCK_DEPTH: Partial<Record<BusId, number>> = {
  engines: 0.4, // −8 dB
  airframe: 0.5, // −6 dB
  world: 0.5, // −6 dB
};

export interface LevelReading {
  rms: number;
  peak: number;
}

export interface MixerOptions {
  /** Create analysers on every bus and the master (debug handle, sandbox). */
  meters?: boolean;
  destination?: AudioNode;
  trims?: BusTrims;
}

/**
 * An AudioParam scheduled with explicit ramps (setValueAtTime + linearRampToValueAtTime only),
 * whose event times never go backwards.
 */
export class RampParam {
  private last = -Infinity;

  constructor(
    readonly param: AudioParam,
    initial: number,
  ) {
    param.value = initial;
  }

  /** Jump to `value` at `when` (anchors the following ramps). */
  set(value: number, when: number): void {
    if (!Number.isFinite(value)) return;
    const t = Math.max(when, this.last + 1e-4);
    this.param.setValueAtTime(value, t);
    this.last = t;
  }

  /** Ramp linearly from the previous event to `value` at `when`. */
  ramp(value: number, when: number): void {
    if (!Number.isFinite(value)) return;
    const t = Math.max(when, this.last + 1e-4);
    this.param.linearRampToValueAtTime(value, t);
    this.last = t;
  }
}

export class Mixer {
  readonly ctx: BaseAudioContext;
  /** Where voices connect, one per bus. */
  readonly buses: Record<BusId, GainNode>;
  /** Each bus after its trim and ducking (taps for meters and the sandbox). */
  readonly busOut: Record<BusId, AudioNode>;
  readonly sum: GainNode;
  /** The sum after the sub-bass high-pass: what the limiter sees ("before the limiter"). */
  readonly preLimiter: BiquadFilterNode;
  readonly limiter: DynamicsCompressorNode;
  /** Final node, connected to the destination. */
  readonly output: GainNode;
  readonly meters: Partial<Record<BusId | 'preLimiter' | 'output', AnalyserNode>> = {};

  private readonly nodes: AudioNode[] = [];
  private readonly ducks: Partial<Record<BusId, GainNode>> = {};
  private readonly trimParams: Record<BusId, SmoothParam>;
  private readonly master: SmoothParam;
  private readonly gate: SmoothParam;
  private readonly gateNode: GainNode;
  private readonly masterNode: GainNode;
  private trims: BusTrims;
  private ducked = false;
  private stopped = false;
  private meterBuffer: Float32Array<ArrayBuffer> | null = null;

  constructor(ctx: BaseAudioContext, opts: MixerOptions = {}) {
    this.ctx = ctx;
    this.trims = sanitizeTrims(opts.trims ?? defaultTrims());
    const sum = this.gain(1);
    this.sum = sum;
    const hp = this.track(ctx.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = SUB_BASS_HZ;
    hp.Q.value = Math.SQRT1_2;
    this.preLimiter = hp;
    const limiter = this.track(ctx.createDynamicsCompressor());
    limiter.threshold.value = LIMITER_THRESHOLD;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    this.limiter = limiter;
    const trim = this.gain(LIMITER_TRIM);
    const master = this.gain(0);
    const gate = this.gain(0);
    sum.connect(hp).connect(limiter).connect(trim).connect(master).connect(gate);
    gate.connect(opts.destination ?? ctx.destination);
    this.output = gate;
    this.gateNode = gate;
    this.masterNode = master;
    this.master = new SmoothParam(master.gain, TC_VOLUME, 0);
    this.gate = new SmoothParam(gate.gain, TC_GATE, 0);

    const buses = {} as Record<BusId, GainNode>;
    const busOut = {} as Record<BusId, AudioNode>;
    const trimParams = {} as Record<BusId, SmoothParam>;
    for (const id of BUS_IDS) {
      const input = this.gain(this.trims[id]);
      trimParams[id] = new SmoothParam(input.gain, TC_VOLUME, this.trims[id]);
      let out: AudioNode = input;
      if (DUCK_DEPTH[id] !== undefined) {
        const duck = this.gain(1);
        input.connect(duck);
        this.ducks[id] = duck;
        out = duck;
      }
      out.connect(sum);
      buses[id] = input;
      busOut[id] = out;
    }
    this.buses = buses;
    this.busOut = busOut;
    this.trimParams = trimParams;

    if (opts.meters) {
      for (const id of BUS_IDS) this.meters[id] = this.meter(busOut[id]);
      this.meters.preLimiter = this.meter(hp);
      this.meters.output = this.meter(gate);
    }
  }

  /** Nodes owned by the mixer. */
  get nodeCount(): number {
    return this.nodes.length;
  }

  get currentTrims(): BusTrims {
    return { ...this.trims };
  }

  /**
   * Master gain (already square-law) and whether anything should be heard at all. `immediate`
   * jumps instead of gliding (offline measurements).
   */
  setMaster(gain: number, audible: boolean, when = this.ctx.currentTime, immediate = false): void {
    if (this.stopped) return;
    if (immediate) {
      for (const [node, v] of [
        [this.masterNode, gain],
        [this.gateNode, audible ? 1 : 0],
      ] as const) {
        node.gain.cancelScheduledValues(0);
        node.gain.setValueAtTime(v, when);
      }
    }
    this.master.set(gain, when);
    this.gate.set(audible ? 1 : 0, when);
  }

  setTrims(trims: Partial<BusTrims>, when = this.ctx.currentTime): void {
    this.trims = sanitizeTrims(trims, this.trims);
    for (const id of BUS_IDS) this.trimParams[id].set(this.trims[id], when);
  }

  /** Duck the engines, airframe and world at `when` (the gun starts firing in the cockpit). */
  duck(when: number): void {
    if (this.ducked) return;
    this.ducked = true;
    for (const id of BUS_IDS) {
      const node = this.ducks[id];
      if (node) node.gain.setTargetAtTime(DUCK_DEPTH[id] ?? 1, when, TC_DUCK_ATTACK);
    }
  }

  /** Release the ducking at `when` (the gun stops, or the listener leaves the cockpit). */
  release(when: number): void {
    if (!this.ducked) return;
    this.ducked = false;
    for (const id of BUS_IDS) {
      const node = this.ducks[id];
      if (node) node.gain.setTargetAtTime(1, when, TC_DUCK_RELEASE);
    }
  }

  get isDucked(): boolean {
    return this.ducked;
  }

  /** Gain reduction of the limiter right now, dB (≤ 0). */
  get limiterReduction(): number {
    const r = this.limiter.reduction as unknown;
    return typeof r === 'number' ? r : ((r as { value?: number }).value ?? 0);
  }

  /** RMS and peak over the analyser window (≈43 ms at 48 kHz) of a metered point. */
  level(point: BusId | 'preLimiter' | 'output', out: LevelReading): LevelReading {
    const analyser = this.meters[point];
    out.rms = 0;
    out.peak = 0;
    if (!analyser) return out;
    if (!this.meterBuffer || this.meterBuffer.length !== analyser.fftSize) {
      this.meterBuffer = new Float32Array(analyser.fftSize);
    }
    const buf = this.meterBuffer;
    analyser.getFloatTimeDomainData(buf);
    let s = 0;
    let p = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      s += v * v;
      const a = Math.abs(v);
      if (a > p) p = a;
    }
    out.rms = Math.sqrt(s / buf.length);
    out.peak = p;
    return out;
  }

  /** Fade out fast (teardown). */
  stop(when = this.ctx.currentTime): void {
    if (this.stopped) return;
    this.stopped = true;
    this.gateNode.gain.setTargetAtTime(0, when, 0.03);
  }

  dispose(): void {
    for (const node of this.nodes) node.disconnect();
    this.nodes.length = 0;
  }

  private track<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  private gain(value: number): GainNode {
    const node = this.track(this.ctx.createGain());
    node.gain.value = value;
    return node;
  }

  private meter(node: AudioNode): AnalyserNode {
    const analyser = this.track(this.ctx.createAnalyser());
    analyser.fftSize = 2048;
    node.connect(analyser);
    return analyser;
  }
}
