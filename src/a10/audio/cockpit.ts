/**
 * Cockpit warnings and switches (PLAN_A10.md §5 "Warnings", §13). These go to the cockpit bus,
 * which is never ducked, so a warning is heard over the gun.
 *
 *   stall          FlightGear's steady 600 Hz tone (approaching the stall)
 *   stallChopped   FlightGear's chopped tone (at the stall); replaces the steady one
 *   overG          a synthesised two-tone warble
 *   overspeed      a synthesised fast beeper
 *   altitude       FlightGear's "ALTITUDE, ALTITUDE" voice, once when the alert trips
 *   pullUp         "PULL UP" (made offline with CMU Flite), repeated while the warning is on
 *   masterCaution, lowFuel   a two-note chime
 *   switch events  FlightGear's switch clicks
 */
import { SmoothParam } from '../../engine';
import type { WarningId } from '../core/flight/types';
import type { AudioKit } from './kit';
import { getSample, type SampleId } from './samples';

/** Levels (linear, measured in the audio sandbox: the tones must stand above the gun). */
export const COCKPIT_LEVELS = {
  stall: 0.25,
  overG: 0.12,
  overspeed: 0.1,
  voice: 0.75,
  chime: 0.14,
  click: 0.35,
};
/** "PULL UP" repeats this often while the warning stands, s. */
export const PULL_UP_PERIOD = 1.0;

const WARNINGS: WarningId[] = [
  'stall',
  'stallChopped',
  'overG',
  'altitude',
  'pullUp',
  'overspeed',
  'lowFuel',
  'masterCaution',
];

/** A recorded loop that restarts from its beginning each time it is switched on. */
class LoopTone {
  private src: AudioBufferSourceNode | null = null;
  private readonly out: GainNode;
  on = false;

  constructor(
    private readonly kit: AudioKit,
    private readonly sample: SampleId,
    level: number,
  ) {
    this.out = kit.gain(0);
    const level_ = kit.gain(level);
    this.out.connect(level_).connect(kit.mixer.buses.cockpit);
  }

  set(on: boolean, when: number): void {
    if (on === this.on) return;
    this.on = on;
    if (on) {
      const buffer = getSample(this.sample);
      if (!buffer) return;
      const src = this.kit.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.connect(this.out);
      src.start(when);
      this.src = src;
      this.out.gain.setTargetAtTime(1, when, 0.003);
    } else {
      this.out.gain.setTargetAtTime(0, when, 0.006);
      const src = this.src;
      this.src = null;
      if (src) {
        src.stop(when + 0.05);
        src.addEventListener('ended', () => src.disconnect(), { once: true });
      }
    }
  }
}

export class CockpitVoices {
  private readonly active = {} as Record<WarningId, boolean>;
  private readonly stallSteady: LoopTone;
  private readonly stallChopped: LoopTone;
  private readonly overG: SmoothParam;
  private readonly overspeed: SmoothParam;
  private readonly voiceOut: GainNode;
  private readonly clickOut: GainNode;
  private nextPullUp = 0;
  private clickToggle = 0;

  constructor(private readonly kit: AudioKit) {
    for (const w of WARNINGS) this.active[w] = false;
    const bus = kit.mixer.buses.cockpit;
    this.stallSteady = new LoopTone(kit, 'stallSteady', COCKPIT_LEVELS.stall);
    this.stallChopped = new LoopTone(kit, 'stallChopped', COCKPIT_LEVELS.stall);

    // over-g: a square wave switching between 800 and 1200 Hz six times a second
    const warble = kit.oscillator('square', 1000);
    const lfo = kit.oscillator('square', 6);
    const depth = kit.gain(200);
    lfo.connect(depth).connect(warble.frequency);
    const overG = kit.gain(0);
    warble.connect(kit.filter('lowpass', 3500)).connect(overG).connect(bus);
    this.overG = new SmoothParam(overG.gain, 0.004, 0);

    // overspeed: a 1.6 kHz beeper, ten beeps a second
    const beep = kit.oscillator('triangle', 1600);
    const chopper = kit.gain(0.5);
    const chop = kit.oscillator('square', 10);
    const chopDepth = kit.gain(0.5);
    chop.connect(chopDepth).connect(chopper.gain);
    const overspeed = kit.gain(0);
    beep.connect(chopper).connect(overspeed).connect(bus);
    this.overspeed = new SmoothParam(overspeed.gain, 0.004, 0);

    this.voiceOut = kit.gain(COCKPIT_LEVELS.voice);
    this.voiceOut.connect(bus);
    this.clickOut = kit.gain(COCKPIT_LEVELS.click);
    this.clickOut.connect(bus);
  }

  /** A warning switched at audio time `when` (from a `warning` event or the state). */
  warning(id: WarningId, on: boolean, when: number): void {
    if (!(id in this.active) || this.active[id] === on) return;
    this.active[id] = on;
    switch (id) {
      case 'stall':
      case 'stallChopped':
        this.stallChopped.set(this.active.stallChopped, when);
        this.stallSteady.set(this.active.stall && !this.active.stallChopped, when);
        break;
      case 'overG':
        this.overG.set(on ? COCKPIT_LEVELS.overG : 0, when);
        break;
      case 'overspeed':
        this.overspeed.set(on ? COCKPIT_LEVELS.overspeed : 0, when);
        break;
      case 'altitude':
        if (on) this.voice('altitude', when);
        break;
      case 'pullUp':
        if (on) this.nextPullUp = when;
        break;
      case 'masterCaution':
      case 'lowFuel':
        if (on) this.chime(when, id === 'lowFuel' ? 660 : 880);
        break;
    }
  }

  /** Bring the voices in line with the aircraft's warning state (covers missed events). */
  sync(warnings: Readonly<Record<string, boolean>>, when: number): void {
    for (const id of WARNINGS) {
      const on = warnings[id] === true;
      if (on !== this.active[id]) this.warning(id, on, when);
    }
  }

  /** Once per frame: repeat "PULL UP" while it stands. */
  update(now: number, horizon: number): void {
    if (this.active.pullUp && this.nextPullUp <= now + horizon) {
      const at = Math.max(this.nextPullUp, now);
      this.voice('pullUp', at);
      this.nextPullUp = at + PULL_UP_PERIOD;
    }
  }

  /** A cockpit switch moved. */
  click(name: string, when: number): void {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    const id: SampleId = (h + this.clickToggle++) % 2 === 0 ? 'click' : 'click2';
    const buffer = getSample(id);
    if (buffer) this.kit.playOnce(buffer, this.clickOut, when, 0.95 + (0.1 * ((h >>> 3) % 7)) / 6);
  }

  /** Every warning off (new flight). */
  reset(when: number): void {
    for (const id of WARNINGS) this.warning(id, false, when);
  }

  activeWarnings(): string[] {
    return WARNINGS.filter((w) => this.active[w]);
  }

  private voice(id: SampleId, when: number): void {
    const buffer = getSample(id);
    if (buffer) this.kit.playOnce(buffer, this.voiceOut, when);
  }

  /** Two short notes, a fifth apart. */
  private chime(when: number, hz: number): void {
    const ctx = this.kit.ctx;
    for (let k = 0; k < 2; k++) {
      const t = when + k * 0.16;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = k === 0 ? hz : hz * 1.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(COCKPIT_LEVELS.chime, t + 0.005);
      g.gain.setTargetAtTime(0, t + 0.09, 0.02);
      osc.connect(g).connect(this.kit.mixer.buses.cockpit);
      osc.start(t);
      osc.stop(t + 0.25);
      osc.addEventListener('ended', () => g.disconnect(), { once: true });
    }
  }
}
