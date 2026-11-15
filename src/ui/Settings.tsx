/** Settings — graphics, audio and control options. PLACEHOLDER: quality only. */
import { QUALITY_ORDER } from '../config/quality';
import { useGameStore } from '../state/useGameStore';
import type { QualityLevel } from '../state/types';

export default function Settings() {
  const quality = useGameStore((s) => s.settings.quality);
  const updateSettings = useGameStore((s) => s.updateSettings);
  const setSettingsOpen = useGameStore((s) => s.setSettingsOpen);
  return (
    <div
      data-testid="settings"
      className="fac-panel"
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        padding: 20,
        display: 'grid',
        gap: 12,
        minWidth: 260,
      }}
    >
      <strong>SETTINGS</strong>
      <label>
        <span className="fac-label">Graphics quality</span>
        <br />
        <select
          data-testid="settings-quality"
          value={quality}
          onChange={(e) => updateSettings({ quality: e.target.value as QualityLevel })}
        >
          {QUALITY_ORDER.map((q) => (
            <option key={q} value={q}>
              {q}
            </option>
          ))}
        </select>
      </label>
      <button
        className="fac-btn"
        data-testid="settings-close"
        onClick={() => setSettingsOpen(false)}
      >
        Close
      </button>
    </div>
  );
}
