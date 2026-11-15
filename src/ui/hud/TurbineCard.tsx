/**
 * One turbine of the turbine panel: engine switch, throttle and tilt sliders with live
 * actual-versus-commanded bars, thrust readout and a button that points the camera at it.
 *
 * The card is presentational: the panel decides what the sliders show (the flight computer's
 * live commands in assist mode, the manual levers otherwise) and performs the writes.
 */
import { memo } from 'react';
import { TURBINE, TURBINE_LABELS, TURBINE_NAMES } from '../../config/layout';
import { gaugeState } from './attitude';
import { formatPercent, formatThrustMN, formatTiltDeg, thrustFraction } from './format';
import { EyeIcon } from './icons';
import { TILT_ZERO_FRACTION, type PanelLive } from './panelLive';

export interface TurbineCardProps {
  index: number;
  enabled: boolean;
  /** True in assist mode: the sliders follow the flight computer and cannot be moved. */
  readOnly: boolean;
  /** Commanded throttle shown on the slider, 0..1. */
  throttleCommand: number;
  /** Commanded tilt shown on the slider, degrees. */
  tiltCommandDeg: number;
  /** Actual (spooled) throttle, 0..1 — decides the state colour. */
  throttle: number;
  thrustKN: number;
  /** True while the turbine camera is framing this turbine. */
  viewed: boolean;
  live: PanelLive;
  onToggleEngine: (index: number) => void;
  onThrottle: (index: number, throttle: number) => void;
  onTiltDeg: (index: number, tiltDeg: number) => void;
  onView: (index: number) => void;
}

interface BarProps {
  index: number;
  live: PanelLive;
}

/** Live throttle bar: solid = actual, white tick = commanded. Painted by the frame loop. */
const ThrottleBar = memo(function ThrottleBar({ index, live }: BarProps) {
  return (
    <span className="tp-bar" aria-hidden="true">
      <span
        className="tp-bar-fill"
        ref={(el) => {
          live.throttleFill[index] = el;
        }}
      />
      <span
        className="tp-bar-cmd"
        ref={(el) => {
          live.throttleCommand[index] = el;
        }}
      />
    </span>
  );
});

/** Live tilt bar: fills from upright toward the actual angle, white tick = commanded. */
const TiltBar = memo(function TiltBar({ index, live }: BarProps) {
  return (
    <span className="tp-bar" aria-hidden="true">
      <span className="tp-bar-zero" style={{ left: `${TILT_ZERO_FRACTION * 100}%` }} />
      <span
        className="tp-bar-fill"
        ref={(el) => {
          live.tiltFill[index] = el;
        }}
      />
      <span
        className="tp-bar-cmd"
        ref={(el) => {
          live.tiltCommand[index] = el;
        }}
      />
    </span>
  );
});

export default function TurbineCard({
  index,
  enabled,
  readOnly,
  throttleCommand,
  tiltCommandDeg,
  throttle,
  thrustKN,
  viewed,
  live,
  onToggleEngine,
  onThrottle,
  onTiltDeg,
  onView,
}: TurbineCardProps) {
  const name = TURBINE_NAMES[index];
  const state = gaugeState(enabled, throttle);
  const throttlePercent = formatPercent(throttleCommand);
  const tiltWhole = Math.round(tiltCommandDeg);

  return (
    <section
      className={`tp-card tp-card--${state}`}
      aria-label={`Turbine ${name}, ${TURBINE_LABELS[index]}`}
    >
      <div className="tp-card-head">
        <span className="tp-card-name">{name}</span>
        <span className="tp-card-label">{TURBINE_LABELS[index]}</span>
        <label className="tp-engine">
          <span className="tp-engine-text">{enabled ? 'ON' : 'OFF'}</span>
          <input
            type="checkbox"
            role="switch"
            className="tp-switch"
            data-testid={`turbine-enabled-${index}`}
            aria-label={`${name} engine`}
            checked={enabled}
            onChange={() => onToggleEngine(index)}
          />
        </label>
      </div>

      <label className="tp-field">
        <span className="tp-field-row">
          <span className="fac-label">Throttle</span>
          <span className="tp-field-value">{throttlePercent}%</span>
        </span>
        <input
          type="range"
          className="tp-range"
          data-testid={`turbine-throttle-${index}`}
          aria-label={`${name} throttle, percent`}
          min={0}
          max={100}
          step={1}
          value={Number(throttlePercent)}
          disabled={readOnly}
          onChange={(event) => onThrottle(index, Number(event.currentTarget.value) / 100)}
        />
        <ThrottleBar index={index} live={live} />
      </label>

      <label className="tp-field">
        <span className="tp-field-row">
          <span className="fac-label">Tilt</span>
          <span className="tp-field-value">{formatTiltDeg(tiltCommandDeg)}</span>
        </span>
        <input
          type="range"
          className="tp-range"
          data-testid={`turbine-tilt-${index}`}
          aria-label={`${name} tilt, degrees`}
          min={TURBINE.tiltMinDeg}
          max={TURBINE.tiltMaxDeg}
          step={1}
          value={tiltWhole}
          disabled={readOnly}
          onChange={(event) => onTiltDeg(index, Number(event.currentTarget.value))}
        />
        <TiltBar index={index} live={live} />
      </label>

      <div className="tp-card-foot">
        <span className="tp-thrust">
          <span className="fac-label">Thrust</span>{' '}
          <strong>{enabled ? `${formatPercent(thrustFraction(thrustKN))}%` : 'OFF'}</strong>
          <span className="tp-thrust-mn">{formatThrustMN(thrustKN)} MN</span>
        </span>
        <button
          type="button"
          className="tp-view fac-focusable"
          onClick={() => onView(index)}
          aria-pressed={viewed}
          aria-label={`View turbine ${name}`}
          title="Point the camera at this turbine"
        >
          <EyeIcon />
          View
        </button>
      </div>
    </section>
  );
}
