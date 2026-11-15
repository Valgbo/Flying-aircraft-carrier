/** UIRoot — the DOM overlay above the canvas. Composition only. */
import TouchControls from '../controls/TouchControls';
import { debugFlags } from '../config/debugFlags';
import { isFlyingScreen, useGameStore } from '../state/useGameStore';
import HangarOverlay from './HangarOverlay';
import HUD from './HUD';
import LoadingScreen from './LoadingScreen';
import MainMenu from './MainMenu';
import OpsHUD from './OpsHUD';
import PauseMenu from './PauseMenu';
import Settings from './Settings';
import Toasts from './Toasts';
import TurbinePanel from './TurbinePanel';

export default function UIRoot() {
  const screen = useGameStore((s) => s.screen);
  const paused = useGameStore((s) => s.paused);
  const settingsOpen = useGameStore((s) => s.settingsOpen);
  const flying = isFlyingScreen(screen);
  if (debugFlags.ui === '0') return null;
  return (
    <div className="ui-root">
      {screen === 'menu' && <MainMenu />}
      {screen === 'hangar' && <HangarOverlay />}
      {flying && <HUD />}
      {flying && <TurbinePanel />}
      {screen === 'ops' && <OpsHUD />}
      {flying && <TouchControls />}
      <Toasts />
      {flying && paused && <PauseMenu />}
      {settingsOpen && <Settings />}
      <LoadingScreen />
    </div>
  );
}
