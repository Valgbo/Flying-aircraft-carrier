/**
 * AdaptiveQualityMonitor — watches the frame rate and calls `onDecline` when it stays under
 * `minFps` (45 by default) for about three seconds: at least 11 of 12 quarter-second samples.
 * The measurement restarts whenever `level` changes. Mounted only while `active` and above the
 * lowest preset. Carrier-free (src/engine re-exports it): what "declining" means — one preset
 * step down, a message — and when the scene is settled enough to measure is the app's call.
 */
import { PerformanceMonitor } from '@react-three/drei';

export interface AdaptiveQualityMonitorProps {
  /** Measure now (the scene is loaded, not paused, and the player allows automatic changes). */
  active: boolean;
  /** The preset in use; nothing is measured on 'low'. */
  level: 'low' | 'medium' | 'high';
  /** The frame rate stayed under the floor: lower the preset. */
  onDecline: () => void;
  /** Frame-rate floor, fps. */
  minFps?: number;
}

export default function AdaptiveQualityMonitor({
  active,
  level,
  onDecline,
  minFps = 45,
}: AdaptiveQualityMonitorProps) {
  if (!active || level === 'low') return null;
  return (
    <PerformanceMonitor
      // restart the measurement whenever the preset changes
      key={level}
      ms={250}
      iterations={12}
      threshold={0.9}
      bounds={() => [minFps, Number.MAX_SAFE_INTEGER]}
      onDecline={onDecline}
    />
  );
}
