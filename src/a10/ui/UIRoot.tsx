/**
 * DOM overlay of the A-10 app: menus, loading, pause, settings, the in-flight strip and toasts,
 * debrief and credits. OWNED BY THE UI MODULE (docs/a10/ARCHITECTURE.md §11).
 *
 * Layers (z-index): pages 5 · in-flight overlay 10 · toasts 20 · help 30 · pause 35 ·
 * settings 40 · loading 50 · FPS readout 60.
 *
 * Escape (shared with the input module, which pauses on its pause binding, Esc by default):
 *  - paused in flight: Escape always resumes, also from the controls page or the settings
 *    dialog opened from the pause menu;
 *  - with the help panel open (and not paused) it closes the panel;
 *  - on the menu, loadout and credits: it closes the settings dialog or goes back to the menu.
 * The UI decides during the key's dispatch and calls preventDefault() on an Escape it used; the
 * input runtime toggles pause only after the dispatch, and only for an Escape nobody prevented
 * (src/a10/input/runtime.ts), so one press never resumes and pauses again. An Escape already
 * prevented (a key being captured for rebinding) is left alone.
 */
import { useEffect } from 'react';
import { FpsCounter, isKeyCaptureActive } from '../../engine';
import { a10Flags } from '../state/debugFlags';
import { applyA10Flags } from '../state/flow';
import { useA10Store } from '../state/store';
import { useSimBridge } from './bridge';
import CreditsScreen from './CreditsScreen';
import DebriefScreen from './DebriefScreen';
import FlightOverlay from './FlightOverlay';
import HelpPanel from './HelpPanel';
import LoadingScreen from './LoadingScreen';
import LoadoutScreen from './LoadoutScreen';
import MainMenu from './MainMenu';
import PauseMenu from './PauseMenu';
import SettingsDialog from './SettingsDialog';
import Toasts from './Toasts';
import { persistLoadoutChoices } from './uiStore';
import './ui.css';

let flagsApplied = false;

// The player's last preset and gun load are in the store before any flight can start (also
// with ?ui=0).
persistLoadoutChoices();

// Leaving the pause (by any key, button or module) also closes what was open on top of it.
useA10Store.subscribe((s, prev) => {
  if (prev.paused && !s.paused && s.screen === 'flight' && s.settingsOpen)
    useA10Store.getState().setSettingsOpen(false);
});

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.repeat || e.defaultPrevented || isKeyCaptureActive()) return;
  const s = useA10Store.getState();
  if (s.helpOpen && !s.paused && !s.settingsOpen) {
    e.preventDefault();
    s.setHelpOpen(false);
    return;
  }
  if (s.screen === 'flight') {
    // not paused: the input module's pause binding pauses (nothing to prevent here)
    if (!s.paused) return;
    e.preventDefault();
    if (s.settingsOpen) s.setSettingsOpen(false);
    s.setPaused(false);
    return;
  }
  if (s.settingsOpen) {
    e.preventDefault();
    s.setSettingsOpen(false);
  } else if (s.screen === 'loadout' || s.screen === 'credits') {
    e.preventDefault();
    s.setScreen('menu');
  }
}

export default function UIRoot() {
  const screen = useA10Store((s) => s.screen);
  const paused = useA10Store((s) => s.paused);
  const settingsOpen = useA10Store((s) => s.settingsOpen);
  const showFps = useA10Store((s) => s.settings.showFps);
  const helpOpen = useA10Store((s) => s.helpOpen);

  useEffect(() => {
    if (flagsApplied) return;
    flagsApplied = true;
    applyA10Flags();
  }, []);

  useSimBridge();

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!a10Flags.ui) return null;
  const flying = screen === 'flight';
  return (
    <div className="ui-root a10-ui" data-screen={screen}>
      {screen === 'menu' && <MainMenu />}
      {screen === 'loadout' && <LoadoutScreen />}
      {screen === 'credits' && <CreditsScreen />}
      {screen === 'debrief' && <DebriefScreen />}
      {flying && <FlightOverlay />}
      <Toasts />
      {helpOpen && screen !== 'loading' && <HelpPanel />}
      {flying && paused && <PauseMenu />}
      {settingsOpen && (!flying || paused) && <SettingsDialog />}
      {screen === 'loading' && <LoadingScreen />}
      {showFps && <FpsCounter />}
    </div>
  );
}
