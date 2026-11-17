/**
 * Overhead plot of one pass (PLAN_A10.md §11.4): every impact of the pass around its target,
 * drawn with the RUN-IN UP, so a long bomb is above the target and a short one below, as a
 * range scores it. The target's outline is drawn to scale at its heading, with a tick on its
 * front; the cross is where the pilot aimed (the gun's pipper or the store's aim point); the
 * bombing circle adds its score rings and clock. Rounds are small marks coloured by what they
 * did (shape repeats the colour); stores are larger, numbered in release order.
 */
import type { VehicleKind } from '../core/targets/types';
import { VEHICLE_SHAPES } from '../data/vehicles';
import { IMPACT_CLASS_LABEL, type ImpactClass } from './debriefData';
import type { PassMark, PassPlotModel } from './debriefModel';
import { formatClock } from './format';

type MarkClass = PassMark['cls'];

const ROUND_ORDER: readonly ImpactClass[] = [
  'ground',
  'fragments',
  'defeated',
  'burst',
  'penetrated',
];
const STORE_LABEL: Record<Exclude<MarkClass, ImpactClass>, string> = {
  bomb: 'Bomb',
  rocket: 'Rocket',
  missile: 'Missile',
  smoke: 'Smoke rocket',
  dud: 'Dud',
  simulated: 'Simulated release (TRAIN)',
};
const LEGEND_ORDER: readonly MarkClass[] = [
  'penetrated',
  'burst',
  'defeated',
  'fragments',
  'ground',
  'bomb',
  'rocket',
  'missile',
  'smoke',
  'dud',
  'simulated',
];

function isStore(cls: MarkClass): cls is Exclude<MarkClass, ImpactClass> {
  return cls in STORE_LABEL;
}

function classLabel(cls: MarkClass): string {
  return isStore(cls) ? STORE_LABEL[cls] : IMPACT_CLASS_LABEL[cls];
}

/** One mark's glyph at (x, y) in SVG units (y down). */
function Glyph({ cls, x, y, r }: { cls: MarkClass; x: number; y: number; r: number }) {
  const c = `a10-impact a10-impact--${cls}`;
  switch (cls) {
    case 'defeated':
      return (
        <rect className={c} x={x - r * 0.9} y={y - r * 0.9} width={r * 1.8} height={r * 1.8} />
      );
    case 'burst':
      return (
        <path
          className={c}
          d={`M${x} ${y - r * 1.25}L${x + r * 1.25} ${y}L${x} ${y + r * 1.25}L${x - r * 1.25} ${y}Z`}
        />
      );
    case 'fragments':
      return <circle className={c} cx={x} cy={y} r={r} />;
    case 'rocket':
      return (
        <path
          className={c}
          d={`M${x} ${y - r * 1.2}L${x + r * 1.1} ${y + r * 0.9}L${x - r * 1.1} ${y + r * 0.9}Z`}
        />
      );
    case 'missile':
      return (
        <path
          className={c}
          d={`M${x} ${y - r * 1.3}L${x + r * 0.45} ${y - r * 0.45}L${x + r * 1.3} ${y}L${x + r * 0.45} ${y + r * 0.45}L${x} ${y + r * 1.3}L${x - r * 0.45} ${y + r * 0.45}L${x - r * 1.3} ${y}L${x - r * 0.45} ${y - r * 0.45}Z`}
        />
      );
    case 'simulated':
      return <circle className={c} cx={x} cy={y} r={r} />;
    case 'dud':
      return (
        <g className={c}>
          <circle cx={x} cy={y} r={r} />
          <path
            d={`M${x - r * 0.6} ${y - r * 0.6}L${x + r * 0.6} ${y + r * 0.6}M${x + r * 0.6} ${y - r * 0.6}L${x - r * 0.6} ${y + r * 0.6}`}
          />
        </g>
      );
    default:
      return <circle className={c} cx={x} cy={y} r={cls === 'ground' ? r * 0.75 : r} />;
  }
}

