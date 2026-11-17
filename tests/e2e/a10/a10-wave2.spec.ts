import { expect, test, type Page } from '@playwright/test';
import { evalIn } from '../helpers';
import {
  A10_TEST_TIMEOUT,
  SLOW,
  diveStart,
  diveStartPoint,
  inPage,
  openA10,
  startEvent,
  untilSimTime,
} from './a10-helpers';

test.describe.configure({ timeout: A10_TEST_TIMEOUT });

/**
 * Wave-2 browser tests (PLAN_A10.md §16): a scripted pilot flies a strafing pass and the target's
 * state changes, and the debrief shows the pass; Master Arm SAFE blocks every release (the gun
 * and a pickle with a bomb profile) while ARM lets the bomb go; the display pages switch; the
 * range options and the loadout's free choice reach the flight.
 *
 * A pass is flown from an air start in a dive aimed at its target (?start=x,z,agl,heading,kias,
 * pathDeg): a first load starts the event to read where the target is (every load builds the
 * same world and the same first flight: the same seeds), the second starts the dive there.
 */

/** The terrain height under a point of the page's world. */
function groundAt(page: Page, p: { x: number; z: number }): Promise<number> {
  return inPage(page, (h, q) => h.getTerrain()!.heightAt(q.x, q.z), p);
}

