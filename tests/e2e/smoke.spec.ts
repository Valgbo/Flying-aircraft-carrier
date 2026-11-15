import { expect, test } from '@playwright/test';
import {
  SLOW,
  evalIn,
  openApp,
  readNumber,
  setRange,
  trackPageErrors,
  turnedToStarboard,
  waitForFlight,
  waitForSimStep,
} from './helpers';

test.describe('smoke', () => {
  test('the app loads, draws the scene and shows the main menu', async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await expect(page.locator('canvas')).toBeVisible();
    await expect(page.getByTestId('main-menu')).toBeVisible();
    for (const id of ['menu-free-flight', 'menu-flight-ops', 'menu-hangar', 'menu-settings']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    // the ship idles in a hover with its turbines running
    const state = await evalIn<{ altitude: number; throttle: number }>(
      page,
      '({ altitude: window.__FAC__.sim.carrier.altitude, throttle: window.__FAC__.sim.turbines[0].throttle })',
    );
    expect(state.altitude).toBeGreaterThan(300);
    expect(state.throttle).toBeGreaterThan(0.4);
    expect(errors).toEqual([]);
  });

  test('free flight: holding the climb key lifts the ship off the sea', async ({ page }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await page.getByTestId('menu-free-flight').click();
    await expect(page.getByTestId('hud')).toBeVisible();
    await waitForFlight(page);

    await expect(page.getByTestId('hud-assist')).toHaveText('ON');
    const start = await readNumber(page, 'hud-altitude');
    expect(start).toBeLessThan(30); // afloat

    await page.keyboard.down('KeyW');
    await expect.poll(() => readNumber(page, 'hud-altitude'), SLOW).toBeGreaterThan(start + 25);
    await page.keyboard.up('KeyW');

    const afloat = await evalIn<boolean>(page, 'window.__FAC__.sim.carrier.afloat');
    expect(afloat).toBe(false);
    expect(errors).toEqual([]);
  });

  test('free flight: yaw and camera keys act on the ship and the view', async ({ page }) => {
    await openApp(page, 'screen=ops'); // ops starts airborne, so yaw has authority immediately
    await waitForFlight(page);
    const heading0 = await evalIn<number>(page, 'window.__FAC__.sim.carrier.headingDeg');
    await page.keyboard.down('KeyD');
    // signed, so the small wobble the wind gives the heading cannot pass for a turn
    await expect.poll(() => turnedToStarboard(page, heading0), SLOW).toBeGreaterThan(3);
    await page.keyboard.up('KeyD');

    const camera0 = await page.getByTestId('hud-camera').textContent();
    await page.keyboard.press('KeyC');
    await expect(page.getByTestId('hud-camera')).not.toHaveText(camera0 ?? '');
  });

  test('turbine panel: a manual throttle slider drives that turbine', async ({ page }) => {
    await openApp(page, 'screen=ops');
    await waitForFlight(page);

    await page.keyboard.press('KeyF'); // flight assist off → manual control
    await expect(page.getByTestId('hud-assist')).toHaveText('OFF');
    await waitForSimStep(page); // the flight model has handed the levers over
    await page.keyboard.press('KeyT');
    await expect(page.getByTestId('turbine-panel')).toBeVisible();

    await setRange(page, 'turbine-throttle-0', 0.9);
    await expect
      .poll(() => evalIn<number>(page, 'window.__FAC__.sim.controls.manualThrottle[0]'), SLOW)
      .toBeGreaterThan(0.85);
    await expect
      .poll(() => evalIn<number>(page, 'window.__FAC__.sim.turbines[0].throttle'), SLOW)
      .toBeGreaterThan(0.75);
    // the other turbines were not touched
    const other = await evalIn<number>(page, 'window.__FAC__.sim.controls.manualThrottle[3]');
    expect(other).toBeLessThan(0.8);

    await page.keyboard.press('KeyT');
    await expect(page.getByTestId('turbine-panel')).toBeHidden();
  });

  test('pause freezes the simulation and the pause menu can exit to the main menu', async ({
    page,
  }) => {
    await openApp(page, 'screen=ops');
    await waitForFlight(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    const t0 = await evalIn<number>(page, 'window.__FAC__.sim.time');
    await page.waitForTimeout(1500);
    const t1 = await evalIn<number>(page, 'window.__FAC__.sim.time');
    expect(t1).toBe(t0);

    await page.getByTestId('pause-resume').click();
    await expect(page.getByTestId('pause-menu')).toBeHidden();
    await expect
      .poll(() => evalIn<number>(page, 'window.__FAC__.sim.time'), SLOW)
      .toBeGreaterThan(t1);

    await page.keyboard.press('Escape');
    await page.getByTestId('pause-exit').click();
    await expect(page.getByTestId('main-menu')).toBeVisible();
  });

  test('hangar: a hotspot opens its info card and the demo sliders drive the turbines', async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await page.getByTestId('menu-hangar').click();
    await expect(page.getByTestId('hangar-overlay')).toBeVisible();

    // dispatch the click directly: the pin follows the orbiting model
    await page.getByTestId('hotspot-island').dispatchEvent('click');
    await expect(page.getByTestId('hangar-card')).toBeVisible();
    expect(
      await evalIn<string>(page, 'window.__FAC__.store.getState().hangar.selectedHotspot'),
    ).toBe('island');

    await setRange(page, 'hangar-throttle', 1);
    await expect
      .poll(() => evalIn<number>(page, 'window.__FAC__.sim.turbines[2].throttle'), SLOW)
      .toBeGreaterThan(0.9);
    await setRange(page, 'hangar-tilt', 1);
    await expect
      .poll(() => evalIn<number>(page, 'window.__FAC__.sim.turbines[2].tilt'), SLOW)
      .toBeGreaterThan(0.9);

    await page.getByTestId('hangar-back').click();
    await expect(page.getByTestId('main-menu')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('settings: the quality preset changes and persists across a reload', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('menu-settings').click();
    await expect(page.getByTestId('settings')).toBeVisible();
    await page.getByTestId('settings-quality-medium').click();
    await expect
      .poll(() => evalIn<string>(page, 'window.__FAC__.store.getState().settings.quality'))
      .toBe('medium');
    await page.getByTestId('settings-close').click();
    await expect(page.getByTestId('settings')).toBeHidden();

    await page.goto('/?mute=1'); // no ?quality flag: the stored preference applies
    await expect
      .poll(
        () =>
          evalIn<string>(
            page,
            'window.__FAC__ ? window.__FAC__.store.getState().settings.quality : ""',
          ),
        SLOW,
      )
      .toBe('medium');
  });

  test('flight ops: launching a jet sends it off the catapult', async ({ page }) => {
    test.slow();
    const errors = trackPageErrors(page);
    await openApp(page, 'screen=ops');
    await waitForFlight(page);
    await expect(page.getByTestId('ops-hud')).toBeVisible();
    expect(await evalIn<number>(page, 'window.__FAC__.sim.jets.length')).toBe(4);

    await page.keyboard.press('Space');
    await expect
      .poll(() => evalIn<number>(page, 'window.__FAC__.store.getState().ops.launches'), {
        timeout: 240_000,
        intervals: [1000],
      })
      .toBeGreaterThanOrEqual(1);
    const airborne = await evalIn<number>(
      page,
      'window.__FAC__.sim.jets.filter((j) => j.phase !== "parked" && j.phase !== "taxi").length',
    );
    expect(airborne).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
  });
});
