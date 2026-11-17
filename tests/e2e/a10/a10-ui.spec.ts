import { expect, test, type Page } from '@playwright/test';
import { evalIn } from '../helpers';
import {
  A10_TEST_TIMEOUT,
  SLOW,
  openA10,
  screenOf,
  simTime,
  startFlight,
  waitForSimTime,
} from './a10-helpers';

test.describe.configure({ timeout: A10_TEST_TIMEOUT });

/**
 * The A-10 overlay (src/a10/ui): menu navigation, the range events, loadout, credits, pause
 * menu, settings, checklist strip, toasts, crash panel, debrief and loading screen.
 */

type Hook = {
  store: { getState(): Record<string, unknown> & Record<string, (...a: unknown[]) => void> };
  getSim(): { time: number; events: unknown[]; options: { realism: { preset: string } } } | null;
  command(c: unknown): void;
  setInput(p: Record<string, number> | null): void;
};

function hook(page: Page, fn: (h: Hook) => unknown): Promise<unknown> {
  return page.evaluate((src) => {
    const h = (window as unknown as { __A10__: Hook }).__A10__;
    return new Function('h', `return (${src})(h);`)(h) as unknown;
  }, fn.toString());
}

test('the main menu works from the keyboard', async ({ page }) => {
  await openA10(page);
  await expect(page.getByTestId('a10-fly')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('a10-range-strafe')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByTestId('a10-credits')).toBeFocused();
  await page.keyboard.press('ArrowDown'); // wraps to the top
  await expect(page.getByTestId('a10-fly')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('a10-credits')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('a10-loadout')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('a10-loadout-screen')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('a10-menu')).toBeVisible();
  await page.getByTestId('a10-credits').click();
  await expect(page.getByTestId('a10-credits-screen')).toContainText('GPL-2.0-or-later');
  await expect(page.getByTestId('a10-credits-screen')).toContainText('Lee Elliott');
  await expect(page.getByTestId('a10-credits-screen')).toContainText('github.com/l0k1/A-10');
  await page.getByTestId('a10-credits-back').click();
  await expect(page.getByTestId('a10-menu')).toBeVisible();
});

test('the weapons range entries start their events', async ({ page }) => {
  test.slow(); // three flights
  await openA10(page);
  await startFlight(page, 'a10-range-strafe');
  expect(await evalIn<string>(page, 'window.__A10__.store.getState().scenario')).toBe('strafePit');
  await page.keyboard.press('Escape');
  await page.getByTestId('a10-pause-exit').click();
  await expect(page.getByTestId('a10-menu')).toBeVisible();
  expect(await evalIn<boolean>(page, 'window.__A10__.getSim() === null')).toBe(true);
  for (const [id, scenario] of [
    ['a10-range-bomb', 'bombCircle'],
    ['a10-range-lane', 'tacticalLane'],
  ] as const) {
    // the store records the event before the flight starts (flow.beginFlight reads it)
    await page.evaluate(() => {
      // keep the page on the menu: start nothing, only check the scenario choice
      (window as unknown as { __A10__: Hook }).__A10__.store.getState().setScenario('freeHunt');
    });
    await page.getByTestId(id).click();
    await expect
      .poll(() => evalIn<string>(page, 'window.__A10__.store.getState().scenario'))
      .toBe(scenario);
    await expect.poll(() => screenOf(page), SLOW).toBe('flight');
    await page.evaluate(() =>
      (window as unknown as { __A10__: Hook }).__A10__.store.getState().setScreen('menu'),
    );
    await expect(page.getByTestId('a10-menu')).toBeVisible();
  }
});

