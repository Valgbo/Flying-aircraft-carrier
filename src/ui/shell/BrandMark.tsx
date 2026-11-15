/**
 * BrandMark — the mark of the app: the ship seen from above, drawn straight from the layout
 * config (flight-deck outline, four outrigger fans), so it is our own design by construction
 * and follows the ship if the layout changes. Drawn in carrier-local metres: bow up,
 * starboard to the right. Styles: shell.css (`.shell-mark`).
 */
import {
  CATAPULTS,
  DECK,
  HULL,
  ISLAND,
  LANDING_STRIP,
  TURBINE,
  TURBINE_MOUNTS,
} from '../../config/layout';

const MARGIN = 5;
const HALF_WIDTH =
  Math.max(...TURBINE_MOUNTS.map((m) => Math.abs(m[0]))) + TURBINE.ductOuterRadius + MARGIN;
const HALF_LENGTH = HULL.length / 2 + MARGIN;
const VIEW_BOX = `${-HALF_WIDTH} ${-HALF_LENGTH} ${HALF_WIDTH * 2} ${HALF_LENGTH * 2}`;

/** Width / height of the mark. */
export const BRAND_MARK_ASPECT = HALF_WIDTH / HALF_LENGTH;

const DECK_PATH = `${DECK.outline
  .map(([x, z], i) => `${i === 0 ? 'M' : 'L'}${x} ${z}`)
  .join(' ')} Z`;

/** Stroke widths in metres (the drawing unit). */
const RING_STROKE = 6;
const PYLON_STROKE = 8;
const MARKING_STROKE = 2.4;

/** The fan disc as one dashed circle: each dash is a blade, so rotating it spins the fan. */
const ROTOR_BLADES = 6;
const ROTOR_RADIUS = (TURBINE.hubRadius + TURBINE.fanRadius) / 2;
const ROTOR_STROKE = TURBINE.fanRadius - TURBINE.hubRadius - 4;
const ROTOR_PITCH = (2 * Math.PI * ROTOR_RADIUS) / ROTOR_BLADES;
const ROTOR_DASH = `${(ROTOR_PITCH * 0.44).toFixed(2)} ${(ROTOR_PITCH * 0.56).toFixed(2)}`;

export interface BrandMarkProps {
  /** Rendered height in px; the width follows from the ship's proportions. */
  height: number;
  /** Spin the fans (the loading screen's sign of life). Off under prefers-reduced-motion. */
  spin?: boolean;
  /** Draw the deck markings and the island too — worth it from about 80 px up. */
  detail?: boolean;
  /** Accessible name. Without it the mark is decorative and hidden from assistive tech. */
  title?: string;
  className?: string;
}

export default function BrandMark({
  height,
  spin = false,
  detail = false,
  title,
  className,
}: BrandMarkProps) {
  const classes = ['shell-mark', spin ? 'shell-mark--spin' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <svg
      className={classes}
      width={height * BRAND_MARK_ASPECT}
      height={height}
      viewBox={VIEW_BOX}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {TURBINE_MOUNTS.map(([x, , z], i) => (
        <line
          key={`pylon-${i}`}
          className="shell-mark__pylon"
          x1={Math.sign(x) * (HULL.beam / 2)}
          y1={z}
          x2={x - Math.sign(x) * TURBINE.ductOuterRadius}
          y2={z}
          strokeWidth={PYLON_STROKE}
        />
      ))}
      <path className="shell-mark__deck" d={DECK_PATH} />
      {detail && (
        <g className="shell-mark__markings" strokeWidth={MARKING_STROKE}>
          <line
            x1={LANDING_STRIP.threshold[0]}
            y1={LANDING_STRIP.threshold[2]}
            x2={LANDING_STRIP.end[0]}
            y2={LANDING_STRIP.end[2]}
          />
          {CATAPULTS.map((c) => (
            <line key={c.id} x1={c.start[0]} y1={c.start[2]} x2={c.end[0]} y2={c.end[2]} />
          ))}
          <rect
            className="shell-mark__island"
            x={ISLAND.centerX - ISLAND.width / 2}
            y={ISLAND.centerZ - ISLAND.length / 2}
            width={ISLAND.width}
            height={ISLAND.length}
            rx="2"
          />
        </g>
      )}
      {TURBINE_MOUNTS.map(([x, , z], i) => (
        <g key={`fan-${i}`}>
          <circle
            className="shell-mark__rotor"
            cx={x}
            cy={z}
            r={ROTOR_RADIUS}
            strokeWidth={ROTOR_STROKE}
            strokeDasharray={ROTOR_DASH}
          />
          <circle
            className="shell-mark__ring"
            cx={x}
            cy={z}
            r={TURBINE.ductOuterRadius - RING_STROKE / 2}
            strokeWidth={RING_STROKE}
          />
        </g>
      ))}
    </svg>
  );
}
