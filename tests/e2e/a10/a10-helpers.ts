import { expect, type Page } from '@playwright/test';
import { evalIn } from '../helpers';

/**
 * Helpers for the A-10 browser tests. The page exposes `window.__A10__` (store, getSim,
 * getTerrain, command, setInput); tests read it through string expressions so they need no app
 * types. Headless Chromium renders WebGL in software and the simulation runs slower than real
 * time there: wait on state (sim time), never on fixed delays.
 */

/**
 * Polling budget for A-10 state. A first flight loads the aircraft models and sounds and
 * compiles every shader in software WebGL: on a busy machine that alone can take a minute.
 */
export const SLOW: { timeout: number; intervals: number[] } = {
  timeout: 180_000,
  intervals: [250, 500, 1000],
};

/** Per-test time limit for the A-10 specs (test.slow() triples it). */
export const A10_TEST_TIMEOUT = 300_000;

/** Open /a10/ (always with the slash) with the cheapest preset, muted, and wait for the menu. */
export async function openA10(page: Page, query = ''): Promise<void> {
  await page.goto(`/a10/?quality=low&mute=1${query ? `&${query}` : ''}`);
  await expect(page.getByTestId('a10-menu')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => evalIn<boolean>(page, 'Boolean(window.__A10__)'), SLOW).toBe(true);
}

export function simTime(page: Page): Promise<number> {
  return evalIn<number>(page, 'window.__A10__.getSim() ? window.__A10__.getSim().time : -1');
}

export function screenOf(page: Page): Promise<string> {
  return evalIn<string>(page, 'window.__A10__.store.getState().screen');
}

/** Wait until the simulation has advanced `seconds` past `from` (default: now). */
export async function waitForSimTime(page: Page, seconds: number, from?: number): Promise<number> {
  const t0 = from ?? (await simTime(page));
  await expect.poll(() => simTime(page), SLOW).toBeGreaterThan(t0 + seconds);
  return simTime(page);
}

/** Start a flight from a menu entry and wait until it is running (its first steps taken). */
export async function startFlight(page: Page, testId = 'a10-fly'): Promise<void> {
  await page.getByTestId(testId).click();
  await expect.poll(() => screenOf(page), SLOW).toBe('flight');
  await waitForSimTime(page, 0, 0);
}

/**
 * Sample the canvas right after the renderer has drawn a frame (a requestAnimationFrame callback
 * queued now runs after React Three Fiber's own in the next frame, before the frame is shown).
 * Returns the mean and spread of the luminance of a 9 × 9 grid of pixels, 0..255.
 */
