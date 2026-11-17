/**
 * Pause menu (flight screen while store.paused): Resume, Restart flight, Rearm and refuel,
 * Settings, the controls reference, End flight and debrief, Exit to menu. Escape always
 * resumes (UIRoot handles the key, together with the input module's own pause binding). While
 * the settings dialog is open on top, the menu hides and hands the focus over.
 *
 * The controls page can also keep the reference on screen: "Keep on screen" resumes with the
 * help panel (HelpPanel.tsx) open beside the flight, so it needs no key of its own.
 */
import { useEffect, useRef, useState } from 'react';
import { IconArrowLeft, IconSliders, useModalFocus } from '../../engine';
import { pushCommand } from '../core/sim';
import { finishFlight, exitToMenu, restartFlight } from '../state/flow';
import { getSim } from '../state/runtime';
import { useA10Store } from '../state/store';
import A10Mark from './A10Mark';
import ControlsReference from './ControlsReference';
import { formatClock, formatInt } from './format';
import { IconDebrief, IconExit, IconKeyboard, IconPlay, IconRestart, IconRound } from './icons';
import { scenarioName } from './names';
import { useA10Ui } from './uiStore';

export default function PauseMenu() {
  const settingsOpen = useA10Store((s) => s.settingsOpen);
  const scenario = useA10Store((s) => s.scenario);
  const time = useA10Store((s) => s.telemetry.time);
  const rounds = useA10Store((s) => s.telemetry.rounds);
  const helpOpen = useA10Store((s) => s.helpOpen);
  const view = useA10Ui((s) => s.pauseView);
  const setView = useA10Ui((s) => s.setPauseView);
  const [rearmed, setRearmed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useModalFocus(panelRef, { active: !settingsOpen });

  // every pause starts on the main page
  useEffect(() => () => useA10Ui.getState().setPauseView('main'), []);

  // a rearm is applied on the first step after the pause: say so when the flight resumes
  const rearmedRef = useRef(false);
  useEffect(
    () => () => {
      const s = useA10Store.getState();
      if (rearmedRef.current && s.screen === 'flight' && getSim())
        s.pushMessage('REARMED AND REFUELLED', 'info');
    },
    [],
  );

  // the page change moves the focus to the new page's first control
  useEffect(() => {
    panelRef.current
      ?.querySelector<HTMLElement>('[data-autofocus]')
      ?.focus({ preventScroll: true });
  }, [view]);

  const keepOnScreen = () => {
    const s = useA10Store.getState();
    s.setHelpOpen(true);
    s.setPaused(false);
  };

  const rearm = () => {
    const sim = getSim();
    if (!sim) return;
    pushCommand(sim, { type: 'rearm' });
    rearmedRef.current = true;
    setRearmed(true);
  };

  return (
    <div className="a10-pause" data-testid="a10-pause" hidden={settingsOpen}>
      <div
        ref={panelRef}
        className={`a10-pause__panel fac-panel${view === 'controls' ? ' a10-pause__panel--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="a10-pause-title"
        tabIndex={-1}
      >
        <header className="a10-pause__head">
          <A10Mark size={40} />
          <div>
            <h2 className="a10-pause__title" id="a10-pause-title">
              {view === 'controls' ? 'Controls' : 'Paused'}
            </h2>
            <p className="fac-label a10-pause__sub">
              {scenarioName(scenario)} · <span className="fac-readout">{formatClock(time)}</span>
              {' · '}
              <span className="fac-readout">{formatInt(rounds)}</span> rounds
            </p>
          </div>
        </header>

        {view === 'controls' ? (
          <>
            <div className="a10-pause__scroll">
              <ControlsReference />
            </div>
            <div className="a10-pause__actions a10-pause__actions--row">
              <button
                type="button"
                className="fac-btn"
                data-testid="a10-pause-controls-back"
                data-autofocus
                onClick={() => setView('main')}
              >
                <IconArrowLeft size={18} />
                <span>Back</span>
              </button>
              {!helpOpen && (
                <button
                  type="button"
                  className="fac-btn a10-pause__keep"
                  data-testid="a10-pause-controls-keep"
                  title="Resume with this list beside the flight"
                  onClick={keepOnScreen}
                >
                  <IconKeyboard size={18} />
                  <span>Keep on screen</span>
                </button>
              )}
              <button
                type="button"
                className="fac-btn fac-btn--primary"
                onClick={() => useA10Store.getState().setPaused(false)}
              >
                <IconPlay size={18} />
                <span>Resume</span>
              </button>
            </div>
          </>
        ) : (
          <div className="a10-pause__actions">
            <button
              type="button"
              className="fac-btn fac-btn--primary"
              data-testid="a10-pause-resume"
              data-autofocus
              onClick={() => useA10Store.getState().setPaused(false)}
            >
              <IconPlay size={18} />
              <span>Resume</span>
              <kbd className="shell-key a10-pause__key">Esc</kbd>
            </button>
            <button
              type="button"
              className="fac-btn"
              data-testid="a10-pause-restart"
              onClick={() => void restartFlight()}
            >
              <IconRestart size={18} />
              <span>Restart flight</span>
            </button>
            <button
              type="button"
              className="fac-btn"
              data-testid="a10-pause-rearm"
              disabled={rearmed}
              onClick={rearm}
            >
              <IconRound size={18} />
              <span>{rearmed ? 'Rearmed and refuelled' : 'Rearm and refuel'}</span>
            </button>
            <button
              type="button"
              className="fac-btn"
              data-testid="a10-pause-settings"
              onClick={() => useA10Store.getState().setSettingsOpen(true)}
            >
              <IconSliders size={18} />
              <span>Settings</span>
            </button>
            <button
              type="button"
              className="fac-btn"
              data-testid="a10-pause-controls"
              onClick={() => setView('controls')}
            >
              <IconKeyboard size={18} />
              <span>Controls reference</span>
            </button>
            <button
              type="button"
              className="fac-btn"
              data-testid="a10-pause-debrief"
              onClick={finishFlight}
            >
              <IconDebrief size={18} />
              <span>End flight and debrief</span>
            </button>
            <button
              type="button"
              className="fac-btn fac-btn--ghost"
              data-testid="a10-pause-exit"
              onClick={exitToMenu}
            >
              <IconExit size={18} />
              <span>Exit to menu</span>
            </button>
          </div>
        )}
        {rearmed && view === 'main' && (
          <p className="a10-note" role="status">
            The aircraft is rearmed and refuelled as the flight resumes.
          </p>
        )}
      </div>
    </div>
  );
}
