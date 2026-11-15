/**
 * Row building blocks of the settings dialog: a labelled switch, a labelled slider with its
 * value, and a labelled select. Styles: settings.css (`settings-row`).
 */
import { useId, type ReactNode } from 'react';
import { Slider, Switch } from './controls';

export interface ToggleRowProps {
  label: string;
  /** One line under the label saying what the option does. */
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
}

export function ToggleRow({ label, hint, checked, onChange, testId }: ToggleRowProps) {
  const labelId = useId();
  return (
    <div className="settings-row">
      {/* the text is a click target too, like the label of a checkbox */}
      <div className="settings-row__text" onClick={() => onChange(!checked)}>
        <span className="settings-row__label" id={labelId}>
          {label}
        </span>
        {hint && <span className="settings-row__hint">{hint}</span>}
      </div>
      <Switch checked={checked} onChange={onChange} labelledBy={labelId} testId={testId} />
    </div>
  );
}

export interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** The value as shown next to the slider and announced, e.g. "80 %" or "16:30". */
  valueLabel: string;
  onChange: (value: number) => void;
  testId?: string;
}

export function SliderRow({ label, valueLabel, testId, ...slider }: SliderRowProps) {
  const id = useId();
  return (
    <div className="settings-row settings-row--slider">
      <label className="settings-row__label" htmlFor={id}>
        {label}
      </label>
      <Slider id={id} testId={testId} valueText={valueLabel} {...slider} />
      <output className="fac-readout settings-row__value" htmlFor={id}>
        {valueLabel}
      </output>
    </div>
  );
}

export interface SelectRowProps<T extends string> {
  label: string;
  hint?: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  testId?: string;
}

export function SelectRow<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  testId,
}: SelectRowProps<T>) {
  const id = useId();
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <label className="settings-row__label" htmlFor={id}>
          {label}
        </label>
        {hint && <span className="settings-row__hint">{hint}</span>}
      </div>
      <select
        id={id}
        className="settings-select fac-focusable"
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A titled block of rows. `id` is the scroll target of the dialog's section links. */
export function SettingsSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section" id={id} aria-labelledby={`${id}-title`}>
      <h3 className="settings-section__title" id={`${id}-title`}>
        {title}
      </h3>
      {children}
    </section>
  );
}
