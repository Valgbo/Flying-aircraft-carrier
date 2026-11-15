/**
 * The audio engine: a fixed Web Audio graph, built once, whose parameters follow an
 * `AudioFrame` (a plain snapshot of what the listener should hear right now).
 *
 *   turbine voices, jet voices ─► engines bus ─┐
 *   wind, sea, spray, one-shots ─► effects bus ─┴► master ─► gate ─► limiter ─► trim ─► out
 *
 * The engine knows nothing about the simulation or React: `simAudioFrame.ts` fills the frame
 * from `sim`, `AudioManager.tsx` owns the AudioContext and calls `update` once per animation
 * frame. It works on any BaseAudioContext, so the same graph renders in an
 * OfflineAudioContext for analysis. The pure parameter mappings are re-exported from here.
 */
import type { Quad } from '../state/types';
import { NOISE_SECONDS, SmoothParam, createBrownNoise, createWhiteNoise } from './audioGraph';
import {
  TURBINE_DETUNE,
  WHINE_PARTIALS,
  distanceCutoff,
  distanceGain,
  dopplerFactor,
  jetGain,
  jetNoiseHz,
  jetToneHz,
  offsetToPan,
  seaBedGain,
  sprayGain,
  turbineRoarCutoff,
  turbineRoarGain,
  turbineRumbleGain,
  turbineWhineGain,
  turbineWhineHz,
  volumeToGain,
  windBuffetDepth,
  windCutoff,
  windGain,
} from './audioMappings';
import { scheduleOneShot, type OneShotKind } from './oneShots';

export * from './audioMappings';
export type { OneShotKind } from './oneShots';

/** Jets that can be heard at the same time. */
export const MAX_JET_VOICES = 4;

/** A sound source as the listener hears it: offset in CAMERA space (+x right, +y up, -z ahead), m. */
export interface SourceOffset {
  x: number;
  y: number;
  z: number;
}

export interface TurbineFrame extends SourceOffset {
  /** Fan speed 0..1 (turbineRpmFraction): 0.1 at idle, 0 once a switched-off engine has spooled down. */
  rpm: number;
  /** Actual throttle 0..1. */
  throttle: number;
}

export interface JetFrame extends SourceOffset {
  /** False = this voice is silent (no jet assigned, or the jet is parked). */
  active: boolean;
  /** Engine power 0..1. */
  power: number;
  /** Rate of change of the distance to the listener, m/s (positive = moving away). */
  radialVelocity: number;
}

/** Everything the engine needs to know about one moment. Reused every frame (no allocation). */
export interface AudioFrame {
  turbines: Quad<TurbineFrame>;
  jets: Quad<JetFrame>;
  /** Speed of the ship through the air, m/s. */
  airspeed: number;
  gLoad: number;
  /** 0..1 scale on the airflow (subdued in the menu / hangar idle scenes). */
  windScale: number;
  /** Listener height above mean sea level, m. */
  cameraHeight: number;
  /** Strongest turbine downwash on the sea, 0..1. */
  downwash: number;
  /** Distance from the listener to the ship's origin, m. */
  shipDistance: number;
}

export function createAudioFrame(): AudioFrame {
  const turbine = (): TurbineFrame => ({ x: 0, y: 0, z: -100, rpm: 0, throttle: 0 });
  const jet = (): JetFrame => ({
    x: 0,
    y: 0,
    z: -100,
    active: false,
    power: 0,
    radialVelocity: 0,
  });
  return {
    turbines: [turbine(), turbine(), turbine(), turbine()],
    jets: [jet(), jet(), jet(), jet()],
    airspeed: 0,
    gLoad: 1,
    windScale: 1,
    cameraHeight: 400,
    downwash: 0,
    shipDistance: 100,
  };
}

/** Target values of the main parameters, for tests and the sandbox read-out. */
export interface EngineSnapshot {
  master: number;
  gate: number;
  engines: number;
  effects: number;
  turbines: { roar: number; cutoff: number; whineHz: number; level: number; pan: number }[];
  jets: { level: number; pitch: number; pan: number }[];
  wind: number;
  sea: number;
  spray: number;
}

