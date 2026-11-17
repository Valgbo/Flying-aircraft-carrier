import { describe, expect, it } from 'vitest';
import { createSim, pushCommand, runSim } from '../../../src/a10/core/sim';
import {
  LOADOUTS,
  loadoutIssues,
  stationAccepts,
  stationIssue,
  STATION_COUNT,
} from '../../../src/a10/core/weapons';
import type { StoreType } from '../../../src/a10/core/weapons/types';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { STORES } from '../../../src/a10/data/munitions';
import {
  applyCustomLoadout,
  copyStations,
  CUSTOM_ID,
  customSummary,
  exclusiveWith,
  keyOf,
  sanitizeCustomStations,
  setStationLoad,
  stationOptions,
} from '../../../src/a10/ui/customLoadout';
import { setUpFlight } from '../../../src/a10/ui/flightSetup';
import { DEFAULT_RANGE_OPTIONS } from '../../../src/a10/ui/rangeOptions';
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

describe('presets and the free choice follow the weapons module’s loading rules', () => {
  it('every preset on offer is a legal load', () => {
    for (const p of loadoutPresets()) expect(loadoutIssues(p.stations), p.id).toEqual([]);
  });

  it('each station lists every legal load, empty first, and nothing else', () => {
    for (let s = 1; s <= STATION_COUNT; s++) {
      const options = stationOptions(s);
      expect(options[0]).toEqual({ key: '', list: [], label: 'Empty' });
      const keys = new Set<string>();
      for (const o of options.slice(1)) {
        expect(stationIssue(s, o.list), `${s}: ${o.key}`).toBeNull();
        expect(keys.has(o.key)).toBe(false);
        keys.add(o.key);
        expect(o.label.length).toBeGreaterThan(0);
      }
      // every store the station accepts is offered (a rack with each store it can carry)
      for (const type of Object.keys(STORES) as StoreType[]) {
        if (!stationAccepts(s, type)) continue;
        const offered = options.some((o) => o.list[0] === type);
        expect(offered, `${type} on station ${s}`).toBe(true);
      }
    }
    // Mavericks hang only on 3 and 9, on their launchers
    const withMaverick = (s: number) =>
      stationOptions(s).some((o) => o.list.some((t) => t.startsWith('AGM-65')));
    const mavStations = [...Array(STATION_COUNT).keys()].map((i) => i + 1).filter(withMaverick);
    expect(mavStations).toEqual([3, 9]);
    const s3 = stationOptions(3).map((o) => o.label);
    expect(s3).toContain('LAU-117 · AGM-65D');
    expect(s3).toContain('LAU-88 · 2 × AGM-65H');
  });

  it('loading the centreline empties stations 5 and 7, and the other way round', () => {
    expect(exclusiveWith(6).sort()).toEqual([5, 7]);
    expect(exclusiveWith(5)).toEqual([6]);
    let load = setStationLoad({}, 5, ['MK-82']).stations;
    load = setStationLoad(load, 7, ['GBU-12']).stations;
    const centre = setStationLoad(load, 6, ['MK-82']);
    expect(centre.cleared.sort()).toEqual([5, 7]);
    expect(centre.stations).toEqual({ 6: ['MK-82'] });
    expect(loadoutIssues(centre.stations)).toEqual([]);
    const back = setStationLoad(centre.stations, 5, ['MK-82AIR']);
    expect(back.cleared).toEqual([6]);
    expect(back.stations).toEqual({ 5: ['MK-82AIR'] });
    // emptying a station removes it; the input map is not changed
    const empty = setStationLoad(back.stations, 5, []);
    expect(empty.stations).toEqual({});
    expect(back.stations).toEqual({ 5: ['MK-82AIR'] });
    expect(keyOf(['LAU-88', 'AGM-65D', 'AGM-65D'])).toBe('LAU-88+AGM-65D+AGM-65D');
  });

  it('a saved custom load is kept only when the aircraft can carry it', () => {
    const legal = copyStations(LOADOUTS.tankHunter.stations);
    expect(sanitizeCustomStations(JSON.parse(JSON.stringify(legal)))).toEqual(legal);
    expect(sanitizeCustomStations({ 5: ['AGM-65D'] })).toBeNull();
    expect(
      sanitizeCustomStations({ 3: ['LAU-88', 'AGM-65D', 'AGM-65D', 'AGM-65D', 'AGM-65D'] }),
    ).toBeNull();
    expect(sanitizeCustomStations({ 12: ['MK-82'] })).toBeNull();
    expect(sanitizeCustomStations({ 4: ['MK-99'] })).toBeNull();
    expect(sanitizeCustomStations({ 5: ['MK-82'], 6: ['MK-82'] })).toBeNull();
    expect(sanitizeCustomStations([['MK-82']])).toBeNull();
    expect(sanitizeCustomStations('x')).toBeNull();
    expect(sanitizeCustomStations({ 4: [] })).toEqual({});
    expect(customSummary({})).toMatch(/^Gun only/);
    expect(customSummary({ 3: ['LAU-88', 'AGM-65D', 'AGM-65H'], 4: ['MK-82'] })).toBe(
      '2 × AGM-65 · Mk-82',
    );
  });

  it('a custom load flies from the first step, and a rearm restores it', () => {
    const custom = {
      3: ['LAU-117', 'AGM-65D'],
      4: ['TER-9A', 'MK-82', 'MK-82', 'MK-82'],
      8: ['GBU-12'],
      10: ['AN/AAQ-28'],
    } as Record<number, StoreType[]>;
    const s = createSim({
      terrain: createFlatTerrain(0),
      scenario: 'empty',
      loadoutId: CUSTOM_ID,
      seed: 2,
    });
    // the flow creates a custom flight with nothing on the stations; the set-up loads it
    expect(s.stores.mass).toBe(0);
    const empty = s.aircraft.mass;
    expect(setUpFlight(s, CUSTOM_ID, custom, DEFAULT_RANGE_OPTIONS)).toEqual({
      custom: true,
      range: false,
    });
    expect(s.options.customLoadout).toEqual(custom);
    const on = (n: number) => s.stores.stations.find((x) => x.station === n)!;
    expect(on(3).rack).toBe('LAU-117');
    expect(on(3).stores).toEqual(['AGM-65D']);
    expect(on(4).stores).toEqual(['MK-82', 'MK-82', 'MK-82']);
    expect(on(8).stores).toEqual(['GBU-12']);
    expect(s.stores.mass).toBeGreaterThan(1000);
    expect(s.aircraft.mass).toBeCloseTo(empty + s.stores.mass, 3);
    // the fire-control computer has a profile for each weapon type now on board
    const stores = s.avionics.profiles.map((p) => p.store);
    for (const t of ['AGM-65D', 'MK-82', 'GBU-12']) expect(stores).toContain(t);
    // a pause-menu rearm after a jettison puts the same custom load back
    pushCommand(s, { type: 'jettison', stations: 'all' });
    runSim(s, 0.05);
    expect(on(4).stores).toEqual([]);
    pushCommand(s, { type: 'rearm' });
    runSim(s, 0.05);
    expect(on(4).stores).toEqual(['MK-82', 'MK-82', 'MK-82']);
    expect(on(3).stores).toEqual(['AGM-65D']);
  });

  it('an illegal or empty choice is refused: the flight keeps the gun only', () => {
    const s = createSim({
      terrain: createFlatTerrain(0),
      scenario: 'empty',
      loadoutId: CUSTOM_ID,
      seed: 2,
    });
    expect(applyCustomLoadout(s, { 5: ['AGM-65D'] })).toBe(false);
    expect(s.stores.mass).toBe(0);
    // a preset flight is not touched, nor one created with its custom load already
    const preset = createSim({
      terrain: createFlatTerrain(0),
      scenario: 'empty',
      loadoutId: 'gunOnly',
      seed: 2,
    });
    expect(setUpFlight(preset, 'gunOnly', { 4: ['MK-82'] }, DEFAULT_RANGE_OPTIONS).custom).toBe(
      false,
    );
    expect(preset.stores.mass).toBe(0);
    const given = createSim({
      terrain: createFlatTerrain(0),
      scenario: 'empty',
      loadoutId: CUSTOM_ID,
      customLoadout: { 4: ['GBU-12'] },
      seed: 2,
    });
    expect(setUpFlight(given, CUSTOM_ID, { 4: ['MK-82'] }, DEFAULT_RANGE_OPTIONS).custom).toBe(
      false,
    );
    expect(given.stores.stations[3].stores).toEqual(['GBU-12']);
  });
});
