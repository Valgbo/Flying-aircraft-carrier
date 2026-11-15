/** TurbinePanel — per-turbine throttle and tilt. PLACEHOLDER: nothing yet. */
import { useGameStore } from '../state/useGameStore';

export default function TurbinePanel() {
  const open = useGameStore((s) => s.turbinePanelOpen);
  if (!open) return null;
  return (
    <div
      data-testid="turbine-panel"
      className="fac-panel"
      style={{ position: 'absolute', right: 16, top: 16, padding: 12 }}
    >
      Turbine panel
    </div>
  );
}
