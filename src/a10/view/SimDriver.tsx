/**
 * SimDriver — steps the simulation once per frame (fixed 120 Hz steps, at most 5 per frame),
 * hands the frame's events to every `onSimFrame` listener and publishes the 10 Hz telemetry.
 * FOUNDATION-OWNED (docs/a10/ARCHITECTURE.md §3, §6).
 */
import { useFrame } from '@react-three/fiber';
import { MAX_STEPS_PER_FRAME, SIM_DT } from '../core/constants';
import { drainEvents, stepSim } from '../core/sim';
import type { SimEvent } from '../core/types';
import { getSim } from '../state/runtime';
import { useA10Store } from '../state/store';
import { publishTelemetry } from '../state/telemetry';
import { A10_PRIORITY, frameInfo, notifyBeforeSimSteps, notifySimFrame } from './frame';

const events: SimEvent[] = [];
let accumulator = 0;
let telemetryClock = 0;

export default function SimDriver() {
  useFrame((_, delta) => {
    const sim = getSim();
    const realDt = Math.min(delta, 0.25);
    frameInfo.realDt = realDt;
    frameInfo.steps = 0;
    frameInfo.simDt = 0;
    if (!sim) return;
    const store = useA10Store.getState();
    notifyBeforeSimSteps(sim, realDt);
    if (!store.paused && store.screen === 'flight') {
      accumulator += realDt;
      let n = 0;
      while (accumulator >= SIM_DT && n < MAX_STEPS_PER_FRAME) {
        stepSim(sim);
        accumulator -= SIM_DT;
        n++;
      }
      if (n === MAX_STEPS_PER_FRAME && accumulator >= SIM_DT) accumulator = 0;
      frameInfo.steps = n;
      frameInfo.simDt = n * SIM_DT;
    }
    frameInfo.alpha = accumulator / SIM_DT;
    drainEvents(sim, events);
    notifySimFrame(events, sim, frameInfo);
    telemetryClock += realDt;
    if (telemetryClock >= 0.1) {
      telemetryClock = 0;
      publishTelemetry(sim);
    }
  }, A10_PRIORITY.sim);
  return null;
}
