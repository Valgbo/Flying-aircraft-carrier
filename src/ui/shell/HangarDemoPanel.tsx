/**
 * HangarDemoPanel — the turbine demo of the hangar: spin the fans up, tilt the nacelles,
 * change the time of day and watch the resulting thrust against the weight of the ship.
 * The sliders write `hangar.demoThrottle` / `hangar.demoTiltDeg` (the idle driver makes the
 * turbines follow them) and `settings.timeOfDay`. On phones it is a bottom sheet that folds
 * down to its title row. Styles: hangar.css (`hangar-demo`, `hangar-field`, `hangar-thrust`).
 */
import { useState, type CSSProperties } from 'react';
import { TURBINE } from '../../config/layout';
import { HOVER_THROTTLE, WEIGHT } from '../../config/physicsConfig';
import { useGameStore } from '../../state/useGameStore';
import { clamp01 } from '../../utils/math';
import { PresetChips, Slider, type Preset } from './controls';
import {
  formatMeganewtons,
  formatPercent,
  formatRatio,
  formatSignedDeg,
  formatTimeOfDay,
} from './format';
import { IconChevronDown } from './icons';
import { MAX_TOTAL_THRUST, summariseThrust, type LiftState } from './thrust';

const THROTTLE_PRESETS: readonly Preset[] = [
  { label: 'Idle', value: 0.05 },
  { label: 'Hover', value: HOVER_THROTTLE },
  { label: 'Full power', value: 1 },
];

const TILT_PRESETS: readonly Preset[] = [
  { label: 'Hover', value: 0 },
  { label: 'Cruise', value: 25 },
  { label: 'Max', value: TURBINE.tiltMaxDeg },
];

/** Latest time the slider offers: a quarter of an hour before the clock wraps to 00:00. */
export const TIME_SLIDER_MAX = 23.75;
export const TIME_SLIDER_STEP = 0.25;

const VERDICTS: Record<LiftState, string> = {
  sink: 'not enough to stay up',
  hover: 'holding altitude',
  climb: 'climbing',
};

/** Live thrust of the four turbines (≈10 Hz telemetry of the spooling fans) against the weight. */
function ThrustReadout() {
  const thrustKN = useGameStore((s) => s.telemetry.thrustKN);
  const tiltDeg = useGameStore((s) => s.telemetry.tiltDeg);
  const { totalKN, liftKN, liftRatio, state } = summariseThrust(thrustKN, tiltDeg);
  const barStyle = {
    '--hangar-total': clamp01(totalKN / MAX_TOTAL_THRUST),
    '--hangar-lift': clamp01(liftKN / MAX_TOTAL_THRUST),
    '--hangar-weight': clamp01(WEIGHT / MAX_TOTAL_THRUST),
  } as CSSProperties;
  return (
    <div className="hangar-thrust" data-state={state} data-testid="hangar-thrust">
      <div className="hangar-thrust__row">
        <span className="fac-label">Total thrust</span>
        <span className="fac-readout hangar-thrust__value" data-testid="hangar-thrust-total">
          {formatMeganewtons(totalKN)}
        </span>
      </div>
      <div className="hangar-thrust__bar" style={barStyle} aria-hidden="true">
        <span className="hangar-thrust__total" />
        <span className="hangar-thrust__lift" />
        <span className="hangar-thrust__weight" />
      </div>
      <div className="hangar-thrust__row">
        <span className="fac-label">Ship weight</span>
        <span className="fac-readout">{formatMeganewtons(WEIGHT)}</span>
      </div>
      <p className="hangar-thrust__verdict">
        Lift <span className="fac-readout">{formatRatio(liftRatio)}</span> weight —{' '}
        {VERDICTS[state]}
      </p>
    </div>
  );
}

export interface HangarDemoPanelProps {
  /** Phone layout: a bottom sheet with a fold toggle. */
  compact: boolean;
  /** Whether the sheet starts unfolded (phone layout only). */
  defaultOpen: boolean;
}

export default function HangarDemoPanel({ compact, defaultOpen }: HangarDemoPanelProps) {
  const demoThrottle = useGameStore((s) => s.hangar.demoThrottle);
  const demoTiltDeg = useGameStore((s) => s.hangar.demoTiltDeg);
  const timeOfDay = useGameStore((s) => s.settings.timeOfDay);
  const setHangar = useGameStore((s) => s.setHangar);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const [open, setOpen] = useState(defaultOpen);
  const expanded = !compact || open;

  return (
    <section className="hangar-demo fac-panel" aria-label="Turbine demo">
      <header className="hangar-demo__head">
        <h2 className="fac-label hangar-demo__title">Turbine demo</h2>
        {compact && (
          <button
            type="button"
            className="hangar-demo__toggle fac-focusable"
            aria-expanded={open}
            aria-controls="hangar-demo-body"
            onClick={() => setOpen(!open)}
          >
            <span className="fac-readout">
              {formatPercent(demoThrottle)} · {formatSignedDeg(demoTiltDeg)}
            </span>
            <IconChevronDown size={16} className="hangar-demo__chevron" />
          </button>
        )}
      </header>
      {expanded && (
        <div className="hangar-demo__body" id="hangar-demo-body">
          <div className="hangar-field">
            <div className="hangar-field__head">
              <label htmlFor="hangar-throttle">Spin up turbines</label>
              <output className="fac-readout" htmlFor="hangar-throttle">
                {formatPercent(demoThrottle)}
              </output>
            </div>
            <Slider
              id="hangar-throttle"
              testId="hangar-throttle"
              value={demoThrottle * 100}
              min={0}
              max={100}
              step={1}
              valueText={formatPercent(demoThrottle)}
              onChange={(percent) => setHangar({ demoThrottle: percent / 100 })}
            />
            <PresetChips
              presets={THROTTLE_PRESETS}
              value={demoThrottle}
              tolerance={0.006}
              ariaLabel="Throttle presets"
              onSelect={(value) => setHangar({ demoThrottle: value })}
            />
          </div>

          <div className="hangar-field">
            <div className="hangar-field__head">
              <label htmlFor="hangar-tilt">Tilt</label>
              <output className="fac-readout" htmlFor="hangar-tilt">
                {formatSignedDeg(demoTiltDeg)}
              </output>
            </div>
            <Slider
              id="hangar-tilt"
              testId="hangar-tilt"
              value={demoTiltDeg}
              min={TURBINE.tiltMinDeg}
              max={TURBINE.tiltMaxDeg}
              step={1}
              origin={0}
              valueText={`${formatSignedDeg(demoTiltDeg)} toward the bow`}
              onChange={(deg) => setHangar({ demoTiltDeg: deg })}
            />
            <PresetChips
              presets={TILT_PRESETS}
              value={demoTiltDeg}
              tolerance={0.5}
              ariaLabel="Tilt presets"
              onSelect={(value) => setHangar({ demoTiltDeg: value })}
            />
          </div>

          <div className="hangar-field">
            <div className="hangar-field__head">
              <label htmlFor="hangar-time">Time of day</label>
              <output className="fac-readout" htmlFor="hangar-time" data-testid="hangar-time-value">
                {formatTimeOfDay(timeOfDay)}
              </output>
            </div>
            <Slider
              id="hangar-time"
              testId="hangar-time"
              value={timeOfDay}
              min={0}
              max={TIME_SLIDER_MAX}
              step={TIME_SLIDER_STEP}
              valueText={formatTimeOfDay(timeOfDay)}
              onChange={(hours) => updateSettings({ timeOfDay: hours })}
            />
          </div>

          <ThrustReadout />
        </div>
      )}
    </section>
  );
}