export function canvasStats(page: Page): Promise<{ mean: number; spread: number }> {
  return page.evaluate(
    () =>
      new Promise<{ mean: number; spread: number }>((resolve) => {
        requestAnimationFrame(() => {
          const canvas = document.querySelector('canvas');
          const gl = (canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')) as
            WebGL2RenderingContext | WebGLRenderingContext | null;
          if (!canvas || !gl) return resolve({ mean: -1, spread: -1 });
          const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          const px = new Uint8Array(4);
          const lum: number[] = [];
          for (let i = 1; i <= 9; i++) {
            for (let j = 1; j <= 9; j++) {
              const x = Math.floor((gl.drawingBufferWidth * i) / 10);
              const y = Math.floor((gl.drawingBufferHeight * j) / 10);
              gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
              lum.push(0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]);
            }
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
          const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
          resolve({ mean, spread: Math.max(...lum) - Math.min(...lum) });
        });
      }),
  );
}

// ---- wave 2: scripted passes ------------------------------------------------------------------

/** What the wave-2 tests read and drive through `window.__A10__` (only the fields they use). */
export interface A10Vehicle {
  id: number;
  kind: string;
  position: { x: number; y: number; z: number };
  heading: number;
  speed: number;
  condition: string;
}

export interface A10Hook {
  store: {
    getState(): {
      screen: string;
      paused: boolean;
      setPaused(paused: boolean): void;
    };
  };
  getSim(): {
    time: number;
    options: { loadoutId: string; customLoadout?: Record<number, string[]> };
    gun: { totalFired: number; rounds: number };
    avionics: {
      masterArm: string;
      masterMode: string;
      selectedProfile: string;
      soi: string;
      mfd: { left: string; right: string };
      profiles: { id: string; store: string }[];
    };
    stores: {
      stations: { station: number; rack: string | null; stores: string[]; rockets?: number }[];
      releaseQueue: unknown[];
    };
    projectiles: { bodies: unknown[] };
    targets: {
      vehicles: A10Vehicle[];
      groups: { template: string; areaId: number; vehicleIds: number[]; speed: number }[];
    };
    debrief: {
      passes: { bursts: number[]; hits: number[]; endReason: string; targetId: number }[];
      hits: { vehicleId: number; weapon: string }[];
      weapons: { store: string; simulated: boolean }[];
      internal: { layout: { x: number; z: number; runIn: number } | null };
    };
    world: { surfaceWind: { x: number; y: number; z: number }; turbulence: number };
  } | null;
  getTerrain(): {
    heightAt(x: number, z: number): number;
    targetAreas: { id: number; name: string; heading?: number }[];
    start: { heading: number };
  } | null;
  command(c: unknown): void;
  setInput(p: Record<string, number | boolean> | null): void;
}

/**
 * Run `fn(hook, arg)` in the page. The function is sent as source text: it must use only its
 * parameters (no imports or variables from the test file).
 */
export function inPage<T, A = undefined>(
  page: Page,
  fn: (h: A10Hook, arg: A) => T,
  arg?: A,
): Promise<T> {
  return page.evaluate(
    ([src, a]) => {
      const h = (window as unknown as { __A10__: unknown }).__A10__;
      return new Function('h', 'arg', `return (${src})(h, arg);`)(h, a) as T;
    },
    [fn.toString(), arg] as const,
  ) as Promise<T>;
}

/**
 * Start a flight from a menu entry. With `paused`, the flight waits on its first frame (the
 * test queues commands, then resumes it); otherwise it is running when this returns.
 */
export async function startEvent(page: Page, testId: string, paused = false): Promise<void> {
  await page.getByTestId(testId).click();
  await expect.poll(() => screenOf(page), SLOW).toBe('flight');
  if (paused) await inPage(page, (h) => h.store.getState().setPaused(true));
  else await waitForSimTime(page, 0, 0);
}

/**
 * Polling budget for seconds of sim time in flight: software WebGL renders a frame in a second or
 * more on a busy machine, and the sim takes at most five steps (1/24 s) per frame.
 */
export const SIM_SLOW: { timeout: number; intervals: number[] } = {
  timeout: 420_000,
  intervals: [250, 500, 1000],
};

/** Wait until the simulation clock has reached `t` seconds. */
export async function untilSimTime(page: Page, t: number): Promise<void> {
  await expect.poll(() => simTime(page), SIM_SLOW).toBeGreaterThanOrEqual(t);
}

const DEG = Math.PI / 180;

/**
 * The `?start=` flag of an air start in a dive at a ground point: `distance` m short of it
 * (horizontally) along the compass heading `heading` (rad), on a `diveDeg` flight path, at
 * 295 kn indicated (≈ 155 m/s true near the ground). The start is 2.4° above the line to the
 * point: the gun line (2° below the fuselage), the angle of attack and the rounds' drop put the
 * pipper on the point then (measured in the debrief module's scripted strafing passes).
 * `groundAtStart` is the terrain height under the start point (the page's terrain).
 */
export function diveStart(
  point: { x: number; z: number; ground: number },
  heading: number,
  groundAtStart: number,
  distance = 1500,
  diveDeg = 10,
): string {
  const { x, z } = diveStartPoint(point, heading, distance);
  const agl = point.ground - groundAtStart + distance * Math.tan((diveDeg + 2.4) * DEG);
  const hdg = (((heading / DEG) % 360) + 360) % 360;
  return [x, z, agl, hdg].map((v) => v.toFixed(1)).join(',') + `,295,${-diveDeg}`;
}

/** Where `diveStart` puts the aircraft: `distance` m back from the point along `heading`. */
export function diveStartPoint(
  point: { x: number; z: number },
  heading: number,
  distance = 1500,
): { x: number; z: number } {
  return { x: point.x - Math.sin(heading) * distance, z: point.z + Math.cos(heading) * distance };
}
