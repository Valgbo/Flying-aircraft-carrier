/**
 * HUD — the flight instruments shown on the flight and ops screens.
 *
 * Layout (see hud/hud.css): a top bar with the mode chips, the compass tape and the icon
 * buttons; the flight cluster (speed · artificial horizon · altitude) at the bottom centre
 * with the caution banners above it; the four turbine gauges on the right edge; the keyboard
 * legend at the bottom left. The centre of the screen stays clear for the ship.
 *
 * Numbers come from the ≈10 Hz store telemetry. Everything that moves smoothly (horizon,
 * compass strip, vertical-speed needle, gauge arcs and needles) is painted every animation
 * frame straight from `sim` by one painter (hud/live.ts) — no React render per frame.
 */
import { useMemo, useRef, useState } from 'react';
import { useTouchControlsVisible } from '../controls/touchVisibility';
import { emitAction, type ActionName } from '../state/actions';
import { CAMERA_LABELS, useGameStore } from '../state/useGameStore';
import { AttitudeIndicator, CompassTape, VerticalSpeedScale } from './hud/Instruments';
import KeyLegend from './hud/KeyLegend';
import TurbineGauges from './hud/TurbineGauges';
import { deriveCautions, sameCautions, selectVisibleCautions, type Caution } from './hud/cautions';
import {
  formatHeading,
  formatInt,
  formatSigned,
  motionSense,
  showSeaReadout,
  targetSense,
  verticalTrend,
} from './hud/format';
import { useFramePainter } from './hud/frameLoop';
import { AssistIcon, CameraIcon, PauseIcon, TurbineIcon } from './hud/icons';
import { createHudLive, createHudPainter } from './hud/live';
import { useBlurAfterPointer } from './hud/useBlurAfterPointer';
import './hud/hud.css';

/** Warnings / cautions shown at once; lower priorities wait their turn. */
const MAX_BANNERS = 3;

const MOTION_LABELS = { ahead: 'AHEAD', astern: 'ASTERN', stopped: 'STOPPED' } as const;

function emit(action: ActionName): () => void {
  return () => emitAction(action);
}

const onToggleAssist = emit('toggleAssist');
const onCycleCamera = emit('cycleCamera');
const onTogglePause = emit('togglePause');
const onTogglePanel = emit('toggleTurbinePanel');

