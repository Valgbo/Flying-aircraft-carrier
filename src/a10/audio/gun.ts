/**
 * The GAU-8/A (PLAN_A10.md §6.2, §13).
 *
 * In the cockpit the pilot hears the gun through the airframe:
 *   - the FlightGear recording (a 69.7 shots/s loop) played at rate/69.7, so at full rate its
 *     shots come at the real 65 per second; low-passed and given body around 180 Hz;
 *   - a pulse train, one pulse per round at the sim's instantaneous rate, through the airframe's
 *     modes (a convolution with a synthesised impulse response): the 65 Hz growl and the thump of
 *     every round, from the very first one of the spin-up;
 *   - a low rumble, and the hydraulic drive's whine that rises over the spin-up and falls with the
 *     spin-down.
 * Outside, the recording as it is, brighter, heard at the RETARDED time (the gun as it was when
 * the sound left it), with Doppler, spreading loss and air absorption; the crack of the rounds
 * passing the listener is the world module's (world.ts).
 *
 * Timing: gunStart / gunStop carry the sim time of the burst's first and last round; the
 * envelopes are scheduled at exactly those times on the audio clock (SimAudioClock). Between
 * them the rate and spin are followed frame by frame with linear ramps placed at each frame's
 * own audio time, so the spin-up is reproduced as the simulation computed it.
 */
import { SmoothParam } from '../../engine';
import type { AudioKit } from './kit';
import type { AudioListener } from './listener';
import {
  gunLoopGain,
  gunLoopRate,
  gunPulseGain,
  gunPulseHz,
  gunRumbleGain,
  gunWhineGain,
  gunWhineHz,
} from './mappings';
import { RampParam } from './mixer';
import { absorptionCutoff, distanceGain, dopplerFactor, type SourceSample } from './propagation';
import { getSample } from './samples';

/**
 * Levels of the layers at full rate (linear). Measured in the audio sandbox, gun bus in the
 * cockpit: loop ≈ −15.5, pulse ≈ −17.5, rumble ≈ −26, whine ≈ −32 dBFS RMS, together ≈ −13 dBFS
 * RMS with peaks near −5 dBFS (the loudness reference of the whole mix).
 */
export const GUN_LEVELS = {
  loop: 0.24,
  pulse: 0.18,
  rumble: 0.4,
  whine: 0.08,
  /**
   * Outside, at OUTSIDE_REF_DISTANCE: the recording, and the growl of the muzzle blasts (a chase
   * camera 30 m back hears peaks near −4 dBFS; from the target at 1,150 m about −38 dBFS RMS).
   */
  outside: 0.42,
  growl: 0.38,
  /** The terrain echo under the outside gun (the tail of a burst). */
  echo: 0.2,
};
/** Distance at which the outside gun has its reference level, m. */
export const OUTSIDE_REF_DISTANCE = 15;
/**
 * Spreading loss of the gun outside, as an exponent of distance: 0.65 ≈ −3.9 dB per doubling
 * instead of the physical −6, so the growl still carries at the ranges the gun is fired from
 * (the dynamic range of a game is far smaller than that of a range).
 */
export const OUTSIDE_ROLLOFF = 0.65;
/** Partials of the drive whine (the hydraulic motor and its gear mesh). */
const WHINE_PARTIALS = [1, 2.02, 3.4];
const WHINE_PARTIAL_GAIN = [0.6, 0.3, 0.15];

/** Envelope time constants, s: the first round's attack, the cut when the trigger is released. */
const TC_ATTACK = 0.003;
const TC_RELEASE = 0.008;
const TC_RUMBLE_RELEASE = 0.05;
const TC_FOLLOW = 0.015;

export class GunVoices {
  /** True between gunStart and gunStop (the cockpit voice's view of the burst). */
  firing = false;
  private loop: AudioBufferSourceNode | null = null;
  private loopRate: RampParam | null = null;
  private readonly loopEnv: GainNode;
  private readonly pulseHz: RampParam;
  private readonly pulseEnv: GainNode;
  private readonly rumbleEnv: GainNode;
  private readonly whineHz: RampParam[] = [];
  private readonly whineBand: RampParam;
  private readonly whineLevel: SmoothParam;
  private readonly inside: SmoothParam;
  private outsideLoop: AudioBufferSourceNode | null = null;
  private outsideRate: SmoothParam | null = null;
  private readonly outsideLoopLevel: SmoothParam;
  private readonly growlHz: SmoothParam;
  private readonly growlLevel: SmoothParam;
  private readonly outsideLevel: SmoothParam;
  private readonly outsideCutoff: SmoothParam;
  private readonly outsidePan: SmoothParam;
  private readonly loopIn: AudioNode;
  private readonly outsideIn: AudioNode;
  /** Last values, for the debug handle. */
  readonly state = { rate: 0, spin: 0, outsideLevel: 0, outsideDelay: 0, doppler: 1 };