/** Time constants of the parameter glides, seconds. */
const TC_GAIN = 0.08;
const TC_TONE = 0.06;
const TC_PLACE = 0.1;
/** Fade of the whole mix on pause / mute / hide: about -40 dB after half a second. */
const TC_GATE = 0.11;
/** Fade used by stop(), and how long after it the sources are stopped. */
const TC_STOP = 0.03;
const STOP_TAIL = 0.25;
/** Simultaneous one-shots; further triggers are dropped (keeps the node count bounded). */
const MAX_LIVE_SHOTS = 10;
/** The compressor adds make-up gain for its settings; this trim takes it back out. */
const LIMITER_TRIM = 0.7;
/** Read rates of the shared noise loop per turbine: decorrelates the four roars. */
const TURBINE_NOISE_RATE: readonly number[] = [1, 0.93, 1.07, 0.97];
/** Relative levels of the three whine partials. */
const WHINE_PARTIAL_GAIN: readonly number[] = [0.5, 0.3, 0.2];

interface Placement {
  lowpass: SmoothParam;
  gain: SmoothParam;
  pan: SmoothParam;
}

interface TurbineVoice {
  roarCutoff: SmoothParam;
  roarGain: SmoothParam;
  whineHz: SmoothParam[];
  whineGain: SmoothParam;
  rumbleGain: SmoothParam;
  place: Placement;
}

interface JetVoice {
  noiseHz: SmoothParam;
  noiseRate: SmoothParam;
  toneHz: SmoothParam;
  level: SmoothParam;
  place: Placement;
}

export class AudioEngine {
  readonly ctx: BaseAudioContext;
  /** Final node of the chain (after the limiter); already connected to the destination. */
  readonly output: AudioNode;

  private readonly white: AudioBuffer;
  private readonly brown: AudioBuffer;
  /** Every node of the fixed graph, for teardown and the node count. */
  private readonly nodes: AudioNode[] = [];
  private readonly noiseSources: AudioBufferSourceNode[] = [];
  private readonly oscillators: OscillatorNode[] = [];
  private readonly enginesBus: GainNode;
  private readonly effectsBus: GainNode;
  private readonly gateNode: GainNode;

  private readonly master: SmoothParam;
  private readonly gate: SmoothParam;
  private readonly enginesLevel: SmoothParam;
  private readonly effectsLevel: SmoothParam;
  private readonly turbines: TurbineVoice[] = [];
  private readonly jets: JetVoice[] = [];
  private readonly windCutoff: SmoothParam;
  private readonly windBuffet: SmoothParam;
  private readonly windLevel: SmoothParam;
  private readonly seaLevel: SmoothParam;
  private readonly sprayLevel: SmoothParam;

  private started = false;
  private stopped = false;
  private audible = false;
  private liveShots = 0;
  private liveShotNodes = 0;
  private shotCounter = 0;

  constructor(ctx: BaseAudioContext, destination: AudioNode = ctx.destination) {
    this.ctx = ctx;
    this.white = createWhiteNoise(ctx);
    this.brown = createBrownNoise(ctx);

    // ---- output chain ----
    const master = this.gainNode(0);
    const gate = this.gainNode(0);
    const limiter = this.track(ctx.createDynamicsCompressor());
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    const trim = this.gainNode(LIMITER_TRIM);
    master.connect(gate).connect(limiter).connect(trim).connect(destination);
    this.output = trim;
    this.gateNode = gate;
    this.master = new SmoothParam(master.gain, TC_GAIN, 0);
    this.gate = new SmoothParam(gate.gain, TC_GATE, 0);

    this.enginesBus = this.gainNode(0);
    this.effectsBus = this.gainNode(0);
    this.enginesBus.connect(master);
    this.effectsBus.connect(master);
    this.enginesLevel = new SmoothParam(this.enginesBus.gain, TC_GAIN, 0);
    this.effectsLevel = new SmoothParam(this.effectsBus.gain, TC_GAIN, 0);

    for (let i = 0; i < 4; i++) this.turbines.push(this.buildTurbine(i));
    for (let i = 0; i < MAX_JET_VOICES; i++) this.jets.push(this.buildJet(i));

    // ---- wind: noise -> low-pass (brightness) -> high-pass -> buffet (LFO) -> level ----
    const windLp = this.filterNode('lowpass', 250, 0.6);
    const windHp = this.filterNode('highpass', 110, 0.5);
    const buffet = this.gainNode(1);
    const buffetDepth = this.gainNode(0);
    const windOut = this.gainNode(0);
    this.noiseSource(this.white, 0.81, 1.7).connect(windLp).connect(windHp).connect(buffet);
    buffet.connect(windOut).connect(this.effectsBus);
    this.oscillator('sine', 1.3).connect(buffetDepth).connect(buffet.gain);
    this.windCutoff = new SmoothParam(windLp.frequency, TC_GAIN, 250);
    this.windBuffet = new SmoothParam(buffetDepth.gain, TC_GAIN, 0);
    this.windLevel = new SmoothParam(windOut.gain, TC_GAIN, 0);

    // ---- sea: a low surf bed breathing with a slow swell, and a bright spray hiss ----
    const seaLp = this.filterNode('lowpass', 620, 0.5);
    const swell = this.gainNode(0.65);
    const swellDepth = this.gainNode(0.35);
    const seaOut = this.gainNode(0);
    this.noiseSource(this.white, 0.62, 2.9).connect(seaLp).connect(swell);
    swell.connect(seaOut).connect(this.effectsBus);
    this.oscillator('sine', 0.11).connect(swellDepth).connect(swell.gain);
    this.seaLevel = new SmoothParam(seaOut.gain, 0.3, 0);

    const sprayHp = this.filterNode('highpass', 1500, 0.6);
    const sprayLp = this.filterNode('lowpass', 6500, 0.5);
    const sprayOut = this.gainNode(0);
    this.noiseSource(this.white, 1.13, 0.6).connect(sprayHp).connect(sprayLp).connect(sprayOut);
    sprayOut.connect(this.effectsBus);
    this.sprayLevel = new SmoothParam(sprayOut.gain, 0.15, 0);
  }

