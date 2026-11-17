/**
 * Loadout screen (PLAN_A10.md §6.8, §11.3): the presets the weapons module offers and the free
 * choice ('Custom': a load per station, from what the weapons module allows there), a top-down
 * schematic of the eleven stations, what hangs on each, the total stores weight and drag, and
 * the gun load for the next flight. store.setLoadout(id) picks the load every flight uses; the
 * custom load itself lives in the UI store (customLoadout.ts) and reaches the flight through
 * flightSetup.ts.
 */
import { useMemo, useState } from 'react';
import { loadoutIssues } from '../core/weapons';
import { COMPACT_QUERY, IconArrowLeft, useMediaQuery } from '../../engine';
import { A10 } from '../data/aircraft';
import { GAU8 } from '../data/gun';
import { beginFlight } from '../state/flow';
import { useA10Store } from '../state/store';
import AircraftSchematic from './AircraftSchematic';
import {
  copyStations,
  CUSTOM_ID,
  CUSTOM_NAME,
  customSummary,
  keyOf,
  setStationLoad,
  stationOptions,
  type CustomStations,
} from './customLoadout';
import { formatDragArea, formatInt, formatKg, formatLbFromKg, DASH } from './format';
import { IconJet } from './icons';
import {
  humanizeId,
  loadoutPresets,
  loadoutSummary,
  loadoutTotals,
  stationViews,
  storeLabel,
  type StoreCategory,
} from './loadout';
import { GUN_LOADS, useA10Ui } from './uiStore';

/** The loads each station can take (the weapons module's rules do not change in a visit). */
const OPTIONS = Array.from({ length: 11 }, (_, i) => stationOptions(i + 1));

const LEGEND: readonly { category: StoreCategory; label: string }[] = [
  { category: 'missile', label: 'Missiles' },
  { category: 'guided', label: 'Guided bombs' },
  { category: 'bomb', label: 'Bombs' },
  { category: 'rocket', label: 'Rockets' },
  { category: 'airToAir', label: 'Air-to-air' },
  { category: 'pod', label: 'Pods' },
];

