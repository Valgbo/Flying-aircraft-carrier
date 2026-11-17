/**
 * Switch and message events of the avionics. Every switch, mode, profile, SOI, altitude-source
 * and display change made by a command emits `switch {name, value}` (the audio module clicks on
 * it, the checklist strip reads it) and records `lastSwitch` (docs/a10/ARCHITECTURE.md §3).
 */
import type { Sim } from '../types';

export function switched(sim: Sim, name: string, value: string): void {
  const av = sim.avionics;
  av.lastSwitch.name = name;
  av.lastSwitch.time = sim.time;
  av.lastSwitchValue = value;
  sim.events.push({ type: 'switch', t: sim.time, name, value });
}

/** A cockpit message (the UI shows it as a toast). */
export function notify(sim: Sim, text: string, level: 'info' | 'warn' | 'alert' = 'info'): void {
  sim.events.push({ type: 'message', t: sim.time, text, level });
}