test.describe.serial('a scripted strafing pass on the tactical lane', () => {
  let page: Page;
  let target: { id: number; kind: string; name: string };

  test.beforeAll(async ({ browser }, testInfo) => {
    // one page for both tests (the debrief reads the pass the first one flew)
    const { baseURL, viewport } = testInfo.project.use;
    page = await browser.newPage({ baseURL, viewport: viewport ?? { width: 1280, height: 720 } });
    // calm air and the lane column halted (the weapons-range options, 'a10-range-v1')
    await page.addInitScript(() => {
      localStorage.setItem(
        'a10-range-v1',
        JSON.stringify({ windKt: 0, windClock: 12, turbulence: 'calm', columnKmh: 0 }),
      );
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('the target’s state changes', async () => {
    test.setTimeout(1_500_000); // two page loads and a pass on a machine shared with others
    await openA10(page);
    await startEvent(page, 'a10-range-lane');
    // the column's cargo truck (a soft target), approached square to its side from the side
    // nearer the lane's run-in, so the rest of the column is not in the line of fire
    const lane = await inPage(page, (h) => {
      const sim = h.getSim()!;
      const col = sim.targets.groups.find((g) => g.template === 'laneColumn')!;
      const list = sim.targets.vehicles.filter((v) => col.vehicleIds.includes(v.id));
      const v = list.find((x) => x.kind === 'truckCargo') ?? list[list.length - 1];
      const t = h.getTerrain()!;
      const runIn = sim.debrief.internal.layout?.runIn ?? t.start.heading;
      return {
        id: v.id,
        kind: v.kind,
        x: v.position.x,
        z: v.position.z,
        ground: t.heightAt(v.position.x, v.position.z),
        heading: v.heading,
        speed: v.speed,
        condition: v.condition,
        runIn,
        columnSpeed: col.speed,
      };
    });
    // the range options halted the column: it stays where this load found it
    expect(lane.columnSpeed).toBe(0);
    expect(lane.speed).toBe(0);
    expect(lane.condition).toBe('intact');
    const side = [lane.heading + Math.PI / 2, lane.heading - Math.PI / 2];
    const off = (a: number) =>
      Math.abs(Math.atan2(Math.sin(a - lane.runIn), Math.cos(a - lane.runIn)));
    const heading = off(side[0]) <= off(side[1]) ? side[0] : side[1];
    const start = diveStart(lane, heading, await groundAt(page, diveStartPoint(lane, heading)));
    target = {
      id: lane.id,
      kind: lane.kind,
      name: lane.kind === 'truckCargo' ? 'Cargo truck' : lane.kind,
    };

    // the pass: Master Arm ARM, GUN/PAC ARM, GUNS (?arm=1); a burst of about a second from 0.4 s,
    // then the pull-off (the rounds fly on; the climb after the burst closes the pass). Few
    // seconds of sim time: software WebGL on a busy machine can run the sim at 1/50 of real time
    await openA10(page, `start=${start}&arm=1`);
    await startEvent(page, 'a10-range-lane');
    await untilSimTime(page, 0.4);
    await inPage(page, (h) => h.setInput({ trigger: 2 }));
    await untilSimTime(page, 1.3);
    await inPage(page, (h) => h.setInput({ trigger: 0 }));
    await untilSimTime(page, 1.5);
    await inPage(page, (h) => h.setInput({ trigger: 0, pitch: 0.7 }));
    await untilSimTime(page, 3.5);
    await inPage(page, (h) => h.setInput(null));

    const fired = await inPage(page, (h) => h.getSim()!.gun.totalFired);
    expect(fired).toBeGreaterThan(30);
    // the rounds reach it and it is no longer intact
    await expect
      .poll(
        () =>
          inPage(
            page,
            (h, id) => h.getSim()!.targets.vehicles.find((v) => v.id === id)!.condition,
            target.id,
          ),
        SLOW,
      )
      .not.toBe('intact');
    const hits = await inPage(
      page,
      (h, id) => h.getSim()!.debrief.hits.filter((r) => r.vehicleId === id).length,
      target.id,
    );
    expect(hits).toBeGreaterThan(0);
    expect(await evalIn<boolean>(page, 'window.__A10__.getSim().aircraft.crashed')).toBe(false);
  });

  test('the debrief shows the pass', async () => {
    // one pass, its burst and hits, closed at the pull-off
    await expect
      .poll(
        () => evalIn<string>(page, 'window.__A10__.getSim().debrief.passes[0]?.endReason ?? ""'),
        SLOW,
      )
      .not.toBe('');
    const pass = await inPage(page, (h) => {
      const d = h.getSim()!.debrief;
      return {
        count: d.passes.length,
        bursts: d.passes[0].bursts.length,
        hits: d.passes[0].hits.length,
      };
    });
    expect(pass.count).toBe(1);
    expect(pass.bursts).toBe(1);
    expect(pass.hits).toBeGreaterThan(0);

    // after the pass, on request: the pause menu's "Debrief so far"
    await page.keyboard.press('Escape');
    await page.getByTestId('a10-pause-pass-debrief').click();
    const view = page.getByTestId('a10-pause-debrief-view');
    await expect(view.getByTestId('a10-pass-tab-1')).toBeVisible();
    await expect(view.getByTestId('a10-pass-tab-1')).toContainText('GAU-8');
    const detail = view.getByTestId('a10-debrief-pass');
    await expect(detail).toContainText('Pass 1');
    await expect(detail).toContainText(target.name);
    // the overhead plot of the pass, around the vehicle it attacked
    await expect(
      detail.getByRole('img', { name: new RegExp(`^Pass 1: \\d+ impacts around ${target.name}`) }),
    ).toBeVisible();
    await expect(detail.getByTestId('a10-pass-events')).toContainText('Burst 1');

    // at the end of the flight: the debrief screen shows the same pass
    await page.getByRole('button', { name: 'End flight', exact: true }).click();
    const debrief = page.getByTestId('a10-debrief');
    await expect(debrief).toBeVisible();
    await expect(page.getByTestId('a10-pass-tab-1')).toContainText('GAU-8');
    await expect(page.getByTestId('a10-debrief-pass')).toContainText(target.name);
  });
});

test('Master Arm SAFE blocks every release: the gun and a pickle with a bomb profile', async ({
  page,
}) => {
  test.setTimeout(1_500_000); // two page loads and a pass on a machine shared with others
  // the bull's-eye of the bombing circle and its run-in
  await openA10(page);
  await startEvent(page, 'a10-range-bomb');
  const bull = await inPage(page, (h) => {
    const sim = h.getSim()!;
    const layout = sim.debrief.internal.layout!;
    return {
      x: layout.x,
      z: layout.z,
      runIn: layout.runIn,
      ground: h.getTerrain()!.heightAt(layout.x, layout.z),
    };
  });
  const start = diveStart(bull, bull.runIn, await groundAt(page, diveStartPoint(bull, bull.runIn)));

  // a CCIP dive at the bull with the tank hunter's Mk-82 profile, Master Arm SAFE
  await openA10(page, `start=${start}`);
  await startEvent(page, 'a10-range-bomb', true);
  await inPage(page, (h) => {
    const sim = h.getSim()!;
    const av = sim.avionics;
    const n = av.profiles.length;
    const from = av.profiles.findIndex((p) => p.id === av.selectedProfile);
    const to = av.profiles.findIndex((p) => p.store === 'MK-82');
    for (let k = 0; k < (to - from + n) % n; k++) h.command({ type: 'profile', dir: 1 });
    h.command({ type: 'masterMode', value: 'CCIP' });
    h.store.getState().setPaused(false);
  });
  await untilSimTime(page, 0.2);
  const before = await inPage(page, (h) => {
    const sim = h.getSim()!;
    const av = sim.avionics;
    return {
      masterArm: av.masterArm,
      mode: av.masterMode,
      store: av.profiles.find((p) => p.id === av.selectedProfile)?.store,
      rounds: sim.gun.rounds,
      stores: sim.stores.stations.reduce((n, s) => n + s.stores.length + (s.rockets ?? 0), 0),
    };
  });
  expect(before).toMatchObject({ masterArm: 'SAFE', mode: 'CCIP', store: 'MK-82' });

  // trigger and pickle held for a second: nothing leaves. The pickle press is refused at once
  // (the avionics' message, a toast that lasts a few seconds of real time: look right away)
  const t0 = await evalIn<number>(page, 'window.__A10__.getSim().time');
  await inPage(page, (h) => h.setInput({ trigger: 2, weaponRelease: true }));
  await expect(page.getByTestId('a10-toasts')).toContainText('MASTER ARM SAFE', SLOW);
  await untilSimTime(page, t0 + 1);
  await inPage(page, (h) => h.setInput({ trigger: 0, weaponRelease: false }));
  const safe = await inPage(page, (h) => {
    const sim = h.getSim()!;
    return {
      fired: sim.gun.totalFired,
      rounds: sim.gun.rounds,
      records: sim.debrief.weapons.length,
      bodies: sim.projectiles.bodies.length,
      queued: sim.stores.releaseQueue.length,
      stores: sim.stores.stations.reduce((n, s) => n + s.stores.length + (s.rockets ?? 0), 0),
      passes: sim.debrief.passes.length,
    };
  });
  expect(safe).toEqual({
    fired: 0,
    rounds: before.rounds,
    records: 0,
    bodies: 0,
    queued: 0,
    stores: before.stores,
    passes: 0,
  });

  // the same pickle with Master Arm ARM: the bomb leaves
  await inPage(page, (h) => h.command({ type: 'masterArm', value: 'ARM' }));
  await expect
    .poll(() => evalIn<string>(page, 'window.__A10__.getSim().avionics.masterArm'), SLOW)
    .toBe('ARM');
  await inPage(page, (h) => h.setInput({ weaponRelease: true }));
  await expect
    .poll(() => evalIn<number>(page, 'window.__A10__.getSim().debrief.weapons.length'), SLOW)
    .toBe(1);
  await inPage(page, (h) => h.setInput({ weaponRelease: false, pitch: 0.7 }));
  const armed = await inPage(page, (h) => {
    const sim = h.getSim()!;
    const w = sim.debrief.weapons[0];
    return {
      store: w.store,
      simulated: w.simulated,
      stores: sim.stores.stations.reduce((n, s) => n + s.stores.length + (s.rockets ?? 0), 0),
      fired: sim.gun.totalFired,
    };
  });
  expect(armed).toEqual({ store: 'MK-82', simulated: false, stores: before.stores - 1, fired: 0 });
  await inPage(page, (h) => h.setInput(null));
});

test('the display pages switch: OSB and page commands, and the sensor of interest', async ({
  page,
}) => {
  await openA10(page);
  await startEvent(page, 'a10-fly');
  const displays = () =>
    inPage(page, (h) => {
      const av = h.getSim()!.avionics;
      return { left: av.mfd.left, right: av.mfd.right, soi: av.soi };
    });
  expect(await displays()).toEqual({ left: 'TAD', right: 'DSMS', soi: 'HUD' });
  // the bottom row of OSBs selects pages (OSB 14: TGP, 13: MAV, 12: DSMS, 15: TAD)
  await inPage(page, (h) => h.command({ type: 'osb', display: 'R', button: 14 }));
  await expect.poll(displays, SLOW).toEqual({ left: 'TAD', right: 'TGP', soi: 'HUD' });
  await inPage(page, (h) => h.command({ type: 'mfdPage', display: 'L', page: 'MAV' }));
  await expect.poll(displays, SLOW).toEqual({ left: 'MAV', right: 'TGP', soi: 'HUD' });
  // a sensor page can be the sensor of interest; leaving it for a page that cannot hands it
  // back to the HUD
  await inPage(page, (h) => h.command({ type: 'soi', value: 'RMFD' }));
  await expect.poll(displays, SLOW).toEqual({ left: 'MAV', right: 'TGP', soi: 'RMFD' });
  await inPage(page, (h) => h.command({ type: 'osb', display: 'R', button: 12 }));
  await expect.poll(displays, SLOW).toEqual({ left: 'MAV', right: 'DSMS', soi: 'HUD' });
  await inPage(page, (h) => h.command({ type: 'osb', display: 'L', button: 15 }));
  await expect.poll(displays, SLOW).toEqual({ left: 'TAD', right: 'DSMS', soi: 'HUD' });
});

test('the range options and the loadout’s free choice reach the flight, and are remembered', async ({
  page,
}) => {
  test.slow(); // a flight and a reload
  await openA10(page);
  // range options: 15 kn from 3 o'clock, moderate turbulence, the lane column at 30 km/h
  await page.getByTestId('a10-range-options-open').click();
  const dialog = page.getByTestId('a10-range-options');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '15 kn', exact: true }).click();
  await dialog.getByTestId('a10-range-clock').selectOption('3');
  await dialog.getByTestId('a10-range-turb-moderate').click();
  await dialog.getByRole('button', { name: '30 km/h', exact: true }).click();
  await dialog.getByTestId('a10-range-options-done').click();
  await expect(dialog).toHaveCount(0);
  const conditions = "Wind 15 kn from 3 o'clock · moderate turbulence · column 30 km/h";
  await expect(page.getByTestId('a10-range-conditions')).toHaveText(conditions);

  // the free choice: from the tank hunter, three Mk-82 AIR on a TER on station 4, a Mk-82 on
  // the centreline (which empties stations 5 and 7)
  await page.getByTestId('a10-loadout').click();
  await page.getByTestId('a10-loadout-custom').click();
  await page.getByTestId('a10-station-select-4').selectOption({ label: 'TER · 3 × Mk-82 AIR' });
  await page.getByTestId('a10-station-select-6').selectOption({ label: 'Mk-82' });
  await expect(page.getByTestId('a10-loadout-screen')).toContainText('Stations 5 and 7 emptied');
  await expect(page.getByTestId('a10-custom-issues')).toHaveCount(0);
  await page.getByTestId('a10-loadout-back').click();
  await expect(page.getByTestId('a10-menu-loadout-chip')).toContainText('Custom');

  await startEvent(page, 'a10-range-lane');
  const flight = await inPage(page, (h) => {
    const sim = h.getSim()!;
    const at = (n: number) => sim.stores.stations.find((s) => s.station === n)!;
    const col = sim.targets.groups.find((g) => g.template === 'laneColumn')!;
    return {
      loadoutId: sim.options.loadoutId,
      st4: { rack: at(4).rack, stores: at(4).stores },
      st5: at(5).stores.length,
      st6: at(6).stores,
      st7: at(7).stores.length,
      st3: at(3).stores,
      wind: sim.world.surfaceWind,
      turbulence: sim.world.turbulence,
      runIn: sim.debrief.internal.layout!.runIn,
      columnSpeed: col.speed,
    };
  });
  expect(flight.loadoutId).toBe('custom');
  expect(flight.st4).toEqual({ rack: 'TER-9A', stores: ['MK-82AIR', 'MK-82AIR', 'MK-82AIR'] });
  expect(flight.st6).toEqual(['MK-82']);
  expect([flight.st5, flight.st7]).toEqual([0, 0]);
  // the rest of the tank hunter stays (the Mavericks on station 3)
  expect(flight.st3).toEqual(['AGM-65D', 'AGM-65D']);
  // 15 kn from 3 o'clock along the lane's run-in: the air moves toward 9 o'clock
  const kn = 0.514444;
  expect(Math.hypot(flight.wind.x, flight.wind.z)).toBeCloseTo(15 * kn, 3);
  const toward = flight.runIn - Math.PI / 2;
  const along = (flight.wind.x * Math.sin(toward) - flight.wind.z * Math.cos(toward)) / (15 * kn);
  expect(along).toBeGreaterThan(0.999);
  expect(flight.turbulence).toBeCloseTo(0.5, 6);
  expect(flight.columnSpeed).toBeCloseTo(30 / 3.6, 6);

  // both survive a reload
  await page.keyboard.press('Escape');
  await page.getByTestId('a10-pause-exit').click();
  await page.reload();
  await expect(page.getByTestId('a10-menu')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('a10-range-conditions')).toHaveText(conditions);
  await expect(page.getByTestId('a10-menu-loadout-chip')).toContainText('Custom');
});