export default function HUD() {
  const t = useGameStore((s) => s.telemetry);
  const assist = useGameStore((s) => s.assistEnabled);
  const cameraMode = useGameStore((s) => s.cameraMode);
  const panelOpen = useGameStore((s) => s.turbinePanelOpen);
  const paused = useGameStore((s) => s.paused);
  const touch = useTouchControlsVisible();

  const rootRef = useRef<HTMLDivElement>(null);
  useBlurAfterPointer(rootRef);

  const live = useMemo(createHudLive, []);
  const painter = useMemo(() => createHudPainter(live), [live]);
  useFramePainter(painter);

  // The list on screen feeds back into the derivation (hysteresis), so it is state that is
  // adjusted while rendering; it settles after one extra pass when a banner sets or clears.
  const [cautions, setCautions] = useState<Caution[]>([]);
  const nextCautions = deriveCautions(t, assist, cautions);
  if (!sameCautions(nextCautions, cautions)) setCautions(nextCautions);
  const banners = selectVisibleCautions(nextCautions, MAX_BANNERS);

  const motion = motionSense(t.forwardSpeedKts);
  const trend = verticalTrend(t.verticalSpeed);
  const target = targetSense(t.targetAltitude, t.altitude);

  const rootClass = ['hud', touch && 'hud--touch', panelOpen && 'hud--panel']
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={rootRef} className={rootClass} data-testid="hud">
      <div className="hud-top">
        <div className="hud-chips">
          <button
            type="button"
            className={`hud-chip fac-focusable ${assist ? 'hud-chip--on' : 'hud-chip--off'}`}
            onClick={onToggleAssist}
            aria-pressed={assist}
            title="Toggle flight assist"
          >
            <span className="hud-chip-long">FLIGHT&nbsp;</span>ASSIST{' '}
            <strong data-testid="hud-assist">{assist ? 'ON' : 'OFF'}</strong>
          </button>
          <button
            type="button"
            className="hud-chip fac-focusable"
            onClick={onCycleCamera}
            title="Next camera"
          >
            <span className="hud-chip-key">CAM</span>{' '}
            <strong data-testid="hud-camera">{CAMERA_LABELS[cameraMode]}</strong>
          </button>
        </div>

        <div className="hud-compass">
          <div className="hud-tape-window">
            <CompassTape live={live} />
          </div>
          <div className="hud-heading" aria-label={`Heading ${formatHeading(t.headingDeg)} degrees`}>
            <span data-testid="hud-heading">{formatHeading(t.headingDeg)}</span>
            <span className="hud-unit">°</span>
          </div>
        </div>

        <div className="hud-buttons">
          <button
            type="button"
            className="hud-iconbtn hud-iconbtn--secondary fac-focusable"
            onClick={onToggleAssist}
            aria-label="Toggle flight assist"
            aria-pressed={assist}
            title="Flight assist"
          >
            <AssistIcon />
          </button>
          <button
            type="button"
            className="hud-iconbtn hud-iconbtn--secondary fac-focusable"
            onClick={onCycleCamera}
            aria-label="Next camera"
            title="Camera"
          >
            <CameraIcon />
          </button>
          <button
            type="button"
            className="hud-iconbtn fac-focusable"
            onClick={onTogglePanel}
            aria-label="Turbine panel"
            aria-pressed={panelOpen}
            title="Turbine panel"
          >
            <TurbineIcon />
          </button>
          <button
            type="button"
            className="hud-iconbtn fac-focusable"
            onClick={onTogglePause}
            aria-label="Pause"
            aria-pressed={paused}
            title="Pause"
          >
            <PauseIcon />
          </button>
        </div>
      </div>

      <TurbineGauges telemetry={t} live={live} />

      <div className="hud-bottom">
        <div className="hud-cautions" role="status" aria-live="polite">
          {banners.map((caution) => (
            <span key={caution.id} className={`hud-caution hud-caution--${caution.level}`}>
              {caution.label}
            </span>
          ))}
        </div>

        <div className="hud-cluster">
          <div className="hud-box hud-box--speed">
            <span className="fac-label">Ground speed</span>
            <div className="hud-big">
              <span data-testid="hud-speed">{formatInt(t.speedKts)}</span>
              <span className="hud-unit">kt</span>
            </div>
            <div className={`hud-sub hud-motion hud-motion--${motion}`}>
              <span className="hud-motion-arrow" aria-hidden="true" />
              {MOTION_LABELS[motion]}
            </div>
            <div className="hud-sub">
              <span className="hud-key">G</span> {t.gLoad.toFixed(2)}
            </div>
          </div>

          <AttitudeIndicator live={live} />

          <div className={`hud-box hud-box--alt hud-trend--${trend}`}>
            <div className="hud-alt-data">
              <span className="fac-label">Altitude</span>
              <div className="hud-big">
                <span data-testid="hud-altitude">{formatInt(t.altitude)}</span>
                <span className="hud-unit">m</span>
              </div>
              <div className="hud-sub hud-vs">
                <span className="hud-key">V/S</span>{' '}
                <span data-testid="hud-vspeed">{formatSigned(t.verticalSpeed)}</span>
                <span className="hud-unit">m/s</span>
              </div>
              <div className="hud-sub hud-alt-extra">
                {assist && (
                  <span className={`hud-target hud-target--${target}`}>
                    <span className="hud-target-bug" aria-hidden="true" />
                    <span className="hud-key">TGT</span> {formatInt(t.targetAltitude)}
                  </span>
                )}
                {t.afloat ? (
                  <span className="hud-afloat">AFLOAT</span>
                ) : (
                  showSeaReadout(t.keelClearance, t.afloat) && (
                    <span className="hud-sea">
                      <span className="hud-key">SEA</span> {formatInt(Math.max(0, t.keelClearance))}{' '}
                      m
                    </span>
                  )
                )}
              </div>
            </div>
            <VerticalSpeedScale live={live} />
          </div>
        </div>
      </div>

      <KeyLegend />
    </div>
  );
}
