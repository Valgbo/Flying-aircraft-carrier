/**
 * `window.__A10_AUDIO__`: levels per bus (RMS and peak in dBFS, before the limiter and at the
 * output), the limiter's gain reduction, the active voices and what the engine is doing, and
 * per-bus trims for tuning by ear. Installed in development builds, or with `?audiodebug=1`.
 */
import type { A10AudioEngine, AudioSnapshot } from './audioEngine';
import { BUS_IDS, type BusId, type BusTrims } from './mappings';

export interface A10AudioLevels {
  /** dBFS (−∞ … 0) over the last ≈43 ms. */
  rmsDb: number;
  peakDb: number;
}

export interface A10AudioDebug {
  /** 'running', 'suspended' or 'closed'. */
  state(): string;
  sampleRate: number;
  /** Levels at every bus, before the limiter and at the output; the limiter's reduction, dB. */
  levels(): Record<BusId | 'preLimiter' | 'output', A10AudioLevels> & { limiterDb: number };
  /** What is sounding: the gun, engines, airframe, warnings, queued world sounds, pool. */
  voices(): AudioSnapshot;
  nodeCount(): number;
  trims(): BusTrims;
  /** Trim a bus (0..2, linear) for this visit. */
  setTrim(bus: BusId, value: number): void;
}

declare global {
  interface Window {
    __A10_AUDIO__?: A10AudioDebug;
  }
}

const dbfs = (v: number) => (v > 0 ? +(20 * Math.log10(v)).toFixed(1) : -Infinity);

/** Publish the handle; returns a function that removes it. */
export function installAudioDebug(engine: A10AudioEngine): () => void {
  const handle: A10AudioDebug = {
    state: () => (engine.ctx as AudioContext).state ?? 'offline',
    sampleRate: engine.ctx.sampleRate,
    levels() {
      const raw = engine.levels();
      const out = { limiterDb: +engine.mixer.limiterReduction.toFixed(1) } as ReturnType<
        A10AudioDebug['levels']
      >;
      for (const id of [...BUS_IDS, 'preLimiter', 'output'] as const) {
        out[id] = { rmsDb: dbfs(raw[id].rms), peakDb: dbfs(raw[id].peak) };
      }
      return out;
    },
    voices: () => engine.snapshot(),
    nodeCount: () => engine.nodeCount,
    trims: () => engine.mixer.currentTrims,
    setTrim(bus, value) {
      engine.setTrims({ [bus]: value });
    },
  };
  window.__A10_AUDIO__ = handle;
  return () => {
    if (window.__A10_AUDIO__ === handle) delete window.__A10_AUDIO__;
  };
}
