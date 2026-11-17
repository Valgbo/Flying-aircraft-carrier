/**
 * Overhead plot of the impacts around one vehicle, in the vehicle's own frame (its front up):
 * the hull and turret outline to scale, every round that hit it coloured by what it did, the
 * bursts whose blast or fragments reached it (rings), and the near misses on the ground around
 * it in grey. Shape repeats the colour (circle, square, diamond, ring) so the classes read
 * without colour; each mark has a tooltip and the hit table beside the plot is its table view.
 */
import type { VehicleKind } from '../core/targets/types';
import { VEHICLE_SHAPES } from '../data/vehicles';
import { IMPACT_CLASS_LABEL, plotScale, type ImpactClass, type ImpactMark } from './debriefData';
import { formatClock } from './format';

const ORDER: readonly ImpactClass[] = ['penetrated', 'defeated', 'burst', 'fragments', 'ground'];

function Mark({ m, r }: { m: ImpactMark; r: number }) {
  const x = m.x;
  const y = -m.y;
  const title = `${IMPACT_CLASS_LABEL[m.cls]} · ${formatClock(m.t)}`;
  const cls = `a10-impact a10-impact--${m.cls}`;
  if (m.cls === 'defeated')
    return (
      <rect className={cls} x={x - r * 0.9} y={y - r * 0.9} width={r * 1.8} height={r * 1.8}>
        <title>{title}</title>
      </rect>
    );
  if (m.cls === 'burst')
    return (
      <path
        className={cls}
        d={`M${x} ${y - r * 1.25}L${x + r * 1.25} ${y}L${x} ${y + r * 1.25}L${x - r * 1.25} ${y}Z`}
      >
        <title>{title}</title>
      </path>
    );
  return (
    <circle className={cls} cx={x} cy={y} r={m.cls === 'ground' ? r * 0.75 : r}>
      <title>{title}</title>
    </circle>
  );
}

export default function ImpactPlot({
  kind,
  marks,
  label,
}: {
  kind: string;
  marks: readonly ImpactMark[];
  label: string;
}) {
  const shape = VEHICLE_SHAPES[kind as VehicleKind];
  const halfSize = shape ? Math.max(shape.hullLength, shape.hullWidth) / 2 : 4;
  const { radius: R, step } = plotScale(marks, halfSize);
  const r = R / 28;
  const ring = R / 70;
  const lines: number[] = [];
  for (let v = step; v < R; v += step) lines.push(v);
  // draw ground marks first, then misses, then the hits that did something on top
  const sorted = [...marks].sort((a, b) => ORDER.indexOf(b.cls) - ORDER.indexOf(a.cls));
  const counts = new Map<ImpactClass, number>();
  for (const m of marks) counts.set(m.cls, (counts.get(m.cls) ?? 0) + 1);

  return (
    <figure className="a10-plot">
      <svg
        className="a10-plot__svg"
        viewBox={`${-R} ${-R} ${2 * R} ${2 * R}`}
        role="img"
        aria-label={`${label}: ${marks.length} impacts plotted around the vehicle, its front up`}
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
        {shape && (
          <g className="a10-plot__vehicle">
            <rect
              x={-shape.hullWidth / 2}
              y={-shape.hullLength / 2}
              width={shape.hullWidth}
              height={shape.hullLength}
              rx={Math.min(0.3, shape.hullWidth / 8)}
            />
            {shape.cabLength && (
              <line
                x1={-shape.hullWidth / 2}
                x2={shape.hullWidth / 2}
                y1={-shape.hullLength / 2 + shape.cabLength}
                y2={-shape.hullLength / 2 + shape.cabLength}
              />
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
          </g>
        )}
        <g style={{ strokeWidth: ring }}>
          {sorted.map((m, i) => (
            <Mark key={i} m={m} r={r} />
          ))}
        </g>
        <text
          className="a10-plot__front"
          x={0}
          y={-R + R * 0.09}
          textAnchor="middle"
          fontSize={R * 0.075}
        >
          FRONT
        </text>
        <g className="a10-plot__scale">
          <line x1={R - step - R * 0.06} x2={R - R * 0.06} y1={R - R * 0.08} y2={R - R * 0.08} />
          <text
            x={R - step / 2 - R * 0.06}
            y={R - R * 0.12}
            textAnchor="middle"
            fontSize={R * 0.07}
          >
            {step} m
          </text>
        </g>
      </svg>
      <figcaption className="a10-plot__legend">
        {ORDER.filter((c) => counts.has(c)).map((c) => (
          <span key={c} className="a10-plot__key">
            <svg viewBox="-1 -1 2 2" width="10" height="10" aria-hidden="true">
              {c === 'fragments' ? (
                <circle className={`a10-impact a10-impact--${c}`} r={0.75} />
              ) : c === 'defeated' ? (
                <rect
                  className={`a10-impact a10-impact--${c}`}
                  x={-0.8}
                  y={-0.8}
                  width={1.6}
                  height={1.6}
                />
              ) : c === 'burst' ? (
                <path className={`a10-impact a10-impact--${c}`} d="M0 -1L1 0L0 1L-1 0Z" />
              ) : (
                <circle className={`a10-impact a10-impact--${c}`} r={0.85} />
              )}
            </svg>
            {IMPACT_CLASS_LABEL[c]} <span className="fac-readout">{counts.get(c)}</span>
          </span>
        ))}
        {marks.length === 0 && <span className="a10-plot__key">No impacts recorded</span>}
      </figcaption>
    </figure>
  );
}
