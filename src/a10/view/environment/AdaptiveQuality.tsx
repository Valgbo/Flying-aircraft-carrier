/**
 * Automatic graphics downgrade for the A-10 (PLAN §14): one preset step down when the frame
 * rate stays under 45 fps for about three seconds — measured by the carrier's monitor (shared
 * through src/engine) — only while flying, not paused, a few seconds after the flight or the
 * last preset change started, and while the terrain is not streaming tiles in (those frames are
 * not representative). The lower preset is used for this visit and not saved; choosing a preset
 * in the settings replaces it. Off when settings.adaptiveQuality is false (and with ?quality=).
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import { AdaptiveQualityMonitor, lowerQuality } from '../../../engine';
import { useA10Store } from '../../state/store';
import { terrainStreaming } from '../terrain/terrainStats';

/** Seconds of quiet flying before measuring starts. */
const SETTLE_SECONDS = 4;
/** More terrain builds than this in flight count as "streaming" (a few are normal in flight). */
const BUSY_PENDING = 4;

function onDecline(): void {
  const s = useA10Store.getState();
  const current = s.settings.quality;
  const next = lowerQuality(current);
  if (next === current) return;
  s.overrideSettings({ quality: next });
  s.pushMessage(`GRAPHICS: ${next.toUpperCase()} (AUTO)`, 'info', 3000);
}

export default function AdaptiveQuality() {
  const adaptive = useA10Store((s) => s.settings.adaptiveQuality);
  const level = useA10Store((s) => s.settings.quality);
  const flying = useA10Store((s) => s.screen === 'flight' && !s.paused);
  const flightNonce = useA10Store((s) => s.flightNonce);
  const [settled, setSettled] = useState(false);
  const quiet = useRef(0);

  // restart the settling time on a new flight, a preset change or a pause
  useEffect(() => {
    quiet.current = 0;
    setSettled(false);
  }, [flightNonce, level, flying]);

  useFrame((_, delta) => {
    if (!adaptive || !flying) return;
    const busy = terrainStreaming.pending > BUSY_PENDING;
    quiet.current = busy ? 0 : quiet.current + Math.min(delta, 0.25);
    const ok = quiet.current >= SETTLE_SECONDS;
    if (ok !== settled) setSettled(ok);
  });

  return (
    <AdaptiveQualityMonitor
      active={adaptive && flying && settled}
      level={level}
      onDecline={onDecline}
    />
  );
}