function Target({ kind, rotation }: { kind: string; rotation: number }) {
  const shape = VEHICLE_SHAPES[kind as VehicleKind];
  if (!shape) return null;
  const L = shape.hullLength;
  const W = shape.hullWidth;
  const deg = (rotation * 180) / Math.PI;
  const tick = Math.max(L, W) * 0.22;
  return (
    <g className="a10-plot__vehicle" transform={`rotate(${deg})`}>
      <rect x={-W / 2} y={-L / 2} width={W} height={L} rx={Math.min(0.3, W / 8)} />
      {shape.cabLength && (
        <line x1={-W / 2} x2={W / 2} y1={-L / 2 + shape.cabLength} y2={-L / 2 + shape.cabLength} />
      )}
      {shape.turret && <circle cx={0} cy={shape.turret.offsetZ} r={shape.turret.radius} />}
      {shape.turret && shape.gunLength > 0 && (
        <line
          x1={0}
          x2={0}
          y1={shape.turret.offsetZ - shape.turret.radius}
          y2={shape.turret.offsetZ - shape.turret.radius - shape.gunLength}
        />
      )}
      {/* the front: a tick beyond the bow */}
      <line className="a10-plot__bow" x1={0} x2={0} y1={-L / 2} y2={-L / 2 - tick} />
    </g>
  );
}

