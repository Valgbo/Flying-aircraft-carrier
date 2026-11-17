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
});
