/**
 * HangarOverlay — the inspect mode around the 3D ship: back button and title, hotspot pins
 * anchored to the model, the info card of the selected hotspot and the turbine demo panel.
 * Selecting a pin writes `hangar.selectedHotspot`; the camera rig eases toward it.
 * On phones the card and the demo panel are bottom sheets and only one shows at a time, so
 * the ship stays in view. Styles: shell/hangar.css.
 */
import { useCallback, useEffect } from 'react';
import type { HotspotId } from '../config/layout';
import { SHIP } from '../config/palette';
import { isKeyCaptureActive } from '../controls/keyCapture';
import { useGameStore } from '../state/useGameStore';
import HangarCard from './shell/HangarCard';
import HangarDemoPanel from './shell/HangarDemoPanel';
import HangarPins from './shell/HangarPins';
import { getHotspotContent } from './shell/hotspotContent';
import { IconArrowLeft, IconSliders } from './shell/icons';
import {
  COARSE_POINTER_QUERY,
  COMPACT_QUERY,
  SHORT_QUERY,
  useMediaQuery,
} from './shell/useMediaQuery';
import './shell/shell.css';
import './shell/hangar.css';

export default function HangarOverlay() {
  const selected = useGameStore((s) => s.hangar.selectedHotspot);
  const setScreen = useGameStore((s) => s.setScreen);
  const setHangar = useGameStore((s) => s.setHangar);
  const setSettingsOpen = useGameStore((s) => s.setSettingsOpen);
  const compact = useMediaQuery(COMPACT_QUERY);
  const short = useMediaQuery(SHORT_QUERY);
  const coarse = useMediaQuery(COARSE_POINTER_QUERY);

  const toggleHotspot = useCallback(
    (id: HotspotId) => {
      const current = useGameStore.getState().hangar.selectedHotspot;
      setHangar({ selectedHotspot: current === id ? null : id });
    },
    [setHangar],
  );

  // Escape deselects — unless the settings dialog is open (the togglePause action closes
  // that one) or a key is being captured for rebinding. Capture phase: read the dialog
  // state before any other handler of this key press has changed it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isKeyCaptureActive()) return;
      const state = useGameStore.getState();
      if (state.settingsOpen || state.hangar.selectedHotspot === null) return;
      state.setHangar({ selectedHotspot: null });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const content = selected ? getHotspotContent(selected) : null;

  return (
    <div className="hangar" data-testid="hangar-overlay">
      <HangarPins selected={selected} onToggle={toggleHotspot} />

      <header className="hangar-top">
        <button
          type="button"
          className="fac-btn hangar-back"
          data-testid="hangar-back"
          onClick={() => setScreen('menu')}
        >
          <IconArrowLeft size={18} />
          <span>Menu</span>
        </button>
        <div className="hangar-heading">
          <h1 className="hangar-heading__title">
            Hangar
            <span className="hangar-heading__ship">
              {SHIP.name} · {SHIP.hullNumber}
            </span>
          </h1>
          <p className="hangar-heading__hint">
            {coarse
              ? 'Drag to orbit · pinch to zoom · tap a pin to inspect'
              : 'Drag to orbit · scroll to zoom · click a pin to inspect'}
          </p>
        </div>
      </header>

      <button
        type="button"
        className="hangar-icon-btn hangar-settings fac-focusable"
        data-testid="hangar-settings"
        aria-label="Settings"
        onClick={() => setSettingsOpen(true)}
      >
        <IconSliders size={20} />
      </button>

      {content && (
        <HangarCard
          // keyed so the entrance plays again when another hotspot is picked
          key={content.id}
          content={content}
          onClose={() => setHangar({ selectedHotspot: null })}
        />
      )}
      {(!compact || !content) && <HangarDemoPanel compact={compact} defaultOpen={!short} />}
    </div>
  );
}
