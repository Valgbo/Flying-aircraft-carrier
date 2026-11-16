/**
 * Calibration of one analogue binding: invert, dead zone, full-deflection point and curve, with
 * the response drawn as a graph and the device's live position on it. OWNED BY THE INPUT MODULE.
 */
import { useId, useState } from 'react';
import { Slider, Switch } from '../../../engine';
import type { AxisCal, Binding } from '../bindings';
import type { ControlKind } from '../controls';
import { shapeCentred, shapeLever, shapePressure, shapeStickAxis } from '../curves';
import {
  axisValue,
  buttonValue,
  deviceOrdinal,
  identityOf,
  isStandard,
  stickPartner,
  type PadLike,
} from '../devices';
import { readPads } from '../runtime';
import { useAnimationFrame } from './usePads';

export interface TuneEditorProps {
  binding: Binding;
  kind: ControlKind;
  onChange: (cal: AxisCal) => void;
}

type Mode = 'centred' | 'stick' | 'lever' | 'pressure';

function modeOf(b: Binding, kind: ControlKind): Mode {
  const s = b.src;
  if (s.type === 'padButton' || s.type === 'hidButton') return 'pressure';
  if (kind === 'lever' || kind === 'trigger') return 'lever';
  return s.type === 'padAxis' && stickPartner(s.axis) >= 0 ? 'stick' : 'centred';
}

/** Output for an input along the graph's x axis (-1..1, or 0..1 for pressure). */
function response(mode: Mode, x: number, cal: AxisCal): number {
  switch (mode) {
    case 'centred':
      return shapeCentred(x, cal);
    case 'stick':
      return shapeStickAxis(x, 0, cal);
    case 'lever':
      return shapeLever(x, cal);
    case 'pressure':
      return shapePressure(x, cal);
  }
}

/** The device this binding reads, and its raw value(s) now. */
function readLive(b: Binding): { raw: number; partner: number } | null {
  const pads = readPads();
  const s = b.src;
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i] as PadLike | null;
    if (!pad || !pad.connected) continue;
    if (s.type === 'padAxis' || s.type === 'padButton') {
      if (!isStandard(pad)) continue;
    } else if (s.type === 'hidAxis' || s.type === 'hidButton') {
      if (identityOf(pad.id).key !== s.device.key || deviceOrdinal(pads, i) !== s.device.ordinal)
        continue;
    } else return null;
    if (s.type === 'padButton' || s.type === 'hidButton')
      return { raw: buttonValue(pad, s.button), partner: 0 };
    const partner = s.type === 'padAxis' ? stickPartner(s.axis) : -1;
    return {
      raw: axisValue(pad, s.axis),
      partner: partner >= 0 ? axisValue(pad, partner) : 0,
    };
  }
  return null;
}

const W = 132;
const PAD_PX = 8;

export default function TuneEditor({ binding, kind, onChange }: TuneEditorProps) {
  const cal = binding.cal!;
  const mode = modeOf(binding, kind);
  const [live, setLive] = useState<{ raw: number; partner: number } | null>(null);
  const ids = { invert: useId(), dz: useId(), sat: useId(), curve: useId() };

  useAnimationFrame(true, () => {
    const v = readLive(binding);
    setLive((prev) =>
      prev === v ||
      (prev &&
        v &&
        Math.abs(prev.raw - v.raw) < 0.002 &&
        Math.abs(prev.partner - v.partner) < 0.002)
        ? prev
        : v,
    );
  });

  const xMin = mode === 'pressure' ? 0 : -1;
  const yMin = mode === 'centred' || mode === 'stick' ? -1 : 0;
  const sx = (x: number) => PAD_PX + ((x - xMin) / (1 - xMin)) * (W - 2 * PAD_PX);
  const sy = (y: number) => W - PAD_PX - ((y - yMin) / (1 - yMin)) * (W - 2 * PAD_PX);
  const points: string[] = [];
  for (let i = 0; i <= 64; i++) {
    const x = xMin + ((1 - xMin) * i) / 64;
    points.push(`${sx(x).toFixed(1)},${sy(response(mode, x, cal)).toFixed(1)}`);
  }
  let liveOut: number | null = null;
  if (live) {
    liveOut =
      mode === 'stick'
        ? shapeStickAxis(live.raw, live.partner, cal)
        : response(mode, live.raw, cal);
  }

  const set = (patch: Partial<AxisCal>) => onChange({ ...cal, ...patch });
  const centred = mode === 'centred' || mode === 'stick';

  return (
    <div className="a10in-tune" data-testid="tune-editor">
      <div className="a10in-tune__rows">
        <label className="a10in-tune__row">
          <span id={`${ids.invert}-l`}>Invert</span>
          <span>
            <Switch
              checked={cal.invert}
              onChange={(invert) => set({ invert })}
              labelledBy={`${ids.invert}-l`}
            />
          </span>
          <span />
        </label>
        <div className="a10in-tune__row">
          <label htmlFor={ids.dz}>{centred ? 'Dead zone' : 'Idle dead zone'}</label>
          <Slider
            id={ids.dz}
            value={cal.deadZone}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(deadZone) =>
              set({ deadZone, saturation: Math.max(cal.saturation, Math.min(1, deadZone + 0.05)) })
            }
          />
          <span className="a10in-tune__value">{Math.round(cal.deadZone * 100)} %</span>
        </div>
        <div className="a10in-tune__row">
          <label htmlFor={ids.sat}>Full at</label>
          <Slider
            id={ids.sat}
            value={cal.saturation}
            min={0.5}
            max={1}
            step={0.01}
            onChange={(saturation) =>
              set({ saturation: Math.max(saturation, cal.deadZone + 0.05) })
            }
          />
          <span className="a10in-tune__value">{Math.round(cal.saturation * 100)} %</span>
        </div>
        {centred && (
          <div className="a10in-tune__row">
            <label htmlFor={ids.curve}>Curve</label>
            <Slider
              id={ids.curve}
              value={cal.curve}
              min={0}
              max={1}
              step={0.05}
              onChange={(curve) => set({ curve })}
            />
            <span className="a10in-tune__value">
              {cal.curve === 0 ? 'Linear' : `${Math.round(cal.curve * 100)} %`}
            </span>
          </div>
        )}
        <p className="a10in-hint" style={{ margin: 0 }}>
          {live
            ? `Device: ${live.raw.toFixed(2)} → ${liveOut === null ? '—' : liveOut.toFixed(2)}`
            : 'Move the device to see its position on the graph.'}
        </p>
      </div>
      <svg
        className="a10in-graph"
        viewBox={`0 0 ${W} ${W}`}
        role="img"
        aria-label="Response: device position across, output up"
      >
        <line className="a10in-graph__axis" x1={sx(xMin)} y1={sy(0)} x2={sx(1)} y2={sy(0)} />
        {xMin < 0 && (
          <line className="a10in-graph__axis" x1={sx(0)} y1={sy(yMin)} x2={sx(0)} y2={sy(1)} />
        )}
        <polyline className="a10in-graph__curve" points={points.join(' ')} />
        {live && liveOut !== null && (
          <circle
            className="a10in-graph__point"
            cx={sx(Math.max(xMin, Math.min(1, live.raw)))}
            cy={sy(liveOut)}
            r={4}
          />
        )}
      </svg>
    </div>
  );
}
