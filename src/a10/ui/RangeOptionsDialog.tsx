/**
 * Weapons-range options (main menu, PLAN_A10.md §11.2): the wind each range event is flown in —
 * its speed and the clock direction it blows from along the run-in, drawn on a small range
 * card — the turbulence, and the tactical lane's column speed. The choices are saved at once
 * (useA10Ui.setRangeOptions) and apply to every range flight from its first step (createSim
 * takes them as SimOptions.range); free hunt keeps the world's own weather. Escape or Done
 * closes it (UIRoot).
 */
import { useRef } from 'react';
import { IconClose, PresetChips, SelectRow, useModalFocus } from '../../engine';
import { formatClockDirection } from './format';
import {
  COLUMN_SPEEDS_KMH,
  DEFAULT_RANGE_OPTIONS,
  LANE_SPEED_KMH,
  TURBULENCE_LEVELS,
  WIND_SPEEDS_KT,
  windClockName,
  type TurbulenceLevel,
} from './rangeOptions';
import { useA10Ui } from './uiStore';

const CLOCKS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
const CLOCK_OPTIONS = CLOCKS.map((c) => ({
  value: String(c),
  label: `${formatClockDirection(c)} — ${windClockName(c)}`,
}));

const TURBULENCE_IDS = Object.keys(TURBULENCE_LEVELS) as TurbulenceLevel[];

/**
 * The run-in seen from above, run-in up: the aircraft's track toward the target in the centre,
 * and the wind arrow blowing in from its clock direction (no arrow when calm).
 */
function WindCard({ kt, clock }: { kt: number; clock: number }) {
  const a = (clock % 12) * (Math.PI / 6);
  // the arrow starts outside the clock face and points at the centre (downwind)
  const sx = 50 + Math.sin(a) * 42;
  const sy = 50 - Math.cos(a) * 42;
  const ex = 50 + Math.sin(a) * 14;
  const ey = 50 - Math.cos(a) * 14;
  const hx = Math.sin(a);
  const hy = -Math.cos(a);
  // arrow head at the end, pointing toward the centre
  const head = `${ex},${ey} ${ex + hx * 8 - hy * 5},${ey + hy * 8 + hx * 5} ${ex + hx * 8 + hy * 5},${ey + hy * 8 - hx * 5}`;
  return (
    <svg
      className="a10-windcard"
      viewBox="0 0 100 100"
      role="img"
      aria-label={kt > 0 ? `Wind ${kt} knots from ${formatClockDirection(clock)}` : 'Calm'}
    >
      <circle cx="50" cy="50" r="36" className="a10-windcard__face" />
      {CLOCKS.map((c) => {
        const t = (c % 12) * (Math.PI / 6);
        return (
          <line
            key={c}
            x1={50 + Math.sin(t) * 32}
            y1={50 - Math.cos(t) * 32}
            x2={50 + Math.sin(t) * 36}
            y2={50 - Math.cos(t) * 36}
            className="a10-windcard__tick"
          />
        );
      })}
      <text x="50" y="11" className="a10-windcard__label">
        12
      </text>
      {/* the run-in: the aircraft comes up from 6 o'clock toward the target */}
      <line x1="50" y1="90" x2="50" y2="58" className="a10-windcard__runin" />
      <polygon points="50,54 46,62 54,62" className="a10-windcard__runin-head" />
      <circle cx="50" cy="50" r="3.5" className="a10-windcard__target" />
      {kt > 0 && (
        <g className="a10-windcard__wind">
          <line x1={sx} y1={sy} x2={ex + hx * 6} y2={ey + hy * 6} />
          <polygon points={head} />
        </g>
      )}
    </svg>
  );
}

