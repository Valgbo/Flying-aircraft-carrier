/**
 * Game-event bus: one-shot things that happened in the simulation, for systems that react
 * to them without importing each other (audio, camera shake, HUD flashes, tests).
 *
 *   emitEvent('jetLaunch', { jetId: 2, catapult: 1 });
 *   const off = onEvent('splashdown', ({ sinkRate }) => …);
 *
 * Player COMMANDS go through the action bus (actions.ts); this bus is for OUTCOMES.
 */

export interface GameEvents {
  /** The hull left the water. Emitted by the flight driver. */
  liftOff: undefined;
  /** The hull touched the water. `sinkRate` = downward speed at contact, m/s (≥ 0). */
  splashdown: { sinkRate: number };
  /** A turbine's engine switch changed. Emitted by the flight driver when it sees the flag flip. */
  engineToggled: { index: number; enabled: boolean };
  /** Flight assist was switched. Emitted by the flight driver when it applies the change. */
  assistChanged: { enabled: boolean };
  /** A jet is hooked to a catapult and spooling up. */
  jetCatapult: { jetId: number; catapult: number };
  /** A jet left the deck. */
  jetLaunch: { jetId: number; catapult: number };
  /** A jet caught a wire. */
  jetTrap: { jetId: number; points: number; grade: string };
  /** A jet abandoned its approach. */
  jetWaveOff: { jetId: number };
}

export type GameEventName = keyof GameEvents;

type Handler<K extends GameEventName> = (payload: GameEvents[K]) => void;

const handlers: { [K in GameEventName]?: Set<Handler<K>> } = {};

export function onEvent<K extends GameEventName>(name: K, handler: Handler<K>): () => void {
  let set = handlers[name] as Set<Handler<K>> | undefined;
  if (!set) {
    set = new Set<Handler<K>>();
    (handlers as Record<string, unknown>)[name] = set;
  }
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}

export function emitEvent<K extends GameEventName>(
  name: K,
  ...payload: GameEvents[K] extends undefined ? [] : [GameEvents[K]]
): void {
  const set = handlers[name] as Set<Handler<K>> | undefined;
  if (!set) return;
  for (const h of [...set]) h(payload[0] as GameEvents[K]);
}
