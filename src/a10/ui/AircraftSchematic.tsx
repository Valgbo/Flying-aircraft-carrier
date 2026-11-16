/**
 * Top-down schematic of the A-10 and its eleven stations (station 1 left wing tip … 6 centreline
 * … 11 right wing tip), with what hangs on each drawn to scale on top of the wing. Hovering or
 * focusing a station highlights it here and in the station list beside it.
 */
import { A10_GEOMETRY } from '../data/geometry';
import { capsulePath, planformPaths, PLANFORM_BOUNDS } from './planform';
import { storeLabel, type StationView, type StoreCategory } from './loadout';

/** Drawing sizes of the stores (length, body width, fin span), m — a schematic, not data. */
const DRAW: Record<string, { length: number; width: number; fins: number }> = {
  missile: { length: 2.49, width: 0.3, fins: 0.72 },
  'MK-82': { length: 2.21, width: 0.27, fins: 0.38 },
  'MK-82AIR': { length: 2.39, width: 0.27, fins: 0.46 },
  'GBU-12': { length: 3.27, width: 0.27, fins: 0.5 },
  'CBU-97': { length: 2.34, width: 0.4, fins: 0.5 },
  rocket: { length: 1.7, width: 0.4, fins: 0 },
  'AN/AAQ-28': { length: 2.2, width: 0.41, fins: 0 },
  'AN/ALQ-184': { length: 3.95, width: 0.3, fins: 0 },
  'AIM-9M': { length: 2.87, width: 0.13, fins: 0.63 },
  'TER-9A': { length: 2.3, width: 0.22, fins: 0 },
  'LAU-117': { length: 2.0, width: 0.18, fins: 0 },
  'LAU-88': { length: 2.5, width: 0.42, fins: 0 },
};

function drawSize(type: string, category: StoreCategory) {
  return (
    DRAW[type] ??
    (category === 'missile' ? DRAW.missile : category === 'rocket' ? DRAW.rocket : undefined) ?? {
      length: 2.2,
      width: 0.3,
      fins: 0,
    }
  );
}

/** Lateral offsets of stores sharing a station (rack shoulders), m. */
function offsets(count: number, rack: string | null): number[] {
  if (count <= 1) return [0];
  const spread = rack === 'LAU-88' ? 0.32 : rack === 'TER-9A' ? 0.25 : 0.22;
  if (count === 2) return [-spread, spread];
  return [-spread, spread, 0];
}

function StoreGlyph({ type, x, z }: { type: string; x: number; z: number }) {
  const label = storeLabel(type);
  const d = drawSize(type, label.category);
  const tail = z + d.length / 2;
  const fins =
    d.fins > 0
      ? `M${x - d.fins / 2} ${tail - 0.05}L${x - d.width / 2} ${tail - 0.42}` +
        `L${x + d.width / 2} ${tail - 0.42}L${x + d.fins / 2} ${tail - 0.05}Z`
      : '';
  return (
    <g className={`a10-store a10-store--${label.category}`}>
      {fins && <path className="a10-store__fins" d={fins} />}
      <path className="a10-store__body" d={capsulePath(x, z, d.length, d.width)} />
      {type === 'AN/AAQ-28' && (
        <circle className="a10-store__ball" cx={x} cy={z - d.length / 2 + 0.18} r={0.17} />
      )}
      {label.category === 'rocket' && (
        <circle className="a10-store__ball" cx={x} cy={z - d.length / 2 + 0.3} r={0.1} />
      )}
    </g>
  );
}

const PAD = 0.5;
/** Station numbers sit in an evenly spaced row ahead of the aircraft, with leader lines. */
const BADGE_Y = PLANFORM_BOUNDS.minY - 1.35;
const BADGE_SPAN = 15.5;
const badgeX = (station: number) => -BADGE_SPAN / 2 + ((station - 1) * BADGE_SPAN) / 10;
const VIEW_MIN_Y = BADGE_Y - 0.9;
const VIEW = [
  PLANFORM_BOUNDS.minX - PAD,
  VIEW_MIN_Y,
  PLANFORM_BOUNDS.maxX - PLANFORM_BOUNDS.minX + 2 * PAD,
  PLANFORM_BOUNDS.maxY + PAD - VIEW_MIN_Y,
].join(' ');

export interface AircraftSchematicProps {
  stations: readonly StationView[];
  /** Highlighted station (1..11) or null. */
  active: number | null;
  onActive: (station: number | null) => void;
  /** Larger station numbers for small screens. */
  compact?: boolean;
}

export default function AircraftSchematic({
  stations,
  active,
  onActive,
  compact = false,
}: AircraftSchematicProps) {
  const p = planformPaths();
  const r = compact ? 0.62 : 0.5;
  return (
    <svg
      className="a10-schematic"
      viewBox={VIEW}
      role="img"
      aria-label="The aircraft from above with its eleven stations; station 1 is the left wing tip, 6 the centreline, 11 the right wing tip"
      data-active={active ?? undefined}
    >
      <g className="a10-schematic__airframe">
        <path d={p.wing} />
        <path d={p.tailplane} />
        <path d={p.gearPods} />
        <path d={p.fuselage} />
        <path d={p.gun} />
        <path d={p.nacelles} />
        <path d={p.fins} />
      </g>
      <path className="a10-schematic__lines" d={p.hinges} />
      <path className="a10-schematic__lines" d={p.nacelleRims} />
      <ellipse className="a10-schematic__canopy" {...p.canopy} />

      {stations.map((st) => {
        const pos = A10_GEOMETRY.stations[st.station];
        if (!pos) return null;
        const x = pos.x;
        const z = pos.z;
        const on = active === st.station;
        const empty = !st.rack && st.stores.length === 0;
        const bx = badgeX(st.station);
        const xs = offsets(st.stores.length, st.rack);
        return (
          <g
            key={st.station}
            className={`a10-station${on ? ' a10-station--active' : ''}${empty ? ' a10-station--empty' : ''}`}
            onPointerEnter={() => onActive(st.station)}
            onPointerLeave={() => onActive(null)}
          >
            <title>{`Station ${st.station}: ${st.label || 'empty'}`}</title>
            <path
              className="a10-station__leader"
              d={`M${bx} ${BADGE_Y + r}V${BADGE_Y + 1.1}L${x} ${BADGE_Y + 2.6}V${z - 0.75}`}
            />
            <rect
              className="a10-station__pylon"
              x={x - 0.09}
              y={z - 0.7}
              width={0.18}
              height={1.4}
              rx={0.05}
            />
            {st.rack && <StoreGlyph type={st.rack} x={x} z={z} />}
            {st.stores.map((s, i) => (
              <StoreGlyph key={i} type={s} x={x + (xs[i] ?? 0)} z={z} />
            ))}
            <circle className="a10-station__badge" cx={bx} cy={BADGE_Y} r={r} />
            <text
              className="a10-station__number"
              x={bx}
              y={BADGE_Y}
              dy="0.35em"
              textAnchor="middle"
              fontSize={r * 1.15}
            >
              {st.station}
            </text>
            {/* invisible hit areas: the number, and the column of the station on the wing */}
            <rect
              className="a10-station__hit"
              x={bx - 0.7}
              y={BADGE_Y - r - 0.2}
              width={1.4}
              height={2 * r + 0.4}
            />
            <rect className="a10-station__hit" x={x - 0.45} y={z - 2.2} width={0.9} height={4.4} />
          </g>
        );
      })}
    </svg>
  );
}
