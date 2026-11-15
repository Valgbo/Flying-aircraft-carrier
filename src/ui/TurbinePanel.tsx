/**
 * TurbinePanel — hands-on control of the four turbines (rendered while
 * `store.turbinePanelOpen`). A side panel on desktop, a bottom sheet on phones; while the
 * on-screen touch controls are visible it keeps out of their two bottom corners, because the
 * ship flies on while the panel is open (hud/tp.css).
 *
 * Who owns what (docs/ARCHITECTURE.md §3):
 * - Engine switches write `sim.turbines[i].enabled` in either mode.
 * - Flight assist ON: the flight computer owns throttle and tilt. The sliders are read-only
 *   and follow its live commands (`telemetry.throttleCmd` / `tiltCmdDeg`); the panel says so
 *   and offers the switch to manual control.
 * - Flight assist OFF: the sliders are the manual levers. They write
 *   `sim.controls.manualThrottle[i]` (0..1) and `manualTilt[i]` (radians) immediately and
 *   show those same arrays, so keyboard changes (which move all four) come straight back.
 */
import { useMemo, useReducer, useRef, useState } from 'react';
import { TURBINE } from '../config/layout';
import { useTouchControlsVisible } from '../controls/touchVisibility';
import { HOVER_THROTTLE, PHYS } from '../config/physicsConfig';
import { emitAction } from '../state/actions';
import { sim } from '../state/sim';
import type { TurbineIndex } from '../state/types';
import { useGameStore } from '../state/useGameStore';
import { DEG2RAD, RAD2DEG, clamp, clamp01 } from '../utils/math';
import ShipSchematic from './hud/ShipSchematic';
import TurbineCard from './hud/TurbineCard';
import { formatTiltDeg } from './hud/format';
import { useFramePainter } from './hud/frameLoop';
import { CloseIcon } from './hud/icons';
import { createPanelLive, createPanelPainter } from './hud/panelLive';
import { useBlurAfterPointer } from './hud/useBlurAfterPointer';
import './hud/tp.css';

const INDICES: readonly TurbineIndex[] = [0, 1, 2, 3];

/** The lever and the computer's command count as different beyond this, degrees. */
const LEVER_MISMATCH_DEG = 1.5;

function closePanel(): void {
  useGameStore.getState().setTurbinePanelOpen(false);
}

function toggleAssist(): void {
  emitAction('toggleAssist');
}

function viewTurbine(index: number): void {
  const store = useGameStore.getState();
  store.setCameraTurbine(index as TurbineIndex);
  store.setCameraMode('turbine');
}