test('the loadout screen picks the preset and the gun load; the next flight carries them', async ({
  page,
}) => {
  test.slow(); // a reload and a flight
  await openA10(page);
  await page.getByTestId('a10-loadout').click();
  const screen = page.getByTestId('a10-loadout-screen');
  await expect(screen).toBeVisible();
  await expect(page.getByTestId('a10-loadout-stations').locator('li')).toHaveCount(11);
  await expect(screen.locator('svg.a10-schematic .a10-station')).toHaveCount(11);
  const presets = screen.locator('[data-testid^="a10-loadout-preset-"]');
  expect(await presets.count()).toBeGreaterThan(0);
  const last = presets.last();
  const id = ((await last.getAttribute('data-testid')) ?? '').replace('a10-loadout-preset-', '');
  await last.click();
  await expect
    .poll(() => evalIn<string>(page, 'window.__A10__.store.getState().loadoutId'))
    .toBe(id);
  await expect(page.getByTestId('a10-loadout-totals')).toContainText('rounds');
  await page.getByTestId('a10-gunload-allHEI').click();
  expect(await evalIn<string>(page, 'window.__A10__.store.getState().ammoLoad')).toBe('allHEI');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('a10-ui-v1') ?? '{}'))).toEqual({
    loadoutId: id,
    gunLoad: 'allHEI',
  });

  // both choices survive a reload: restored into the store before any flight starts
  await page.reload();
  await expect(page.getByTestId('a10-menu')).toBeVisible({ timeout: 60_000 });
  expect(await evalIn<string>(page, 'window.__A10__.store.getState().ammoLoad')).toBe('allHEI');
  expect(await evalIn<string>(page, 'window.__A10__.store.getState().loadoutId')).toBe(id);
  await page.getByTestId('a10-loadout').click();
  await expect(page.getByTestId(`a10-loadout-preset-${id}`).locator('input')).toBeChecked();
  await expect(page.getByTestId('a10-gunload-allHEI').locator('input')).toBeChecked();

  // Fly now from the loadout screen: the flight carries that preset and gun load
  await startFlight(page, 'a10-loadout-fly');
  expect(await evalIn<string>(page, 'window.__A10__.getSim().options.ammoLoad')).toBe('allHEI');
  expect(await evalIn<string>(page, 'window.__A10__.getSim().gun.load')).toBe('allHEI');
  expect(await evalIn<string>(page, 'window.__A10__.getSim().options.loadoutId')).toBe(id);
});

test('the pause menu: controls reference, settings, rearm; Escape always resumes', async ({
  page,
}) => {
  await openA10(page);
  await startFlight(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('a10-pause')).toBeVisible();
  await expect(page.getByTestId('a10-pause-resume')).toBeFocused();

  await page.getByTestId('a10-pause-controls').click();
  const ref = page.getByTestId('a10-controls-reference');
  await expect(ref).toBeVisible();
  await expect(ref).toContainText('Master Arm');
  await page.keyboard.press('Escape'); // resumes from the controls page too
  await expect(page.getByTestId('a10-pause')).toHaveCount(0);
  expect(await evalIn<boolean>(page, 'window.__A10__.store.getState().paused')).toBe(false);

  await page.keyboard.press('Escape');
  await page.getByTestId('a10-pause-settings').click();
  await expect(page.getByTestId('a10-settings-dialog')).toBeVisible();
  await expect(page.getByTestId('a10-pause')).toBeHidden();
  await page.keyboard.press('Escape'); // closes the dialog and resumes the flight
  await expect(page.getByTestId('a10-settings-dialog')).toHaveCount(0);
  await expect(page.getByTestId('a10-pause')).toHaveCount(0);
  const t0 = await simTime(page);
  await waitForSimTime(page, 0.05, t0);

  await page.keyboard.press('Escape');
  await page.getByTestId('a10-pause-rearm').click();
  await expect(page.getByTestId('a10-pause-rearm')).toBeDisabled();
  expect(
    await evalIn<boolean>(page, 'window.__A10__.getSim().commands.some((c) => c.type === "rearm")'),
  ).toBe(true);
  await page.getByTestId('a10-pause-resume').click();
  await expect(page.getByTestId('a10-pause')).toHaveCount(0);
});

