/**
 * The drawn instruments of the HUD: compass tape, artificial horizon and the vertical-speed
 * scale. Each is a static SVG rendered once (memo); its moving group is registered in the
 * `HudLive` record and animated by the frame painter (live.ts), never by React.
 */
import { memo } from 'react';
import {
  HORIZON_CENTER,
  HORIZON_SIZE,
  ROLL_SCALE_MARKS,
  buildPitchLadder,
  vsiFraction,
} from './attitude';
import { TAPE_WIDTH, buildTapeTicks } from './compass';
import { VSI_DIAL, type HudLive } from './live';

interface LiveProps {
  live: HudLive;
}

const TAPE_HEIGHT = 30;
const TAPE_TICKS = buildTapeTicks();

/** Scrolling heading tape: a tick every 10°, long ticks and labels every 30°, N / E / S / W. */
export const CompassTape = memo(function CompassTape({ live }: LiveProps) {
  return (
    <svg
      className="hud-tape"
      viewBox={`0 0 ${TAPE_WIDTH} ${TAPE_HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <g
        ref={(el) => {
          live.compassStrip = el;
        }}
      >
        {TAPE_TICKS.map((tick) => (
          <g key={tick.deg}>
            <line
              className={tick.major ? 'hud-tape-tick hud-tape-tick--major' : 'hud-tape-tick'}
              x1={tick.x}
              x2={tick.x}
              y1={tick.major ? TAPE_HEIGHT - 10 : TAPE_HEIGHT - 5}
              y2={TAPE_HEIGHT}
            />
            {tick.label && (
              <text
                className={
                  tick.cardinal ? 'hud-tape-label hud-tape-label--cardinal' : 'hud-tape-label'
                }
                x={tick.x}
                y={14}
              >
                {tick.label}
              </text>
            )}
          </g>
        ))}
      </g>
      <path
        className="hud-tape-caret"
        d={`M${TAPE_WIDTH / 2 - 5} ${TAPE_HEIGHT} L${TAPE_WIDTH / 2} ${TAPE_HEIGHT - 7} L${TAPE_WIDTH / 2 + 5} ${TAPE_HEIGHT} Z`}
      />
    </svg>
  );
});

const LADDER = buildPitchLadder();
const HORIZON_RADIUS = 45;
/** Far enough to cover the dial at any roll and at the pitch limit. */
const HORIZON_SPAN = 200;

/**
 * Artificial horizon. The sky / sea disc rolls and slides behind a fixed ship symbol:
 * rolling to starboard turns the horizon counter-clockwise, bow up moves it down.
 */
export const AttitudeIndicator = memo(function AttitudeIndicator({ live }: LiveProps) {
  const c = HORIZON_CENTER;
  return (
    <svg
      className="hud-horizon"
      viewBox={`0 0 ${HORIZON_SIZE} ${HORIZON_SIZE}`}
      role="img"
      aria-label="Attitude indicator"
      focusable="false"
    >
      <defs>
        <clipPath id="hud-horizon-clip">
          <circle cx={c} cy={c} r={HORIZON_RADIUS} />
        </clipPath>
      </defs>
      <g clipPath="url(#hud-horizon-clip)">
        <g
          ref={(el) => {
            live.horizonRoll = el;
          }}
        >
          <g
            ref={(el) => {
              live.horizonPitch = el;
            }}
          >
            <rect
              className="hud-horizon-sky"
              x={c - HORIZON_SPAN}
              y={c - HORIZON_SPAN}
              width={HORIZON_SPAN * 2}
              height={HORIZON_SPAN}
            />
            <rect
              className="hud-horizon-sea"
              x={c - HORIZON_SPAN}
              y={c}
              width={HORIZON_SPAN * 2}
              height={HORIZON_SPAN}
            />
            <line
              className="hud-horizon-line"
              x1={c - HORIZON_SPAN}
              x2={c + HORIZON_SPAN}
              y1={c}
              y2={c}
            />
            {LADDER.map((rung) => (
              <g key={rung.deg}>
                <line
                  className="hud-horizon-rung"
                  x1={c - rung.halfWidth}
                  x2={c + rung.halfWidth}
                  y1={rung.y}
                  y2={rung.y}
                />
                {rung.label && (
                  <text className="hud-horizon-num" x={c + rung.halfWidth + 2} y={rung.y + 2}>
                    {rung.label}
                  </text>
                )}
              </g>
            ))}
          </g>
          {ROLL_SCALE_MARKS.map((mark) => (
            <line
              key={mark}
              className={
                mark === 0 ? 'hud-horizon-mark hud-horizon-mark--zero' : 'hud-horizon-mark'
              }
              x1={c}
              x2={c}
              y1={c - HORIZON_RADIUS}
              y2={c - HORIZON_RADIUS + (mark === 0 ? 8 : mark % 30 === 0 ? 6 : 4)}
              transform={`rotate(${mark} ${c} ${c})`}
            />
          ))}
        </g>
      </g>
      <circle className="hud-horizon-bezel" cx={c} cy={c} r={HORIZON_RADIUS + 0.5} />
      {/* fixed references: the roll pointer and the ship symbol */}
      <path className="hud-horizon-pointer" d={`M${c} ${c - 34} l-3.4 6 h6.8 z`} />
      <path
        className="hud-horizon-ship"
        d={`M${c - 24} ${c} h13 l3 4 M${c + 24} ${c} h-13 l-3 4`}
      />
      <circle className="hud-horizon-dot" cx={c} cy={c} r={1.6} />
    </svg>
  );
});

/** Vertical speeds marked on the scale, m/s. */
const VSI_MARKS: readonly number[] = [-30, -15, -5, 0, 5, 15, 30];

/** Vertical-speed scale with a needle that rides up for a climb and down for a descent. */
export const VerticalSpeedScale = memo(function VerticalSpeedScale({ live }: LiveProps) {
  return (
    <svg
      className="hud-vsi"
      viewBox={`0 0 ${VSI_DIAL.width} ${VSI_DIAL.height}`}
      aria-hidden="true"
      focusable="false"
    >
      <line
        className="hud-vsi-rail"
        x1={2}
        x2={2}
        y1={VSI_DIAL.center - VSI_DIAL.travel}
        y2={VSI_DIAL.center + VSI_DIAL.travel}
      />
      {VSI_MARKS.map((mark) => {
        const y = VSI_DIAL.center - vsiFraction(mark) * VSI_DIAL.travel;
        return (
          <line
            key={mark}
            className={mark === 0 ? 'hud-vsi-mark hud-vsi-mark--zero' : 'hud-vsi-mark'}
            x1={2}
            x2={mark === 0 ? 9 : 6}
            y1={y}
            y2={y}
          />
        );
      })}
      <g
        ref={(el) => {
          live.vsiNeedle = el;
        }}
      >
        <path className="hud-vsi-needle" d={`M4 ${VSI_DIAL.center} l9 -4.5 v9 z`} />
      </g>
    </svg>
  );
});
