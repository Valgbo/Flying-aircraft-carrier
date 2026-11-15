import { expect, type Page } from '@playwright/test';

/**
 * Helpers for end-to-end tests. The app exposes `window.__FAC__` (store, sim, input sources,
 * action bus); tests read it through string expressions so they need no app types.
 *
 * Headless Chromium renders WebGL in software, so the frame rate is low and simulated time
 * runs slower than real time: always wait on state with `expect.poll`, never on a fixed delay.
 */

export const SLOW: { timeout: number; intervals: number[] } = {
  timeout: 90_000,
  intervals: [250, 500, 1000],
};

export function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  return errors;
}

/** Evaluate a JS expression in the page and return its (JSON-serialisable) value. */
export async function evalIn<T>(page: Page, expression: string): Promise<T> {
  return (await page.evaluate(expression)) as T;
}

/** Open the app with the cheapest graphics preset and wait until the scene has drawn. */
export async function openApp(page: Page, query = ''): Promise<void> {
  const extra = query ? `&${query}` : '';
  await page.goto(`/?quality=low&mute=1${extra}`);
  await expect
    .poll(
      () =>
        evalIn<boolean>(
          page,
          'Boolean(window.__FAC__ && window.__FAC__.store.getState().sceneReady)',
        ),
      SLOW,
    )
    .toBe(true);
  await expect(page.getByTestId('loading-screen')).toBeHidden({ timeout: 30_000 });
}

/** Wait until the lazily loaded flight physics is running (sim time advancing). */
export async function waitForFlight(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        evalIn<boolean>(
          page,
          '(() => { const s = window.__FAC__.store.getState(); return !s.physicsLoading && window.__FAC__.sim.time > 0.2; })()',
        ),
      SLOW,
    )
    .toBe(true);
}

export async function readNumber(page: Page, testId: string): Promise<number> {
  const text = (await page.getByTestId(testId).textContent()) ?? '';
  return Number(text.replace(/[^0-9.+-]/g, ''));
}

/** Set a range input the way a user drag would (React-controlled inputs need the native setter). */
export async function setRange(page: Page, testId: string, fraction: number): Promise<void> {
  await page.getByTestId(testId).evaluate((el, f) => {
    const input = el as HTMLInputElement;
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const step = Number(input.step || 1) || 1;
    const raw = min + (max - min) * f;
    const value = Math.round(raw / step) * step;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, fraction);
}
