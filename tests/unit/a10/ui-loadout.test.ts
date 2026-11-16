import { describe, expect, it } from 'vitest';
import { LOADOUTS } from '../../../src/a10/core/weapons';
import type { StoreType } from '../../../src/a10/core/weapons/types';
import {
  humanizeId,
  loadoutPresets,
  loadoutSummary,
  loadoutTotals,
  stationLabel,
  stationViews,
  storeLabel,
  type LoadoutPreset,
} from '../../../src/a10/ui/loadout';

const hunter: LoadoutPreset = {
  id: 'test',
  name: 'Test',
  stations: {
    1: ['AN/ALQ-184'],
    3: ['LAU-88', 'AGM-65D', 'AGM-65D'],
    5: ['TER-9A', 'MK-82', 'MK-82'],
    6: [],
    9: ['GBU-12'],
    10: ['LAU-131-M156'],
    11: ['AN/AAQ-28'],
  },
};

describe('loadout screen data', () => {
  it('lists every preset the weapons module offers, the planned ones first', () => {
    const presets = loadoutPresets({
      zulu: { name: 'Zulu', stations: {} },
      gunOnly: { name: 'Gun only', stations: {} },
      alpha: { stations: {} },
      tankHunter: { name: 'Tank hunter', stations: { 3: ['AGM-65D'] } },
    });
    expect(presets.map((p) => p.id)).toEqual(['tankHunter', 'gunOnly', 'alpha', 'zulu']);
    expect(presets[2].name).toBe('Alpha');
    // the live module: at least one preset, each with a name
    const live = loadoutPresets();
    expect(live.length).toBe(Object.keys(LOADOUTS).length);
    for (const p of live) expect(p.name.length).toBeGreaterThan(0);
  });

  it('eleven stations, racks split from what they carry', () => {
    const views = stationViews(hunter);
    expect(views.map((v) => v.station)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const s3 = views[2];
    expect(s3.rack).toBe('LAU-88');
    expect(s3.stores).toEqual(['AGM-65D', 'AGM-65D']);
    expect(s3.label).toBe('LAU-88 · 2 × AGM-65D');
    expect(views[4].label).toBe('TER · 2 × Mk-82');
    expect(views[1].label).toBe('');
    expect(views[1].mass).toBe(0);
    // mass is the weapons module's figure, or unknown while it has none
    const m = views[8].mass;
    expect(Number.isNaN(m) || m > 0).toBe(true);
  });

  it('labels, summaries and totals', () => {
    expect(stationLabel(null, [])).toBe('');
    expect(stationLabel('TER-9A', [])).toBe('TER (empty)');
    expect(stationLabel(null, ['AGM-65D', 'AGM-65H'])).toBe('AGM-65D, AGM-65H');
    expect(loadoutSummary(hunter)).toBe(
      'ECM pod · 2 × AGM-65 · 2 × Mk-82 · GBU-12 · Rocket pod · Targeting pod',
    );
    expect(loadoutSummary({ id: 'g', name: 'G', stations: {} })).toBe('No stores');
    const t = loadoutTotals(hunter);
    expect(t.weapons).toBe(6);
    expect(t.stations).toBe(6);
    expect(Number.isNaN(t.mass) || t.mass > 0).toBe(true);
    const clean = loadoutTotals({ id: 'g', name: 'G', stations: {} });
    expect(clean.weapons).toBe(0);
    expect(clean.mass === 0 || Number.isNaN(clean.mass)).toBe(true);
  });

  it('copes with store types it does not know', () => {
    const odd = storeLabel('XYZ-1' as StoreType);
    expect(odd.short).toBe('XYZ-1');
    expect(storeLabel('LAU-117').category).toBe('rack');
    expect(humanizeId('rangeTraining')).toBe('Range training');
  });
});