function TurbinePanelBody() {
  const telemetry = useGameStore((s) => s.telemetry);
  const assist = useGameStore((s) => s.assistEnabled);
  const cameraMode = useGameStore((s) => s.cameraMode);
  const cameraTurbine = useGameStore((s) => s.cameraTurbine);
  const touch = useTouchControlsVisible();
  const [linkAll, setLinkAll] = useState(false);
  // Writes go to `sim`, which React cannot see: bump to show them at once instead of waiting
  // for the next telemetry snapshot.
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  const rootRef = useRef<HTMLElement>(null);
  useBlurAfterPointer(rootRef);

  const live = useMemo(createPanelLive, []);
  const painter = useMemo(() => createPanelPainter(live), [live]);
  useFramePainter(painter);

  const setThrottle = (index: number, throttle: number): void => {
    const value = clamp01(throttle);
    for (const i of INDICES) {
      if (linkAll || i === index) sim.controls.manualThrottle[i] = value;
    }
    refresh();
  };
  const setTiltDeg = (index: number, tiltDeg: number): void => {
    const value = clamp(tiltDeg * DEG2RAD, PHYS.tiltMin, PHYS.tiltMax);
    for (const i of INDICES) {
      if (linkAll || i === index) sim.controls.manualTilt[i] = value;
    }
    refresh();
  };
  const toggleEngine = (index: number): void => {
    sim.turbines[index].enabled = !sim.turbines[index].enabled;
    refresh();
  };
  const setAll = (throttle: number | null, tilt: number | null): void => {
    for (const i of INDICES) {
      if (throttle !== null) sim.controls.manualThrottle[i] = throttle;
      if (tilt !== null) sim.controls.manualTilt[i] = tilt;
    }
    refresh();
  };

  // In assist mode the lever is the pilot's request and tiltCmd what the computer allows.
  const leverDeg = sim.controls.tiltLever * RAD2DEG;
  const allowedDeg =
    (telemetry.tiltCmdDeg[0] +
      telemetry.tiltCmdDeg[1] +
      telemetry.tiltCmdDeg[2] +
      telemetry.tiltCmdDeg[3]) /
    4;
  const leverLimited = assist && Math.abs(leverDeg - allowedDeg) > LEVER_MISMATCH_DEG;
  const viewed = cameraMode === 'turbine' ? cameraTurbine : null;

  return (
    <aside
      ref={rootRef}
      className={`tp fac-panel ${assist ? 'tp--assist' : 'tp--manual'}${touch ? ' tp--touch' : ''}`}
      data-testid="turbine-panel"
      aria-label="Turbine control"
    >
      <header className="tp-header">
        <h2 className="tp-title">Turbines</h2>
        <span className={`tp-mode ${assist ? 'tp-mode--assist' : 'tp-mode--manual'}`}>
          {assist ? 'ASSIST' : 'MANUAL'}
        </span>
        <button
          type="button"
          className="tp-close fac-focusable"
          onClick={closePanel}
          aria-label="Close turbine panel"
          title="Close"
        >
          <CloseIcon />
        </button>
      </header>

      <div className="tp-body">
        <div className="tp-overview">
          <ShipSchematic telemetry={telemetry} viewed={viewed} />
          <div className="tp-note">
            {assist ? (
              <>
                <p>
                  <strong>Flight computer in command.</strong> It sets throttle and tilt; the
                  sliders show its live commands. Engine switches stay live.
                </p>
                {leverLimited && (
                  <p className="tp-note-lever">
                    Tilt lever {formatTiltDeg(leverDeg)} · computer allows{' '}
                    {formatTiltDeg(allowedDeg)}
                  </p>
                )}
                <button type="button" className="fac-btn fac-btn--primary" onClick={toggleAssist}>
                  Take manual control
                </button>
              </>
            ) : (
              <>
                <p>
                  <strong>Manual control.</strong> The sliders command each turbine directly.
                  Nothing stabilises the ship.
                </p>
                <button type="button" className="fac-btn" onClick={toggleAssist}>
                  Engage flight assist
                </button>
              </>
            )}
          </div>
        </div>

        <div className="tp-actions" role="group" aria-label="Manual quick actions">
          <button
            type="button"
            className="fac-btn fac-btn--ghost tp-link"
            aria-pressed={linkAll}
            disabled={assist}
            onClick={() => setLinkAll((on) => !on)}
            title="Move all four turbines together"
          >
            Link all
          </button>
          <button
            type="button"
            className="fac-btn fac-btn--ghost"
            disabled={assist}
            onClick={() => setAll(HOVER_THROTTLE, 0)}
            title="All throttles to hover power, nacelles upright"
          >
            Hover
          </button>
          <button
            type="button"
            className="fac-btn fac-btn--ghost"
            disabled={assist}
            onClick={() => setAll(0, null)}
            title="All throttles to idle"
          >
            Idle
          </button>
          <button
            type="button"
            className="fac-btn fac-btn--ghost"
            disabled={assist}
            onClick={() => setAll(null, 0)}
            title="All nacelles upright"
          >
            Level
          </button>
        </div>

        <div className="tp-cards">
          {INDICES.map((i) => (
            <TurbineCard
              key={i}
              index={i}
              enabled={sim.turbines[i].enabled}
              readOnly={assist}
              throttleCommand={assist ? telemetry.throttleCmd[i] : sim.controls.manualThrottle[i]}
              tiltCommandDeg={
                assist
                  ? clamp(telemetry.tiltCmdDeg[i], TURBINE.tiltMinDeg, TURBINE.tiltMaxDeg)
                  : sim.controls.manualTilt[i] * RAD2DEG
              }
              throttle={telemetry.throttle[i]}
              thrustKN={telemetry.thrustKN[i]}
              viewed={viewed === i}
              live={live}
              onToggleEngine={toggleEngine}
              onThrottle={setThrottle}
              onTiltDeg={setTiltDeg}
              onView={viewTurbine}
            />
          ))}
        </div>

        <p className="tp-legend">
          <span className="tp-legend-fill" aria-hidden="true" /> actual
          <span className="tp-legend-cmd" aria-hidden="true" /> commanded
        </p>
      </div>
    </aside>
  );
}

export default function TurbinePanel() {
  const open = useGameStore((s) => s.turbinePanelOpen);
  return open ? <TurbinePanelBody /> : null;
}