  /** Nodes currently alive: the fixed graph plus any one-shots still sounding. */
  get nodeCount(): number {
    return this.nodes.length + this.liveShotNodes;
  }

  /** Start every source. The mix stays silent until `setMix` opens the gate. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const now = this.ctx.currentTime;
    for (let i = 0; i < this.noiseSources.length; i++) {
      // spread the read positions so no two voices play the same stretch of noise
      this.noiseSources[i].start(now, (i * 0.377) % (NOISE_SECONDS - 0.5));
    }
    for (const osc of this.oscillators) osc.start(now);
  }

  /** Fade out quickly and stop the sources shortly after. Call `dispose` once that has passed. */
  stop(): void {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    this.audible = false;
    const now = this.ctx.currentTime;
    // faster than the gate's usual glide: a teardown must be over before the sources stop
    this.gateNode.gain.setTargetAtTime(0, now, TC_STOP);
    for (const source of this.noiseSources) source.stop(now + STOP_TAIL);
    for (const osc of this.oscillators) osc.stop(now + STOP_TAIL);
  }

  /** Disconnect the whole graph. The engine is unusable afterwards. */
  dispose(): void {
    for (const node of this.nodes) node.disconnect();
    this.nodes.length = 0;
  }

  /**
   * Volume settings (0..1 sliders) and whether anything should be heard at all (false while
   * muted, paused or hidden: the whole mix fades out and one-shots are dropped).
   */
  setMix(
    master: number,
    engines: number,
    effects: number,
    audible: boolean,
    when = this.ctx.currentTime,
  ): void {
    if (this.stopped) return;
    this.audible = audible;
    this.master.set(volumeToGain(master), when);
    this.enginesLevel.set(volumeToGain(engines), when);
    this.effectsLevel.set(volumeToGain(effects), when);
    this.gate.set(audible ? 1 : 0, when);
  }

