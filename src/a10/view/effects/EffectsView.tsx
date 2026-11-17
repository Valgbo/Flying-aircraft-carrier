/**
 * Effects: gun smoke, impacts, explosions, fires, smoke columns, craters. OWNED BY THE
 * VEHICLES-AND-EFFECTS MODULE (docs/a10/ARCHITECTURE.md §11).
 *
 * Mounted by SceneRoot. Adds the effects group (particles, decals, pressure rings) to the world
 * scene, feeds the simulation's events to the director (`onSimFrame`, at the sim's priority) and
 * advances everything once per frame at visual priority 0, after the camera rig has placed the
 * world camera (sorting and level of detail need the final camera). Time is simulated time
 * (`frameInfo.simDt`), so pause freezes every effect.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { frameInfo, onSimFrame } from '../frame';
import type { SimEvent } from '../../core/types';
import { acquireFx, getFx, playFx, releaseFx, updateFx, warmFx } from './fx';

export default function EffectsView() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // window.__A10_FX__: development aid for screenshots and the console (dev server only)
    const hook = {
      /** Run the effects forward without stepping the simulation. */
      warm: (seconds: number) => warmFx(seconds, camera),
      /** Play hand-made events (t = seconds from now) at their exact times, then `seconds` more. */
      play: (events: SimEvent[], seconds: number) => playFx(events, seconds, camera),
      stats: () => getFx()?.ps.stats,
    };
    (window as unknown as { __A10_FX__?: typeof hook }).__A10_FX__ = hook;
    return () => {
      delete (window as unknown as { __A10_FX__?: typeof hook }).__A10_FX__;
    };
  }, [camera]);

  useEffect(() => {
    const fx = acquireFx();
    scene.add(fx.root);
    const off = onSimFrame(fx.director.onSimFrame);
    return () => {
      off();
      scene.remove(fx.root);
      releaseFx();
    };
  }, [scene]);

  useFrame((state) => {
    const fx = getFx();
    if (fx) updateFx(fx, frameInfo.simDt, state.camera);
  });

  return null;
}
