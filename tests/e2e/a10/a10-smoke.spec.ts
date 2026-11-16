import { expect, test, type Page } from '@playwright/test';
import { evalIn, openApp, trackPageErrors } from '../helpers';
import {
  A10_TEST_TIMEOUT,
  SLOW,
  canvasStats,
  openA10,
  simTime,
  startFlight,
  waitForSimTime,
} from './a10-helpers';

test.describe.configure({ timeout: A10_TEST_TIMEOUT });

/**
 * A-10 smoke tests (PLAN_A10.md §16, browser tests): the page loads and draws, a flight starts
 * and runs, the stick moves the aircraft, Master Arm gates the gun, pause stops time, settings
 * persist — and the carrier app at / still loads.
 */

test('the A-10 page loads at /a10/ with its menu and a WebGL canvas', async ({ page }) => {
  const errors = trackPageErrors(page);
  await openA10(page);
  await expect(page).toHaveTitle(/A-10/);
  await expect(page.getByTestId('a10-menu')).toContainText('A-10C Warthog');
  for (const id of [
    'a10-fly',
    'a10-range-strafe',
    'a10-range-bomb',
    'a10-range-lane',
    'a10-loadout',
    'a10-settings',
    'a10-credits',
  ])
    await expect(page.getByTestId(id)).toBeVisible();
  const canvas = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const gl = c ? (c.getContext('webgl2') ?? c.getContext('webgl')) : null;
    return { width: c?.width ?? 0, height: c?.height ?? 0, gl: gl !== null };
  });
  expect(canvas.gl).toBe(true);
  expect(canvas.width).toBeGreaterThan(0);
  expect(canvas.height).toBeGreaterThan(0);
  // the telemetry line is a debugging aid: hidden without ?fps=1
  await expect(page.getByTestId('a10-telemetry')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Fly now reaches the flight screen, the world draws and sim time advances', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openA10(page);
  await startFlight(page);
  await expect(page.getByTestId('a10-menu')).toHaveCount(0);
  await expect(page.getByTestId('a10-loading')).toHaveCount(0);
  const t0 = await simTime(page);
  await waitForSimTime(page, 0.1, t0);
  // the world is on screen: the picture is not one flat colour
  await expect.poll(async () => (await canvasStats(page)).spread, SLOW).toBeGreaterThan(8);
  // telemetry reaches the store (≈10 Hz)
  await expect
    .poll(() => evalIn<number>(page, 'window.__A10__.store.getState().telemetry.time'), SLOW)
    .toBeGreaterThan(t0);
  expect(errors).toEqual([]);
});

test('holding the stick through window.__A10__.setInput turns or pitches the aircraft', async ({
  page,
}) => {
  await openA10(page);
  await startFlight(page);
  const attitude = () =>
    evalIn<{ heading: number; pitch: number }>(
      page,
      '(() => { const a = window.__A10__.getSim().aircraft; return { heading: a.heading, pitch: a.pitch }; })()',
    );
  const a0 = await attitude();
  await page.evaluate(() =>
    (
      window as unknown as { __A10__: { setInput(p: Record<string, number> | null): void } }
    ).__A10__.setInput({ roll: 0.7, pitch: 0.4 }),
  );
  await expect
    .poll(async () => {
      const a = await attitude();
      const dh = Math.abs(((a.heading - a0.heading + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      return Math.max(dh, Math.abs(a.pitch - a0.pitch)) * (180 / Math.PI);
    }, SLOW)
    .toBeGreaterThan(5);
  await page.evaluate(() =>
    (window as unknown as { __A10__: { setInput(p: null): void } }).__A10__.setInput(null),
  );
});

const holdTrigger = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __A10__: { setInput(p: Record<string, number>): void } }
    ).__A10__.setInput({ trigger: 2 }),
  );
const rounds = (page: Page) => evalIn<number>(page, 'window.__A10__.getSim().gun.rounds');

test('with Master Arm at SAFE the trigger fires no rounds', async ({ page }) => {
  await openA10(page);
  await startFlight(page);
  const loaded = await rounds(page);
  expect(await evalIn<string>(page, 'window.__A10__.getSim().avionics.masterArm')).toBe('SAFE');
  await holdTrigger(page);
  await waitForSimTime(page, 1);
  expect(await rounds(page)).toBe(loaded);
});

// FIXME(weapons): src/a10/core/weapons still has the foundation's stand-in stepGun (a no-op), so
// no round can leave yet. Remove `.fixme` when the weapons module's GAU-8 lands; nothing else in
// this test needs to change.
test.fixme('with Master Arm ARM and GUN/PAC ARM the trigger fires', async ({ page }) => {
  await openA10(page);
  await startFlight(page);
  const loaded = await rounds(page);
  await page.evaluate(() => {
    const hook = (window as unknown as { __A10__: { command(c: unknown): void } }).__A10__;
    hook.command({ type: 'masterArm', value: 'ARM' });
    hook.command({ type: 'gunPac', value: 'ARM' });
    hook.command({ type: 'masterMode', value: 'GUNS' });
  });
  await expect
    .poll(() => evalIn<string>(page, 'window.__A10__.getSim().avionics.masterArm'), SLOW)
    .toBe('ARM');
  await holdTrigger(page);
  await expect.poll(() => rounds(page), SLOW).toBeLessThan(loaded);
});

test('pause stops sim time, and Escape resumes it', async ({ page }) => {
  await openA10(page);
  await startFlight(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('a10-pause')).toBeVisible();
  // let a frame that was already stepping finish, then time must stand still
  await page.waitForTimeout(500);
  const t0 = await simTime(page);
  await page.waitForTimeout(2000);
  expect(await simTime(page)).toBe(t0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('a10-pause')).toHaveCount(0);
  await waitForSimTime(page, 0.05, t0);
});

test("settings persist across a reload under 'a10-settings-v1'", async ({ page }) => {
  await openA10(page);
  await page.getByTestId('a10-settings').click();
  const dialog = page.getByTestId('a10-settings-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('a10-set-checklist').click();
  await page.getByTestId('a10-set-realism-standard').click();
  await page.getByTestId('a10-set-quality-high').click();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('a10-settings-v1') ?? 'null'),
  );
  expect(stored).toMatchObject({ checklist: false, realism: 'standard', quality: 'high' });
  await page.getByTestId('a10-settings-close').click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('a10-menu')).toBeVisible({ timeout: 60_000 });
  const settings = await evalIn<Record<string, unknown>>(
    page,
    'window.__A10__.store.getState().settings',
  );
  // ?quality=low on the URL overrides the saved preset for this visit, without overwriting it
  expect(settings).toMatchObject({ checklist: false, realism: 'standard', quality: 'low' });
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('a10-settings-v1') ?? '{}').quality),
  ).toBe('high');
  await page.getByTestId('a10-settings').click();
  await expect(page.getByTestId('a10-set-checklist')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('a10-set-realism-standard').locator('input')).toBeChecked();
});

test('the carrier app at / still loads', async ({ page }) => {
  const errors = trackPageErrors(page);
  await openApp(page);
  await expect(page.getByTestId('main-menu')).toBeVisible();
  expect(await evalIn<boolean>(page, 'typeof window.__A10__ === "undefined"')).toBe(true);
  expect(errors).toEqual([]);
});