test('the checklist strip names the next step and follows the switches', async ({ page }) => {
  await openA10(page);
  await startFlight(page);
  const strip = page.getByTestId('a10-checklist');
  await expect(strip).toBeVisible();
  await expect(strip).toHaveAttribute('data-step', 'gun.masterArm');
  await expect(strip).toContainText('Master Arm → ARM');
  await hook(page, (h) => {
    h.command({ type: 'masterArm', value: 'ARM' });
    h.command({ type: 'gunPac', value: 'ARM' });
  });
  await expect(strip).toHaveAttribute('data-step', 'gun.masterMode', SLOW);
  await expect(strip).toContainText('Master mode → GUNS');
  await hook(page, (h) => h.command({ type: 'masterMode', value: 'GUNS' }));
  await expect(strip).toHaveAttribute('data-step', 'gun.trigger', SLOW);
  await expect(strip).toContainText('first detent for PAC');
  await hook(page, (h) => h.store.getState().updateSettings({ checklist: false }));
  await expect(strip).toHaveCount(0);
});

test('toasts show sim messages; kill messages only in the Relaxed preset', async ({ page }) => {
  test.slow(); // two page loads and two flights
  const destroyed = (h: Hook) => {
    const sim = h.getSim()!;
    sim.events.push({ type: 'message', t: sim.time, text: 'RANGE IS HOT', level: 'info' });
    sim.events.push({
      type: 'vehicleDestroyed',
      t: sim.time,
      vehicleId: 1,
      vehicleKind: 'mbt',
      catastrophic: false,
      position: { x: 0, y: 0, z: 0 },
    });
  };
  await openA10(page);
  await startFlight(page);
  await hook(page, destroyed);
  const toasts = page.getByTestId('a10-toasts');
  await expect(toasts).toContainText('RANGE IS HOT', SLOW);
  await expect(toasts).not.toContainText('T-72 destroyed');

  await openA10(page, 'realism=relaxed');
  await startFlight(page);
  expect(await evalIn<string>(page, 'window.__A10__.getSim().options.realism.preset')).toBe(
    'relaxed',
  );
  await hook(page, destroyed);
  await expect(page.getByTestId('a10-toasts')).toContainText('T-72 destroyed', SLOW);
});

test('flying into the ground shows the crash panel; Restart starts again', async ({ page }) => {
  test.slow(); // a dive and a second flight
  await openA10(page, 'start=0,0,30,0,250');
  await startFlight(page);
  const nonce = await evalIn<number>(page, 'window.__A10__.store.getState().flightNonce');
  await hook(page, (h) => h.setInput({ pitch: -1 }));
  const crash = page.getByTestId('a10-crash');
  await expect(crash).toBeVisible(SLOW);
  await expect(crash).toContainText(/You flew into the (ground|water)|broke up/);
  await expect(page.getByTestId('a10-crash-restart')).toBeFocused();
  await expect(page.getByTestId('a10-checklist')).toHaveCount(0);
  await hook(page, (h) => h.setInput(null));
  await page.getByTestId('a10-crash-restart').click();
  await expect
    .poll(() => evalIn<number>(page, 'window.__A10__.store.getState().flightNonce'), SLOW)
    .toBeGreaterThan(nonce);
  await expect.poll(() => screenOf(page), SLOW).toBe('flight');
  await expect(page.getByTestId('a10-crash')).toHaveCount(0);
});

test('End flight shows the debrief; Fly again starts a new flight', async ({ page }) => {
  test.slow(); // two flights
  await openA10(page);
  await startFlight(page);
  await page.keyboard.press('Escape');
  await page.getByTestId('a10-pause-debrief').click();
  const debrief = page.getByTestId('a10-debrief');
  await expect(debrief).toBeVisible();
  await expect(page.getByTestId('a10-debrief-summary')).toContainText('Rounds fired');
  await expect(debrief).toContainText('Gun bursts');
  await expect(debrief).toContainText('Hits by vehicle');
  // the sim stays readable but does not run on the debrief
  const t0 = await simTime(page);
  await page.waitForTimeout(800);
  expect(await simTime(page)).toBe(t0);
  await page.getByTestId('a10-debrief-again').click();
  await expect.poll(() => screenOf(page), SLOW).toBe('flight');
  await waitForSimTime(page, 0, 0);
});

