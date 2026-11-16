/**
 * The live device tester of the controls panel: every connected gamepad, stick, throttle and
 * pedal set with its axes and buttons, and the keys and mouse buttons held. OWNED BY THE INPUT
 * MODULE.
 */
import { useEffect, useRef, useState } from 'react';
import { KeyCap } from '../../../engine';
import { deviceIdentity, hatDirOf, hatMask, isHatRest } from '../devices';
import { keyName, mouseName } from '../labels';
import { usePads } from './usePads';

const ARROW: Record<string, string> = { up: '↑', down: '↓', left: '←', right: '→' };

function AxisBar({ label, value, hat }: { label: string; value: number; hat: boolean }) {
  if (hat) {
    const dir = hatDirOf(hatMask(value));
    return (
      <div className="a10in-axis">
        <span>{label}</span>
        <span className="a10in-device__meta">hat {dir ? ARROW[dir] : 'centred'}</span>
        <span className="a10in-axis__value">{value.toFixed(2)}</span>
      </div>
    );
  }
  const v = Math.max(-1, Math.min(1, value));
  const left = v < 0 ? 50 + v * 50 : 50;
  const width = Math.abs(v) * 50;
  return (
    <div className="a10in-axis">
      <span>{label}</span>
      <div className="a10in-bar" data-centred="">
        <div className="a10in-bar__fill" style={{ left: `${left}%`, width: `${width}%` }} />
      </div>
      <span className="a10in-axis__value">{value.toFixed(2)}</span>
    </div>
  );
}

function useHeldInputs(): string[] {
  const [held, setHeld] = useState<string[]>([]);
  useEffect(() => {
    const set = new Set<string>();
    const publish = () => setHeld([...set]);
    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      set.add(keyName(e.code));
      publish();
    };
    const up = (e: KeyboardEvent) => {
      set.delete(keyName(e.code));
      publish();
    };
    const mdown = (e: MouseEvent) => {
      set.add(mouseName(e.button));
      publish();
    };
    const mup = (e: MouseEvent) => {
      set.delete(mouseName(e.button));
      publish();
    };
    const clear = () => {
      set.clear();
      publish();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('mousedown', mdown);
    window.addEventListener('mouseup', mup);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('mousedown', mdown);
      window.removeEventListener('mouseup', mup);
      window.removeEventListener('blur', clear);
    };
  }, []);
  return held;
}

export default function DeviceTester() {
  const pads = usePads(true, 30);
  const held = useHeldInputs();
  /** Axes that have rested outside -1..1 (hats), per device. */
  const hats = useRef(new Map<string, Set<number>>());
  for (const p of pads) {
    const key = `${p.id}#${p.index}`;
    let set = hats.current.get(key);
    if (!set) hats.current.set(key, (set = new Set()));
    p.axes.forEach((v, i) => {
      if (isHatRest(v)) set.add(i);
    });
  }

  return (
    <div className="a10in-devices" data-testid="device-tester">
      <div className="a10in-device">
        <div className="a10in-device__head">
          <span>Keyboard and mouse</span>
          <span className="a10in-device__meta">held now</span>
        </div>
        <div className="a10in-keys">
          {held.length === 0 ? 'Press keys or mouse buttons to see them here.' : null}
          {held.map((k) => (
            <KeyCap key={k}>{k}</KeyCap>
          ))}
        </div>
      </div>
      {pads.length === 0 && (
        <p className="a10in-hint">
          No gamepad, stick or throttle yet. Browsers show a controller only after one of its
          buttons is pressed: press a button on each device.
        </p>
      )}
      {pads.map((p) => {
        const ident = deviceIdentity(p.id);
        const hatSet = hats.current.get(`${p.id}#${p.index}`);
        return (
          <div className="a10in-device" key={`${p.index}-${p.id}`}>
            <div className="a10in-device__head">
              <span>{ident.name}</span>
              <span className="a10in-device__meta">
                {p.mapping === 'standard' ? 'Gamepad (standard layout)' : 'Device (own layout)'} ·
                slot {p.index + 1}
                {ident.key.includes(':') ? ` · ${ident.key}` : ''}
              </span>
            </div>
            <div className="a10in-device__axes">
              {p.axes.map((v, i) => (
                <AxisBar key={i} label={`A${i + 1}`} value={v} hat={hatSet?.has(i) ?? false} />
              ))}
            </div>
            <div className="a10in-device__buttons">
              {p.buttons.map((b, i) => (
                <span
                  key={i}
                  className="a10in-btn"
                  data-on={b.pressed || b.value > 0.5 ? '' : undefined}
                  title={`Button ${i + 1}: ${b.value.toFixed(2)}`}
                >
                  {i + 1}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