export default function RangeOptionsDialog() {
  const o = useA10Ui((s) => s.rangeOptions);
  const set = useA10Ui((s) => s.setRangeOptions);
  const close = () => useA10Ui.getState().setRangeOptionsOpen(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, { active: true, restoreFocus: true });

  return (
    <div
      className="a10-dialog-layer"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        className="a10-dialog a10-dialog--narrow fac-panel"
        data-testid="a10-range-options"
        role="dialog"
        aria-modal="true"
        aria-labelledby="a10-range-options-title"
        tabIndex={-1}
      >
        <header className="a10-dialog__head">
          <h2 className="a10-dialog__title" id="a10-range-options-title">
            Range options
          </h2>
          <button
            type="button"
            className="settings-close fac-focusable"
            aria-label="Close range options"
            onClick={close}
          >
            <IconClose size={20} />
          </button>
        </header>
        <div className="a10-dialog__body a10-range-options">
          <p className="a10-note">
            The conditions of the strafe pit, the bombing circle and the tactical lane. The wind is
            given the way the range calls it: the clock direction it blows from, 12 o’clock straight
            down the run-in. Free hunt keeps the world’s own weather.
          </p>

          <section className="a10-range-options__section" aria-labelledby="a10-ro-wind">
            <h3 className="a10-section-title" id="a10-ro-wind">
              Surface wind
            </h3>
            <div className="a10-range-options__wind">
              <WindCard kt={o.windKt} clock={o.windClock} />
              <div className="a10-range-options__controls" data-testid="a10-range-wind">
                <PresetChips
                  ariaLabel="Wind speed"
                  presets={WIND_SPEEDS_KT.map((kt) => ({
                    label: kt === 0 ? 'Calm' : `${kt} kn`,
                    value: kt,
                  }))}
                  value={o.windKt}
                  tolerance={0.1}
                  onSelect={(windKt) => set({ windKt })}
                />
              </div>
            </div>
            <SelectRow
              label="From"
              hint="The clock direction along the run-in, as the range officer calls it."
              value={String(o.windClock)}
              options={CLOCK_OPTIONS}
              onChange={(v) => set({ windClock: Number(v) })}
              testId="a10-range-clock"
            />
          </section>

          <section className="a10-range-options__section" aria-labelledby="a10-ro-turb">
            <h3 className="a10-section-title" id="a10-ro-turb">
              Turbulence
            </h3>
            <div
              className="a10-choices a10-choices--row a10-choices--compact"
              role="radiogroup"
              aria-labelledby="a10-ro-turb"
            >
              {TURBULENCE_IDS.map((id) => (
                <label key={id} className="a10-choice" data-testid={`a10-range-turb-${id}`}>
                  <input
                    type="radio"
                    name="a10-range-turbulence"
                    value={id}
                    checked={o.turbulence === id}
                    onChange={() => set({ turbulence: id })}
                  />
                  <span className="a10-choice__name">{TURBULENCE_LEVELS[id].label}</span>
                  <span className="a10-choice__desc">{TURBULENCE_LEVELS[id].hint}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="a10-range-options__section" aria-labelledby="a10-ro-lane">
            <h3 className="a10-section-title" id="a10-ro-lane">
              Tactical lane column
            </h3>
            <div data-testid="a10-range-column">
              <PresetChips
                ariaLabel="Column speed"
                presets={COLUMN_SPEEDS_KMH.map((kmh) => ({
                  label:
                    kmh === 0
                      ? 'Halted'
                      : kmh === LANE_SPEED_KMH
                        ? `${kmh} km/h (lane)`
                        : `${kmh} km/h`,
                  value: kmh,
                }))}
                value={o.columnKmh}
                tolerance={0.1}
                onSelect={(columnKmh) => set({ columnKmh })}
              />
            </div>
            <p className="a10-note">
              The remote-controlled column drives its loop at this speed: a Maverick or a laser bomb
              has to lead a mover, the gun’s pipper too.
            </p>
          </section>
        </div>
        <footer className="a10-dialog__foot a10-range-options__foot">
          <button
            type="button"
            className="fac-btn fac-btn--ghost"
            data-testid="a10-range-options-reset"
            onClick={() => set({ ...DEFAULT_RANGE_OPTIONS })}
          >
            Reset
          </button>
          <button
            type="button"
            className="fac-btn fac-btn--primary"
            data-testid="a10-range-options-done"
            onClick={close}
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