test('the loading screen shows the progress and step of flow.beginFlight', async ({ page }) => {
  await openA10(page);
  await hook(page, (h) => {
    const s = h.store.getState();
    s.setScreen('loading');
    s.setLoading(0.42, 'Loading the aircraft model');
  });
  const loading = page.getByTestId('a10-loading');
  await expect(loading).toBeVisible();
  await expect(loading).toContainText('Loading the aircraft model');
  await expect(loading).toContainText('42%');
  await expect(loading.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
});

test('the help panel lists the controls beside the flight; Escape closes it', async ({ page }) => {
  await openA10(page);
  await startFlight(page);
  await hook(page, (h) => h.store.getState().setHelpOpen(true));
  const help = page.getByTestId('a10-help');
  await expect(help).toBeVisible();
  await expect(help).toContainText('Master Arm');
  // the flight goes on behind it
  await waitForSimTime(page, 0.05);
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  expect(await evalIn<boolean>(page, 'window.__A10__.store.getState().paused')).toBe(false);
});

test('Keep on screen shows the controls in flight; a rebinding renames their keys and the strip', async ({
  page,
}) => {
  await openA10(page);
  await startFlight(page);
  // pause → Controls reference → Keep on screen: the flight resumes with the list beside it
  await page.keyboard.press('Escape');
  await page.getByTestId('a10-pause-controls').click();
  await page.getByTestId('a10-pause-controls-keep').click();
  await expect(page.getByTestId('a10-pause')).toHaveCount(0);
  const help = page.getByTestId('a10-help');
  await expect(help).toBeVisible();
  expect(await evalIn<boolean>(page, 'window.__A10__.store.getState().paused')).toBe(false);
  const masterArmKeys = help.locator('.a10-keys__row', { hasText: 'Master Arm' }).locator('kbd');
  await expect(masterArmKeys).toHaveText(['1']);
  const strip = page.getByTestId('a10-checklist');
  await expect(strip).toHaveAttribute('data-step', 'gun.masterArm');
  await expect(strip.locator('kbd')).toHaveText(['1']);

  // pause again (with the list open, Escape would close the list first), Settings, and add J
  // to Master Arm in the input module's controls panel
  await hook(page, (h) => h.store.getState().setPaused(true));
  await page.getByTestId('a10-pause-settings').click();
  await page.getByTestId('binding-add-masterArm').click();
  await expect(page.getByTestId('capture-masterArm')).toBeVisible();
  await page.keyboard.press('j');
  await expect(page.getByTestId('capture-masterArm')).toHaveCount(0);
  await page.keyboard.press('Escape'); // closes the dialog and resumes the flight
  await expect(page.getByTestId('a10-settings-dialog')).toHaveCount(0);
  expect(await evalIn<boolean>(page, 'window.__A10__.store.getState().paused')).toBe(false);

  // the list that stayed open and the checklist strip both name the new key
  await expect(masterArmKeys).toHaveText(['1', 'J']);
  await expect(strip.locator('kbd')).toHaveText(['1', 'J'], SLOW);
  await expect(strip).toContainText('Master Arm → ARM');
});

test('the menu realism chip opens the settings at the realism table', async ({ page }) => {
  await openA10(page);
  await page.getByTestId('a10-menu-realism-chip').click();
  await expect(page.getByTestId('a10-settings-dialog')).toBeVisible();
  await expect(page.getByTestId('a10-realism-table')).toBeInViewport();
  await expect(page.getByTestId('a10-realism-table')).toContainText('Snaps to the nearest vehicle');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('a10-settings-dialog')).toHaveCount(0);
  await expect(page.getByTestId('a10-menu')).toBeVisible();
});
