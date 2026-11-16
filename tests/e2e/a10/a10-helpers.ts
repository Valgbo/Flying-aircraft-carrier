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
