/**
 * The two TF34 turbofans (PLAN_A10.md §13): FlightGear's fan, whine and jet loops, crossfaded and
 * pitched by each engine's fan (N1) and core (N2) speed, so a spool-up is heard as it happens.
 *
 * In the cockpit the engines are behind and either side of the pilot: the cockpit fan loop, the
 * core whine and a muffled roar, low-passed by the canopy, a little left and right. Outside, the
 * outside fan, the high whine and the exhaust roar, placed at the aircraft with spreading loss
 * and air absorption, at the retarded time (a fly-by passes with its Doppler shift).
 * The two engines never sit exactly in tune: a small fixed detune and their own loop phases.
 */
import { SmoothParam } from '../../engine';
import type { AudioKit } from './kit';
import type { AudioListener } from './listener';
import { createEngineLayers, engineLayers, type EngineLayers } from './mappings';
import { absorptionCutoff, distanceGain, dopplerFactor, type SourceSample } from './propagation';
import { getSample, type SampleId } from './samples';

/**
 * Overall levels (linear): in the cockpit (measured in the audio sandbox: ≈ −27.5 dBFS RMS at MAX,
 * ≈ −35.5 at idle, ≥ 12 dB under the gun), and outside at 30 m.
 */
export const ENGINE_LEVELS = { inside: 0.2, outside: 0.3 };
const OUTSIDE_REF_DISTANCE = 30;
/** Softened spreading loss outside (as for the gun, gun.ts OUTSIDE_ROLLOFF). */
const OUTSIDE_ROLLOFF = 0.7;
/** Layer weights in the cockpit and outside. */
const INSIDE_MIX = { fan: 0, fanInside: 0.5, whine: 0.12, whineLow: 0.4, jet: 0.45 };
const OUTSIDE_MIX = { fan: 0.6, fanInside: 0, whine: 0.35, whineLow: 0.12, jet: 0.75 };
const DETUNE = [0.994, 1.006];
const INSIDE_PAN = [-0.3, 0.3];
const INSIDE_CUTOFF = 2600;

type Layer = 'fan' | 'fanInside' | 'whine' | 'whineLow' | 'jet';
const LAYERS: { layer: Layer; sample: SampleId; rate: 'fanRate' | 'whineRate' | 'jetRate' }[] = [
  { layer: 'fan', sample: 'engineFan', rate: 'fanRate' },
  { layer: 'fanInside', sample: 'engineFanInside', rate: 'fanRate' },
  { layer: 'whine', sample: 'engineWhine', rate: 'whineRate' },
  { layer: 'whineLow', sample: 'engineWhineLow', rate: 'whineRate' },
  { layer: 'jet', sample: 'engineJet', rate: 'jetRate' },
];

interface EngineVoice {
  sources: (AudioBufferSourceNode | null)[];
  rates: (SmoothParam | null)[];
  gains: SmoothParam[];
  inputs: GainNode[];
  cutoff: SmoothParam;
  level: SmoothParam;
  pan: SmoothParam;
  layers: EngineLayers;
}

export interface EngineInput {
  n1: number;
  n2: number;
  running: boolean;
}

export class EngineVoices {
  private readonly voices: EngineVoice[] = [];
  /** Last overall level per engine, for the debug handle. */
  readonly state = { levels: [0, 0], n1: [0, 0], doppler: 1 };

  constructor(private readonly kit: AudioKit) {
    for (let e = 0; e < 2; e++) {
      const sum = kit.gain(1);
      const lp = kit.filter('lowpass', INSIDE_CUTOFF, 0.6);
      const level = kit.gain(0);
      const pan = kit.panner(INSIDE_PAN[e]);
      sum.connect(lp).connect(level).connect(pan).connect(kit.mixer.buses.engines);
      const inputs: GainNode[] = [];
      const gains: SmoothParam[] = [];
      for (let k = 0; k < LAYERS.length; k++) {
        const g = kit.gain(0);
        g.connect(sum);
        inputs.push(g);
        gains.push(new SmoothParam(g.gain, 0.08, 0));
      }
      this.voices.push({
        sources: LAYERS.map(() => null),
        rates: LAYERS.map(() => null),
        gains,
        inputs,
        cutoff: new SmoothParam(lp.frequency, 0.1, INSIDE_CUTOFF),
        level: new SmoothParam(level.gain, 0.1, 0),
        pan: new SmoothParam(pan.pan, 0.1, INSIDE_PAN[e]),
        layers: createEngineLayers(),
      });
    }
    this.attachSamples();
  }

  /** Start the loop players whose recordings are decoded. */
  attachSamples(): void {
    this.voices.forEach((voice, e) => {
      LAYERS.forEach(({ sample }, k) => {
        if (voice.sources[k]) return;
        const buffer = getSample(sample);
        if (!buffer) return;
        const src = this.kit.loop(buffer, 1);
        src.connect(voice.inputs[k]);
        voice.sources[k] = src;
        voice.rates[k] = new SmoothParam(src.playbackRate, 0.06, DETUNE[e]);
      });
    });
  }

  /**
   * Once per frame. `engines` is the aircraft's engine state now (cockpit), `ret` the aircraft at
   * the retarded time (outside), `alive` false after a crash.
   */
  update(
    when: number,
    engines: readonly EngineInput[],
    listener: AudioListener,
    ret: SourceSample,
    c: number,
    alive: boolean,
  ): void {
    const inside = listener.inCockpit;
    const mix = inside ? INSIDE_MIX : OUTSIDE_MIX;
    let level = ENGINE_LEVELS.inside;
    let cutoff = INSIDE_CUTOFF;
    let doppler = 1;
    let pan = 0;
    if (!inside) {
      const d = listener.distanceTo(ret.x, ret.y, ret.z);
      level = ENGINE_LEVELS.outside * distanceGain(d, OUTSIDE_REF_DISTANCE, OUTSIDE_ROLLOFF);
      cutoff = Math.min(18000, absorptionCutoff(d));
      doppler = dopplerFactor(ret, listener, c);
      pan = listener.panOf(ret.x, ret.y, ret.z);
    }
    this.state.doppler = doppler;
    for (let e = 0; e < 2; e++) {
      const voice = this.voices[e];
      const n1 = inside ? engines[e].n1 : e === 0 ? ret.n1a : ret.n1b;
      const n2 = inside ? engines[e].n2 : e === 0 ? ret.n2a : ret.n2b;
      const layers = engineLayers(n1, n2, engines[e].running && alive, voice.layers);
      for (let k = 0; k < LAYERS.length; k++) {
        const { layer, rate } = LAYERS[k];
        voice.gains[k].set(layers[layer] * mix[layer], when);
        voice.rates[k]?.set(layers[rate] * DETUNE[e] * doppler, when);
      }
      const l = alive ? level : 0;
      voice.level.set(l, when);
      voice.cutoff.set(cutoff, when);
      voice.pan.set(inside ? INSIDE_PAN[e] : pan, when);
      this.state.levels[e] = l;
      this.state.n1[e] = n1;
    }
  }
}
