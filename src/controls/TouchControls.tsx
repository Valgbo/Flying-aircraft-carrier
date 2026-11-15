/**
 * TouchControls — the on-screen flight controls, a two-thumb layout inside the two reserved
 * bottom corners (240 × 240 px each, see docs/ARCHITECTURE.md section 5).
 *
 *   left corner    the steering stick: X = yaw, Y = tilt
 *   right corner   the lift slider on the outer edge; beside it the action buttons
 *                  (LAUNCH on the ops screen, ASSIST, CAM, TURBINES) above the two
 *                  hold-to-strafe buttons
 *
 * The action buttons live INSIDE the right corner rather than above it: the HUD puts its
 * turbine gauges and, on narrow screens, the flight cluster directly above the corners, and
 * the corners are the only area guaranteed to be free.
 *
 * Shown only when touch controls are wanted (useTouchControlsVisible) and the pilot can
 * actually fly (flying screen, not paused, no settings dialog). Whenever it is hidden or
 * unmounted the touch input slot is zero.
 */
import { useEffect, type MouseEvent as ReactMouseEvent } from 'react';
import { useGameStore } from '../state/useGameStore';
import { pilotInputLive } from './gating';
import { clearInput } from './input';
import './touch.css';
import { useTouchControlsVisible } from './touchVisibility';
import { TouchActionButton, TouchStick, TouchStrafe, TouchThrottle } from './touchWidgets';

function preventContextMenu(e: ReactMouseEvent): void {
  e.preventDefault();
}

function TouchSurface() {
  const ops = useGameStore((s) => s.screen === 'ops');
  const assistEnabled = useGameStore((s) => s.assistEnabled);
  const turbinePanelOpen = useGameStore((s) => s.turbinePanelOpen);

  // the widgets zero their own axes when they unbind; this covers the whole slot regardless
  useEffect(() => () => clearInput('touch'), []);

  return (
    <div
      className="touch-root"
      data-testid="touch-controls"
      role="group"
      aria-label="Touch flight controls"
      onContextMenu={preventContextMenu}
    >
      <TouchStick />
      <div className="touch-zone touch-zone--right">
        <div className="touch-cluster">
          <div className="touch-actions">
            {ops && (
              <TouchActionButton action="launchJet" className="touch-btn--wide touch-btn--launch">
                LAUNCH
              </TouchActionButton>
            )}
            <TouchActionButton action="toggleAssist" pressed={assistEnabled}>
              ASSIST
            </TouchActionButton>
            <TouchActionButton action="cycleCamera">CAM</TouchActionButton>
            <TouchActionButton
              action="toggleTurbinePanel"
              pressed={turbinePanelOpen}
              className="touch-btn--wide"
            >
              TURBINES
            </TouchActionButton>
          </div>
          <TouchStrafe />
        </div>
        <TouchThrottle />
      </div>
    </div>
  );
}

export default function TouchControls() {
  const visible = useTouchControlsVisible();
  const live = useGameStore(pilotInputLive);
  return visible && live ? <TouchSurface /> : null;
}
