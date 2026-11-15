/**
 * Four compact turbine gauges laid out like the ship seen from above (bow up):
 *   FL  FR
 *   RL  RR
 * Each shows the actual throttle as an arc with a tick at the commanded value, the thrust in
 * percent of the sea-level maximum, and the nacelle tilt as a needle plus number.
 * A gauge is a button that opens the turbine panel.
 */
import { memo } from 'react';
import { TURBINE, TURBINE_LABELS, TURBINE_NAMES } from '../../config/layout';
import type { Telemetry } from '../../state/types';
import { useGameStore } from '../../state/useGameStore';
import { ARC_START_DEG, arcLength, gaugeState } from './attitude';
import { formatPercent, formatTiltDeg, thrustFraction } from './format';
import { GAUGE_DIAL, TILT_DIAL, type HudLive } from './live';

interface DialProps {
  index: number;
  live: HudLive;
}

const CIRCUMFERENCE = 2 * Math.PI * GAUGE_DIAL.radius;
const TRACK_DASH = `${arcLength(1, GAUGE_DIAL.radius)} ${CIRCUMFERENCE}`;
const ARC_ROTATION = `rotate(${ARC_START_DEG} ${GAUGE_DIAL.center} ${GAUGE_DIAL.center})`;

/** Throttle dial: static track, live arc (actual) and live tick (commanded). */
const ThrottleDial = memo(function ThrottleDial({ index, live }: DialProps) {
  const { size, center, radius } = GAUGE_DIAL;
  return (
    <svg
      className="hud-gauge-dial"
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      focusable="false"
    >
      <circle
        className="hud-gauge-track"
        cx={center}
        cy={center}
        r={radius}
        strokeDasharray={TRACK_DASH}
        transform={ARC_ROTATION}
      />
      <circle
        ref={(el) => {
          live.throttleArcs[index] = el;
        }}
        className="hud-gauge-arc"
        cx={center}
        cy={center}
        r={radius}
        strokeDasharray={`0 ${CIRCUMFERENCE}`}
        transform={ARC_ROTATION}
      />
      <line
        ref={(el) => {
          live.commandTicks[index] = el;
        }}
        className="hud-gauge-cmd"
        x1={center + radius - 4.5}
        x2={center + radius + 4.5}
        y1={center}
        y2={center}
        transform={ARC_ROTATION}
      />
    </svg>
  );
});

/** End point of a tilt-scale mark `deg` from upright, on the small tilt dial. */
function tiltMark(deg: number, inner: number, outer: number): string {
  const a = (deg * Math.PI) / 180;
  const { pivotX, pivotY } = TILT_DIAL;
  const x1 = pivotX + Math.sin(a) * inner;
  const y1 = pivotY - Math.cos(a) * inner;
  const x2 = pivotX + Math.sin(a) * outer;
  const y2 = pivotY - Math.cos(a) * outer;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

const TILT_MARKS = [TURBINE.tiltMinDeg, 0, 30, TURBINE.tiltMaxDeg]
  .map((deg) => tiltMark(deg, TILT_DIAL.needle - 1, TILT_DIAL.needle + 2.5))
  .join(' ');

/** Tilt dial: upright at 0°, the needle swings clockwise as the thrust leans toward the bow. */
const TiltDial = memo(function TiltDial({ index, live }: DialProps) {
  const { width, height, pivotX, pivotY, needle } = TILT_DIAL;
  return (
    <svg
      className="hud-gauge-tilt"
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      <path className="hud-gauge-tiltscale" d={TILT_MARKS} />
      <line
        ref={(el) => {
          live.tiltNeedles[index] = el;
        }}
        className="hud-gauge-needle"
        x1={pivotX}
        y1={pivotY}
        x2={pivotX}
        y2={pivotY - needle}
      />
      <circle className="hud-gauge-pivot" cx={pivotX} cy={pivotY} r={1.6} />
    </svg>
  );
});

interface TurbineGaugesProps {
  telemetry: Telemetry;
  live: HudLive;
}

function openPanel(): void {
  useGameStore.getState().setTurbinePanelOpen(true);
}

export default function TurbineGauges({ telemetry, live }: TurbineGaugesProps) {
  return (
    <div className="hud-turbines" role="group" aria-label="Turbines">
      {TURBINE_NAMES.map((name, i) => {
        const enabled = telemetry.enabled[i];
        const state = gaugeState(enabled, telemetry.throttle[i]);
        const thrust = formatPercent(thrustFraction(telemetry.thrustKN[i]));
        const tilt = formatTiltDeg(telemetry.tiltDeg[i]);
        return (
          <button
            key={name}
            type="button"
            className={`hud-gauge hud-gauge--${state} fac-focusable`}
            onClick={openPanel}
            aria-label={
              enabled
                ? `Turbine ${name}, ${TURBINE_LABELS[i]}: thrust ${thrust} percent, tilt ${tilt}. Open turbine panel`
                : `Turbine ${name}, ${TURBINE_LABELS[i]}: engine off. Open turbine panel`
            }
          >
            <span className="hud-gauge-face">
              <ThrottleDial index={i} live={live} />
              <span className="hud-gauge-value">{enabled ? thrust : 'OFF'}</span>
            </span>
            <span className="hud-gauge-side">
              <span className="hud-gauge-name">{name}</span>
              <TiltDial index={i} live={live} />
              <span className="hud-gauge-tiltnum">{tilt}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
