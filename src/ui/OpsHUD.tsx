/**
 * OpsHUD — flight-ops score and status: a compact block on the left edge below the top bar.
 * Everything comes from `store.ops`, which the flight-ops system publishes at a low rate.
 */
import { useRef } from 'react';
import { OPS } from '../aircraft/opsConfig';
import { WAVE_OFF_GRADE } from '../aircraft/steadiness';
import { emitAction } from '../state/actions';
import { keyLabel } from '../state/bindings';
import type { JetPhase, RecoveryResult } from '../state/types';
import { useGameStore } from '../state/useGameStore';
import './ops/ops.css';

/** Short chip label and colour group per phase. */
const PHASES: Record<JetPhase, { label: string; tone: string }> = {
  parked: { label: 'DECK', tone: 'deck' },
  taxi: { label: 'TAXI', tone: 'move' },
  catapult: { label: 'CAT', tone: 'launch' },
  launch: { label: 'LAUNCH', tone: 'launch' },
  climbout: { label: 'CLIMB', tone: 'air' },
  pattern: { label: 'PATTERN', tone: 'air' },
  approach: { label: 'FINAL', tone: 'final' },
  trap: { label: 'TRAP', tone: 'trap' },
  waveoff: { label: 'WAVE-OFF', tone: 'alert' },
  rollout: { label: 'ROLLOUT', tone: 'trap' },
};

function steadinessTone(value: number): string {
  if (value < OPS.minSteadiness) return 'alert';
  return value < OPS.gradeGood ? 'warn' : 'good';
}

function calloutTone(result: RecoveryResult): string {
  if (result.grade === WAVE_OFF_GRADE) return 'alert';
  return result.grade === 'PERFECT' || result.grade === 'GOOD' ? 'good' : 'warn';
}

export default function OpsHUD() {
  const ops = useGameStore((s) => s.ops);
  const launchKey = useGameStore((s) => s.settings.keyBindings.launchJet);
  // call-outs are for results that arrive while the HUD is up, not for one it finds on mount
  const outcomes = ops.recoveries + ops.waveOffs;
  const seenOnMount = useRef(outcomes);
  if (outcomes < seenOnMount.current) seenOnMount.current = outcomes;
  const result = outcomes > seenOnMount.current ? ops.lastRecovery : null;

  const percent = Math.round(ops.deckStability * 100);
  const tone = steadinessTone(ops.deckStability);
  return (
    <div className="ops-hud fac-panel" data-testid="ops-hud">
      <div className="ops-score">
        <span className="fac-label">Score</span>
        <span className="ops-score__value fac-readout" data-testid="ops-score">
          {ops.score}
        </span>
      </div>

      <dl className="ops-tally fac-readout">
        <div>
          <dt className="fac-label">Launch</dt>
          <dd>{ops.launches}</dd>
        </div>
        <div>
          <dt className="fac-label">Trap</dt>
          <dd>{ops.recoveries}</dd>
        </div>
        <div>
          <dt className="fac-label">Wave-off</dt>
          <dd>{ops.waveOffs}</dd>
        </div>
      </dl>

      <div className={`ops-steady ops-steady--${tone}`}>
        <div className="ops-steady__head">
          <span className="fac-label">Deck steady</span>
          <span
            className="ops-steady__value fac-readout"
            data-testid="ops-stability"
            role="meter"
            aria-label="Deck steadiness"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            {percent}
          </span>
        </div>
        <div className="ops-steady__track" aria-hidden="true">
          <div className="ops-steady__fill" style={{ width: `${percent}%` }} />
          <div
            className="ops-steady__limit"
            style={{ left: `${OPS.minSteadiness * 100}%` }}
            title="Wave-off limit"
          />
        </div>
      </div>

      <div className="ops-status fac-readout" data-testid="ops-status" role="status">
        {ops.status}
      </div>

      <ul className="ops-jets" aria-label="Aircraft">
        {ops.jets.map((jet) => (
          <li key={jet.id} className={`ops-jet ops-jet--${PHASES[jet.phase].tone}`}>
            <span className="ops-jet__id">{jet.id}</span>
            <span className="ops-jet__phase">{PHASES[jet.phase].label}</span>
          </li>
        ))}
      </ul>

      <button
        type="button"
        className="ops-launch fac-btn fac-btn--primary"
        data-testid="ops-launch"
        onClick={(event) => {
          emitAction('launchJet');
          // keep the keyboard on the ship: Space must not re-press a focused button
          event.currentTarget.blur();
        }}
      >
        Launch
        <kbd className="ops-launch__key">{keyLabel(launchKey)}</kbd>
      </button>

      {result && (
        <div
          key={outcomes}
          className={`ops-callout ops-callout--${calloutTone(result)} fac-readout`}
          aria-hidden="true"
        >
          <span className="ops-callout__grade">{result.grade}</span>
          {result.points > 0 && <span className="ops-callout__points">+{result.points}</span>}
        </div>
      )}
    </div>
  );
}