  /** Move every parameter of the fixed graph toward what `frame` describes. */
  update(frame: AudioFrame, when = this.ctx.currentTime): void {
    if (this.stopped) return;
    for (let i = 0; i < 4; i++) {
      const voice = this.turbines[i];
      const t = frame.turbines[i];
      const hz = turbineWhineHz(t.rpm) * TURBINE_DETUNE[i];
      voice.roarCutoff.set(turbineRoarCutoff(t.rpm), when);
      voice.roarGain.set(turbineRoarGain(t.rpm), when);
      for (let k = 0; k < WHINE_PARTIALS.length; k++) {
        voice.whineHz[k].set(hz * WHINE_PARTIALS[k], when);
      }
      voice.whineGain.set(turbineWhineGain(t.rpm), when);
      voice.rumbleGain.set(turbineRumbleGain(t.throttle), when);
      this.place(voice.place, t, when);
    }
    for (let i = 0; i < MAX_JET_VOICES; i++) {
      const voice = this.jets[i];
      const j = frame.jets[i];
      const doppler = dopplerFactor(j.radialVelocity);
      voice.level.set(jetGain(j.power, j.active), when);
      if (j.active) {
        voice.noiseHz.set(jetNoiseHz(j.power) * doppler, when);
        voice.noiseRate.set(doppler, when);
        voice.toneHz.set(jetToneHz(j.power) * doppler, when);
        this.place(voice.place, j, when);
      }
    }
    this.windCutoff.set(windCutoff(frame.airspeed), when);
    this.windBuffet.set(windBuffetDepth(frame.gLoad), when);
    this.windLevel.set(windGain(frame.airspeed, frame.gLoad) * frame.windScale, when);
    this.seaLevel.set(seaBedGain(frame.cameraHeight), when);
    this.sprayLevel.set(sprayGain(frame.downwash) * distanceGain(frame.shipDistance), when);
  }

  /**
   * Play a one-shot effect. `intensity`, `pan` and `gain` scale and place this instance.
   * Returns false when it was dropped (engine silent or stopped, or too many effects at once).
   */
  playOneShot(
    kind: OneShotKind,
    intensity = 1,
    pan = 0,
    gain = 1,
    when = this.ctx.currentTime,
  ): boolean {
    if (!this.started || this.stopped || !this.audible) return false;
    if (this.liveShots >= MAX_LIVE_SHOTS) return false;
    const ctx = this.ctx;
    const level = ctx.createGain();
    level.gain.value = Math.min(1, Math.max(0, gain));
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.min(1, Math.max(-1, pan));
    level.connect(panner).connect(this.effectsBus);
    this.shotCounter++;
    const shot = scheduleOneShot(
      ctx,
      level,
      this.white,
      kind,
      Math.min(1, Math.max(0, intensity)),
      when + 0.01,
      (this.shotCounter * 0.619) % (NOISE_SECONDS - 0.1),
    );
    const nodes = shot.nodes;
    nodes.push(level, panner);
    this.liveShots++;
    this.liveShotNodes += nodes.length;
    shot.last.addEventListener(
      'ended',
      () => {
        for (const node of nodes) node.disconnect();
        this.liveShots--;
        this.liveShotNodes -= nodes.length;
      },
      { once: true },
    );
    return true;
  }

  /** Current target values (allocates: for tests and debug read-outs, not for the frame loop). */
  snapshot(): EngineSnapshot {
    return {
      master: this.master.target,
      gate: this.gate.target,
      engines: this.enginesLevel.target,
      effects: this.effectsLevel.target,
      turbines: this.turbines.map((v) => ({
        roar: v.roarGain.target,
        cutoff: v.roarCutoff.target,
        whineHz: v.whineHz[0].target,
        level: v.place.gain.target,
        pan: v.place.pan.target,
      })),
      jets: this.jets.map((v) => ({
        level: v.level.target * v.place.gain.target,
        pitch: v.toneHz.target,
        pan: v.place.pan.target,
      })),
      wind: this.windLevel.target,
      sea: this.seaLevel.target,
      spray: this.sprayLevel.target,
    };
  }

  // ---- graph construction -----------------------------------------------------------------

  private track<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  private gainNode(value: number): GainNode {
    const node = this.track(this.ctx.createGain());
    node.gain.value = value;
    return node;
  }

  private filterNode(type: BiquadFilterType, frequency: number, q: number): BiquadFilterNode {
    const node = this.track(this.ctx.createBiquadFilter());
    node.type = type;
    node.frequency.value = frequency;
    node.Q.value = q;
    return node;
  }

  private noiseSource(buffer: AudioBuffer, rate: number, loopStart: number) {
    const node = this.track(this.ctx.createBufferSource());
    node.buffer = buffer;
    node.loop = true;
    // different loop starts give each voice its own loop length as well as its own phase
    node.loopStart = loopStart * 0.1;
    node.loopEnd = NOISE_SECONDS;
    node.playbackRate.value = rate;
    this.noiseSources.push(node);
    return node;
  }

  private oscillator(type: OscillatorType, frequency: number): OscillatorNode {
    const node = this.track(this.ctx.createOscillator());
    node.type = type;
    node.frequency.value = frequency;
    this.oscillators.push(node);
    return node;
  }

