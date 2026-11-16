/**
 * Screen flow: menu → loading → flight → debrief. FOUNDATION-OWNED (docs/a10/ARCHITECTURE.md §7).
 * The UI calls these; they own the order of world generation, asset loading and sim start.
 */
import { pushCommand } from '../core/sim';
import { KT } from '../core/units';
import { a10Flags } from './debugFlags';
import { endFlight, getSim, prepareWorld, startFlight } from './runtime';
import { useA10Store } from './store';

type Loader = (onProgress: (fraction: number, label: string) => void) => Promise<void>;
const loaders: { id: string; weight: number; run: Loader }[] = [];

/**
 * Modules that need something loaded before the first flight (models, sounds) register a loader
 * here at import time. Each runs once; the loading screen shows their combined progress.
 */
export function registerFlightLoader(id: string, weight: number, run: Loader): void {
  if (loaders.some((l) => l.id === id)) return;
  loaders.push({ id, weight, run });
}

const done = new Set<string>();

async function runLoaders(): Promise<void> {
  const store = useA10Store.getState();
  const total = loaders.reduce((s, l) => s + l.weight, 0) + 1;
  let finished = 0;
  for (const l of loaders) {
    if (done.has(l.id)) {
      finished += l.weight;
      continue;
    }
    await l.run((f, label) =>
      store.setLoading((finished + l.weight * Math.min(1, f)) / total, label),
    );
    done.add(l.id);
    finished += l.weight;
  }
}

/** Generate the world, load assets, start a flight and switch to the flight screen. */
export async function beginFlight(): Promise<void> {
  const store = useA10Store.getState();
  store.setScreen('loading');
  store.setLoading(0, 'Generating terrain');
  try {
    await new Promise((r) => setTimeout(r, 30));
    await prepareWorld(store.settings.worldSeed);
    await runLoaders();
    store.setLoading(1, 'Starting');
    const f = a10Flags;
    const sim = startFlight({
      start: f.start
        ? {
            x: f.start.x,
            z: f.start.z,
            agl: f.start.agl,
            heading: (f.start.heading * Math.PI) / 180,
            speed: f.start.speedKt * KT,
          }
        : undefined,
    });
    if (f.arm) {
      pushCommand(sim, { type: 'masterArm', value: 'ARM' });
      pushCommand(sim, { type: 'gunPac', value: 'ARM' });
      pushCommand(sim, { type: 'masterMode', value: 'GUNS' });
    }
    useA10Store.getState().setScreen('flight');
    if (f.paused) useA10Store.getState().setPaused(true);
  } catch (err) {
    console.error(err);
    useA10Store.getState().setScreen('menu');
    useA10Store
      .getState()
      .pushMessage('THE FLIGHT COULD NOT START — RELOAD THE PAGE', 'alert', 10000);
  }
}

/** Start the same scenario again. */
export async function restartFlight(): Promise<void> {
  endFlight();
  await beginFlight();
}

/** End the flight and show the debrief (the sim stays readable until the next flight). */
export function finishFlight(): void {
  if (getSim()) useA10Store.getState().setScreen('debrief');
}

export function exitToMenu(): void {
  endFlight();
  useA10Store.getState().setScreen('menu');
}

/** Apply URL flags once at startup (settings overrides, auto-start). */
export function applyA10Flags(): void {
  const f = a10Flags;
  const store = useA10Store.getState();
  const patch: Record<string, unknown> = {};
  if (f.quality === 'low' || f.quality === 'medium' || f.quality === 'high') {
    patch.quality = f.quality;
    patch.adaptiveQuality = false;
  }
  if (f.realism === 'authentic' || f.realism === 'standard' || f.realism === 'relaxed')
    patch.realism = f.realism;
  if (f.seed !== undefined) patch.worldSeed = f.seed;
  if (f.time !== undefined) patch.timeOfDay = f.time;
  if (f.mute) patch.muted = true;
  if (f.fps) patch.showFps = true;
  if (Object.keys(patch).length) store.overrideSettings(patch);
  const scenarios = ['freeHunt', 'strafePit', 'bombCircle', 'tacticalLane', 'empty'] as const;
  const sc = scenarios.find((s) => s === f.scenario);
  if (sc) store.setScenario(sc);
  const views = ['cockpit', 'chase', 'flyby', 'orbit', 'weapon', 'target'] as const;
  const v = views.find((s) => s === f.view);
  if (v) store.setView(v);
  if (f.screen === 'flight') void beginFlight();
  else if (f.screen === 'loadout' || f.screen === 'credits') store.setScreen(f.screen);
}
