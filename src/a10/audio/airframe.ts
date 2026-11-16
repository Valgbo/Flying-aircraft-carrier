/**
 * The airframe (PLAN_A10.md §13): airflow over the canopy by indicated airspeed (FlightGear's
 * wind loop and a synthesised hiss that brightens with speed), buffet near the stall and above
 * Vne, the speed brakes' rumble by their opening, the gear in the airflow, creaks under g, and
 * the clunk of a store leaving its rack. All of it is felt in the cockpit; outside only a little
 * airflow is left (the camera moving through the air).
 */
import { SmoothParam } from '../../engine';
import type { AudioKit } from './kit';
import { buffetGain, creakGain, gearGain, speedBrakeGain, windCutoff, windGain } from './mappings';
import { getSample } from './samples';

/** Levels at full effect (linear, measured in the audio sandbox). */
export const AIRFRAME_LEVELS = {
  wind: 0.2,
  hiss: 0.05,
  buffet: 0.45,
  speedBrake: 0.2,
  gear: 0.14,
  creak: 0.12,
  release: 0.5,
  /** Airflow left in outside views. */
  outsideWind: 0.3,
};

export interface AirframeInput {
  ias: number;
  alpha: number;
  gLoad: number;
  speedBrake: number;
  gearDown: boolean;
}

export class AirframeVoices {
  private windLoop: AudioBufferSourceNode | null = null;
  private readonly windIn: GainNode;
  private readonly windCutoff: SmoothParam;
  private readonly windLevel: SmoothParam;
  private readonly hissLevel: SmoothParam;
  private readonly buffetLevel: SmoothParam;
  private readonly speedBrakeLevel: SmoothParam;
  private readonly gearLevel: SmoothParam;
  private readonly creakOut: GainNode;
  private nextCreak = 0;
  private seed = 1;
  readonly state = { wind: 0, buffet: 0, speedBrake: 0 };

  constructor(private readonly kit: AudioKit) {
    const bus = kit.mixer.buses.airframe;
    // airflow: the recording and a hiss, darker when slow
    const windLp = kit.filter('lowpass', 800, 0.6);
    const windLevel = kit.gain(0);
    windLp.connect(windLevel).connect(bus);
    this.windIn = kit.gain(1);
    this.windIn.connect(windLp);
    this.windCutoff = new SmoothParam(windLp.frequency, 0.1, 800);
    this.windLevel = new SmoothParam(windLevel.gain, 0.1, 0);
    const hiss = kit.gain(0);
    kit.noise(kit.white, 0.91).connect(kit.filter('highpass', 900)).connect(hiss).connect(windLp);
    this.hissLevel = new SmoothParam(hiss.gain, 0.1, 0);

    // buffet: a low rumble shaken by an irregular 6–11 Hz flutter
    const buffetAm = kit.gain(0.6);
    const buffetDepth = kit.gain(0.3);
    const buffetOut = kit.gain(0);
    kit
      .noise(kit.brown, 1.13)
      .connect(kit.filter('lowpass', 75, 0.8))
      .connect(kit.filter('highpass', 22))
      .connect(buffetAm)
      .connect(buffetOut)
      .connect(bus);
    kit.oscillator('sine', 7.3).connect(buffetDepth).connect(buffetAm.gain);
    kit.oscillator('sine', 10.9).connect(buffetDepth);
    this.buffetLevel = new SmoothParam(buffetOut.gain, 0.12, 0);

    // speed brakes: turbulent flow off the split ailerons
    const sbOut = kit.gain(0);
    kit
      .noise(kit.white, 0.77)
      .connect(kit.filter('bandpass', 230, 0.9))
      .connect(kit.filter('lowpass', 900))
      .connect(sbOut)
      .connect(bus);
    this.speedBrakeLevel = new SmoothParam(sbOut.gain, 0.15, 0);

    // gear
    const gearOut = kit.gain(0);
    kit.noise(kit.brown, 0.95).connect(kit.filter('lowpass', 320)).connect(gearOut).connect(bus);
    this.gearLevel = new SmoothParam(gearOut.gain, 0.2, 0);

    // creaks (one-shots)
    this.creakOut = kit.gain(AIRFRAME_LEVELS.creak);
    this.creakOut.connect(bus);
    this.attachSamples();
  }

  attachSamples(): void {
    if (this.windLoop) return;
    const buffer = getSample('wind');
    if (!buffer) return;
    this.windLoop = this.kit.loop(buffer, 1);
    this.windLoop.connect(this.windIn);
  }

  /**
   * Once per frame. In outside views only airflow is left, driven by the camera's own speed.
   */
  update(when: number, a: AirframeInput, inCockpit: boolean, listenerSpeed: number): void {
    const ias = inCockpit ? a.ias : listenerSpeed;
    const w = windGain(ias);
    const level = inCockpit
      ? AIRFRAME_LEVELS.wind
      : AIRFRAME_LEVELS.wind * AIRFRAME_LEVELS.outsideWind;
    this.windLevel.set(level * w, when);
    this.hissLevel.set((AIRFRAME_LEVELS.hiss / AIRFRAME_LEVELS.wind) * Math.sqrt(w), when);
    this.windCutoff.set(windCutoff(ias), when);
    const buffet = inCockpit ? buffetGain(a.alpha, a.ias) : 0;
    const sb = inCockpit ? speedBrakeGain(a.speedBrake, a.ias) : 0;
    this.buffetLevel.set(AIRFRAME_LEVELS.buffet * buffet, when);
    this.speedBrakeLevel.set(AIRFRAME_LEVELS.speedBrake * sb, when);
    this.gearLevel.set(inCockpit ? AIRFRAME_LEVELS.gear * gearGain(a.gearDown, a.ias) : 0, when);
    this.state.wind = w;
    this.state.buffet = buffet;
    this.state.speedBrake = sb;

    // creaks: the harder the pull, the more often (never more than ~3 a second)
    const creak = inCockpit ? creakGain(a.gLoad) : 0;
    if (creak > 0.05 && when >= this.nextCreak) {
      this.seed = (this.seed * 16807) % 2147483647;
      const r = this.seed / 2147483647;
      this.kit.playOnce(this.kit.synth.creak, this.creakOut, when, 0.8 + 0.5 * r);
      this.nextCreak = when + 0.35 + (1.6 - 1.2 * creak) * (0.5 + r);
    }
  }

  /** A store leaves its rack: the ejector cartridges and the clunk through the airframe. */
  release(when: number): void {
    const buffer = getSample('bombRelease');
    if (!buffer) return;
    const g = this.kit.ctx.createGain();
    g.gain.value = AIRFRAME_LEVELS.release;
    g.connect(this.kit.mixer.buses.airframe);
    const src = this.kit.playOnce(buffer, g, when);
    src.addEventListener('ended', () => g.disconnect(), { once: true });
  }
}
