/**
 * Top-down schematic of the ship for the turbine panel, bow up, drawn from the layout:
 * deck outline, island, pylons and the four ducts. Each duct shows its state (running,
 * near the limit, off), how hard it is working (fill) and which way its thrust leans
 * (the vector from its centre: toward the bow for positive tilt).
 */
import { DECK, HULL, ISLAND, TURBINE, TURBINE_MOUNTS, TURBINE_NAMES } from '../../config/layout';
import type { Telemetry } from '../../state/types';
import { DEG2RAD } from '../../utils/math';
import { gaugeState } from './attitude';

/** View box: carrier-local x → SVG x (starboard right), carrier-local z → SVG y (bow up). */
const VIEW = { x: -96, y: -176, width: 192, height: 352 } as const;
const DECK_POINTS = DECK.outline.map(([x, z]) => `${x},${z}`).join(' ');
/** Length of the thrust vector at the forward tilt limit, user units. */
const VECTOR_LENGTH = 44;

interface ShipSchematicProps {
  telemetry: Telemetry;
  /** Turbine the turbine camera is looking at, if that camera is active. */
  viewed: number | null;
}

export default function ShipSchematic({ telemetry, viewed }: ShipSchematicProps) {
  return (
    <svg
      className="tp-ship"
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`}
      role="img"
      aria-label="Ship from above, bow up, with the state of the four turbines"
      focusable="false"
    >
      <path className="tp-ship-bow" d="M0 -174 l-7 9 h14 z" />
      {TURBINE_MOUNTS.map(([x, , z], i) => (
        <line
          key={TURBINE_NAMES[i]}
          className="tp-ship-pylon"
          x1={Math.sign(x) * (HULL.beam / 2)}
          x2={x - Math.sign(x) * TURBINE.ductOuterRadius}
          y1={z}
          y2={z}
        />
      ))}
      <polygon className="tp-ship-deck" points={DECK_POINTS} />
      <rect
        className="tp-ship-island"
        x={ISLAND.centerX - ISLAND.width / 2}
        y={ISLAND.centerZ - ISLAND.length / 2}
        width={ISLAND.width}
        height={ISLAND.length}
      />
      {TURBINE_MOUNTS.map(([x, , z], i) => {
        const state = gaugeState(telemetry.enabled[i], telemetry.throttle[i]);
        const lean =
          Math.sin(telemetry.tiltDeg[i] * DEG2RAD) / Math.sin(TURBINE.tiltMaxDeg * DEG2RAD);
        return (
          <g
            key={TURBINE_NAMES[i]}
            className={`tp-ship-duct tp-ship-duct--${state}${viewed === i ? ' tp-ship-duct--viewed' : ''}`}
          >
            <circle className="tp-ship-ring" cx={x} cy={z} r={TURBINE.ductOuterRadius} />
            <circle
              className="tp-ship-fan"
              cx={x}
              cy={z}
              r={TURBINE.fanRadius - 2}
              fillOpacity={telemetry.enabled[i] ? 0.12 + 0.78 * telemetry.throttle[i] : 0}
            />
            <line className="tp-ship-vector" x1={x} y1={z} x2={x} y2={z - lean * VECTOR_LENGTH} />
            <text className="tp-ship-name" x={x} y={z + 6}>
              {TURBINE_NAMES[i]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
