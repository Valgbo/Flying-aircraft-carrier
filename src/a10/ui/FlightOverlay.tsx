/**
 * The in-flight overlay, kept minimal: the cockpit and HUD show the flight data. It holds the
 * checklist strip (PLAN_A10.md §2), the crash panel, and — only with ?fps=1 — a telemetry line
 * for debugging (tests read telemetry from window.__A10__.store instead).
 */
import { Fragment, useEffect, useRef } from 'react';
import { a10Flags } from '../state/debugFlags';
import { exitToMenu, finishFlight, restartFlight } from '../state/flow';
import { getSim } from '../state/runtime';
import { useA10Store } from '../state/store';
import { getCrashInfo, useChecklistStep } from './bridge';
import { keyCaps } from './ControlsReference';
import { formatDegFromRad, formatKnots } from './format';
import { IconDebrief, IconExit, IconRestart } from './icons';

/** A step's key as key caps: "1 / J" (two keys bound) → 1 / J, each in its own cap. */
function StepKeys({ label }: { label: string }) {
  const caps = keyCaps(label);
  if (caps.length <= 1) return <kbd className="shell-key">{caps[0] ?? label}</kbd>;
  return (
    <span className="a10-checklist__keys">
      {caps.map((k, i) => (
        <Fragment key={`${k}-${i}`}>
          {i > 0 && <span className="a10-checklist__or">/</span>}
          <kbd className="shell-key">{k}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

function ChecklistStrip() {
  const step = useChecklistStep();
  if (!step) return null;
  return (
    <div
      className={`a10-checklist a10-checklist--${step.tone}`}
      data-testid="a10-checklist"
      data-step={step.id}
      role="status"
      aria-live="polite"
    >
      {/* what assistive technology announces: the line as plain text */}
      <span className="fac-visually-hidden">
        Next step, {step.weapon}: {step.text}
      </span>
      <span className="a10-checklist__weapon" aria-hidden="true">
        <span className="a10-checklist__label">Next</span>
        <span className="a10-checklist__name">{step.weapon}</span>
      </span>
      <span className="a10-checklist__ticks" aria-hidden="true">
        {Array.from({ length: step.count }, (_, i) => (
          <span
            key={i}
            className={`a10-checklist__tick${i < step.index ? ' a10-checklist__tick--done' : i === step.index ? ' a10-checklist__tick--now' : ''}`}
          />
        ))}
      </span>
      <span className="a10-checklist__text" aria-hidden="true">
        {step.parts.map((p, i) =>
          p.key !== undefined ? <StepKeys key={i} label={p.key} /> : <span key={i}>{p.text}</span>,
        )}
      </span>
    </div>
  );
}

const CRASH_TITLE = {
  terrain: 'You flew into the ground',
  water: 'You flew into the water',
  overstress: 'The airframe broke up',
} as const;

function CrashPanel() {
  const ref = useRef<HTMLButtonElement>(null);
  const sim = getSim();
  const info = getCrashInfo(sim);
  const ias = info?.ias ?? sim?.aircraft.ias ?? NaN;
  const path = info?.flightPath ?? sim?.aircraft.flightPathAngle ?? NaN;

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      className="a10-crash"
      data-testid="a10-crash"
      role="alertdialog"
      aria-labelledby="a10-crash-title"
    >
      <div className="a10-crash__panel fac-panel">
        <p className="fac-label a10-crash__kicker">Flight ended</p>
        <h2 className="a10-crash__title" id="a10-crash-title">
          {CRASH_TITLE[info?.reason ?? 'terrain']}
        </h2>
        <p className="a10-crash__facts">
          At <span className="fac-readout">{formatKnots(ias)}</span>
          {Number.isFinite(path) && path < -0.01 && (
            <>
              {' '}
              in a <span className="fac-readout">{formatDegFromRad(-path)}</span> descent
            </>
          )}
          . Pull out earlier: the altitude alert and PULL UP are the only safety net.
        </p>
        <div className="a10-crash__actions">
          <button
            ref={ref}
            type="button"
            className="fac-btn fac-btn--primary"
            data-testid="a10-crash-restart"
            onClick={() => void restartFlight()}
          >
            <IconRestart size={18} />
            <span>Restart</span>
          </button>
          <button
            type="button"
            className="fac-btn"
            data-testid="a10-crash-debrief"
            onClick={finishFlight}
          >
            <IconDebrief size={18} />
            <span>Debrief</span>
          </button>
          <button
            type="button"
            className="fac-btn fac-btn--ghost"
            data-testid="a10-crash-menu"
            onClick={exitToMenu}
          >
            <IconExit size={18} />
            <span>Menu</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function TelemetryLine() {
  const t = useA10Store((s) => s.telemetry);
  const paused = useA10Store((s) => s.paused);
  return (
    <div className="a10-telemetry fac-readout" data-testid="a10-telemetry">
      T {t.time.toFixed(1)} · IAS {t.ias.toFixed(0)} KT · ALT {t.altitude.toFixed(0)} FT · AGL{' '}
      {t.agl.toFixed(0)} · HDG {t.heading.toFixed(0)} · G {t.g.toFixed(1)} · RDS {t.rounds} ·{' '}
      {t.masterArm}/{t.gunPac}/{t.masterMode}
      {t.crashed ? ' · CRASHED' : ''}
      {paused ? ' · PAUSED' : ''}
    </div>
  );
}

export default function FlightOverlay() {
  // the telemetry snapshot lags up to 0.1 s: confirm against the live flight, so a restart
  // never flashes the previous flight's crash panel
  const crashed = useA10Store((s) => s.telemetry.crashed) && getSim()?.aircraft.crashed === true;
  const paused = useA10Store((s) => s.paused);
  const nonce = useA10Store((s) => s.flightNonce);
  return (
    <div className="a10-flight">
      <ChecklistStrip />
      {crashed && !paused && <CrashPanel key={nonce} />}
      {a10Flags.fps && <TelemetryLine />}
    </div>
  );
}
