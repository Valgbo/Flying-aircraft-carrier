/**
 * DOM overlay: menus, loading, pause, messages, debrief, checklist strip. OWNED BY THE UI MODULE.
 * FOUNDATION STAND-IN: a minimal menu, loading text and a telemetry line.
 */
import { useEffect } from 'react';
import { a10Flags } from '../state/debugFlags';
import { applyA10Flags, beginFlight, exitToMenu } from '../state/flow';
import { useA10Store } from '../state/store';

const BOX: React.CSSProperties = { position: 'absolute', pointerEvents: 'auto' };

export default function UIRoot() {
  const screen = useA10Store((s) => s.screen);
  const loading = useA10Store((s) => s.loading);
  const t = useA10Store((s) => s.telemetry);
  const paused = useA10Store((s) => s.paused);

  useEffect(() => applyA10Flags(), []);

  if (!a10Flags.ui) return null;
  return (
    <div className="ui-root" style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }}>
      {screen === 'menu' && (
        <div
          className="fac-panel"
          data-testid="a10-menu"
          style={{ ...BOX, left: 24, top: 24, padding: 20 }}
        >
          <h1 style={{ margin: '0 0 12px', fontSize: 22 }}>A-10 Warthog Simulator</h1>
          <button
            type="button"
            className="fac-btn fac-btn--primary"
            data-testid="a10-fly"
            onClick={() => void beginFlight()}
          >
            Fly now
          </button>
        </div>
      )}
      {screen === 'loading' && (
        <div
          className="fac-panel"
          data-testid="a10-loading"
          style={{ ...BOX, left: 24, top: 24, padding: 16 }}
        >
          {loading.label} {Math.round(loading.progress * 100)}%
        </div>
      )}
      {screen === 'flight' && (
        <div
          className="fac-readout"
          data-testid="a10-telemetry"
          style={{ ...BOX, left: 12, bottom: 12, fontSize: 12 }}
        >
          IAS {t.ias.toFixed(0)} KT · ALT {t.altitude.toFixed(0)} FT · HDG {t.heading.toFixed(0)} ·
          G {t.g.toFixed(1)} · RDS {t.rounds} · {t.masterArm} {t.masterMode}
          {t.crashed ? ' · CRASHED' : ''}
          {paused ? ' · PAUSED' : ''}
          <button
            type="button"
            className="fac-btn fac-btn--ghost"
            style={{ marginLeft: 8 }}
            onClick={exitToMenu}
          >
            Menu
          </button>
        </div>
      )}
    </div>
  );
}