  constructor(private readonly kit: AudioKit) {
    const bus = kit.mixer.buses.gun;
    const cockpit = kit.gain(1);
    cockpit.connect(bus);
    this.inside = new SmoothParam(cockpit.gain, 0.05, 1);

    // recorded loop, heard through the airframe: low-passed, with body
    const loopEnv = kit.gain(0);
    const hp = kit.filter('highpass', 55);
    const body = kit.filter('peaking', 180, 1, 4);
    const lp = kit.filter('lowpass', 1400, 0.7);
    loopEnv.connect(hp).connect(body).connect(lp).connect(cockpit);
    this.loopEnv = loopEnv;
    this.loopIn = loopEnv;

    // one pulse per round through the airframe's modes
    const pulse = kit.oscillator('sine', 1);
    pulse.setPeriodicWave(kit.synth.pulseWave);
    this.pulseHz = new RampParam(pulse.frequency, 1);
    const pulseEnv = kit.gain(0);
    const airframe = kit.track(kit.ctx.createConvolver());
    airframe.normalize = false;
    airframe.buffer = kit.synth.airframeIR;
    pulse.connect(pulseEnv).connect(airframe).connect(cockpit);
    this.pulseEnv = pulseEnv;

    // rumble
    const rumbleEnv = kit.gain(0);
    kit
      .noise(kit.brown, 0.83)
      .connect(kit.filter('lowpass', 110, 0.7))
      .connect(kit.filter('highpass', 26))
      .connect(rumbleEnv)
      .connect(cockpit);
    this.rumbleEnv = rumbleEnv;

    // hydraulic drive whine
    const whineSum = kit.gain(1);
    const band = kit.filter('bandpass', 600, 1.2);
    const whineOut = kit.gain(0);
    whineSum.connect(band).connect(whineOut).connect(cockpit);
    WHINE_PARTIALS.forEach((ratio, k) => {
      const osc = kit.oscillator(k === 0 ? 'triangle' : 'sine', gunWhineHz(0) * ratio);
      const g = kit.gain(WHINE_PARTIAL_GAIN[k]);
      osc.connect(g).connect(whineSum);
      this.whineHz.push(new RampParam(osc.frequency, gunWhineHz(0) * ratio));
    });
    this.whineBand = new RampParam(band.frequency, gunWhineHz(0) * 1.5);
    this.whineLevel = new SmoothParam(whineOut.gain, 0.04, 0);

    // outside: the recording as it is, brighter, and the low growl of the muzzle blasts (which
    // carries farthest), placed in the world
    const outside = kit.gain(0);
    const shelf = kit.filter('highshelf', 2500, Math.SQRT1_2, 3);
    const absorb = kit.filter('lowpass', 16000, 0.6);
    const pan = kit.panner(0);
    outside.connect(shelf).connect(absorb).connect(pan).connect(bus);
    // the burst rolls off into the echo of the terrain instead of stopping dead
    const echo = kit.track(kit.ctx.createConvolver());
    echo.normalize = false;
    echo.buffer = kit.synth.echoIR;
    const echoLevel = kit.gain(GUN_LEVELS.echo);
    shelf.connect(echo).connect(echoLevel).connect(absorb);
    this.outsideLevel = new SmoothParam(outside.gain, TC_FOLLOW, 0);
    const outsideLoopEnv = kit.gain(0);
    outsideLoopEnv.connect(outside);
    this.outsideIn = outsideLoopEnv;
    this.outsideLoopLevel = new SmoothParam(outsideLoopEnv.gain, TC_FOLLOW, 0);
    const growl = kit.oscillator('sine', 1);
    growl.setPeriodicWave(kit.synth.growlWave);
    this.growlHz = new SmoothParam(growl.frequency, TC_FOLLOW, 1);
    const growlEnv = kit.gain(0);
    growl
      .connect(kit.filter('lowpass', 320, 0.7))
      .connect(growlEnv)
      .connect(outside);
    this.growlLevel = new SmoothParam(growlEnv.gain, TC_FOLLOW, 0);
    this.outsideCutoff = new SmoothParam(absorb.frequency, 0.08, 16000);
    this.outsidePan = new SmoothParam(pan.pan, 0.05, 0);

    this.attachSamples();
  }

  /** Create the loop players once the recording is decoded (called again when samples arrive). */
  attachSamples(): void {
    const buffer = getSample('gunLoop');
    if (!buffer) return;
    if (!this.loop) {
      this.loop = this.kit.loop(buffer, gunLoopRate(0));
      this.loopRate = new RampParam(this.loop.playbackRate, gunLoopRate(0));
      this.loop.connect(this.loopIn);
    }
    if (!this.outsideLoop) {
      this.outsideLoop = this.kit.loop(buffer, gunLoopRate(0));
      this.outsideRate = new SmoothParam(this.outsideLoop.playbackRate, TC_FOLLOW, gunLoopRate(0));
      this.outsideLoop.connect(this.outsideIn);
    }
  }