  /** Distance low-pass -> distance gain -> stereo pan -> `bus`. Returns the input node. */
  private buildPlacement(bus: AudioNode): { input: AudioNode; place: Placement } {
    const lowpass = this.filterNode('lowpass', 18000, 0.5);
    const gain = this.gainNode(0);
    const panner = this.track(this.ctx.createStereoPanner());
    lowpass.connect(gain).connect(panner).connect(bus);
    return {
      input: lowpass,
      place: {
        lowpass: new SmoothParam(lowpass.frequency, TC_PLACE, 18000),
        gain: new SmoothParam(gain.gain, TC_PLACE, 0),
        pan: new SmoothParam(panner.pan, TC_PLACE, 0),
      },
    };
  }

  private place(place: Placement, offset: SourceOffset, when: number): void {
    const distance = Math.hypot(offset.x, offset.y, offset.z);
    place.lowpass.set(distanceCutoff(distance), when);
    place.gain.set(distanceGain(distance), when);
    place.pan.set(offsetToPan(offset.x, offset.y, offset.z), when);
  }

  private buildTurbine(index: number): TurbineVoice {
    const { input, place } = this.buildPlacement(this.enginesBus);

    // (1) jet roar: shared noise, opened up by a low-pass as the fan speeds up
    const roarLp = this.filterNode('lowpass', 300, 0.8);
    const roarHp = this.filterNode('highpass', 70, 0.5);
    const roarOut = this.gainNode(0);
    this.noiseSource(this.white, TURBINE_NOISE_RATE[index], index + 1)
      .connect(roarLp)
      .connect(roarHp)
      .connect(roarOut)
      .connect(input);

    // (2) fan whine: three partials tracking fan speed, softened by a low-pass
    const whineLp = this.filterNode('lowpass', 3200, 0.5);
    const whineOut = this.gainNode(0);
    whineLp.connect(whineOut).connect(input);
    const whineHz: SmoothParam[] = [];
    for (let k = 0; k < WHINE_PARTIALS.length; k++) {
      const hz = turbineWhineHz(0) * TURBINE_DETUNE[index] * WHINE_PARTIALS[k];
      const osc = this.oscillator(k === 0 ? 'sawtooth' : 'sine', hz);
      const partial = this.gainNode(WHINE_PARTIAL_GAIN[k]);
      osc.connect(partial).connect(whineLp);
      whineHz.push(new SmoothParam(osc.frequency, TC_TONE, hz));
    }

    // (3) rumble: brown noise below ~110 Hz (the high-pass keeps it free of DC)
    const rumbleLp = this.filterNode('lowpass', 110, 0.7);
    const rumbleHp = this.filterNode('highpass', 24, 0.5);
    const rumbleOut = this.gainNode(0);
    this.noiseSource(this.brown, 1 - index * 0.04, index + 5)
      .connect(rumbleLp)
      .connect(rumbleHp)
      .connect(rumbleOut)
      .connect(input);

    return {
      roarCutoff: new SmoothParam(roarLp.frequency, TC_GAIN, 300),
      roarGain: new SmoothParam(roarOut.gain, TC_GAIN, 0),
      whineHz,
      whineGain: new SmoothParam(whineOut.gain, TC_GAIN, 0),
      rumbleGain: new SmoothParam(rumbleOut.gain, 0.15, 0),
      place,
    };
  }

  private buildJet(index: number): JetVoice {
    const { input, place } = this.buildPlacement(this.enginesBus);
    const level = this.gainNode(0);
    level.connect(input);

    const noise = this.noiseSource(this.white, 1, index + 10);
    const band = this.filterNode('bandpass', 500, 0.8);
    noise.connect(band).connect(level);

    const tone = this.oscillator('sawtooth', jetToneHz(0));
    const toneLp = this.filterNode('lowpass', 1200, 0.5);
    const toneGain = this.gainNode(0.2);
    tone.connect(toneLp).connect(toneGain).connect(level);

    return {
      noiseHz: new SmoothParam(band.frequency, TC_TONE, 500),
      noiseRate: new SmoothParam(noise.playbackRate, TC_TONE, 1),
      toneHz: new SmoothParam(tone.frequency, TC_TONE, jetToneHz(0)),
      level: new SmoothParam(level.gain, TC_GAIN, 0),
      place,
    };
  }
}
