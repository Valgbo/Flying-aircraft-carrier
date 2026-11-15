/**
 * Small building blocks shared by the audio engine and the one-shot recipes: the noise
 * buffers (rendered once, shared by every noise voice) and a smoothed AudioParam setter.
 */
import { mulberry32 } from '../utils/math';

/** Length of the shared noise loops, seconds. Long enough that the loop is not heard as a rhythm. */
export const NOISE_SECONDS = 4;

/** White noise, deterministic (seeded), peak just below 1. */
export function createWhiteNoise(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const random = mulberry32(0x5eed);
  for (let i = 0; i < length; i++) data[i] = (random() * 2 - 1) * 0.98;
  return buffer;
}

/**
 * Brown (integrated) noise for the low rumble. The random walk is de-trended so the last
 * sample meets the first (no click at the loop seam), centred (no DC) and normalised.
 */
export function createBrownNoise(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const random = mulberry32(0xb0a7);
  let walk = 0;
  for (let i = 0; i < length; i++) {
    walk = walk * 0.999 + (random() * 2 - 1) * 0.02;
    data[i] = walk;
  }
  const drift = (data[length - 1] - data[0]) / (length - 1);
  let mean = 0;
  for (let i = 0; i < length; i++) {
    data[i] -= drift * i;
    mean += data[i];
  }
  mean /= length;
  let peak = 1e-9;
  for (let i = 0; i < length; i++) {
    data[i] -= mean;
    peak = Math.max(peak, Math.abs(data[i]));
  }
  const scale = 0.9 / peak;
  for (let i = 0; i < length; i++) data[i] *= scale;
  return buffer;
}

/**
 * An AudioParam that is only ever moved with setTargetAtTime (an exponential approach, so no
 * zipper noise and no clicks) and only when the wanted value actually changed, which keeps
 * the parameter's automation timeline short however often `set` is called.
 */
export class SmoothParam {
  private wanted: number;

  constructor(
    private readonly param: AudioParam,
    private readonly timeConstant: number,
    initial: number,
  ) {
    param.value = initial;
    this.wanted = initial;
  }

  /** Value the parameter is currently heading for. */
  get target(): number {
    return this.wanted;
  }

  /** Glide toward `value` starting at context time `when`. Non-finite values are ignored. */
  set(value: number, when: number): void {
    if (!(Math.abs(value - this.wanted) > 1e-4 * Math.max(1, Math.abs(this.wanted)))) return;
    if (!Number.isFinite(value)) return;
    this.wanted = value;
    this.param.setTargetAtTime(value, when, this.timeConstant);
  }
}
