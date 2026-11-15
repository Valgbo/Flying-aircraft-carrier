/**
 * Dev-only inspection handle, `window.__FAC_AUDIO__`: output levels read from analysers on
 * the master bus, the node count and the engine's parameter targets. Used by the audio
 * sandbox (level meters) and by the headless checks; never installed in production builds.
 */
import type { AudioEngine, EngineSnapshot } from './engineAudio';

export interface AudioLevels {
  /** RMS of the left / right output over the last ~85 ms. */
  left: number;
  right: number;
  /** RMS of both channels together. */
  rms: number;
  /** Largest absolute sample in the window. */
  peak: number;
}

export interface AudioDebugHandle {
  engine: AudioEngine;
  /** AudioContext state: 'running', 'suspended' or 'closed'. */
  state(): string;
  /** Current output levels. Returns the same object every call. */
  getLevels(): AudioLevels;
  nodeCount(): number;
  snapshot(): EngineSnapshot;
}

declare global {
  interface Window {
    __FAC_AUDIO__?: AudioDebugHandle;
  }
}

const WINDOW = 4096;

/** Tap the engine's output and publish the handle. Returns a function that removes both. */
export function installAudioDebug(engine: AudioEngine): () => void {
  const ctx = engine.ctx;
  const splitter = ctx.createChannelSplitter(2);
  const analysers = [ctx.createAnalyser(), ctx.createAnalyser()];
  engine.output.connect(splitter);
  analysers.forEach((analyser, channel) => {
    analyser.fftSize = WINDOW;
    splitter.connect(analyser, channel);
  });
  const samples = new Float32Array(WINDOW);
  const levels: AudioLevels = { left: 0, right: 0, rms: 0, peak: 0 };

  const measure = (analyser: AnalyserNode): number => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < WINDOW; i++) {
      const s = samples[i];
      sum += s * s;
      const a = Math.abs(s);
      if (a > levels.peak) levels.peak = a;
    }
    return Math.sqrt(sum / WINDOW);
  };

  const handle: AudioDebugHandle = {
    engine,
    state: () => ctx.state,
    getLevels() {
      levels.peak = 0;
      levels.left = measure(analysers[0]);
      levels.right = measure(analysers[1]);
      levels.rms = Math.sqrt((levels.left * levels.left + levels.right * levels.right) / 2);
      return levels;
    },
    nodeCount: () => engine.nodeCount,
    snapshot: () => engine.snapshot(),
  };
  window.__FAC_AUDIO__ = handle;

  return () => {
    if (window.__FAC_AUDIO__ === handle) delete window.__FAC_AUDIO__;
    splitter.disconnect();
    for (const analyser of analysers) analyser.disconnect();
  };
}