export default function LoadoutScreen() {
  const loadoutId = useA10Store((s) => s.loadoutId);
  const setLoadout = useA10Store((s) => s.setLoadout);
  const setScreen = useA10Store((s) => s.setScreen);
  const gunLoad = useA10Store((s) => s.ammoLoad);
  const setGunLoad = useA10Store((s) => s.setAmmoLoad);
  const custom = useA10Ui((s) => s.customStations);
  const setCustom = useA10Ui((s) => s.setCustomStations);
  const compact = useMediaQuery(COMPACT_QUERY);
  const [active, setActive] = useState<number | null>(null);
  const [cleared, setCleared] = useState<string | null>(null);

  const presets = useMemo(() => loadoutPresets(), []);
  const isCustom = loadoutId === CUSTOM_ID;
  const preset = presets.find((p) => p.id === loadoutId);
  const shown = useMemo(
    () =>
      isCustom
        ? { id: CUSTOM_ID, name: CUSTOM_NAME, stations: custom }
        : (preset ?? { id: loadoutId, name: humanizeId(loadoutId), stations: {} }),
    [isCustom, custom, preset, loadoutId],
  );
  const customTotals = useMemo(
    () => loadoutTotals({ id: CUSTOM_ID, name: CUSTOM_NAME, stations: custom }),
    [custom],
  );
  const issues = useMemo(() => (isCustom ? loadoutIssues(custom) : []), [isCustom, custom]);

  /** Choose the free choice; the first time, start it from the preset on screen. */
  const chooseCustom = () => {
    if (Object.keys(custom).length === 0 && preset) setCustom(copyStations(preset.stations));
    setCleared(null);
    setLoadout(CUSTOM_ID);
  };

  const setStation = (station: number, key: string) => {
    const option = OPTIONS[station - 1].find((o) => o.key === key);
    if (!option) return;
    const next = setStationLoad(custom, station, option.list);
    setCustom(next.stations);
    setCleared(
      next.cleared.length > 0
        ? `${next.cleared.length > 1 ? 'Stations' : 'Station'} ${next.cleared.join(' and ')} emptied: the centreline station 6 cannot be loaded together with stations 5 and 7.`
        : null,
    );
  };

  const copyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setCustom(copyStations(p.stations));
    setCleared(null);
  };
  const stations = useMemo(() => stationViews(shown), [shown]);
  const totals = useMemo(() => loadoutTotals(shown), [shown]);
  const categories = new Set(stations.flatMap((s) => s.stores.map((t) => storeLabel(t).category)));
  const capacityShare = Number.isFinite(totals.mass) ? totals.mass / A10.storesCapacity : 0;

  return (
    <div className="a10-page a10-loadout" data-testid="a10-loadout-screen">
      <header className="a10-page__head">
        <button
          type="button"
          className="fac-btn fac-btn--ghost a10-page__back"
          data-testid="a10-loadout-back"
          onClick={() => setScreen('menu')}
        >
          <IconArrowLeft size={18} />
          <span>Menu</span>
        </button>
        <div className="a10-page__title">
          <p className="fac-label">Before you fly</p>
          <h1>Loadout</h1>
        </div>
        <button
          type="button"
          className="fac-btn fac-btn--primary a10-page__action"
          data-testid="a10-loadout-fly"
          onClick={() => {
            // as on the menu: Fly now is the free hunt
            useA10Store.getState().setScenario('freeHunt');
            void beginFlight();
          }}
        >
          <IconJet size={18} />
          <span>Fly now</span>
        </button>
      </header>

      <div className="a10-page__body">
        <div className="a10-loadout__grid">
          <section className="a10-loadout__presets" aria-labelledby="a10-presets-title">
            <h2 className="a10-section-title" id="a10-presets-title">
              Presets
            </h2>
            {!preset && !isCustom && (
              <p className="a10-note a10-note--warn" role="note">
                “{humanizeId(loadoutId)}” is not available in this build, so the aircraft carries
                the gun only. Pick a preset below.
              </p>
            )}
            <div className="a10-choices" role="radiogroup" aria-labelledby="a10-presets-title">
              {presets.map((p) => {
                const t = loadoutTotals(p);
                return (
                  <label
                    key={p.id}
                    className="a10-choice"
                    data-testid={`a10-loadout-preset-${p.id}`}
                  >
                    <input
                      type="radio"
                      name="a10-loadout"
                      value={p.id}
                      checked={p.id === loadoutId}
                      onChange={() => setLoadout(p.id)}
                    />
                    <span className="a10-choice__name">{p.name}</span>
                    <span className="a10-choice__desc">{loadoutSummary(p)}</span>
                    <span className="a10-choice__meta fac-readout">
                      {Number.isFinite(t.mass) ? formatKg(t.mass) : `${t.weapons} weapons`}
                    </span>
                  </label>
                );
              })}
              <label className="a10-choice a10-choice--custom" data-testid="a10-loadout-custom">
                <input
                  type="radio"
                  name="a10-loadout"
                  value={CUSTOM_ID}
                  checked={isCustom}
                  onChange={chooseCustom}
                />
                <span className="a10-choice__name">{CUSTOM_NAME}</span>
                <span className="a10-choice__desc">
                  {Object.keys(custom).length > 0
                    ? customSummary(custom)
                    : 'Your own load, station by station'}
                </span>
                <span className="a10-choice__meta fac-readout">
                  {Object.keys(custom).length > 0 && Number.isFinite(customTotals.mass)
                    ? formatKg(customTotals.mass)
                    : 'Free choice'}
                </span>
              </label>
            </div>
          </section>

          <section className="a10-loadout__view" aria-label={`${shown.name} on the aircraft`}>
            <AircraftSchematic
              stations={stations}
              active={active}
              onActive={setActive}
              compact={compact}
            />
            <ul className="a10-legend" aria-label="Legend">
              {LEGEND.filter((l) => categories.has(l.category)).map((l) => (
                <li key={l.category}>
                  <span
                    className={`a10-legend__swatch a10-store--${l.category}`}
                    aria-hidden="true"
                  />
                  {l.label}
                </li>
              ))}
              {categories.size === 0 && <li className="a10-legend__none">No stores: gun only</li>}
            </ul>
          </section>

          <div className="a10-loadout__details">
            <section aria-labelledby="a10-stations-title">
              <h2 className="a10-section-title" id="a10-stations-title">
                Stations
              </h2>
              {isCustom && (
                <div className="a10-custom__tools">
                  <label className="a10-custom__copy">
                    <span>Start from</span>
                    <select
                      className="settings-select fac-focusable"
                      data-testid="a10-custom-copy"
                      value=""
                      onChange={(e) => copyPreset(e.target.value)}
                    >
                      <option value="" disabled>
                        a preset…
                      </option>
                      {presets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="fac-btn fac-btn--ghost a10-custom__clear"
                    data-testid="a10-custom-clear"
                    onClick={() => {
                      setCustom({} as CustomStations);
                      setCleared(null);
                    }}
                  >
                    Clear all
                  </button>
                </div>
              )}
              <ol className="a10-stations" data-testid="a10-loadout-stations">
                {stations.map((st) => (
                  <li
                    key={st.station}
                    className={`a10-stations__row${active === st.station ? ' a10-stations__row--active' : ''}${isCustom ? ' a10-stations__row--edit' : ''}`}
                    onPointerEnter={() => setActive(st.station)}
                    onPointerLeave={() => setActive(null)}
                  >
                    <span
                      className="a10-stations__num fac-readout"
                      aria-label={`Station ${st.station}`}
                    >
                      {st.station}
                    </span>
                    {isCustom ? (
                      <select
                        className="settings-select fac-focusable a10-stations__select"
                        data-testid={`a10-station-select-${st.station}`}
                        aria-label={`Station ${st.station}`}
                        value={keyOf(custom[st.station] ?? [])}
                        onChange={(e) => setStation(st.station, e.target.value)}
                        onFocus={() => setActive(st.station)}
                        onBlur={() => setActive(null)}
                      >
                        {OPTIONS[st.station - 1].map((o) => (
                          <option key={o.key} value={o.key}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span
                        className={`a10-stations__what${st.label ? '' : ' a10-stations__what--empty'}`}
                      >
                        {st.label || 'Empty'}
                      </span>
                    )}
                    <span className="a10-stations__mass fac-readout">
                      {st.label ? (Number.isFinite(st.mass) ? formatKg(st.mass) : DASH) : ''}
                    </span>
                  </li>
                ))}
              </ol>
              {isCustom && cleared && (
                <p className="a10-note" role="status">
                  {cleared}
                </p>
              )}
              {issues.length > 0 && (
                <p className="a10-note a10-note--warn" role="note" data-testid="a10-custom-issues">
                  This load is not legal: {issues.join('; ')}.
                </p>
              )}
              {isCustom && (
                <p className="a10-note">
                  Each station lists only what the weapons rules let it carry: Mavericks on 3 and 9,
                  the targeting pod on 2, 3, 9 or 10, the AIM-9 pair and the jamming pod on the wing
                  tips.
                </p>
              )}
            </section>

            <section aria-labelledby="a10-totals-title">
              <h2 className="a10-section-title" id="a10-totals-title">
                Totals
              </h2>
              <dl className="a10-facts" data-testid="a10-loadout-totals">
                <div>
                  <dt>Stores weight</dt>
                  <dd className="fac-readout">
                    {formatKg(totals.mass)}
                    <span className="a10-facts__sub">{formatLbFromKg(totals.mass)}</span>
                  </dd>
                </div>
                <div className="a10-facts__wide">
                  <div
                    className="a10-meter"
                    role="meter"
                    aria-label="Share of the 7,260 kg stores limit"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(capacityShare * 100)}
                  >
                    <span style={{ width: `${Math.min(100, capacityShare * 100)}%` }} />
                  </div>
                  <span className="a10-facts__hint">
                    of the {formatKg(A10.storesCapacity)} the eleven stations can carry
                  </span>
                </div>
                <div>
                  <dt>Stores drag area</dt>
                  <dd className="fac-readout">{formatDragArea(totals.dragArea)}</dd>
                </div>
                <div>
                  <dt>Weapons</dt>
                  <dd className="fac-readout">
                    {totals.weapons} on {totals.stations} stations
                  </dd>
                </div>
                <div>
                  <dt>Gun</dt>
                  <dd className="fac-readout">{formatInt(GAU8.typicalLoad)} rounds</dd>
                </div>
              </dl>
              {!Number.isFinite(totals.mass) && totals.weapons > 0 && (
                <p className="a10-note">Weights and drag appear once the stores data is in.</p>
              )}
            </section>

            <section aria-labelledby="a10-gunload-title">
              <h2 className="a10-section-title" id="a10-gunload-title">
                Gun load
              </h2>
              <div
                className="a10-choices a10-choices--compact"
                role="radiogroup"
                aria-labelledby="a10-gunload-title"
              >
                {GUN_LOADS.map((g) => (
                  <label key={g.id} className="a10-choice" data-testid={`a10-gunload-${g.id}`}>
                    <input
                      type="radio"
                      name="a10-gunload"
                      value={g.id}
                      checked={g.id === gunLoad}
                      onChange={() => setGunLoad(g.id)}
                    />
                    <span className="a10-choice__name">{g.label}</span>
                    <span className="a10-choice__desc">{g.hint}</span>
                  </label>
                ))}
              </div>
              <p className="a10-note">The gun is loaded for the next flight you start.</p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
