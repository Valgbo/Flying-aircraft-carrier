/**
 * AdaptiveQuality — drops to the next lower graphics preset when the frame rate stays under
 * 45 fps for about three seconds (PLAN §9). It never raises the preset again by itself;
 * choosing a preset in the settings resets it. Disabled by `settings.adaptiveQuality = false`
 * (and by the `?quality=` debug flag).
 */
import { PerformanceMonitor } from '@react-three/drei';
import { lowerQuality } from '../config/quality';
import { useGameStore } from '../state/useGameStore';

export default function AdaptiveQuality() {
  const adaptive = useGameStore((s) => s.settings.adaptiveQuality);
  const settled = useGameStore((s) => s.sceneReady && !s.physicsLoading && !s.paused);
  const quality = useGameStore((s) => s.effectiveQuality);
  if (!adaptive || !settled || quality === 'low') return null;
  return (
    <PerformanceMonitor
      // restart the measurement whenever the preset changes
      key={quality}
      ms={250}
      iterations={12}
      threshold={0.9}
      bounds={() => [45, Number.MAX_SAFE_INTEGER]}
      onDecline={() => {
        const s = useGameStore.getState();
        const next = lowerQuality(s.effectiveQuality);
        if (next === s.effectiveQuality) return;
        s.setEffectiveQuality(next);
        s.pushMessage(`GRAPHICS: ${next.toUpperCase()} (AUTO)`, 'info', 3000);
      }}
    />
  );
}
