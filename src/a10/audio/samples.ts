/**
 * The recorded sounds (public/a10/sounds/, made by scripts/a10/sounds.mjs from the FlightGear
 * A-10 files): their URLs, the loader the loading screen runs, and the decoded buffers.
 *
 * Loading never waits for a user gesture: an AudioBuffer is not tied to the context that decoded
 * it, so when the live AudioContext does not exist yet (no click so far, e.g. `?screen=flight`)
 * the files are decoded with an OfflineAudioContext and used later by the live one. A file that
 * fails to load is skipped with a warning: the flight starts anyway, just without that sound.
 */
import { a10Asset } from '../assets/urls';
import { registerFlightLoader } from '../state/flow';

export const SAMPLE_FILES = {
  gunLoop: 'sounds/gun-loop.wav',
  engineFan: 'sounds/engine-fan.wav',
  engineFanInside: 'sounds/engine-fan-inside.wav',
  engineWhine: 'sounds/engine-whine.wav',
  engineWhineLow: 'sounds/engine-whine-low.wav',
  engineJet: 'sounds/engine-jet.wav',
  wind: 'sounds/wind.wav',
  stallSteady: 'sounds/stall-steady.wav',
  stallChopped: 'sounds/stall-chopped.wav',
  altitude: 'sounds/altitude.wav',
  pullUp: 'sounds/pull-up.wav',
  bombRelease: 'sounds/bomb-release.wav',
  click: 'sounds/click.wav',
  click2: 'sounds/click2.wav',
} as const;

export type SampleId = keyof typeof SAMPLE_FILES;
export const SAMPLE_IDS = Object.keys(SAMPLE_FILES) as SampleId[];

const buffers = new Map<SampleId, AudioBuffer>();
const listeners = new Set<() => void>();
let liveDecoder: BaseAudioContext | null = null;
let pending: Promise<void> | null = null;

/** A decoded sample, or null while it is not (or could not be) loaded. */
export function getSample(id: SampleId): AudioBuffer | null {
  return buffers.get(id) ?? null;
}

/** How many samples are decoded. */
export function samplesLoaded(): number {
  return buffers.size;
}

/** Called after each batch of samples arrives. Returns an unsubscribe function. */
export function onSamplesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The AudioManager hands its context over once it exists (decoding then needs no resampling). */
export function setSampleDecoder(ctx: BaseAudioContext | null): void {
  liveDecoder = ctx;
}

function offlineDecoder(): BaseAudioContext | null {
  const scope = globalThis as {
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const Ctor = scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor(1, 1, 48000);
  } catch {
    return null;
  }
}

async function fetchBytes(id: SampleId): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(a10Asset(SAMPLE_FILES[id]));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  } catch (err) {
    console.warn(`[audio] could not load ${SAMPLE_FILES[id]}:`, err);
    return null;
  }
}

function decode(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  // the promise form, with the callback form as a fallback for old WebKit
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(bytes, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

/**
 * Fetch and decode every sample not loaded yet. `ctx` decodes (default: the live context, else
 * an offline one). Resolves when all are done or failed; never rejects.
 */
export function loadSamples(
  ctx?: BaseAudioContext,
  onProgress?: (fraction: number, label: string) => void,
): Promise<void> {
  if (pending) return pending;
  const run = async () => {
    const decoder = ctx ?? liveDecoder ?? offlineDecoder();
    if (!decoder || typeof fetch === 'undefined') return;
    const todo = SAMPLE_IDS.filter((id) => !buffers.has(id));
    let done = 0;
    onProgress?.(0, 'Loading sounds');
    await Promise.all(
      todo.map(async (id) => {
        const bytes = await fetchBytes(id);
        if (bytes) {
          try {
            buffers.set(id, await decode(decoder, bytes));
          } catch (err) {
            console.warn(`[audio] could not decode ${SAMPLE_FILES[id]}:`, err);
          }
        }
        done++;
        onProgress?.(done / Math.max(1, todo.length), 'Loading sounds');
      }),
    );
    for (const l of listeners) l();
  };
  pending = run().finally(() => {
    pending = null;
  });
  return pending;
}

// Behind the loading screen, before the first flight (docs/a10/ARCHITECTURE.md §7).
registerFlightLoader('audio', 1, (onProgress) => loadSamples(undefined, onProgress));
