/** HUD — flight instruments. PLACEHOLDER: a few numbers. */
import { CAMERA_LABELS, useGameStore } from '../state/useGameStore';

export default function HUD() {
  const t = useGameStore((s) => s.telemetry);
  const assist = useGameStore((s) => s.assistEnabled);
  const cameraMode = useGameStore((s) => s.cameraMode);
  return (
    <div
      data-testid="hud"
      className="fac-panel fac-readout"
      style={{ position: 'absolute', left: 16, top: 16, padding: 12, display: 'grid', gap: 2 }}
    >
      <div>
        ALT <span data-testid="hud-altitude">{t.altitude.toFixed(0)}</span> m
      </div>
      <div>
        SPD <span data-testid="hud-speed">{t.speedKts.toFixed(0)}</span> kt
      </div>
      <div>
        HDG <span data-testid="hud-heading">{t.headingDeg.toFixed(0).padStart(3, '0')}</span>°
      </div>
      <div>
        V/S <span data-testid="hud-vspeed">{t.verticalSpeed.toFixed(1)}</span> m/s
      </div>
      <div>
        ASSIST <span data-testid="hud-assist">{assist ? 'ON' : 'OFF'}</span>
      </div>
      <div>
        CAM <span data-testid="hud-camera">{CAMERA_LABELS[cameraMode]}</span>
      </div>
    </div>
  );
}
