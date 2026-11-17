/**
 * Settings dialog (store.settingsOpen): graphics, sound, realism (with the table of what each
 * preset changes, PLAN_A10.md §2), flying, world and the input module's controls panel. Every
 * value is read from and written to the A-10 store, which saves it under `a10-settings-v1`.
 * Escape closes it (UIRoot), and during a flight also resumes it.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  formatPercent,
  formatTimeOfDay,
  IconClose,
  SettingsSection,
  SliderRow,
  ToggleRow,
  useModalFocus,
} from '../../engine';
import type { RealismPreset } from '../core/types';
import ControlsPanel from '../input/ControlsPanel';
import { DEFAULT_SETTINGS, useA10Store, type QualityLevel } from '../state/store';
import RealismTable from './RealismTable';
import { REALISM_INFO, REALISM_PRESETS } from './realism';
import { useScrollEdges } from './TableWrap';
import { useA10Ui } from './uiStore';

const QUALITY: readonly { level: QualityLevel; label: string; description: string }[] = [
  {
    level: 'low',
    label: 'Low',
    description: 'Fastest: short draw distance, few trees and particles.',
  },
  { level: 'medium', label: 'Medium', description: 'Balanced: 60 fps on a mid-range laptop.' },
  {
    level: 'high',
    label: 'High',
    description: 'Everything on: far terrain, shadows, sharp sensors.',
  },
];

const SECTIONS = [
  { id: 'a10-set-graphics', title: 'Graphics' },
  { id: 'a10-set-sound', title: 'Sound' },
  { id: 'a10-set-realism', title: 'Realism' },
  { id: 'a10-set-flying', title: 'Flying' },
  { id: 'a10-set-world', title: 'World' },
  { id: 'a10-set-controls', title: 'Controls' },
] as const;

/** Day only in version 1 (PLAN §10). */
const TIME_MIN = 6;
const TIME_MAX = 18;
const SEED_MAX = 2 ** 31;

