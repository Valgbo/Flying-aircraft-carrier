/**
 * Debrief (store screen 'debrief', reached through flow.finishFlight()): a first version of
 * PLAN_A10.md §11.4 built from sim.debrief and sim.targets — the gun bursts with their open-
 * and cease-fire ranges, every hit on a vehicle with plate, angle, speed, penetration and
 * outcome, an overhead plot of the impacts around each vehicle hit, the kills and the weapons
 * released. The flight stays readable (getSim()) until the next one starts.
 */
import { IconArrowLeft } from '../../engine';
import type { HitRecord } from '../core/debrief/types';
import { exitToMenu, restartFlight } from '../state/flow';
import { getSim } from '../state/runtime';
import { useA10Store } from '../state/store';
import { getCrashInfo, impactRecorder } from './bridge';
import { burstHitRate, hitsByVehicle, summarize, vehicleName } from './debriefData';
import {
  capitalize,
  DASH,
  formatClock,
  formatClockDirection,
  formatDegFromRad,
  formatFeetFromM,
  formatG,
  formatHitRate,
  formatInt,
  formatKnots,
  formatMiss,
  formatMm,
  formatPct,
  formatRangeM,
  formatSeconds,
  humanize,
} from './format';
import { IconRestart } from './icons';
import ImpactPlot from './ImpactPlot';
import { scenarioName } from './names';
import TableWrap from './TableWrap';

const CRASH_WHERE = {
  terrain: 'in a crash into the ground',
  water: 'in a crash into the water',
  overstress: 'when the airframe broke up',
} as const;

/** Rows shown per table before "… and N more". */
const ROW_LIMIT = 40;

function More({ total, cols }: { total: number; cols: number }) {
  if (total <= ROW_LIMIT) return null;
  return (
    <tr className="a10-table__more">
      <td colSpan={cols}>… and {formatInt(total - ROW_LIMIT)} more</td>
    </tr>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="a10-stat">
      <span className="a10-stat__label">{label}</span>
      <span className="a10-stat__value">{value}</span>
      {sub && <span className="a10-stat__sub">{sub}</span>}
    </div>
  );
}

function outcomeClass(outcome: string): string {
  if (outcome === 'penetrated' || outcome === 'passedThrough') return 'a10-outcome--pen';
  if (outcome === 'burst' || outcome === 'blast' || outcome === 'fragment')
    return 'a10-outcome--burst';
  return 'a10-outcome--def';
}

function HitRows({ hits }: { hits: readonly HitRecord[] }) {
  return (
    <TableWrap>
      <table className="a10-table a10-table--dense">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Weapon</th>
            <th scope="col">Plate</th>
            <th scope="col" className="a10-num">
              Angle
            </th>
            <th scope="col" className="a10-num">
              Speed
            </th>
            <th scope="col" className="a10-num">
              Armour
            </th>
            <th scope="col" className="a10-num">
              Penetration
            </th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {hits.slice(0, ROW_LIMIT).map((h, i) => (
            <tr key={i}>
              <td className="fac-readout">{formatClock(h.time)}</td>
              <td>{h.weapon}</td>
              <td>
                {capitalize(humanize(h.face))} {humanize(h.part)}
              </td>
              <td className="a10-num fac-readout">{formatDegFromRad(h.obliquity)}</td>
              <td className="a10-num fac-readout">{formatInt(h.speed)} m/s</td>
              <td className="a10-num fac-readout">{formatMm(h.effectiveThicknessMm)}</td>
              <td className="a10-num fac-readout">{formatMm(h.penetrationMm)}</td>
              <td>
                <span className={`a10-outcome ${outcomeClass(h.outcome)}`}>
                  {capitalize(humanize(h.outcome))}
                </span>
                {h.damaged.length > 0 && (
                  <span className="a10-table__aside"> · {h.damaged.map(humanize).join(', ')}</span>
                )}
              </td>
            </tr>
          ))}
          <More total={hits.length} cols={8} />
        </tbody>
      </table>
    </TableWrap>
  );
}

