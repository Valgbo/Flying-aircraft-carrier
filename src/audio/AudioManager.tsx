/**
 * AudioManager — owns the AudioContext and the audio engine. Renders nothing.
 *
 * Lifecycle: the context is created on the first user gesture (browsers block audio before
 * that), resumed whenever it turns up suspended, suspended while the tab is hidden, and
 * closed on unmount after a short fade. One requestAnimationFrame loop copies the live
 * simulation into the engine; game events trigger the one-shot effects.
 *
 * The mix is faded out (never cut) while the game is paused, the sound is muted, the tab is
 * hidden or the simulation is not advancing (`sim.dt` stays 0, e.g. a frozen screenshot).
 */
import { useEffect } from 'react';
import { onEvent } from '../state/events';
import { sim } from '../state/sim';
import { isFlyingScreen, useGameStore } from '../state/useGameStore';
import { installAudioDebug } from './audioDebug';
import { AudioEngine, createAudioFrame, splashIntensity, type OneShotKind } from './engineAudio';
import { SimFrameReader } from './simAudioFrame';

/** Airflow level in the menu and hangar, where the ship only idles on show. */
const IDLE_SCENE_WIND = 0.35;
/** The sim counts as stopped once `sim.dt` has been 0 for this long (one frame of 0 is not a pause), ms. */
const SIM_STALL_MS = 250;
/** Time allowed for the fade-out before the context is suspended or closed, ms. */
const FADE_MS = 350;

const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

function audioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const scope = globalThis as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

export default function AudioManager() {
  useEffect(() => {
    const Ctor = audioContextConstructor();
    if (!Ctor) return;

    let ctx: AudioContext | null = null;
    let engine: AudioEngine | null = null;
    let removeDebug: (() => void) | null = null;
    let raf = 0;
    let suspendTimer = 0;
    let lastSimAdvance = -Infinity;
    const frame = createAudioFrame();
    const reader = new SimFrameReader();

    const resume = () => {
      if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && !document.hidden) {
        // rejected when the browser still wants a gesture; the next one retries
        ctx.resume().catch(() => undefined);
      }
    };

    const unlock = () => {
      if (!ctx) {
        try {
          ctx = new Ctor();
          engine = new AudioEngine(ctx);
        } catch {
          // no audio device or no Web Audio support worth the name: stay silent
          if (ctx) void ctx.close().catch(() => undefined);
          ctx = null;
          engine = null;
          return;
        }
        engine.start();
        ctx.addEventListener('statechange', resume);
        if (import.meta.env.DEV) removeDebug = installAudioDebug(engine);
      }
      resume();
    };

    const applyMix = (nowMs: number) => {
      if (!engine) return;
      const { settings, paused } = useGameStore.getState();
      if (sim.dt > 0) lastSimAdvance = nowMs;
      const audible =
        !settings.muted && !paused && !document.hidden && nowMs - lastSimAdvance < SIM_STALL_MS;
      engine.setMix(settings.masterVolume, settings.engineVolume, settings.effectsVolume, audible);
    };

    const tick = (nowMs: number) => {
      raf = requestAnimationFrame(tick);
      if (!engine) return;
      applyMix(nowMs);
      reader.read(frame, isFlyingScreen(useGameStore.getState().screen) ? 1 : IDLE_SCENE_WIND);
      engine.update(frame);
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

    const play = (kind: OneShotKind, intensity = 1, pan = 0, gain = 1) => {
      if (engine && ctx && ctx.state === 'running') engine.playOneShot(kind, intensity, pan, gain);
    };
    const playAtJet = (kind: OneShotKind, jetId: number) => {
      reader.locateJet(jetId);
      play(kind, 1, reader.pan, reader.gain);
    };
    const playAtShip = (kind: OneShotKind, intensity: number) => {
      reader.locate(sim.carrier.position);
      play(kind, intensity, reader.pan, reader.gain);
    };

    const unsubscribe = [
      onEvent('liftOff', () => playAtShip('liftOff', 1)),
      onEvent('splashdown', ({ sinkRate }) => playAtShip('splashdown', splashIntensity(sinkRate))),
      onEvent('engineToggled', ({ index, enabled }) => {
        reader.locateTurbine(index);
        play(enabled ? 'engineOn' : 'engineOff', 1, reader.pan, reader.gain);
      }),
      // cockpit tones: not placed in the world
      onEvent('assistChanged', ({ enabled }) => play(enabled ? 'assistOn' : 'assistOff')),
      onEvent('jetWaveOff', () => play('waveOff')),
      onEvent('jetCatapult', ({ jetId }) => playAtJet('catapultHook', jetId)),
      onEvent('jetLaunch', ({ jetId }) => playAtJet('catapultLaunch', jetId)),
      onEvent('jetTrap', ({ jetId }) => playAtJet('trap', jetId)),
    ];

    for (const type of GESTURES) window.addEventListener(type, unlock, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(suspendTimer);
      for (const type of GESTURES) window.removeEventListener(type, unlock);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const off of unsubscribe) off();
      if (!ctx || !engine) return;
      const closingCtx = ctx;
      const closingEngine = engine;
      closingCtx.removeEventListener('statechange', resume);
      removeDebug?.();
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