export default function PassPlot({ plot, label }: { plot: PassPlotModel; label: string }) {
  const R = plot.radius;
  const lines: number[] = [];
  for (let v = plot.step; v < R; v += plot.step) lines.push(v);
  const rRound = R / 46;
  const rStore = R / 24;
  const font = R * 0.062;
  const sorted = [...plot.marks].sort((a, b) => rank(a.cls) - rank(b.cls));
  const counts = new Map<MarkClass, number>();
  for (const m of plot.marks) counts.set(m.cls, (counts.get(m.cls) ?? 0) + 1);
  const outer = plot.rings.length ? plot.rings[plot.rings.length - 1] : 0;

  return (
    <figure className="a10-plot a10-plot--pass">
      <svg
        className="a10-plot__svg"
        viewBox={`${-R} ${-R} ${2 * R} ${2 * R}`}
        role="img"
        aria-label={`${label}: ${plot.marks.length} impacts around ${plot.target?.name ?? 'the aim point'}, run-in up`}
      >
        <rect className="a10-plot__bg" x={-R} y={-R} width={2 * R} height={2 * R} />
        {lines.map((v) => (
          <g key={v} className="a10-plot__grid">
            <line x1={v} y1={-R} x2={v} y2={R} />
            <line x1={-v} y1={-R} x2={-v} y2={R} />
            <line x1={-R} y1={v} x2={R} y2={v} />
            <line x1={-R} y1={-v} x2={R} y2={-v} />
          </g>
        ))}
        <line className="a10-plot__axis" x1={0} y1={-R} x2={0} y2={R} />
        <line className="a10-plot__axis" x1={-R} y1={0} x2={R} y2={0} />
        {plot.rings.map((ring) => (
          <g key={ring} className="a10-plot__ring">
            <circle cx={0} cy={0} r={ring} />
            <text x={ring * 0.71 + font * 0.2} y={-ring * 0.71 - font * 0.2} fontSize={font * 0.85}>
              {ring} m
            </text>
          </g>
        ))}
        {outer > 0 &&
          (
            [
              ['12', 0, -1],
              ['3', 1, 0],
              ['6', 0, 1],
              ['9', -1, 0],
            ] as const
          ).map(([t, x, y]) => (
            <text
              key={t}
              className="a10-plot__clock"
              x={x * (outer + font * 0.9)}
              y={y * (outer + font * 0.9) + font * 0.35}
              textAnchor="middle"
              fontSize={font}
            >
              {t}
            </text>
          ))}
        {plot.target && <Target kind={plot.target.kind} rotation={plot.target.rotation} />}
        {plot.aim && (
          <g className="a10-plot__aim">
            <circle cx={plot.aim.x} cy={-plot.aim.y} r={rStore * 0.9} />
            <line
              x1={plot.aim.x - rStore * 1.6}
              x2={plot.aim.x + rStore * 1.6}
              y1={-plot.aim.y}
              y2={-plot.aim.y}
            />
            <line
              x1={plot.aim.x}
              x2={plot.aim.x}
              y1={-plot.aim.y - rStore * 1.6}
              y2={-plot.aim.y + rStore * 1.6}
            />
          </g>
        )}
        <g style={{ strokeWidth: R / 90 }}>
          {sorted.map((m, i) => {
            const store = isStore(m.cls);
            return (
              <g key={i}>
                <Glyph cls={m.cls} x={m.x} y={-m.y} r={store ? rStore : rRound} />
                {store && m.label && (
                  <text
                    className="a10-plot__label"
                    x={m.x + rStore * 1.3}
                    y={-m.y - rStore * 1.1}
                    fontSize={font * 0.9}
                  >
                    {m.label}
                  </text>
                )}
                <title>{`${classLabel(m.cls)}${m.label ? ` ${m.label}` : ''} · ${formatClock(m.t)}`}</title>
              </g>
            );
          })}
        </g>
        {/* the run-in: an arrow up from the bottom edge */}
        <g className="a10-plot__runin">
          <line x1={-R * 0.86} x2={-R * 0.86} y1={R * 0.92} y2={R * 0.7} />
          <path
            d={`M${-R * 0.86} ${R * 0.66}L${-R * 0.885} ${R * 0.72}L${-R * 0.835} ${R * 0.72}Z`}
          />
          <text x={-R * 0.83} y={R * 0.92} fontSize={font * 0.85}>
            RUN-IN
          </text>
        </g>
        <g className="a10-plot__scale">
          <line
            x1={R - plot.step - R * 0.06}
            x2={R - R * 0.06}
            y1={R - R * 0.08}
            y2={R - R * 0.08}
          />
          <text
            x={R - plot.step / 2 - R * 0.06}
            y={R - R * 0.12}
            textAnchor="middle"
            fontSize={font}
          >
            {plot.step} m
          </text>
        </g>
      </svg>
      <figcaption className="a10-plot__legend">
        {LEGEND_ORDER.filter((c) => counts.has(c)).map((c) => (
          <span key={c} className="a10-plot__key">
            <svg viewBox="-1.4 -1.4 2.8 2.8" width="11" height="11" aria-hidden="true">
              <g style={{ strokeWidth: 0.2 }}>
                <Glyph cls={c} x={0} y={0} r={0.95} />
              </g>
            </svg>
            {classLabel(c)} <span className="fac-readout">{counts.get(c)}</span>
          </span>
        ))}
        {plot.aim && (
          <span className="a10-plot__key">
            <svg viewBox="-1.4 -1.4 2.8 2.8" width="11" height="11" aria-hidden="true">
              <g className="a10-plot__aim" style={{ strokeWidth: 0.25 }}>
                <circle r={0.7} />
                <line x1={-1.3} x2={1.3} y1={0} y2={0} />
                <line x1={0} x2={0} y1={-1.3} y2={1.3} />
              </g>
            </svg>
            {plot.rings.length ? "Bull's-eye" : 'Aim point'}
          </span>
        )}
        {plot.outside > 0 && (
          <span className="a10-plot__key">
            <span className="fac-readout">{plot.outside}</span> beyond the plot
          </span>
        )}
        {plot.marks.length === 0 && <span className="a10-plot__key">No impacts recorded</span>}
      </figcaption>
    </figure>
  );
}

/** Draw order: ground first, then what did more, stores on top. */
function rank(cls: MarkClass): number {
  const i = ROUND_ORDER.indexOf(cls as ImpactClass);
  return i >= 0 ? i : ROUND_ORDER.length + 1;
}