export default function SettingsDialog() {
  const settings = useA10Store((s) => s.settings);
  const inFlight = useA10Store((s) => s.screen === 'flight');
  const updateSettings = useA10Store((s) => s.updateSettings);
  const setSettingsOpen = useA10Store((s) => s.setSettingsOpen);
  const [seedText, setSeedText] = useState(String(settings.worldSeed));
  const [confirmReset, setConfirmReset] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  // on a phone the section links scroll sideways: fade the edge that hides some
  useScrollEdges(navRef);

  // Scroll the body only: scrollIntoView would also scroll the dialog box itself (an
  // overflow: hidden element is still scrollable from script) and push its header away.
  const scrollToSection = (id: string) => {
    const body = bodyRef.current;
    const section = document.getElementById(id);
    if (!body || !section) return;
    body.scrollTop += section.getBoundingClientRect().top - body.getBoundingClientRect().top;
  };

  useModalFocus(dialogRef, { active: true, restoreFocus: true });

  // opened for one section (the menu's realism chip): start there
  useEffect(() => {
    const ui = useA10Ui.getState();
    if (!ui.settingsSection) return;
    scrollToSection(ui.settingsSection);
    ui.setSettingsSection(null);
  }, []);

  const nextFlight = inFlight ? 'Applies from the next flight.' : undefined;

  const commitSeed = (e?: FormEvent) => {
    e?.preventDefault();
    const n = Number(seedText.trim());
    if (Number.isInteger(n) && n >= 0 && n <= SEED_MAX) updateSettings({ worldSeed: n });
    else setSeedText(String(useA10Store.getState().settings.worldSeed));
  };

  const newSeed = () => {
    const n = Math.floor(Math.random() * 1_000_000);
    setSeedText(String(n));
    updateSettings({ worldSeed: n });
  };

  return (
    <div
      className="a10-dialog-layer"
      onPointerDown={(e) => {
        // a press on the dimmed backdrop (not on the dialog) closes it
        if (e.target === e.currentTarget) setSettingsOpen(false);
      }}
    >
      <div
        ref={dialogRef}
        className="a10-dialog fac-panel"
        data-testid="a10-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="a10-settings-title"
        tabIndex={-1}
      >
        <header className="a10-dialog__head">
          <h2 className="a10-dialog__title" id="a10-settings-title">
            Settings
          </h2>
          <nav className="a10-dialog__nav" aria-label="Sections" ref={navRef}>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className="settings-nav__link fac-focusable"
                onClick={() => scrollToSection(s.id)}
              >
                {s.title}
              </button>
            ))}
          </nav>
          <button
            type="button"
            className="settings-close fac-focusable"
            data-testid="a10-settings-close"
            aria-label="Close settings"
            onClick={() => setSettingsOpen(false)}
          >
            <IconClose size={20} />
          </button>
        </header>

        <div className="a10-dialog__body" ref={bodyRef}>
          <SettingsSection id="a10-set-graphics" title="Graphics">
            <div
              className="a10-choices a10-choices--row"
              role="radiogroup"
              aria-label="Quality preset"
            >
              {QUALITY.map((q) => (
                <label
                  key={q.level}
                  className="a10-choice"
                  data-testid={`a10-set-quality-${q.level}`}
                >
                  <input
                    type="radio"
                    name="a10-quality"
                    value={q.level}
                    checked={settings.quality === q.level}
                    onChange={() => updateSettings({ quality: q.level })}
                  />
                  <span className="a10-choice__name">{q.label}</span>
                  <span className="a10-choice__desc">{q.description}</span>
                </label>
              ))}
            </div>
            <ToggleRow
              label="Automatic downgrade"
              hint="One preset lower when the frame rate stays under 45 fps for three seconds."
              checked={settings.adaptiveQuality}
              onChange={(adaptiveQuality) => updateSettings({ adaptiveQuality })}
              testId="a10-set-adaptive"
            />
            <ToggleRow
              label="FPS counter"
              hint="A small frame-rate readout in the top right corner."
              checked={settings.showFps}
              onChange={(showFps) => updateSettings({ showFps })}
              testId="a10-set-fps"
            />
          </SettingsSection>

          <SettingsSection id="a10-set-sound" title="Sound">
            <SliderRow
              label="Volume"
              value={settings.volume * 100}
              min={0}
              max={100}
              step={1}
              valueLabel={formatPercent(settings.volume)}
              onChange={(v) => updateSettings({ volume: v / 100 })}
              testId="a10-set-volume"
            />
            <ToggleRow
              label="Mute"
              hint="Silences everything and keeps the volume."
              checked={settings.muted}
              onChange={(muted) => updateSettings({ muted })}
              testId="a10-set-mute"
            />
          </SettingsSection>

          <SettingsSection id="a10-set-realism" title="Realism">
            <div
              className="a10-choices a10-choices--row"
              role="radiogroup"
              aria-label="Realism preset"
            >
              {REALISM_PRESETS.map((p: RealismPreset) => (
                <label key={p} className="a10-choice" data-testid={`a10-set-realism-${p}`}>
                  <input
                    type="radio"
                    name="a10-realism"
                    value={p}
                    checked={settings.realism === p}
                    onChange={() => updateSettings({ realism: p })}
                  />
                  <span className="a10-choice__name">{REALISM_INFO[p].label}</span>
                  <span className="a10-choice__desc">{REALISM_INFO[p].summary}</span>
                </label>
              ))}
            </div>
            <RealismTable selected={settings.realism} />
            <p className="a10-note">
              In every preset the optional checklist strip names the next real step.
              {nextFlight && ` ${nextFlight}`}
            </p>
          </SettingsSection>

          <SettingsSection id="a10-set-flying" title="Flying">
            <ToggleRow
              label="Checklist strip"
              hint="One line at the top naming the next step toward firing the current weapon."
              checked={settings.checklist}
              onChange={(checklist) => updateSettings({ checklist })}
              testId="a10-set-checklist"
            />
            {/* "Mouse flies the stick" and "Invert Y" are in the Controls section below, with the
                other mouse options of the input module's panel */}
            <SliderRow
              label="Cockpit field of view"
              value={settings.fov}
              min={40}
              max={100}
              step={1}
              valueLabel={`${Math.round(settings.fov)}°`}
              onChange={(fov) => updateSettings({ fov })}
              testId="a10-set-fov"
            />
          </SettingsSection>

          <SettingsSection id="a10-set-world" title="World">
            <SliderRow
              label="Time of day"
              value={settings.timeOfDay}
              min={TIME_MIN}
              max={TIME_MAX}
              step={0.25}
              valueLabel={formatTimeOfDay(settings.timeOfDay)}
              onChange={(timeOfDay) => updateSettings({ timeOfDay })}
              testId="a10-set-time"
            />
            <form className="settings-row a10-seed" onSubmit={commitSeed}>
              <div className="settings-row__text">
                <label className="settings-row__label" htmlFor="a10-seed-input">
                  World seed
                </label>
                <span className="settings-row__hint">
                  The range is generated from this number. Time of day and seed apply from the next
                  flight.
                </span>
              </div>
              <div className="a10-seed__controls">
                <input
                  id="a10-seed-input"
                  className="a10-input fac-readout fac-focusable"
                  data-testid="a10-set-seed"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  value={seedText}
                  onChange={(e) => setSeedText(e.target.value.replace(/[^0-9]/g, '').slice(0, 10))}
                  onBlur={() => commitSeed()}
                />
                <button
                  type="button"
                  className="fac-btn fac-btn--ghost a10-btn-small"
                  onClick={newSeed}
                >
                  New
                </button>
              </div>
            </form>
          </SettingsSection>

          <SettingsSection id="a10-set-controls" title="Controls">
            <ControlsPanel />
          </SettingsSection>

          <footer className="a10-dialog__foot">
            {confirmReset ? (
              <div className="a10-confirm" role="group" aria-label="Reset all settings">
                <span>Reset every setting to its default?</span>
                <button
                  type="button"
                  className="fac-btn a10-btn-small a10-btn--danger"
                  data-testid="a10-settings-reset-confirm"
                  autoFocus
                  onClick={() => {
                    updateSettings({ ...DEFAULT_SETTINGS });
                    setSeedText(String(DEFAULT_SETTINGS.worldSeed));
                    setConfirmReset(false);
                  }}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="fac-btn fac-btn--ghost a10-btn-small"
                  onClick={() => setConfirmReset(false)}
                >
                  Keep
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="fac-btn fac-btn--ghost a10-btn-small"
                data-testid="a10-settings-reset"
                onClick={() => setConfirmReset(true)}
              >
                Reset to defaults
              </button>
            )}
            <button
              type="button"
              className="fac-btn fac-btn--primary a10-btn-small"
              onClick={() => setSettingsOpen(false)}
            >
              Done
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
