/**
 * Controls sandbox — the keyboard, gamepad and touch layers on a plain page (no 3D), with a
 * live readout of what they produce. Open /?sandbox=controls&touch=1 plus:
 *
 *   screen=flight | ops | menu | hangar   screen to start on (default flight; ops adds LAUNCH)
 *   paused=1        start paused (no axes may be written, the touch controls hide)
 *   settings=1      start with the settings flag raised (same gating as paused)
 *   panel=1         start with the turbine panel flag raised (lights the TURBINES button)
 *   invertY=1       start with the invert-Y setting on
 *   bg=day | night  backdrop behind the controls, to judge their transparency (default day)
 *
 * There is no driver here, so the page calls combineInput() itself every animation frame.
 * For scripts, `window.__FAC_CONTROLS__` exposes the actions fired so far, the gamepad
 * status and the key-capture functions; `window.__FAC__` is the usual debug handle.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { debugFlags } from '../../config/debugFlags';
import ControlsManager from '../../controls/ControlsManager';
import { gamepadStatus } from '../../controls/gamepadLayer';
import { AXIS_NAMES, combineInput, input, inputSources } from '../../controls/input';
import { cancelKeyCapture, captureNextKey, isKeyCaptureActive } from '../../controls/keyCapture';
import TouchControls from '../../controls/TouchControls';
import { ACTION_NAMES, onAction } from '../../state/actions';
import { keyLabel } from '../../state/bindings';
import { isFlyingScreen, useGameStore } from '../../state/useGameStore';

interface ControlsSandboxHandle {
  /** Every action emitted since the page loaded, oldest first. */
  actions: string[];
  gamepad: typeof gamepadStatus;
  captureNextKey: typeof captureNextKey;
  cancelKeyCapture: typeof cancelKeyCapture;
  isKeyCaptureActive: typeof isKeyCaptureActive;
}

declare global {
  interface Window {
    __FAC_CONTROLS__?: ControlsSandboxHandle;
  }
}

const params = debugFlags.params;
const ROWS = ['combined', 'keyboard', 'gamepad', 'touch'] as const;
const RECENT_ACTIONS = 6;

const handle: ControlsSandboxHandle = {
  actions: [],
  gamepad: gamepadStatus,
  captureNextKey,
  cancelKeyCapture,
  isKeyCaptureActive,
};

/** Put the store into the requested state before the first render. */
function applyInitialState(): void {
  const store = useGameStore;
  if (!debugFlags.screen) store.getState().setScreen('flight');
  if (params.get('paused') === '1') store.getState().setPaused(true);
  if (params.get('settings') === '1') store.getState().setSettingsOpen(true);
  if (params.get('panel') === '1') store.setState({ turbinePanelOpen: true });
  if (params.get('invertY') === '1') store.getState().updateSettings({ invertY: true });
}

applyInitialState();

const BACKDROPS: Record<string, string> = {
  day: 'linear-gradient(to bottom, #4f8fc4 0%, #a9cfe6 46%, #e9f1f2 55%, #2c6a8c 56%, #0f3550 100%)',
  night:
    'linear-gradient(to bottom, #04070f 0%, #0c1830 46%, #1b2c48 55%, #071422 56%, #02060c 100%)',
};

const backdropStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: BACKDROPS[params.get('bg') ?? 'day'] ?? BACKDROPS.day,
};

/** A bright "deck" band crossing the lower corners, so the widgets sit over real contrast. */
const deckStyle: CSSProperties = {
  position: 'absolute',
  left: '-10%',
  right: '-10%',
  bottom: '9%',
  height: 64,
  transform: 'rotate(-7deg)',
  background:
    'repeating-linear-gradient(90deg, #8a949c 0 56px, #6f7880 56px 60px, #d8c25a 60px 64px)',
  opacity: 0.85,
};

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  width: 'min(430px, calc(100% - 16px))',
  padding: '10px 12px',
  display: 'grid',
  gap: 8,
  fontSize: 11,
};

const preStyle: CSSProperties = { margin: 0, fontSize: 11, lineHeight: 1.45, whiteSpace: 'pre' };
const rowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' };
const smallButton: CSSProperties = { minHeight: 30, padding: '4px 8px', fontSize: 11 };
const fieldStyle: CSSProperties = { pointerEvents: 'auto', width: 110, font: 'inherit' };

