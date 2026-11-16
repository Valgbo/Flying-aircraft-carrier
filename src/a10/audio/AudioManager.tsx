/**
 * AudioManager — owns the AudioContext and the A-10 audio engine. Renders nothing.
 * OWNED BY THE AUDIO MODULE (docs/a10/ARCHITECTURE.md §11).
 *
 * Lifecycle (the carrier app's design, src/audio/AudioManager.tsx):
 *  - The context is created on the first user gesture (browsers block audio before one):
 *    pointerdown, pointerup (pen and touch activate on pointerup), keydown, touchend. The
 *    listeners stay, so every later gesture resumes a context the browser or the OS suspended,
 *    and so does its `statechange`.
 *  - Pause, mute, the menus and a stalled simulation never suspend the context: the mix is gated
 *    (a 0.11 s fade) by a small requestAnimationFrame loop. Only a hidden tab suspends it, after
 *    the fade.
 *  - The sounds load behind the loading screen (samples.ts registers a flight loader) and never
 *    wait for a gesture; the engine picks them up whenever they arrive.
 *  - Each frame `onSimFrame` hands the engine the frame's events and the simulation; the camera
 *    pose published by the render pipeline (view/listener.ts) is the listener.
 *  - On unmount: a fast fade, then the graph is released and the context closed. StrictMode-safe:
 *    no context exists before the first gesture.
 *
 * URL flags: `?audiodebug=1` publishes window.__A10_AUDIO__ in a production build (always in
 * development); `?audiomix=gun:1,engines:0.7` trims buses for this visit.
 */
import { useEffect } from 'react';
import { useA10Store } from '../state/store';
import { onSimFrame } from '../view/frame';
import { listenerPose } from '../view/listener';
import { installAudioDebug } from './audioDebug';
import { A10AudioEngine } from './audioEngine';
import { parseTrims } from './mappings';
import { onSamplesChanged, setSampleDecoder } from './samples';

/**
 * The sim counts as stopped once it has not advanced for this long, ms (generous: a struggling
 * renderer at a few frames a second still moves the sim and should still be heard).
 */
const SIM_STALL_MS = 500;
/** Time allowed for the fade-out before the context is suspended or closed, ms. */
const FADE_MS = 350;

const GESTURES = ['pointerdown', 'pointerup', 'keydown', 'touchend'] as const;

function audioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const scope = globalThis as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function urlParam(name: string): string | null {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

export default function AudioManager() {
  useEffect(() => {
    const Ctor = audioContextConstructor();
    if (!Ctor) return;

    let ctx: AudioContext | null = null;
    let engine: A10AudioEngine | null = null;
    let removeDebug: (() => void) | null = null;
    let raf = 0;
    let suspendTimer = 0;
    let lastSimAdvance = -Infinity;
    const debug = import.meta.env.DEV || urlParam('audiodebug') === '1';
    const trims = parseTrims(urlParam('audiomix'));

    const resume = () => {
      if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && !document.hidden) {
        // rejected while the browser still wants a gesture; the next one retries
        ctx.resume().catch(() => undefined);
      }
    };

    const applyMix = (nowMs: number) => {
      if (!engine) return;
      const { settings, paused, screen } = useA10Store.getState();
      const audible =
        !settings.muted &&
        !paused &&
        !document.hidden &&
        screen === 'flight' &&
        nowMs - lastSimAdvance < SIM_STALL_MS;
      engine.setMix(settings.volume, settings.muted, audible);
    };

    const unlock = () => {
      if (!ctx) {
        try {
          ctx = new Ctor({ latencyHint: 'interactive' });
          engine = new A10AudioEngine(ctx, { meters: debug, trims });
        } catch (err) {
          // no audio device, or no Web Audio worth the name: stay silent
          console.warn('[audio] unavailable:', err);
          if (ctx) void ctx.close().catch(() => undefined);
          ctx = null;
          engine = null;
          return;
        }
        engine.start();
        setSampleDecoder(ctx);
        ctx.addEventListener('statechange', resume);
        if (debug) removeDebug = installAudioDebug(engine);
        applyMix(performance.now());
      }
      resume();
    };

    const tick = (nowMs: number) => {
      raf = requestAnimationFrame(tick);
      applyMix(nowMs);
    };

    const onVisibility = () => {
      window.clearTimeout(suspendTimer);
      if (!ctx) return;
      if (document.hidden) {
        // animation frames stop in a hidden tab: fade out now, suspend once the fade is done
        applyMix(performance.now());
        suspendTimer = window.setTimeout(() => {
          if (ctx && document.hidden && ctx.state === 'running') {
            ctx.suspend().catch(() => undefined);
          }
        }, FADE_MS);
      } else {
        resume();
      }
    };

    const offFrame = onSimFrame((events, sim, info) => {
      if (info.simDt > 0) lastSimAdvance = performance.now();
      if (engine && ctx && ctx.state !== 'closed') engine.frame(events, sim, info, listenerPose);
    });
    const offSamples = onSamplesChanged(() => engine?.attachSamples());

    for (const type of GESTURES) window.addEventListener(type, unlock, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(suspendTimer);
      for (const type of GESTURES) window.removeEventListener(type, unlock);
      document.removeEventListener('visibilitychange', onVisibility);
      offFrame();
      offSamples();
      if (!ctx || !engine) return;
      const closingCtx = ctx;
      const closingEngine = engine;
      closingCtx.removeEventListener('statechange', resume);
      removeDebug?.();
      setSampleDecoder(null);
      closingEngine.stop();
      // let the fade finish, then release the graph and the audio device
      window.setTimeout(() => {
        closingEngine.dispose();
        closingCtx.close().catch(() => undefined);
      }, FADE_MS);
      ctx = null;
      engine = null;
    };
  }, []);

  return null;
}
