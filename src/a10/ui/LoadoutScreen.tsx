/**
 * Loadout screen (PLAN_A10.md §6.8, §11.3): the presets the weapons module offers, a top-down
 * schematic of the eleven stations, what hangs on each, the total stores weight and drag, and
 * the gun load for the next flight. store.setLoadout(id) picks the preset every flight uses.
 */
import { useMemo, useState } from 'react';
import { COMPACT_QUERY, IconArrowLeft, useMediaQuery } from '../../engine';
import { A10 } from '../data/aircraft';
import { GAU8 } from '../data/gun';
import { beginFlight } from '../state/flow';
import { useA10Store } from '../state/store';
import AircraftSchematic from './AircraftSchematic';
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
  const gunLoad = useA10Ui((s) => s.gunLoad);
  const setGunLoad = useA10Ui((s) => s.setGunLoad);
  const compact = useMediaQuery(COMPACT_QUERY);
  const [active, setActive] = useState<number | null>(null);

  const presets = useMemo(() => loadoutPresets(), []);
  const preset = presets.find((p) => p.id === loadoutId);
  const shown = useMemo(
    () => preset ?? { id: loadoutId, name: humanizeId(loadoutId), stations: {} },
    [preset, loadoutId],
  );
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
            {!preset && (
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
              <ol className="a10-stations" data-testid="a10-loadout-stations">
                {stations.map((st) => (
                  <li
                    key={st.station}
                    className={`a10-stations__row${active === st.station ? ' a10-stations__row--active' : ''}`}
                    onPointerEnter={() => setActive(st.station)}
                    onPointerLeave={() => setActive(null)}
                  >
                    <span
                      className="a10-stations__num fac-readout"
                      aria-label={`Station ${st.station}`}
                    >
                      {st.station}
                    </span>
                    <span
                      className={`a10-stations__what${st.label ? '' : ' a10-stations__what--empty'}`}
                    >
                      {st.label || 'Empty'}
                    </span>
                    <span className="a10-stations__mass fac-readout">
                      {st.label ? (Number.isFinite(st.mass) ? formatKg(st.mass) : DASH) : ''}
                    </span>
                  </li>
                ))}
              </ol>
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
