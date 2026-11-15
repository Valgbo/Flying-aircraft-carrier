/**
 * Settings — the modal settings dialog (rendered while `store.settingsOpen`): graphics, audio
 * and controls. Every value is read from and written to the store, which persists it.
 *
 * Escape closes the dialog through the `togglePause` action (src/state/coreActions.ts), which
 * the keyboard layer emits for the key bound to Pause. Only when the pilot has moved Pause
 * off the Escape key does this component close itself on Escape — never both.
 * Styles: shell/settings.css.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { QUALITY_ORDER } from '../config/quality';
import type { QualityLevel, TouchControlsSetting } from '../state/types';
import { useGameStore } from '../state/useGameStore';
import KeyBindingTable from './shell/KeyBindingTable';
import { TIME_SLIDER_MAX, TIME_SLIDER_STEP, formatPercent, formatTimeOfDay } from './shell/format';
import { IconClose } from './shell/icons';
import { SelectRow, SettingsSection, SliderRow, ToggleRow } from './shell/settingsRows';
import { useModalFocus } from './shell/useModalFocus';
import './shell/shell.css';
import './shell/settings.css';

const QUALITY_INFO: Record<QualityLevel, { label: string; description: string }> = {
  low: {
    label: 'Low',
    description: 'Fastest. No shadows or post-processing, a lighter sea and sky.',
  },
  medium: {
    label: 'Medium',
    description: 'Balanced. Shadows, bloom and anti-aliasing.',
  },
  high: {
    label: 'High',
    description: 'Everything on: sharpest shadows, heat haze, densest effects.',
  },
};

const TOUCH_OPTIONS: readonly { value: TouchControlsSetting; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

const SECTIONS = [
  { id: 'settings-graphics', title: 'Graphics' },
  { id: 'settings-audio', title: 'Audio' },
  { id: 'settings-controls', title: 'Controls' },
] as const;

export default function Settings() {
  const settings = useGameStore((s) => s.settings);
  const effectiveQuality = useGameStore((s) => s.effectiveQuality);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const resetSettings = useGameStore((s) => s.resetSettings);
  const setSettingsOpen = useGameStore((s) => s.setSettingsOpen);
  const [confirmReset, setConfirmReset] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const radioRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useModalFocus(dialogRef, { active: true, restoreFocus: true });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat) return;
      const state = useGameStore.getState();
      // with Pause on Escape the keyboard layer's togglePause action closes the dialog
      if (state.settings.keyBindings.togglePause === 'Escape') return;
      state.setSettingsOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Radio group: one tab stop, arrow keys move and select.
  const onQualityKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const count = QUALITY_ORDER.length;
    const index = QUALITY_ORDER.indexOf(settings.quality);
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % count;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + count) % count;
    else return;
    e.preventDefault();
    updateSettings({ quality: QUALITY_ORDER[next] });
    radioRefs.current[next]?.focus();
  };

  const adaptiveNote =
    effectiveQuality !== settings.quality
      ? `Running at ${QUALITY_INFO[effectiveQuality].label} right now to keep the frame rate up.`
      : 'Drops to a lower preset when the frame rate stays low.';

  return (
    <div
      className="settings-layer"
      onPointerDown={(e) => {
        // a press on the dimmed backdrop (not on the dialog) closes
        if (e.target === e.currentTarget) setSettingsOpen(false);
      }}
    >
      <div
        ref={dialogRef}
        className="settings fac-panel"
        data-testid="settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
      >
        <header className="settings-head">
          <h2 className="settings-title" id="settings-title">
            Settings
          </h2>
          <nav className="settings-nav" aria-label="Sections">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                className="settings-nav__link fac-focusable"
                onClick={() =>
                  document.getElementById(section.id)?.scrollIntoView({ block: 'start' })
                }
              >
                {section.title}
              </button>
            ))}
          </nav>
          <button
            type="button"
            className="settings-close fac-focusable"
            data-testid="settings-close"
            aria-label="Close settings"
            onClick={() => setSettingsOpen(false)}
          >
            <IconClose size={20} />
          </button>
        </header>

        <div className="settings-body">
          <SettingsSection id="settings-graphics" title="Graphics">
            <div
              className="settings-quality"
              role="radiogroup"
              aria-label="Quality preset"
              data-testid="settings-quality"
              onKeyDown={onQualityKeyDown}
            >
              {QUALITY_ORDER.map((level, i) => {
                const checked = level === settings.quality;
                return (
                  <button
                    key={level}
                    ref={(el) => {
                      radioRefs.current[i] = el;
                    }}
                    type="button"
                    role="radio"
                    className="settings-quality__option fac-focusable"
                    data-testid={`settings-quality-${level}`}
                    aria-checked={checked}
                    tabIndex={checked ? 0 : -1}
                    onClick={() => updateSettings({ quality: level })}
                  >
                    <span className="settings-quality__name">{QUALITY_INFO[level].label}</span>
                    <span className="settings-quality__desc">
                      {QUALITY_INFO[level].description}
                    </span>
                  </button>
                );
              })}
            </div>
            <ToggleRow
              label="Adaptive quality"
              hint={adaptiveNote}
              checked={settings.adaptiveQuality}
              onChange={(adaptiveQuality) => updateSettings({ adaptiveQuality })}
              testId="settings-adaptive"
            />
            <ToggleRow
              label="Camera shake"
              hint="Rumble from the turbines, hard landings and catapult shots."
              checked={settings.cameraShake}
              onChange={(cameraShake) => updateSettings({ cameraShake })}
              testId="settings-camera-shake"
            />
            <ToggleRow
              label="Show FPS"
              checked={settings.showFps}
              onChange={(showFps) => updateSettings({ showFps })}
              testId="settings-show-fps"
            />
            <SliderRow
              label="Time of day"
              value={settings.timeOfDay}
              min={0}
              max={TIME_SLIDER_MAX}
              step={TIME_SLIDER_STEP}
              valueLabel={formatTimeOfDay(settings.timeOfDay)}
              onChange={(timeOfDay) => updateSettings({ timeOfDay })}
              testId="settings-time"
            />
          </SettingsSection>

          <SettingsSection id="settings-audio" title="Audio">
            <SliderRow
              label="Master volume"
              value={settings.masterVolume * 100}
              min={0}
              max={100}
              step={1}
              valueLabel={formatPercent(settings.masterVolume)}
              onChange={(percent) => updateSettings({ masterVolume: percent / 100 })}
              testId="settings-volume-master"
            />
            <SliderRow
              label="Engines"
              value={settings.engineVolume * 100}
              min={0}
              max={100}
              step={1}
              valueLabel={formatPercent(settings.engineVolume)}
              onChange={(percent) => updateSettings({ engineVolume: percent / 100 })}
              testId="settings-volume-engine"
            />
            <SliderRow
              label="Effects"
              value={settings.effectsVolume * 100}
              min={0}
              max={100}
              step={1}
              valueLabel={formatPercent(settings.effectsVolume)}
              onChange={(percent) => updateSettings({ effectsVolume: percent / 100 })}
              testId="settings-volume-effects"
            />
            <ToggleRow
              label="Mute"
              hint="Silences everything without losing the levels above."
              checked={settings.muted}
              onChange={(muted) => updateSettings({ muted })}
              testId="settings-mute"
            />
          </SettingsSection>

          <SettingsSection id="settings-controls" title="Controls">
            <ToggleRow
              label="Invert Y"
              hint="Reverses the vertical axis of stick tilt and camera look."
              checked={settings.invertY}
              onChange={(invertY) => updateSettings({ invertY })}
              testId="settings-invert-y"
            />
            <SelectRow
              label="Touch controls"
              hint="Auto shows the on-screen stick and slider on touch devices."
              value={settings.touchControls}
              options={TOUCH_OPTIONS}
              onChange={(touchControls) => updateSettings({ touchControls })}
              testId="settings-touch"
            />
            <h4 className="settings-subtitle">Keyboard</h4>
            <KeyBindingTable />
          </SettingsSection>

          <footer className="settings-foot">
            {confirmReset ? (
              <div className="settings-confirm" role="group" aria-label="Reset all settings">
                <span className="settings-confirm__text">
                  Reset every setting and key to its default?
                </span>
                <button
                  type="button"
                  className="fac-btn settings-btn settings-btn--danger"
                  data-testid="settings-reset-confirm"
                  // the button that was focused is replaced by this group: keep focus in step
                  autoFocus
                  onClick={() => {
                    resetSettings();
                    setConfirmReset(false);
                  }}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="fac-btn fac-btn--ghost settings-btn"
                  data-testid="settings-reset-cancel"
                  onClick={() => setConfirmReset(false)}
                >
                  Keep
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="fac-btn fac-btn--ghost settings-btn"
                data-testid="settings-reset-all"
                onClick={() => setConfirmReset(true)}
              >
                Reset all settings
              </button>
            )}
          </footer>
        </div>
      </div>
    </div>
  );
}
