/**
 * One control in the controls panel: its name, its bindings as chips (click to change, ⚙ to
 * tune an axis, × to remove), "+ Add", "Default" and the capture prompt. OWNED BY THE INPUT
 * MODULE.
 */
import { IconClose, IconSliders, IconWarning } from '../../../engine';
import { isAnalogBinding, type AxisCal, type Binding, type BindingsConfig } from '../bindings';
import type { CaptureStep } from '../capture';
import { CONTROL_DEFS, type ControlId } from '../controls';
import { bindingName, directionWord } from '../labels';
import CaptureBox from './CaptureBox';
import TuneEditor from './TuneEditor';

export interface CaptureState {
  control: ControlId;
  /** The binding being changed, or null to add one. */
  replace: number | null;
  step: CaptureStep;
}

export interface BindingRowProps {
  id: ControlId;
  config: BindingsConfig;
  capture: CaptureState | null;
  tuning: number | null;
  conflict: boolean;
  isDefault: boolean;
  onCapture: (state: CaptureState | null) => void;
  onBinding: (binding: Binding) => void;
  onRemove: (index: number) => void;
  onTune: (index: number | null) => void;
  onCal: (index: number, cal: AxisCal) => void;
  onReset: () => void;
}

export default function BindingRow({
  id,
  config,
  capture,
  tuning,
  conflict,
  isDefault,
  onCapture,
  onBinding,
  onRemove,
  onTune,
  onCal,
  onReset,
}: BindingRowProps) {
  const def = CONTROL_DEFS[id];
  const list = config.controls[id];
  const capturing = capture?.control === id ? capture : null;
  const labelId = `a10in-${id}`;

  const stepFor = (b: Binding | null): CaptureStep => (b?.dir === -1 ? 'negative' : 'positive');

  return (
    <li className="a10in-row" data-testid={`binding-row-${id}`}>
      <span className="a10in-row__label" id={labelId}>
        {def.label}
        {conflict && (
          <span
            className="a10in-row__conflict"
            title="An input here is also bound to another control"
          >
            <IconWarning size={14} />
            <span className="fac-visually-hidden">Shares an input with another control</span>
          </span>
        )}
      </span>
      <span className="a10in-row__bindings" role="group" aria-labelledby={labelId}>
        {list.length === 0 && !capturing && <span className="a10in-unbound">Not bound</span>}
        {list.map((b, i) => {
          const analog = isAnalogBinding(b, def.kind);
          const dir = !analog ? directionWord(id, b.dir) : '';
          const name = bindingName(b, config);
          const active = capturing?.replace === i;
          return (
            <span
              key={i}
              className="a10in-chip"
              data-capturing={active ? '' : undefined}
              data-active={tuning === i ? '' : undefined}
            >
              <button
                type="button"
                className="a10in-chip__main"
                title={`Change ${name}`}
                aria-label={`${def.label}: ${name}${dir ? ` (${dir})` : ''}. Change`}
                onClick={() =>
                  onCapture(active ? null : { control: id, replace: i, step: stepFor(b) })
                }
              >
                {active ? 'Press…' : name}
                {dir && <span className="a10in-chip__dir">{dir}</span>}
              </button>
              {analog && (
                <button
                  type="button"
                  className="a10in-chip__icon"
                  title="Invert, dead zone, curve"
                  aria-label={`Tune ${name}`}
                  aria-expanded={tuning === i}
                  onClick={() => onTune(tuning === i ? null : i)}
                >
                  <IconSliders size={14} />
                </button>
              )}
              <button
                type="button"
                className="a10in-chip__icon"
                title="Remove"
                aria-label={`Remove ${name}`}
                onClick={() => onRemove(i)}
              >
                <IconClose size={12} />
              </button>
            </span>
          );
        })}
        <button
          type="button"
          className="a10in-add"
          data-testid={`binding-add-${id}`}
          onClick={() =>
            onCapture(
              capturing && capturing.replace === null
                ? null
                : { control: id, replace: null, step: 'positive' },
            )
          }
        >
          + Add
        </button>
        {!isDefault && (
          <button type="button" className="a10in-reset" onClick={onReset}>
            Default
          </button>
        )}
      </span>
      {capturing && (
        <div className="a10in-row__extra">
          <CaptureBox
            key={`${capturing.replace ?? 'add'}-${capturing.step}`}
            control={id}
            step={capturing.step}
            onBinding={onBinding}
            onCancel={() => onCapture(null)}
          />
        </div>
      )}
      {tuning !== null && list[tuning]?.cal && (
        <div className="a10in-row__extra">
          <TuneEditor
            binding={list[tuning]}
            kind={def.kind}
            onChange={(cal) => onCal(tuning, cal)}
          />
        </div>
      )}
    </li>
  );
}
