/**
 * Controls settings: mouse and key options, the live device tester and every binding (keys and
 * chords, mouse, wheel, gamepad, any stick/throttle/pedals) grouped like the aircraft, with
 * click-to-rebind, per-axis invert / dead zone / curve and reset to defaults. OWNED BY THE INPUT
 * MODULE; the UI mounts it inside its Settings dialog (it brings no dialog chrome of its own).
 *
 * Conflicts (bindings.ts): changing a binding to an input another control uses swaps the two;
 * adding one moves the input here. The notice line says what happened.
 */
import { useMemo, useState } from 'react';
import { SliderRow, ToggleRow } from '../../engine';
import { useA10Store } from '../state/store';
import {
  applyBinding,
  findConflicts,
  isAnalogBinding,
  isDefaultControl,
  removeBinding,
  resetControl,
  updateCal,
  type AxisCal,
  type Binding,
  type InputOptions,
} from './bindings';
import { getBindingsConfig, useBindings } from './bindingsStore';
import { CONTROL_DEFS, CONTROL_GROUPS, controlsInGroup, type ControlId } from './controls';
import { deviceIdentity } from './devices';
import { bindingName, sourceName } from './labels';
import BindingRow, { type CaptureState } from './panel/BindingRow';
import DeviceTester from './panel/DeviceTester';
import { usePadList } from './panel/usePads';
import './input.css';

interface Notice {
  text: string;
  level: 'info' | 'warn';
}

