import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

/**
 * Screenshot regression of the 3D scene at a fixed simulation time (PLAN §11).
 *
 * Software-rendered pixels differ slightly between machines and browser builds, so these
 * tests are opt-in: run them with `VISUAL=1 npm run e2e`, and refresh the baselines with
 * `VISUAL=1 npx playwright test visual --update-snapshots` after an intended visual change.
 */
test.describe('visual', () => {
  test.skip(!process.env.VISUAL, 'set VISUAL=1 to run screenshot comparisons');

  test.use({ viewport: { width: 960, height: 540 } });

  for (const time of [9, 17.5] as const) {
    test(`hangar view at ${time}h matches the baseline`, async ({ page }) => {
      // ui=0 hides the DOM overlay: font rendering is not what is under test here
      await openApp(page, `screen=hangar&fixedTime=12&time=${time}&ui=0`);
      await page.waitForTimeout(1500); // let the frozen frame settle (textures, shader compile)
      await expect(page.locator('canvas')).toHaveScreenshot(`hangar-${time}h.png`, {
        maxDiffPixelRatio: 0.03,
        animations: 'disabled',
      });
    });
  }
});