function format(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

function buildReadout(): string {
  let text = `          ${AXIS_NAMES.map((a) => a.slice(0, 6).padStart(7)).join('')}\n`;
  for (const row of ROWS) {
    const axes = row === 'combined' ? input : inputSources[row];
    text += row.padEnd(10) + AXIS_NAMES.map((a) => format(axes[a]).padStart(7)).join('') + '\n';
  }
  text += `gamepad   ${gamepadStatus.connected ? gamepadStatus.id || 'connected' : 'none'}`;
  return text;
}

/** Live table of the input slots, redrawn only when a value changed. */
function InputReadout() {
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const last = new Float64Array(ROWS.length * AXIS_NAMES.length + 1).fill(NaN);
    let frame = 0;
    const tick = (): void => {
      combineInput();
      let changed = false;
      let i = 0;
      for (const row of ROWS) {
        const axes = row === 'combined' ? input : inputSources[row];
        for (const axis of AXIS_NAMES) {
          if (last[i] !== axes[axis]) {
            last[i] = axes[axis];
            changed = true;
          }
          i++;
        }
      }
      const pad = gamepadStatus.connected ? 1 : 0;
      if (last[i] !== pad) {
        last[i] = pad;
        changed = true;
      }
      if (changed && preRef.current) preRef.current.textContent = buildReadout();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <pre ref={preRef} className="fac-readout" style={preStyle} data-testid="sandbox-readout" />
  );
}

/** The most recent actions, newest first. Also feeds window.__FAC_CONTROLS__.actions. */
function ActionLog() {
  const [recent, setRecent] = useState<readonly string[]>([]);
  useEffect(() => {
    window.__FAC_CONTROLS__ = handle;
    const unsubscribe = ACTION_NAMES.map((name) =>
      onAction(name, () => {
        handle.actions.push(name);
        const count = handle.actions.length;
        setRecent((list) => [`${count}. ${name}`, ...list].slice(0, RECENT_ACTIONS));
      }),
    );
    return () => unsubscribe.forEach((off) => off());
  }, []);
  return (
    <div data-testid="sandbox-actions" className="fac-readout">
      <span className="fac-label">actions </span>
      {recent.length ? recent.join('  ') : '—'}
    </div>
  );
}

function StateRow() {
  const screen = useGameStore((s) => s.screen);
  const paused = useGameStore((s) => s.paused);
  const settingsOpen = useGameStore((s) => s.settingsOpen);
  const assist = useGameStore((s) => s.assistEnabled);
  const camera = useGameStore((s) => s.cameraMode);
  const panel = useGameStore((s) => s.turbinePanelOpen);
  const invertY = useGameStore((s) => s.settings.invertY);
  const pauseKey = useGameStore((s) => s.settings.keyBindings.togglePause);
  const [captured, setCaptured] = useState('');
  const store = useGameStore.getState();

  const capture = (): void => {
    setCaptured('press a key…');
    void captureNextKey().then((code) => setCaptured(code ? keyLabel(code) : 'cancelled'));
  };

  return (
    <>
      <div className="fac-readout" data-testid="sandbox-state">
        {screen}
        {paused ? ' · PAUSED' : ''}
        {settingsOpen ? ' · SETTINGS' : ''} · assist {assist ? 'on' : 'off'} · cam {camera} · panel{' '}
        {panel ? 'open' : 'closed'} · pause key {keyLabel(pauseKey)}
      </div>
      <div style={rowStyle}>
        <button
          type="button"
          className="fac-btn"
          style={smallButton}
          onClick={() => store.setScreen(screen === 'flight' ? 'ops' : 'flight')}
        >
          {isFlyingScreen(screen) && screen === 'flight' ? 'to ops' : 'to flight'}
        </button>
        <button
          type="button"
          className="fac-btn"
          style={smallButton}
          onClick={() => store.setScreen('menu')}
        >
          to menu
        </button>
        <button
          type="button"
          className="fac-btn"
          style={smallButton}
          onClick={() => store.setPaused(!paused)}
        >
          {paused ? 'resume' : 'pause'}
        </button>
        <button
          type="button"
          className="fac-btn"
          style={smallButton}
          onClick={() => store.setSettingsOpen(!settingsOpen)}
        >
          settings {settingsOpen ? 'off' : 'on'}
        </button>
        <button
          type="button"
          className="fac-btn"
          style={smallButton}
          onClick={() => store.updateSettings({ invertY: !invertY })}
        >
          invert Y {invertY ? 'on' : 'off'}
        </button>
        <button type="button" className="fac-btn" style={smallButton} onClick={capture}>
          capture key
        </button>
        <span className="fac-readout">{captured}</span>
      </div>
      <div style={rowStyle}>
        <input
          type="text"
          placeholder="type here"
          style={fieldStyle}
          data-testid="sandbox-text"
          aria-label="Text field: typing here must not fly the ship"
        />
        <input
          type="range"
          min={0}
          max={100}
          defaultValue={50}
          style={fieldStyle}
          data-testid="sandbox-range"
          aria-label="Slider: the arrow keys must move it, not the turbines"
        />
        <button type="button" className="fac-btn" style={smallButton} data-testid="sandbox-button">
          focus me
        </button>
      </div>
    </>
  );
}

export default function ControlsSandbox() {
  return (
    <div className="app">
      <div style={backdropStyle} />
      <div style={deckStyle} />
      <ControlsManager />
      <div className="ui-root">
        <div className="fac-panel" style={panelStyle}>
          <InputReadout />
          <ActionLog />
          <StateRow />
        </div>
        <TouchControls />
      </div>
    </div>
  );
}
