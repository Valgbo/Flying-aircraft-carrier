/** OpsHUD — flight-ops status and score. PLACEHOLDER. */
import { useGameStore } from '../state/useGameStore';

export default function OpsHUD() {
  const ops = useGameStore((s) => s.ops);
  return (
    <div
      data-testid="ops-hud"
      className="fac-panel fac-readout"
      style={{ position: 'absolute', right: 16, bottom: 16, padding: 12 }}
    >
      SCORE <span data-testid="ops-score">{ops.score}</span>
    </div>
  );
}
