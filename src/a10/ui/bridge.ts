/**
 * The overlay's link to the running simulation (OWNED BY THE UI MODULE). One `onSimFrame`
 * listener, installed by UIRoot, turns the frame's events into what React shows:
 *   - 'message' events (cockpit messages: refusals such as MAV NOT LOCKED) → toasts;
 *   - 'vehicleDestroyed' → "T-72 destroyed" toasts in the presets that allow it (realism.ts);
 *   - 'lock' and 'laser' → "MAV LOCKED", "LASING"… in the presets that allow it;
 *   - the range officer's score calls on a weapons range (rangeCalls.ts, from sim.debrief);
 *   - 'crash' → why and how the flight ended, for the crash overlay;
 *   - the checklist strip's next step, recomputed ~20 times a second and published only when
 *     the line changes, so React re-renders on a switch, not on every frame.
 * The debrief's impact plots need nothing here: the core debrief logs every impact.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { Sim, SimEvent } from '../core/types';
import { subscribeBindings } from '../input/bindingsStore';
import { getControlsReference } from '../input/controlsReference';
import { useA10Store } from '../state/store';
import { onSimFrame, type FrameInfo } from '../view/frame';
import {
  checklistKeys,
  checklistStateFromSim,
  DEFAULT_CHECKLIST_KEYS,
  nextChecklistStep,
  type ChecklistKeys,
  type ChecklistStep,
} from './checklist';
import { vehicleName } from './debriefData';
import { createCallState, rangeCalls, type CallState } from './rangeCalls';
import { KILL_MESSAGES, RANGE_CALLS, SENSOR_MESSAGES } from './realism';

/** Seconds between checklist updates (real time). */
const CHECKLIST_PERIOD = 0.05;

/** What a lock or laser event says (Standard and Relaxed). */
export function sensorMessage(e: SimEvent): string | null {
  if (e.type === 'lock')
    return e.sensor === 'MAV'
      ? e.on
        ? 'MAV LOCKED'
        : 'MAV LOCK LOST'
      : e.on
        ? 'TGP POINT TRACK'
        : 'TGP TRACK LOST';
  if (e.type === 'laser') return e.on ? 'LASING' : 'LASER OFF';
  return null;
}

export interface CrashInfo {
  reason: 'terrain' | 'overstress' | 'water';
  /** Indicated airspeed and flight-path angle at impact, m/s and rad (+ up). */
  ias: number;
  flightPath: number;
}

let currentSim: Sim | null = null;
/** Vehicles whose kill message has been shown in the current flight. */
const toasted = new Set<number>();
let crash: CrashInfo | null = null;
let keys: ChecklistKeys = DEFAULT_CHECKLIST_KEYS;
let step: ChecklistStep | null = null;
let checklistClock = 0;
let calls: CallState = createCallState();
const stepListeners = new Set<() => void>();

/** The crash of the current flight, if it ended in one. */
export function getCrashInfo(sim: Sim | null): CrashInfo | null {
  return sim && sim === currentSim ? crash : null;
}

function refreshKeys(): void {
  try {
    keys = checklistKeys(getControlsReference());
  } catch {
    keys = DEFAULT_CHECKLIST_KEYS;
  }
  // the next frame redraws the strip with the new key caps
  checklistClock = CHECKLIST_PERIOD;
}

function sameStep(a: ChecklistStep | null, b: ChecklistStep | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.text === b.text &&
    a.index === b.index &&
    a.count === b.count &&
    a.tone === b.tone
  );
}

function publishStep(next: ChecklistStep | null): void {
  if (sameStep(next, step)) return;
  step = next;
  for (const l of stepListeners) l();
}

let reported = false;

/** A fault in the overlay must never stop the frame loop it listens to: log it once, go on. */
function guard(work: () => void): void {
  try {
    work();
  } catch (err) {
    if (!reported) {
      reported = true;
      console.warn('[a10 ui] the overlay could not read the simulation:', err);
    }
  }
}

function onFrame(events: readonly SimEvent[], sim: Sim, info: FrameInfo): void {
  const store = useA10Store.getState();
  if (sim !== currentSim) {
    currentSim = sim;
    crash = null;
    calls = createCallState();
    toasted.clear();
    checklistClock = CHECKLIST_PERIOD;
    refreshKeys();
  }
  const preset = sim.options.realism.preset;
  guard(() => {
    for (const e of events) {
      if (e.type === 'message') store.pushMessage(e.text, e.level);
      else if (e.type === 'lock' || e.type === 'laser') {
        const text = SENSOR_MESSAGES[preset] ? sensorMessage(e) : null;
        if (text) store.pushMessage(text, 'info', 2000);
      } else if (e.type === 'vehicleDestroyed') {
        // A cook-off sends a second vehicleDestroyed for the same vehicle: one message per kill.
        if (KILL_MESSAGES[preset] && !toasted.has(e.vehicleId)) {
          toasted.add(e.vehicleId);
          store.pushMessage(`${vehicleName(e.vehicleKind)} destroyed`, 'info');
        }
      } else if (e.type === 'crash') {
        crash = {
          reason: e.reason,
          ias: sim.aircraft.ias,
          flightPath: sim.aircraft.flightPathAngle,
        };
      }
    }
  });
  guard(() => {
    if (!RANGE_CALLS[preset] || !sim.debrief.scores) return;
    for (const text of rangeCalls(sim.debrief, calls)) store.pushMessage(text, 'info', 6000);
  });

  checklistClock += info.realDt;
  if (checklistClock < CHECKLIST_PERIOD) return;
  checklistClock = 0;
  const show = store.settings.checklist && store.screen === 'flight';
  guard(() => publishStep(show ? nextChecklistStep(checklistStateFromSim(sim), keys) : null));
}

/** Install the bridge for as long as the calling component is mounted (UIRoot). */
export function useSimBridge(): void {
  useEffect(() => {
    const offFrame = onSimFrame(onFrame);
    // A rebinding (settings dialog, Controls section) renames the strip's key caps at once.
    const offBindings = subscribeBindings(refreshKeys);
    // Hide the strip at once when the player switches it off or leaves the flight.
    const offStore = useA10Store.subscribe((s) => {
      if ((!s.settings.checklist || s.screen !== 'flight') && step) publishStep(null);
    });
    return () => {
      offFrame();
      offBindings();
      offStore();
    };
  }, []);
}

function subscribeStep(listener: () => void): () => void {
  stepListeners.add(listener);
  return () => stepListeners.delete(listener);
}

/** The checklist strip's current line (null = hidden). */
export function useChecklistStep(): ChecklistStep | null {
  return useSyncExternalStore(
    subscribeStep,
    () => step,
    () => null,
  );
}