export default function ControlsPanel() {
  const config = useBindings((s) => s.config);
  const setConfig = useBindings((s) => s.setConfig);
  const resetAll = useBindings((s) => s.resetAll);
  const mouseStick = useA10Store((s) => s.settings.mouseStick);
  const invertY = useA10Store((s) => s.settings.invertY);
  const updateSettings = useA10Store((s) => s.updateSettings);
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const [tuning, setTuning] = useState<{ control: ControlId; index: number } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tester, setTester] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const pads = usePadList();
  const conflicts = useMemo(() => findConflicts(config), [config]);

  const setOption = <K extends keyof InputOptions>(key: K, value: InputOptions[K]) =>
    setConfig({ ...config, options: { ...config.options, [key]: value } });

  const onBinding = (binding: Binding) => {
    if (!capture) return;
    const { control, replace, step } = capture;
    const current = getBindingsConfig();
    const result = applyBinding(current, control, binding, replace);
    const name = bindingName(binding, current);
    const label = CONTROL_DEFS[control].label;
    if (result.duplicate) {
      setNotice({ text: `${name} is already bound to “${label}”.`, level: 'warn' });
    } else if (result.conflict) {
      const other = CONTROL_DEFS[result.conflict.control].label;
      const old = replace !== null ? current.controls[control][replace] : null;
      setNotice({
        level: 'warn',
        text:
          result.conflict.action === 'swapped' && old
            ? `${name} was used by “${other}”, which now has ${bindingName(old, current)}.`
            : `${name} was used by “${other}”, which no longer has it.`,
      });
    } else if (result.changed) {
      setNotice({ text: `“${label}”: ${name}.`, level: 'info' });
    }
    if (result.changed) setConfig(result.config);
    const kind = CONTROL_DEFS[control].kind;
    const digitalAxis =
      (kind === 'axis' || kind === 'lever') && !isAnalogBinding(binding, kind) && !result.duplicate;
    // keys and buttons on an axis come in pairs: ask for the other direction next
    if (replace === null && step === 'positive' && digitalAxis)
      setCapture({ control, replace: null, step: 'negative' });
    else setCapture(null);
  };

  const devices = pads.map((p) =>
    p.mapping === 'standard' ? `${deviceIdentity(p.id).name} (gamepad)` : deviceIdentity(p.id).name,
  );

  return (
    <div className="a10in-panel" data-testid="controls-panel">
      <p className="a10in-hint">
        Select an input to change it, or + Add for another. Keys may be combined with Ctrl or Alt;
        gamepad buttons with the shift layer (
        {sourceName(config.controls.padShift[0]?.src ?? { type: 'padButton', button: 6 })}). An
        input that another control already uses swaps places with it when you change a binding, and
        moves here when you add one. Esc cancels.
      </p>

      <h4 className="a10in-group__title">Mouse and keys</h4>
      <ToggleRow
        label="Mouse flies the stick"
        hint="Off: the mouse looks around. On: it moves a sprung stick; hold the right button to look."
        checked={mouseStick}
        onChange={(v) => updateSettings({ mouseStick: v })}
        testId="controls-mouse-stick"
      />
      <ToggleRow
        label="Invert look up / down"
        checked={invertY}
        onChange={(v) => updateSettings({ invertY: v })}
      />
      <SliderRow
        label="Mouse look speed"
        value={config.options.mouseLookSpeed}
        min={0.2}
        max={3}
        step={0.1}
        valueLabel={`${config.options.mouseLookSpeed.toFixed(1)}×`}
        onChange={(v) => setOption('mouseLookSpeed', v)}
      />
      <SliderRow
        label="Mouse stick speed"
        value={config.options.mouseStickSpeed}
        min={0.2}
        max={3}
        step={0.1}
        valueLabel={`${config.options.mouseStickSpeed.toFixed(1)}×`}
        onChange={(v) => setOption('mouseStickSpeed', v)}
      />
      <SliderRow
        label="Mouse stick centring"
        value={config.options.mouseStickSpring}
        min={0}
        max={1}
        step={0.05}
        valueLabel={
          config.options.mouseStickSpring === 0
            ? 'Off'
            : `${Math.round(config.options.mouseStickSpring * 100)} %`
        }
        onChange={(v) => setOption('mouseStickSpring', v)}
      />
      <SliderRow
        label="Keys: stick travel time"
        value={config.options.keyRampTime}
        min={0}
        max={1}
        step={0.05}
        valueLabel={`${config.options.keyRampTime.toFixed(2)} s`}
        onChange={(v) => setOption('keyRampTime', v)}
      />
      <SliderRow
        label="Keys: throttle idle to max"
        value={config.options.throttleKeyTime}
        min={0.5}
        max={8}
        step={0.5}
        valueLabel={`${config.options.throttleKeyTime.toFixed(1)} s`}
        onChange={(v) => setOption('throttleKeyTime', v)}
      />
      <ToggleRow
        label="Gamepad rumble when the gun fires"
        checked={config.options.rumble}
        onChange={(v) => setOption('rumble', v)}
      />

      <h4 className="a10in-group__title">Devices</h4>
      <ToggleRow
        label="Live device tester"
        hint={
          devices.length
            ? `Keyboard and mouse · ${devices.join(' · ')}`
            : 'Keyboard and mouse. Press a button on a gamepad, stick or throttle to show it.'
        }
        checked={tester}
        onChange={setTester}
        testId="controls-tester"
      />
      {tester && <DeviceTester />}

      {CONTROL_GROUPS.map((group) => (
        <section className="a10in-group" key={group.id} aria-labelledby={`a10in-g-${group.id}`}>
          <h4 className="a10in-group__title" id={`a10in-g-${group.id}`}>
            {group.title}
          </h4>
          <ul className="a10in-rows">
            {controlsInGroup(group.id).map((def) => (
              <BindingRow
                key={def.id}
                id={def.id}
                config={config}
                capture={capture}
                tuning={tuning?.control === def.id ? tuning.index : null}
                conflict={conflicts.has(def.id)}
                isDefault={isDefaultControl(config, def.id)}
                onCapture={(state) => {
                  setCapture(state);
                  setTuning(null);
                }}
                onBinding={onBinding}
                onRemove={(index) => {
                  setCapture(null);
                  setTuning(null);
                  const b = config.controls[def.id][index];
                  setConfig(removeBinding(config, def.id, index));
                  setNotice({
                    text: `${bindingName(b, config)} removed from “${def.label}”.`,
                    level: 'info',
                  });
                }}
                onTune={(index) => {
                  setCapture(null);
                  setTuning(index === null ? null : { control: def.id, index });
                }}
                onCal={(index, cal: AxisCal) => setConfig(updateCal(config, def.id, index, cal))}
                onReset={() => {
                  setCapture(null);
                  setTuning(null);
                  setConfig(resetControl(config, def.id));
                  setNotice({ text: `“${def.label}” back to its default.`, level: 'info' });
                }}
              />
            ))}
          </ul>
        </section>
      ))}

      <div className="a10in-foot">
        <p className="a10in-notice" role="status" data-level={notice?.level}>
          {notice?.text}
        </p>
        {confirmReset ? (
          <span className="settings-confirm">
            <span className="settings-confirm__text">Reset every control and option?</span>
            <button
              type="button"
              className="fac-btn settings-btn settings-btn--danger"
              data-testid="controls-reset-confirm"
              onClick={() => {
                setCapture(null);
                setTuning(null);
                resetAll();
                setConfirmReset(false);
                setNotice({ text: 'All controls are back to their defaults.', level: 'info' });
              }}
            >
              Reset
            </button>
            <button
              type="button"
              className="fac-btn fac-btn--ghost settings-btn"
              onClick={() => setConfirmReset(false)}
            >
              Keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="fac-btn fac-btn--ghost settings-btn"
            data-testid="controls-reset"
            onClick={() => setConfirmReset(true)}
          >
            Reset all controls
          </button>
        )}
      </div>
    </div>
  );
}
