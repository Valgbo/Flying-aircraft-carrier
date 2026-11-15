/**
 * LoadingScreen — mounted on every screen. Two covers, one element:
 *   boot  an opaque cover until the 3D scene has drawn (`store.sceneReady`), then it fades out;
 *   veil  a lighter veil while the flight-physics chunk loads (`store.physicsLoading`) —
 *         delayed by 150 ms so a fast load never flashes it.
 * While fading it no longer takes pointer events, and once faded it leaves the DOM.
 * Being always mounted, it also hosts the FPS counter (`settings.showFps`).
 * Styles: shell/loading.css.
 */
import { useEffect, useState } from 'react';
import { useGameStore } from '../state/useGameStore';
import BrandMark from './shell/BrandMark';
import FpsCounter from './shell/FpsCounter';
import './shell/shell.css';
import './shell/loading.css';

type Cover = 'boot' | 'veil';

/** A physics load shorter than this never shows the veil, ms. */
const VEIL_DELAY = 150;
/** How long a cover stays in the DOM after it started fading; a little over the CSS fade, ms. */
const FADE_OUT = 650;

export default function LoadingScreen() {
  const sceneReady = useGameStore((s) => s.sceneReady);
  const physicsLoading = useGameStore((s) => s.physicsLoading);
  const showFps = useGameStore((s) => s.settings.showFps);

  const [veilDue, setVeilDue] = useState(false);
  useEffect(() => {
    if (!physicsLoading) return;
    const timer = window.setTimeout(() => setVeilDue(true), VEIL_DELAY);
    return () => {
      window.clearTimeout(timer);
      setVeilDue(false);
    };
  }, [physicsLoading]);

  const wanted: Cover | null = !sceneReady ? 'boot' : veilDue ? 'veil' : null;

  // The cover on screen: follows `wanted` at once, and outlives it by the length of the fade.
  const [shown, setShown] = useState<Cover | null>(wanted);
  if (wanted !== null && shown !== wanted) setShown(wanted);
  useEffect(() => {
    if (wanted !== null) return;
    const timer = window.setTimeout(() => setShown(null), FADE_OUT);
    return () => window.clearTimeout(timer);
  }, [wanted]);

  const cover = wanted ?? shown;

  return (
    <>
      {cover && (
        <div
          className={`loading loading--${cover}${wanted === null ? ' loading--out' : ''}`}
          data-testid="loading-screen"
          role="status"
          aria-live="polite"
          aria-busy={wanted !== null}
        >
          <div className="loading-box">
            <BrandMark height={cover === 'boot' ? 132 : 64} spin detail={cover === 'boot'} />
            {cover === 'boot' && (
              <p className="loading-title">
                <span>Flying</span> Aircraft Carrier
              </p>
            )}
            <div className="loading-bar" aria-hidden="true">
              <span className="loading-bar__run" />
            </div>
            <p className="loading-status fac-label">
              {cover === 'boot' ? 'Preparing the ship' : 'Spinning up flight systems'}
            </p>
          </div>
        </div>
      )}
      {showFps && <FpsCounter />}
    </>
  );
}