  /**
   * The burst's first round at audio time `when`. `rate` is the firing rate the sim reports
   * (usually still low: the barrels are spinning up).
   */
  start(when: number, rate: number): void {
    if (this.firing) return;
    this.firing = true;
    this.loopRate?.set(gunLoopRate(rate), when);
    this.pulseHz.set(gunPulseHz(rate), when);
    // the first round is a full thump, whatever the rate
    this.pulseEnv.gain.setTargetAtTime(
      GUN_LEVELS.pulse * gunPulseGain(Math.max(rate, 20)),
      when,
      TC_ATTACK,
    );
    this.loopEnv.gain.setTargetAtTime(GUN_LEVELS.loop * gunLoopGain(rate), when, TC_ATTACK);
    this.rumbleEnv.gain.setTargetAtTime(
      GUN_LEVELS.rumble * gunRumbleGain(Math.max(rate, 20)),
      when,
      0.02,
    );
  }

  /** The burst's last round at audio time `when`: firing stops at once, the barrels run down. */
  stop(when: number): void {
    if (!this.firing) return;
    this.firing = false;
    this.loopEnv.gain.setTargetAtTime(0, when, TC_RELEASE);
    this.pulseEnv.gain.setTargetAtTime(0, when, TC_RELEASE);
    this.rumbleEnv.gain.setTargetAtTime(0, when, TC_RUMBLE_RELEASE);
  }

  /**
   * Once per frame. `when` is the audio time of the frame's sim time; `rate`/`spin` the gun's
   * state now; `ret` the aircraft at the retarded time for this listener (outside).
   */
  update(
    when: number,
    rate: number,
    spin: number,
    listener: AudioListener,
    ret: SourceSample,
    delay: number,
    c: number,
  ): void {
    this.state.rate = rate;
    this.state.spin = spin;
    this.inside.set(listener.inCockpit ? 1 : 0, when);
    if (this.firing) {
      this.loopRate?.ramp(gunLoopRate(rate), when);
      this.pulseHz.ramp(gunPulseHz(rate), when);
      this.loopEnv.gain.setTargetAtTime(GUN_LEVELS.loop * gunLoopGain(rate), when, TC_FOLLOW);
      this.pulseEnv.gain.setTargetAtTime(
        GUN_LEVELS.pulse * gunPulseGain(Math.max(rate, 20)),
        when,
        TC_FOLLOW,
      );
      this.rumbleEnv.gain.setTargetAtTime(GUN_LEVELS.rumble * gunRumbleGain(rate), when, TC_FOLLOW);
    }
    const hz = gunWhineHz(spin);
    for (let k = 0; k < this.whineHz.length; k++)
      this.whineHz[k].ramp(hz * WHINE_PARTIALS[k], when);
    this.whineBand.ramp(hz * 1.5, when);
    this.whineLevel.set(GUN_LEVELS.whine * gunWhineGain(spin), when);

    // outside: the gun as it was when its sound left it
    if (listener.inCockpit) {
      this.outsideLevel.set(0, when);
      this.state.outsideLevel = 0;
      return;
    }
    const d = listener.distanceTo(ret.x, ret.y, ret.z);
    const doppler = dopplerFactor(ret, listener, c);
    const level = distanceGain(d, OUTSIDE_REF_DISTANCE, OUTSIDE_ROLLOFF);
    this.outsideLevel.set(level, when);
    this.outsideLoopLevel.set(GUN_LEVELS.outside * gunLoopGain(ret.gunRate), when);
    this.growlLevel.set(
      GUN_LEVELS.growl * (ret.gunRate > 0.5 ? gunPulseGain(ret.gunRate) : 0),
      when,
    );
    this.growlHz.set(gunPulseHz(ret.gunRate) * doppler, when);
    this.outsideRate?.set(gunLoopRate(ret.gunRate) * doppler, when);
    this.outsideCutoff.set(Math.min(16000, absorptionCutoff(d)), when);
    this.outsidePan.set(listener.panOf(ret.x, ret.y, ret.z), when);
    this.state.outsideLevel = level * gunLoopGain(ret.gunRate);
    this.state.outsideDelay = delay;
    this.state.doppler = doppler;
  }

  /** Silence everything at once (new flight). */
  reset(when: number): void {
    this.firing = false;
    this.loopEnv.gain.setTargetAtTime(0, when, TC_RELEASE);
    this.pulseEnv.gain.setTargetAtTime(0, when, TC_RELEASE);
    this.rumbleEnv.gain.setTargetAtTime(0, when, TC_RELEASE);
    this.whineLevel.set(0, when);
    this.outsideLevel.set(0, when);
  }
}
