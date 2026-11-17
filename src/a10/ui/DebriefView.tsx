/**
 * The debrief's content (PLAN_A10.md §11.4), shared by the debrief screen at the end of a flight
 * and the pause menu's "Debrief so far": the summary, the range score of a range event, the
 * passes — a list, and for the chosen pass its release conditions, an overhead plot of its
 * impacts against the target, what each hit did and its kills — and the flight log (bursts,
 * releases, hits by vehicle with their own plots, kills, the targets on the range).
 */
import { useMemo, useState, type KeyboardEvent } from 'react';
import type { Sim } from '../core/types';
import { getCrashInfo } from './bridge';
import {
  burstHitRate,
  nearMissVehicles,
  strikeSummary,
  summarize,
  vehicleMarks,
  vehicleName,
  type VehicleHits,
} from './debriefData';
import {
  buildDebriefModel,
  hitRow,
  weaponName,
  type HitRow,
  type PassView,
  type RangeView,
} from './debriefModel';
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
import ImpactPlot from './ImpactPlot';
import PassPlot from './PassPlot';
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

const NUM = 'a10-num fac-readout';

/** Rows a pass shows for one vehicle before "Show all". */
const PASS_ROWS = 6;

function HitTable({ rows, limit = ROW_LIMIT }: { rows: readonly HitRow[]; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? Math.min(rows.length, ROW_LIMIT) : Math.min(rows.length, limit);
  return (
    <>
      <TableWrap>
        <table className="a10-table a10-table--dense a10-table--nowrap">
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
              <th scope="col" className="a10-num" title="Plate thickness along the line of flight">
                Armour
              </th>
              <th scope="col" className="a10-num" title="What the round could penetrate at that speed">
                Penetration
              </th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((h, i) => (
              <tr key={i}>
                <td className="fac-readout">{formatClock(h.time)}</td>
                <td>{h.weapon}</td>
                <td title={h.indirect ? 'The plate facing the burst' : undefined}>{h.plate}</td>
                <td className={NUM}>{formatDegFromRad(h.obliquity)}</td>
                <td className={NUM}>{formatInt(h.speed)} m/s</td>
                <td className={NUM}>{formatMm(h.effectiveThicknessMm)}</td>
                <td className={NUM}>{formatMm(h.penetrationMm)}</td>
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
            {all && <More total={rows.length} cols={8} />}
          </tbody>
        </table>
      </TableWrap>
      {rows.length > limit && (
        <button
          type="button"
          className="a10-link a10-more-rows"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? 'Show fewer' : `Show all ${formatInt(rows.length)} hits`}
        </button>
      )}
    </>
  );
}

// ---- range score --------------------------------------------------------------------------------

function RangeScore({ range }: { range: RangeView }) {
  return (
    <section className="a10-card" aria-labelledby="a10-range-title" data-testid="a10-debrief-range">
      <h2 className="a10-section-title" id="a10-range-title">
        Range score · {range.title}
      </h2>
      <p className="a10-note">{range.line}</p>
      {range.strafe &&
        (range.strafe.rows.length === 0 ? (
          <p className="a10-note">No strafing pass yet.</p>
        ) : (
          <TableWrap>
            <table className="a10-table a10-table--nowrap" data-testid="a10-range-strafe-table">
              <thead>
                <tr>
                  <th scope="col">Pass</th>
                  <th scope="col">Panel</th>
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
                  <th scope="col" className="a10-num" title="Closest to the panels while firing">
                    Closest
                  </th>
                  <th scope="col" className="a10-num">
                    Lowest
                  </th>
                  <th scope="col">Fouls</th>
                  <th scope="col" className="a10-num">
                    Score
                  </th>
                </tr>
              </thead>
              <tbody>
                {range.strafe.rows.map((r) => (
                  <tr key={r.pass} data-foul={r.fouls ? '' : undefined}>
                    <td className="fac-readout">{r.pass}</td>
                    <td>{r.panel}</td>
                    <td className={NUM}>{formatInt(r.rounds)}</td>
                    <td className={NUM}>
                      {formatInt(r.hits)}
                      <span className="a10-table__aside">
                        {' '}
                        {r.rounds > 0 ? formatPct(r.hits / r.rounds) : ''}
                      </span>
                    </td>
                    <td className={NUM}>{formatRangeM(r.openFireRange, 10)}</td>
                    <td className={NUM}>{formatRangeM(r.ceaseFireRange, 10)}</td>
                    <td className={NUM}>{formatRangeM(r.closestFiring, 10)}</td>
                    <td className={NUM}>{formatFeetFromM(r.minAgl)}</td>
                    <td>{r.fouls ? <span className="a10-foul">{r.fouls}</span> : DASH}</td>
                    <td className={NUM}>{formatInt(r.scored)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2}>
                    Session
                  </th>
                  <td className={NUM}>{formatInt(range.strafe.total.rounds)}</td>
                  <td className={NUM}>
                    {formatInt(range.strafe.total.hits)}
                    <span className="a10-table__aside">
                      {' '}
                      {range.strafe.total.rounds > 0
                        ? formatPct(range.strafe.total.hits / range.strafe.total.rounds)
                        : ''}
                    </span>
                  </td>
                  <td colSpan={4} />
                  <td>
                    {range.strafe.total.fouls > 0
                      ? `${range.strafe.total.fouls} ${range.strafe.total.fouls === 1 ? 'foul' : 'fouls'}`
                      : 'No fouls'}
                  </td>
                  <td className={NUM}>{formatInt(range.strafe.total.scored)}</td>
                </tr>
              </tfoot>
            </table>
          </TableWrap>
        ))}
      {range.bombs &&
        (range.bombs.rows.length === 0 ? (
          <p className="a10-note">No bomb has landed yet.</p>
        ) : (
          <>
            <div className="a10-stats a10-stats--small">
              <Stat label="Average miss" value={formatMiss(range.bombs.mean)} />
              <Stat label="CEP" value={formatMiss(range.bombs.cep)} sub="half the bombs inside" />
              <Stat label="Best" value={formatMiss(range.bombs.best)} />
            </div>
            <TableWrap>
              <table className="a10-table a10-table--nowrap" data-testid="a10-range-bomb-table">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Pass</th>
                    <th scope="col">Store</th>
                    <th scope="col" className="a10-num">
                      Miss
                    </th>
                    <th scope="col">Clock</th>
                    <th scope="col">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {range.bombs.rows.map((b) => (
                    <tr key={b.n}>
                      <td className="fac-readout">{b.n}</td>
                      <td className="fac-readout">{b.pass || DASH}</td>
                      <td>{b.store}</td>
                      <td className={NUM}>{formatMiss(b.miss)}</td>
                      <td>{formatClockDirection(b.clock)}</td>
                      <td>{b.notes || DASH}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </>
        ))}
      {range.lane && (
        <>
          <div className="a10-stats a10-stats--small">
            <Stat
              label="Destroyed"
              value={formatInt(range.lane.kills.length)}
              sub={`of ${formatInt(range.lane.vehicles)} on the lane`}
            />
            <Stat
              label="Time to kill"
              value={formatSeconds(range.lane.meanTimeToKill)}
              sub="average, first shot to kill"
            />
          </div>
          {range.lane.byWeapon.length > 0 && (
            <TableWrap>
              <table className="a10-table" data-testid="a10-range-lane-table">
                <thead>
                  <tr>
                    <th scope="col">Weapon</th>
                    <th scope="col" className="a10-num">
                      Fired
                    </th>
                    <th scope="col" className="a10-num">
                      Struck
                    </th>
                    <th scope="col" className="a10-num">
                      Kills
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {range.lane.byWeapon.map((w) => (
                    <tr key={w.weapon}>
                      <td>{weaponName(w.weapon)}</td>
                      <td className={NUM}>{formatInt(w.released)}</td>
                      <td className={NUM}>{formatInt(w.hits)}</td>
                      <td className={NUM}>{formatInt(w.kills)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
          {range.lane.kills.length > 0 && (
            <TableWrap>
              <table className="a10-table">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Vehicle</th>
                    <th scope="col">Weapon</th>
                    <th scope="col" className="a10-num">
                      Time to kill
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {range.lane.kills.map((k) => (
                    <tr key={k.kill}>
                      <td className="fac-readout">{formatClock(k.time)}</td>
                      <td>
                        {vehicleName(k.kind)} #{k.vehicleId}
                      </td>
                      <td>{weaponName(k.weapon)}</td>
                      <td className={NUM}>{formatSeconds(k.timeToKill)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </>
      )}
    </section>
  );
}

// ---- passes ---------------------------------------------------------------------------------------

function PassDetail({ pass }: { pass: PassView }) {
  return (
    <article
      className="a10-pass"
      role="tabpanel"
      id={`a10-pass-panel-${pass.index}`}
      aria-labelledby={`a10-pass-tab-${pass.index}`}
      data-testid="a10-debrief-pass"
    >
      <header className="a10-pass__head">
        <h3>Pass {pass.number}</h3>
        <span className="a10-pass__span fac-readout">
          {formatClock(pass.start)} – {pass.open ? 'in progress' : formatClock(pass.end)}
        </span>
        <span className="a10-pass__facts">
          lowest <span className="fac-readout">{formatFeetFromM(pass.minAgl)}</span> · up to{' '}
          <span className="fac-readout">{formatG(pass.maxG)}</span>
        </span>
      </header>
      <p className="a10-pass__result">
        <span className="a10-pass__weapons">{pass.weapons}</span>
        <span>{pass.result}</span>
      </p>
      {pass.fouls.map((f) => (
        <p key={f} className="a10-note a10-note--warn" role="note">
          Foul. {f}.
        </p>
      ))}
      <div className="a10-pass__grid">
        <PassPlot plot={pass.plot} label={`Pass ${pass.number}`} />
        <div className="a10-pass__tables">
          <h4 className="a10-pass__sub">Release conditions</h4>
          <TableWrap>
            <table className="a10-table a10-table--dense a10-table--nowrap" data-testid="a10-pass-events">
              <thead>
                <tr>
                  <th scope="col">Weapon</th>
                  <th scope="col">Time</th>
                  <th scope="col" className="a10-num">
                    Dive
                  </th>
                  <th scope="col" className="a10-num">
                    Speed
                  </th>
                  <th scope="col" className="a10-num">
                    Slant range
                  </th>
                  <th scope="col" className="a10-num">
                    Height
                  </th>
                  <th scope="col" className="a10-num">
                    Load
                  </th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {pass.events.map((e, i) => (
                  <tr key={i}>
                    <td>
                      {e.label}
                      {e.kind === 'release' && e.delivery !== 'MAV' && e.delivery !== 'ROCKET' && (
                        <span className="a10-table__aside"> {e.delivery}</span>
                      )}
                    </td>
                    <td className="fac-readout">{formatClock(e.time)}</td>
                    <td className={NUM}>{formatDegFromRad(e.dive)}</td>
                    <td className={NUM}>{formatKnots(e.speed)}</td>
                    <td className={NUM}>{formatRangeM(e.slantRange, 10)}</td>
                    <td className={NUM}>{formatFeetFromM(e.agl)}</td>
                    <td className={NUM}>{formatG(e.g)}</td>
                    <td>{e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <h4 className="a10-pass__sub">Hits</h4>
          {pass.vehicles.length === 0 ? (
            <p className="a10-note">No vehicle was hit.</p>
          ) : (
            pass.vehicles.map((v) => (
              <div key={v.vehicleId} className="a10-pass__vehicle">
                <div className="a10-vehicle__head">
                  <h5>{v.name}</h5>
                  <span className={`a10-condition a10-condition--${v.condition}`}>
                    {capitalize(humanize(v.condition))}
                  </span>
                  <span className="a10-vehicle__count">{v.strikes}</span>
                </div>
                <HitTable rows={v.rows} limit={PASS_ROWS} />
              </div>
            ))
          )}
          {pass.kills.length > 0 && (
            <>
              <h4 className="a10-pass__sub">Kills</h4>
              <ul className="a10-pass__kills">
                {pass.kills.map((k, i) => (
                  <li key={i}>
                    <span className="fac-readout">{formatClock(k.time)}</span> {k.name}{' '}
                    {k.catastrophic ? 'destroyed, catastrophic' : 'destroyed'} by {k.weapon}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function Passes({ passes }: { passes: readonly PassView[] }) {
  const [chosen, setChosen] = useState<number | null>(null);
  const index = chosen !== null && chosen < passes.length ? chosen : passes.length - 1;
  const pass = passes[index];
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    let next = index;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = Math.min(passes.length - 1, index + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = passes.length - 1;
    else return;
    e.preventDefault();
    setChosen(next);
    document.getElementById(`a10-pass-tab-${next}`)?.focus();
  };
  return (
    <section className="a10-card" aria-labelledby="a10-passes-title" data-testid="a10-debrief-passes">
      <h2 className="a10-section-title" id="a10-passes-title">
        Passes
      </h2>
      {passes.length === 0 ? (
        <p className="a10-note">
          No pass yet: a pass runs from the roll-in to the pull-off and needs a burst or a release.
        </p>
      ) : (
        <div className="a10-passes">
          <div className="a10-passes__list" role="tablist" aria-label="Passes" aria-orientation="vertical" onKeyDown={onKey}>
            {passes.map((p) => (
              <button
                key={p.index}
                type="button"
                role="tab"
                id={`a10-pass-tab-${p.index}`}
                aria-selected={p.index === index}
                aria-controls={`a10-pass-panel-${p.index}`}
                tabIndex={p.index === index ? 0 : -1}
                className="a10-pass-tab"
                data-testid={`a10-pass-tab-${p.number}`}
                onClick={() => setChosen(p.index)}
              >
                <span className="a10-pass-tab__num fac-readout">{p.number}</span>
                <span className="a10-pass-tab__text">
                  <span className="a10-pass-tab__weapons">{p.weapons}</span>
                  <span className="a10-pass-tab__result">
                    {p.target} · {p.result}
                  </span>
                </span>
                <span className="a10-pass-tab__time fac-readout">{formatClock(p.start)}</span>
              </button>
            ))}
          </div>
          {pass && <PassDetail pass={pass} />}
        </div>
      )}
    </section>
  );
}

// ---- flight log -----------------------------------------------------------------------------------

function FlightLog({ sim, groups }: { sim: Sim; groups: readonly VehicleHits[] }) {
  const d = sim.debrief;
  const vehicles = sim.targets.vehicles;
  const nearOnly = nearMissVehicles(d);
  const byKind = new Map<string, { total: number; damaged: number; destroyed: number }>();
  for (const v of vehicles) {
    const k = byKind.get(v.kind) ?? { total: 0, damaged: 0, destroyed: 0 };
    k.total++;
    if (v.condition === 'damaged') k.damaged++;
    if (v.condition === 'destroyed' || v.condition === 'catastrophic') k.destroyed++;
    byKind.set(v.kind, k);
  }
  const released = d.weapons;
  const roundsHit = d.bursts.reduce((n, b) => n + b.hits, 0);
  const roundsFired = d.bursts.reduce((n, b) => n + b.rounds, 0);
  return (
    <section className="a10-card a10-log" aria-labelledby="a10-log-title">
      <h2 className="a10-section-title" id="a10-log-title">
        Flight log
      </h2>
      <details className="a10-log__part" open={d.passes.length === 0}>
        <summary>
          Gun bursts <span className="a10-log__count fac-readout">{d.bursts.length}</span>
        </summary>
        {d.bursts.length === 0 ? (
          <p className="a10-note">No bursts recorded.</p>
        ) : (
          <>
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
                      Struck
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
                      <td className={NUM}>{formatSeconds(b.duration)}</td>
                      <td className={NUM}>{formatInt(b.rounds)}</td>
                      <td className={NUM}>
                        {formatInt(b.hits)}
                        <span className="a10-table__aside">
                          {' '}
                          {Number.isFinite(burstHitRate(b)) ? formatPct(burstHitRate(b)) : ''}
                        </span>
                      </td>
                      <td className={NUM}>{formatRangeM(b.openFireRange, 10)}</td>
                      <td className={NUM}>{formatRangeM(b.ceaseFireRange, 10)}</td>
                      <td className={NUM}>{formatDegFromRad(b.start.dive)}</td>
                      <td className={NUM}>{formatKnots(b.start.speed)}</td>
                      <td className={NUM}>{formatFeetFromM(b.start.agl)}</td>
                    </tr>
                  ))}
                  <More total={d.bursts.length} cols={10} />
                </tbody>
              </table>
            </TableWrap>
            <p className="a10-note">
              Rounds that struck a vehicle: {formatHitRate(roundsHit, roundsFired)}. Open- and
              cease-fire ranges are slant ranges to the pipper.
            </p>
          </>
        )}
      </details>

      {released.length > 0 && (
        <details className="a10-log__part">
          <summary>
            Weapons released <span className="a10-log__count fac-readout">{released.length}</span>
          </summary>
          <TableWrap>
            <table className="a10-table" data-testid="a10-debrief-weapons">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Weapon</th>
                  <th scope="col">Delivery</th>
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
                  <th scope="col" className="a10-num" title="From the aim point">
                    Miss
                  </th>
                  <th scope="col">Clock</th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {released.slice(0, ROW_LIMIT).map((w, i) => (
                  <tr key={i}>
                    <td className="fac-readout">{formatClock(w.release.time)}</td>
                    <td>{weaponName(w.store || w.weapon)}</td>
                    <td>{w.delivery}</td>
                    <td className={NUM}>{formatDegFromRad(w.release.dive)}</td>
                    <td className={NUM}>{formatKnots(w.release.speed)}</td>
                    <td className={NUM}>{formatFeetFromM(w.release.agl)}</td>
                    <td className={NUM}>{formatRangeM(w.release.slantRange, 10)}</td>
                    <td className={NUM}>{formatMiss(w.missDistance)}</td>
                    <td>{formatClockDirection(w.missClock)}</td>
                    <td>
                      {[
                        w.simulated && 'Simulated',
                        w.delivery === 'JETTISON' && 'Jettisoned',
                        w.dud && 'Dud',
                        w.fragmentWarning && 'Inside the fragment envelope',
                      ]
                        .filter(Boolean)
                        .join(' · ') || DASH}
                    </td>
                  </tr>
                ))}
                <More total={released.length} cols={10} />
              </tbody>
            </table>
          </TableWrap>
        </details>
      )}

      <details className="a10-log__part" open={d.passes.length === 0 && groups.length > 0}>
        <summary>
          Hits by vehicle <span className="a10-log__count fac-readout">{groups.length}</span>
        </summary>
        {groups.length === 0 && nearOnly.length === 0 ? (
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
                    <span className="a10-vehicle__count fac-readout">{strikeSummary(g)}</span>
                  </header>
                  <div className="a10-vehicle__body">
                    <ImpactPlot kind={g.kind} marks={vehicleMarks(d, g.vehicleId)} label={name} />
                    <HitTable rows={g.hits.map(hitRow)} />
                  </div>
                </article>
              );
            })}
            {nearOnly.map((id) => {
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
                    <ImpactPlot kind={v.kind} marks={vehicleMarks(d, id)} label={name} />
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </details>

      <div className="a10-debrief__pair">
        <div>
          <h3 className="a10-log__title">Kills</h3>
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
                      <td>{weaponName(k.weapon)}</td>
                      <td>{k.catastrophic ? 'Catastrophic' : 'Destroyed'}</td>
                    </tr>
                  ))}
                  <More total={d.kills.length} cols={4} />
                </tbody>
              </table>
            </TableWrap>
          )}
        </div>
        <div>
          <h3 className="a10-log__title">Targets on the range</h3>
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
                      <td className={NUM}>{k.total}</td>
                      <td className={NUM}>{k.damaged}</td>
                      <td className={NUM}>{k.destroyed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </div>
      </div>
    </section>
  );
}

// ---- the whole view ------------------------------------------------------------------------------

export default function DebriefView({ sim }: { sim: Sim }) {
  const model = useMemo(() => buildDebriefModel(sim), [sim]);
  const d = sim.debrief;
  const summary = summarize(d, sim.gun, sim.targets.vehicles.length);
  const crash = sim.aircraft.crashed ? getCrashInfo(sim) : null;
  return (
    <>
      {sim.aircraft.crashed && (
        <p className="a10-note a10-note--alert" role="note">
          The flight ended {CRASH_WHERE[crash?.reason ?? 'terrain']} at{' '}
          {formatKnots(crash?.ias ?? sim.aircraft.ias)}.
        </p>
      )}
      <div className="a10-stats" data-testid="a10-debrief-summary">
        <Stat label="Flight time" value={formatClock(sim.time)} />
        <Stat
          label="Passes"
          value={formatInt(summary.passes)}
          sub={summary.weaponsReleased > 0 ? `${formatInt(summary.weaponsReleased)} stores released` : undefined}
        />
        <Stat
          label="Rounds fired"
          value={formatInt(summary.roundsFired)}
          sub={`of ${formatInt(summary.roundsLoaded)} loaded`}
        />
        <Stat
          label="Rounds on target"
          value={formatInt(summary.gunHits)}
          sub={
            summary.roundsFired > 0
              ? `${formatPct(summary.gunHits / summary.roundsFired)} of rounds struck a vehicle`
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
      {model.range && <RangeScore range={model.range} />}
      <Passes passes={model.passes} />
      <FlightLog sim={sim} groups={model.vehicles} />
    </>
  );
}
