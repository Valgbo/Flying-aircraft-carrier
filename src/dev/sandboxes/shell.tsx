/**
 * Shell sandbox — the real menu / hangar / settings / pause / loading overlay pieces over a
 * neutral gradient, without the 3D scene, for layout work. Open /?sandbox=shell plus:
 *
 *   view=menu | hangar | settings | pause | loading     which piece to start on (default menu)
 *   hotspot=<id>          hangar: start with this hotspot selected (e.g. turbine-1, island)
 *   orbit=1               hangar: keep the fake camera circling, to watch the pins track
 *   under=pause           settings: open the dialog on top of the pause menu instead of the menu
 *   section=audio | controls   settings: scroll to that section
 *   rebind=<bindingId>    settings: start capturing a key for that binding
 *   confirm=1             settings: open the "reset all" confirm step
 *   phase=boot | veil     loading: the opaque first-load cover (default) or the physics veil
 *   fps=1                 show the FPS counter
 *
 * The composition mirrors src/ui/UIRoot.tsx, so the pieces can be clicked through
 * (menu → hangar → back, menu → settings, …). There is no Canvas here: the hangar pins are fed
 * by a stand-in camera that runs the real projection (hotspotProjection.ts) against the idle
 * hover, and Escape is forwarded to the `togglePause` action as the keyboard layer would.
 */
import { useEffect } from 'react';
import { PerspectiveCamera } from 'three';
import { debugFlags } from '../../config/debugFlags';
import type { HotspotId } from '../../config/layout';
import { HOTSPOTS } from '../../config/layout';
import { stepIdle } from '../../sim/IdleDriver';
import { emitAction } from '../../state/actions';
import { sim } from '../../state/sim';
import { isFlyingScreen, useGameStore } from '../../state/useGameStore';
import HangarOverlay from '../../ui/HangarOverlay';
import LoadingScreen from '../../ui/LoadingScreen';
import MainMenu from '../../ui/MainMenu';
import PauseMenu from '../../ui/PauseMenu';
import Settings from '../../ui/Settings';
import { clearHotspotProjections, projectHotspots } from '../../ui/shell/hotspotProjection';

const params = debugFlags.params;
const view = params.get('view') ?? 'menu';

/** Put the store into the state the requested view needs, before the first render. */
function applyInitialState(): void {
  const store = useGameStore;
  const loadingPhase = view === 'loading' ? (params.get('phase') ?? 'boot') : null;
  store.setState({
    sceneReady: loadingPhase !== 'boot',
    physicsLoading: loadingPhase === 'veil',
  });
  if (view === 'hangar') {
    store.getState().setScreen('hangar');
    const hotspot = params.get('hotspot');
    if (hotspot && HOTSPOTS.some((h) => h.id === hotspot)) {
      store.getState().setHangar({ selectedHotspot: hotspot as HotspotId });
    }
  } else if (view === 'pause' || params.get('under') === 'pause') {
    store.setState({ screen: 'flight', paused: true });
  }
  if (view === 'settings') store.getState().setSettingsOpen(true);
  if (params.get('fps') === '1') {
    store.setState((s) => ({ settings: { ...s.settings, showFps: true } }));
  }
}

applyInitialState();

/**
 * Stand-in for the canvas side of the hangar: advances the idle hover (so the demo sliders
 * spool the turbines and the thrust readout lives) and projects the hotspot anchors through
 * a camera looking at the ship from the port bow quarter.
 */
function FakeHangarScene() {
  useEffect(() => {
    const camera = new PerspectiveCamera(50, 1, 1, 60000);
    const orbit = params.get('orbit') === '1';
    const pitch = 0.42;
    let yaw = 2.45;
    let last = performance.now();
    let handle = 0;
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      stepIdle(dt);
      if (orbit) yaw += dt * 0.3;
      const width = window.innerWidth;
      const height = window.innerHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      // far enough to hold the whole ship in a portrait viewport too
      const distance = 470 / Math.min(1, camera.aspect * 0.9);
      const ship = sim.carrier.position;
      camera.position.set(
        ship.x + Math.sin(yaw) * Math.cos(pitch) * distance,
        ship.y + Math.sin(pitch) * distance,
        ship.z + Math.cos(yaw) * Math.cos(pitch) * distance,
      );
      camera.lookAt(ship);
      camera.updateMatrixWorld();
      projectHotspots(camera, { left: 0, top: 0, width, height });
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(handle);
      clearHotspotProjections();
    };
  }, []);
  return null;
}

/** One-off DOM pokes for states that only exist after an interaction. */
function useSettingsDeepLinks(): void {
  useEffect(() => {
    if (view !== 'settings') return;
    const section = params.get('section');
    if (section) document.getElementById(`settings-${section}`)?.scrollIntoView();
    const rebind = params.get('rebind');
    const click = (testId: string) =>
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click();
    if (rebind) {
      const button = document.querySelector<HTMLElement>(
        `[data-testid="settings-rebind-${rebind}"]`,
      );
      button?.scrollIntoView({ block: 'center' });
      button?.focus();
      button?.click();
    }
    if (params.get('confirm') === '1') {
      click('settings-reset-all');
      document.querySelector('[data-testid="settings-reset-confirm"]')?.scrollIntoView();
    }
  }, []);
}

export default function ShellSandbox() {
  const screen = useGameStore((s) => s.screen);
  const paused = useGameStore((s) => s.paused);
  const settingsOpen = useGameStore((s) => s.settingsOpen);

  // what ControlsManager does in the app for the Pause key
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === useGameStore.getState().settings.keyBindings.togglePause) {
        emitAction('togglePause');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useSettingsDeepLinks();

  return (
    <div
      className="app"
      style={{
        background:
          'radial-gradient(ellipse at 62% 46%, #6f8fa8 0%, #3d566c 38%, #1a2a3a 72%, #0c1722 100%)',
      }}
    >
      {screen === 'hangar' && <FakeHangarScene />}
      <div className="ui-root">
        {screen === 'menu' && <MainMenu />}
        {screen === 'hangar' && <HangarOverlay />}
        {isFlyingScreen(screen) && paused && <PauseMenu />}
        {settingsOpen && <Settings />}
        <LoadingScreen />
      </div>
    </div>
  );
}
