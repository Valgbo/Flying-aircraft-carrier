/**
 * Form controls shared by the shell UI (hangar demo panel, settings dialog, menus):
 * a range slider, an on/off switch, preset chips and key caps. Styles: shell.css (`shell-`).
 */
import type { CSSProperties, PointerEvent } from 'react';
import type { CheatRow } from './cheatSheet';
import { rangeFraction, snapToStep } from './format';

/**
 * A slider keeps the keyboard focus after a click or drag, and would then swallow the arrow
 * keys that fly the ship. So when the pointer that grabbed it lets go, it gives focus up.
 * (Keyboard users are unaffected: they never press a pointer on it.)
 */
function blurOnRelease(e: PointerEvent<HTMLInputElement>): void {
  const input = e.currentTarget;
  const release = () => {
    window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointercancel', release, true);
    // after the browser has finished the release and reported the final value
    window.setTimeout(() => input.blur(), 0);
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
}

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  /**
   * Value the filled part of the track starts from (default: `min`). The tilt slider uses 0,
   * so the fill grows forward or aft from the hover position and a notch marks that position.
   */
  origin?: number;
  /** Spoken value, e.g. "16:30" instead of "16.5". */
  valueText?: string;
  id?: string;
  testId?: string;
  ariaLabel?: string;
  labelledBy?: string;
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  origin,
  valueText,
  id,
  testId,
  ariaLabel,
  labelledBy,
}: SliderProps) {
  const shown = snapToStep(value, min, max, step);
  const start = origin ?? min;
  const style = {
    '--shell-from': rangeFraction(Math.min(start, shown), min, max),
    '--shell-to': rangeFraction(Math.max(start, shown), min, max),
    '--shell-origin': rangeFraction(start, min, max),
  } as CSSProperties;
  return (
    <input
      type="range"
      className="shell-slider"
      id={id}
      data-testid={testId}
      data-origin={origin === undefined ? undefined : 'marked'}
      min={min}
      max={max}
      step={step}
      value={shown}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-valuetext={valueText}
      style={style}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerDown={blurOnRelease}
    />
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Id of the element that names the switch. */
  labelledBy: string;
  testId?: string;
}

/** An on/off switch (`role="switch"`). Wrap it in a <label> to make the whole row clickable. */
export function Switch({ checked, onChange, labelledBy, testId }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      className="shell-switch fac-focusable"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      data-testid={testId}
      onClick={() => onChange(!checked)}
    >
      <span className="shell-switch__thumb" aria-hidden="true" />
    </button>
  );
}

export interface Preset {
  label: string;
  value: number;
}

export interface PresetChipsProps {
  presets: readonly Preset[];
  /** The current value; a chip whose value matches it (within `tolerance`) shows as active. */
  value: number;
  tolerance: number;
  onSelect: (value: number) => void;
  /** Names the group for assistive tech, e.g. "Throttle presets". */
  ariaLabel: string;
}

export function PresetChips({ presets, value, tolerance, onSelect, ariaLabel }: PresetChipsProps) {
  return (
    <div className="shell-chips" role="group" aria-label={ariaLabel}>
      {presets.map((preset) => (
        <button
          key={preset.label}
          type="button"
          className="shell-chip fac-focusable"
          aria-pressed={Math.abs(preset.value - value) <= tolerance}
          onClick={() => onSelect(preset.value)}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}

export function KeyCap({ children }: { children: string }) {
  return <kbd className="shell-key">{children}</kbd>;
}

/** A compact grid of "key caps — what they do" rows (menu cheat-sheet, pause menu). */
export function KeyReference({ rows }: { rows: readonly CheatRow[] }) {
  return (
    <ul className="shell-keyref">
      {rows.map((row) => (
        <li key={row.label} className="shell-keyref__row">
          <span className="shell-keyref__keys">
            {row.keys.map((key, i) => (
              <KeyCap key={`${i}-${key}`}>{key}</KeyCap>
            ))}
          </span>
          <span className="shell-keyref__label">{row.label}</span>
        </li>
      ))}
    </ul>
  );
}
