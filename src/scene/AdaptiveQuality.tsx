/**
 * AdaptiveQuality — drops to the next lower graphics preset when the frame rate stays under
 * 45 fps for about three seconds (PLAN §9). It never raises the preset again by itself;
 * choosing a preset in the settings resets it. Disabled by `settings.adaptiveQuality = false`
 * (and by the `?quality=` debug flag).
 *
 * The measuring is done by the carrier-free `AdaptiveQualityMonitor` (shared with the A-10
 * app through src/engine); this wrapper decides when the scene is settled and what a decline
 * does.
 */
import { lowerQuality } from '../config/quality';
import { useGameStore } from '../state/useGameStore';
import AdaptiveQualityMonitor from './AdaptiveQualityMonitor';

function onDecline(): void {
  const s = useGameStore.getState();
  const next = lowerQuality(s.effectiveQuality);
  if (next === s.effectiveQuality) return;
  s.setEffectiveQuality(next);
  s.pushMessage(`GRAPHICS: ${next.toUpperCase()} (AUTO)`, 'info', 3000);
}

export default function AdaptiveQuality() {
  const adaptive = useGameStore((s) => s.settings.adaptiveQuality);
  const settled = useGameStore((s) => s.sceneReady && !s.physicsLoading && !s.paused);
  const quality = useGameStore((s) => s.effectiveQuality);
  return (
    <AdaptiveQualityMonitor active={adaptive && settled} level={quality} onDecline={onDecline} />
  );
}