export default function DebriefScreen() {
  const scenario = useA10Store((s) => s.scenario);
  const sim = getSim();

  if (!sim) {
    return (
      <div className="a10-page a10-debrief" data-testid="a10-debrief">
        <header className="a10-page__head">
          <div className="a10-page__title">
            <h1>Debrief</h1>
          </div>
        </header>
        <div className="a10-page__body">
          <p className="a10-note">There is no flight to debrief.</p>
          <button type="button" className="fac-btn" onClick={exitToMenu}>
            Menu
          </button>
        </div>
      </div>
    );
  }

  const d = sim.debrief;
  const vehicles = sim.targets.vehicles;
  const summary = summarize(d, sim.gun, vehicles.length);
  const crash = sim.aircraft.crashed ? getCrashInfo(sim) : null;
  const groups = hitsByVehicle(d.hits);
  // vehicles with plotted impacts but no logged hit (near misses only) come after
  const plotted = impactRecorder
    .vehicleIds(sim)
    .filter((id) => !groups.some((g) => g.vehicleId === id));
  const byKind = new Map<string, { total: number; damaged: number; destroyed: number }>();
  for (const v of vehicles) {
    const k = byKind.get(v.kind) ?? { total: 0, damaged: 0, destroyed: 0 };
    k.total++;
    if (v.condition === 'damaged') k.damaged++;
    if (v.condition === 'destroyed' || v.condition === 'catastrophic') k.destroyed++;
    byKind.set(v.kind, k);
  }
  const rangeEntries = Object.entries(d.range);

  return (
    <div className="a10-page a10-debrief" data-testid="a10-debrief">
      <header className="a10-page__head">
        <button
          type="button"
          className="fac-btn fac-btn--ghost a10-page__back"
          data-testid="a10-debrief-menu"
          onClick={exitToMenu}
        >
          <IconArrowLeft size={18} />
          <span>Menu</span>
        </button>
        <div className="a10-page__title">
          <p className="fac-label">
            {scenarioName(scenario)} · {formatClock(sim.time)}
          </p>
          <h1>Debrief</h1>
        </div>
        <button
          type="button"
          className="fac-btn fac-btn--primary a10-page__action"
          data-testid="a10-debrief-again"
          onClick={() => void restartFlight()}
        >
          <IconRestart size={18} />
          <span>Fly again</span>
        </button>
      </header>

      <div className="a10-page__body a10-debrief__body">
        {sim.aircraft.crashed && (
          <p className="a10-note a10-note--alert" role="note">
            The flight ended {CRASH_WHERE[crash?.reason ?? 'terrain']} at{' '}
            {formatKnots(crash?.ias ?? sim.aircraft.ias)}.
          </p>
        )}

        <div className="a10-stats" data-testid="a10-debrief-summary">
          <Stat label="Flight time" value={formatClock(sim.time)} />
          <Stat
            label="Rounds fired"
            value={formatInt(summary.roundsFired)}
            sub={`of ${formatInt(summary.roundsLoaded)} loaded`}
          />
          <Stat
            label="Gun hits"
            value={formatInt(summary.gunHits)}
            sub={
              summary.roundsFired > 0
                ? `${formatPct(summary.gunHits / summary.roundsFired)} of rounds`
                : 'no rounds fired'
            }
          />
          <Stat
            label="Destroyed"
            value={formatInt(summary.kills)}
            sub={`of ${formatInt(summary.vehiclesTotal)} vehicles`}
          />
          <Stat label="Highest load" value={formatG(sim.aircraft.maxG)} />
        </div>

        <section className="a10-card" aria-labelledby="a10-bursts-title">
          <h2 className="a10-section-title" id="a10-bursts-title">
            Gun bursts
          </h2>
          {d.bursts.length === 0 ? (
            <p className="a10-note">No bursts recorded.</p>
          ) : (
            <TableWrap>
              <table className="a10-table" data-testid="a10-debrief-bursts">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Time</th>
                    <th scope="col" className="a10-num">
                      Length
                    </th>
                    <th scope="col" className="a10-num">
                      Rounds
                    </th>
                    <th scope="col" className="a10-num">
                      Hits
                    </th>
                    <th scope="col" className="a10-num">
                      Open fire
                    </th>
                    <th scope="col" className="a10-num">
                      Cease fire
                    </th>
                    <th scope="col" className="a10-num">
                      Dive
                    </th>
                    <th scope="col" className="a10-num">
                      Speed
                    </th>
                    <th scope="col" className="a10-num">
                      Height
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.bursts.slice(0, ROW_LIMIT).map((b, i) => (
                    <tr key={i}>
                      <td className="fac-readout">{b.burst || i + 1}</td>
                      <td className="fac-readout">{formatClock(b.start.time)}</td>
                      <td className="a10-num fac-readout">{formatSeconds(b.duration)}</td>
                      <td className="a10-num fac-readout">{formatInt(b.rounds)}</td>
                      <td className="a10-num fac-readout">
                        {formatInt(b.hits)}
                        <span className="a10-table__aside">
                          {' '}
                          {Number.isFinite(burstHitRate(b)) ? formatPct(burstHitRate(b)) : ''}
                        </span>
                      </td>
                      <td className="a10-num fac-readout">{formatRangeM(b.openFireRange, 10)}</td>
                      <td className="a10-num fac-readout">{formatRangeM(b.ceaseFireRange, 10)}</td>
                      <td className="a10-num fac-readout">{formatDegFromRad(b.start.dive)}</td>
                      <td className="a10-num fac-readout">{formatKnots(b.start.speed)}</td>
                      <td className="a10-num fac-readout">{formatFeetFromM(b.start.agl)}</td>
                    </tr>
                  ))}
                  <More total={d.bursts.length} cols={10} />
                </tbody>
              </table>
            </TableWrap>
          )}
          <p className="a10-note">
            Rounds on target: {formatHitRate(summary.gunHits, summary.roundsFired)}. Open- and
            cease-fire ranges are slant ranges to the pipper.
          </p>
        </section>

        <section className="a10-card" aria-labelledby="a10-hits-title">
          <h2 className="a10-section-title" id="a10-hits-title">
            Hits by vehicle
          </h2>
          {groups.length === 0 && plotted.length === 0 ? (
            <p className="a10-note">No vehicle was hit.</p>
          ) : (
            <div className="a10-vehicles" data-testid="a10-debrief-vehicles">
              {groups.map((g) => {
                const name = `${vehicleName(g.kind)} #${g.vehicleId}`;
                return (
                  <article key={g.vehicleId} className="a10-vehicle">
                    <header className="a10-vehicle__head">
                      <h3>{name}</h3>
                      <span className={`a10-condition a10-condition--${g.condition}`}>
                        {capitalize(humanize(g.condition))}
                      </span>
                      <span className="a10-vehicle__count fac-readout">
                        {formatInt(g.hits.length)} {g.hits.length === 1 ? 'hit' : 'hits'}
                      </span>
                    </header>
                    <div className="a10-vehicle__body">
                      <ImpactPlot
                        kind={g.kind}
                        marks={impactRecorder.marksFor(sim, g.vehicleId)}
                        label={name}
                      />
                      <HitRows hits={g.hits} />
                    </div>
                  </article>
                );
              })}
              {plotted.map((id) => {
                const v = vehicles.find((x) => x.id === id);
                if (!v) return null;
                const name = `${vehicleName(v.kind)} #${id}`;
                return (
                  <article key={id} className="a10-vehicle">
                    <header className="a10-vehicle__head">
                      <h3>{name}</h3>
                      <span className="a10-vehicle__count">Near misses only</span>
                    </header>
                    <div className="a10-vehicle__body">
                      <ImpactPlot
                        kind={v.kind}
                        marks={impactRecorder.marksFor(sim, id)}
                        label={name}
                      />
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <div className="a10-debrief__pair">
          <section className="a10-card" aria-labelledby="a10-kills-title">
            <h2 className="a10-section-title" id="a10-kills-title">
              Kills
            </h2>
            {d.kills.length === 0 ? (
              <p className="a10-note">No vehicle destroyed.</p>
            ) : (
              <TableWrap>
                <table className="a10-table" data-testid="a10-debrief-kills">
                  <thead>
                    <tr>
                      <th scope="col">Time</th>
                      <th scope="col">Vehicle</th>
                      <th scope="col">Weapon</th>
                      <th scope="col">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.kills.slice(0, ROW_LIMIT).map((k, i) => (
                      <tr key={i}>
                        <td className="fac-readout">{formatClock(k.time)}</td>
                        <td>
                          {vehicleName(k.kind)} #{k.vehicleId}
                        </td>
                        <td>{k.weapon}</td>
                        <td>{k.catastrophic ? 'Catastrophic' : 'Destroyed'}</td>
                      </tr>
                    ))}
                    <More total={d.kills.length} cols={4} />
                  </tbody>
                </table>
              </TableWrap>
            )}
          </section>

          <section className="a10-card" aria-labelledby="a10-targets-title">
            <h2 className="a10-section-title" id="a10-targets-title">
              Targets on the range
            </h2>
            {byKind.size === 0 ? (
              <p className="a10-note">No vehicles on this range.</p>
            ) : (
              <TableWrap>
                <table className="a10-table" data-testid="a10-debrief-targets">
                  <thead>
                    <tr>
                      <th scope="col">Vehicle</th>
                      <th scope="col" className="a10-num">
                        On the range
                      </th>
                      <th scope="col" className="a10-num">
                        Damaged
                      </th>
                      <th scope="col" className="a10-num">
                        Destroyed
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...byKind.entries()].map(([kind, k]) => (
                      <tr key={kind}>
                        <td>{vehicleName(kind)}</td>
                        <td className="a10-num fac-readout">{k.total}</td>
                        <td className="a10-num fac-readout">{k.damaged}</td>
                        <td className="a10-num fac-readout">{k.destroyed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </section>
        </div>

        {d.weapons.length > 0 && (
          <section className="a10-card" aria-labelledby="a10-weapons-title">
            <h2 className="a10-section-title" id="a10-weapons-title">
              Weapons released
            </h2>
            <TableWrap>
              <table className="a10-table" data-testid="a10-debrief-weapons">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Weapon</th>
                    <th scope="col" className="a10-num">
                      Dive
                    </th>
                    <th scope="col" className="a10-num">
                      Speed
                    </th>
                    <th scope="col" className="a10-num">
                      Height
                    </th>
                    <th scope="col" className="a10-num">
                      Slant range
                    </th>
                    <th scope="col" className="a10-num">
                      Miss
                    </th>
                    <th scope="col">Clock</th>
                    <th scope="col">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {d.weapons.slice(0, ROW_LIMIT).map((w, i) => (
                    <tr key={i}>
                      <td className="fac-readout">{formatClock(w.release.time)}</td>
                      <td>{w.weapon}</td>
                      <td className="a10-num fac-readout">{formatDegFromRad(w.release.dive)}</td>
                      <td className="a10-num fac-readout">{formatKnots(w.release.speed)}</td>
                      <td className="a10-num fac-readout">{formatFeetFromM(w.release.agl)}</td>
                      <td className="a10-num fac-readout">
                        {formatRangeM(w.release.slantRange, 10)}
                      </td>
                      <td className="a10-num fac-readout">{formatMiss(w.missDistance)}</td>
                      <td>{formatClockDirection(w.missClock)}</td>
                      <td>
                        {[w.dud && 'Dud', w.fragmentWarning && 'Inside the fragment envelope']
                          .filter(Boolean)
                          .join(' · ') || DASH}
                      </td>
                    </tr>
                  ))}
                  <More total={d.weapons.length} cols={9} />
                </tbody>
              </table>
            </TableWrap>
          </section>
        )}

        {rangeEntries.length > 0 && (
          <section className="a10-card" aria-labelledby="a10-range-title">
            <h2 className="a10-section-title" id="a10-range-title">
              Range score
            </h2>
            <dl className="a10-facts">
              {rangeEntries.map(([k, v]) => (
                <div key={k}>
                  <dt>{capitalize(humanize(k))}</dt>
                  <dd className="fac-readout">
                    {Number.isInteger(v) ? formatInt(v) : v.toFixed(1)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </div>
  );
}
