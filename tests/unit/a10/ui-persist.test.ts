import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The loadout screen's two choices live in the app store, which startFlight reads
 * (store.loadoutId, store.ammoLoad → SimOptions.ammoLoad). The UI restores the saved choices into
 * it when the app starts and saves every change under 'a10-ui-v1'
 * (src/a10/ui/uiStore.ts persistLoadoutChoices).
 */

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
  };
}

/** Fresh copies of the store and the UI store (module state included) over `storage`. */
async function load(storage: Storage) {
  vi.resetModules();
  vi.stubGlobal('localStorage', storage);
  const { useA10Store } = await import('../../../src/a10/state/store');
  const { LOADOUTS } = await import('../../../src/a10/core/weapons');
  const ui = await import('../../../src/a10/ui/uiStore');
  return { useA10Store, LOADOUTS, ...ui };
}

const saved = (storage: Storage) =>
  JSON.parse(storage.getItem('a10-ui-v1') ?? 'null') as Record<string, unknown> | null;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadout choices persistence', () => {
  it('restores the saved preset and gun load into the store and saves every change', async () => {
    // a preset the weapons module offers today (the stand-in has only 'gunOnly')
    const probe = await load(memoryStorage());
    const preset = Object.keys(probe.LOADOUTS)[0];
    expect(preset).toBeDefined();

    const storage = memoryStorage({
      'a10-ui-v1': JSON.stringify({ loadoutId: preset, gunLoad: 'allAPI' }),
    });
    const { useA10Store, persistLoadoutChoices } = await load(storage);
    expect(useA10Store.getState().ammoLoad).toBe('combatMix');
    persistLoadoutChoices();
    expect(useA10Store.getState().loadoutId).toBe(preset);
    expect(useA10Store.getState().ammoLoad).toBe('allAPI');

    useA10Store.getState().setAmmoLoad('targetPractice');
    expect(saved(storage)).toEqual({ loadoutId: preset, gunLoad: 'targetPractice' });
    useA10Store.getState().setLoadout('someOtherPreset');
    expect(saved(storage)).toEqual({ loadoutId: 'someOtherPreset', gunLoad: 'targetPractice' });

    // a second call neither re-reads the storage nor subscribes twice
    persistLoadoutChoices();
    expect(useA10Store.getState().ammoLoad).toBe('targetPractice');
    expect(useA10Store.getState().loadoutId).toBe('someOtherPreset');
  });

  it('ignores a preset the weapons module does not offer, and invalid data', async () => {
    const storage = memoryStorage({
      'a10-ui-v1': JSON.stringify({ loadoutId: 'retiredPreset', gunLoad: 'allHEI' }),
    });
    const { useA10Store, persistLoadoutChoices, loadLoadoutChoices } = await load(storage);
    const defaultId = useA10Store.getState().loadoutId;
    expect(loadLoadoutChoices(['gunOnly'])).toEqual({ loadoutId: null, gunLoad: 'allHEI' });
    expect(loadLoadoutChoices(['retiredPreset']).loadoutId).toBe('retiredPreset');
    persistLoadoutChoices();
    expect(useA10Store.getState().loadoutId).toBe(defaultId);
    expect(useA10Store.getState().ammoLoad).toBe('allHEI');

    for (const text of ['{"gunLoad":"silverBullets","loadoutId":7}', 'not json', '42', 'null']) {
      const fresh = await load(memoryStorage({ 'a10-ui-v1': text }));
      expect(fresh.loadLoadoutChoices(['gunOnly'])).toEqual({ loadoutId: null, gunLoad: null });
      fresh.persistLoadoutChoices();
      expect(fresh.useA10Store.getState().ammoLoad).toBe('combatMix');
    }
  });

  it('reads the gun load saved before the preset was remembered ({ gunLoad } only)', async () => {
    const { loadLoadoutChoices } = await load(
      memoryStorage({ 'a10-ui-v1': JSON.stringify({ gunLoad: 'allHEI' }) }),
    );
    expect(loadLoadoutChoices(['gunOnly'])).toEqual({ loadoutId: null, gunLoad: 'allHEI' });
  });

  it('works without storage (private mode): the choices last for the visit', async () => {
    const broken = memoryStorage();
    broken.getItem = () => {
      throw new Error('denied');
    };
    broken.setItem = () => {
      throw new Error('denied');
    };
    const { useA10Store, persistLoadoutChoices } = await load(broken);
    persistLoadoutChoices();
    useA10Store.getState().setAmmoLoad('allHEI');
    expect(useA10Store.getState().ammoLoad).toBe('allHEI');
  });

  it('the free choice: its stations under their own key, "custom" restored only with a legal load', async () => {
    const load4 = { 4: ['TER-9A', 'MK-82', 'MK-82'], 10: ['AN/AAQ-28'] };
    const storage = memoryStorage({
      'a10-ui-v1': JSON.stringify({ loadoutId: 'custom', gunLoad: 'allAPI' }),
      'a10-loadout-v1': JSON.stringify(load4),
    });
    const { useA10Store, useA10Ui, persistLoadoutChoices } = await load(storage);
    expect(useA10Ui.getState().customStations).toEqual(load4);
    persistLoadoutChoices();
    expect(useA10Store.getState().loadoutId).toBe('custom');
    // a change of the custom load is saved under its key; 'a10-ui-v1' keeps its two fields
    useA10Ui.getState().setCustomStations({ 8: ['GBU-12'] });
    expect(JSON.parse(storage.getItem('a10-loadout-v1')!)).toEqual({ 8: ['GBU-12'] });
    useA10Store.getState().setAmmoLoad('allHEI');
    expect(saved(storage)).toEqual({ loadoutId: 'custom', gunLoad: 'allHEI' });

    // no legal custom load saved: 'custom' is ignored like a retired preset
    for (const text of [null, JSON.stringify({ 5: ['AGM-65D'] }), 'not json']) {
      const init: Record<string, string> = {
        'a10-ui-v1': JSON.stringify({ loadoutId: 'custom', gunLoad: 'allAPI' }),
      };
      if (text) init['a10-loadout-v1'] = text;
      const fresh = await load(memoryStorage(init));
      const defaultId = fresh.useA10Store.getState().loadoutId;
      fresh.persistLoadoutChoices();
      expect(fresh.useA10Store.getState().loadoutId).toBe(defaultId);
      expect(fresh.useA10Store.getState().ammoLoad).toBe('allAPI');
      expect(fresh.useA10Ui.getState().customStations).toEqual({});
    }
  });

  it('offers the four gun loads the weapons module knows, the combat mix first', async () => {
    const { GUN_LOADS, isAmmoLoad } = await load(memoryStorage());
    expect(GUN_LOADS.map((g) => g.id)).toEqual(['combatMix', 'allHEI', 'allAPI', 'targetPractice']);
    for (const g of GUN_LOADS) {
      expect(isAmmoLoad(g.id)).toBe(true);
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.hint.length).toBeGreaterThan(0);
    }
    expect(isAmmoLoad('allTP')).toBe(false);
    expect(isAmmoLoad(undefined)).toBe(false);
  });
  it('hands the custom load and the range options to the app store for the next flight', async () => {
    const storage = memoryStorage({
      'a10-loadout-v1': JSON.stringify({ 4: ['MK-82'] }),
      'a10-range-v1': JSON.stringify({
        windKt: 15,
        windClock: 3,
        turbulence: 'moderate',
        columnKmh: 30,
      }),
    });
    const { useA10Store, useA10Ui, persistLoadoutChoices } = await load(storage);
    const { KT } = await import('../../../src/a10/core/units');
    expect(useA10Store.getState().customLoadout).toBeNull();
    expect(useA10Store.getState().rangeConditions).toBeNull();
    persistLoadoutChoices();
    expect(useA10Store.getState().customLoadout).toEqual({ 4: ['MK-82'] });
    const c = useA10Store.getState().rangeConditions!;
    expect(c.windSpeed).toBeCloseTo(15 * KT, 12);
    expect(c.windClock).toBe(3);
    expect(c.turbulence).toBe(0.5);
    expect(c.columnSpeed).toBeCloseTo(30 / 3.6, 12);
    // later choices follow; an illegal custom load is never handed on
    useA10Ui.getState().setRangeOptions({ windKt: 5, turbulence: 'calm' });
    expect(useA10Store.getState().rangeConditions?.windSpeed).toBeCloseTo(5 * KT, 12);
    expect(useA10Store.getState().rangeConditions?.turbulence).toBe(0);
    useA10Ui.getState().setCustomStations({ 5: ['AGM-65D'] });
    expect(useA10Store.getState().customLoadout).toBeNull();
    useA10Ui.getState().setCustomStations({ 4: ['GBU-12'] });
    expect(useA10Store.getState().customLoadout).toEqual({ 4: ['GBU-12'] });
  });
});
