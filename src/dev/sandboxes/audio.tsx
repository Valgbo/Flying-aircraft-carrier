/**
 * Audio sandbox: mounts <AudioManager /> on a plain page with a tiny driver that writes `sim`
 * from the sliders below, and level meters read from the dev handle `window.__FAC_AUDIO__`.
 * Audio starts on the first click or key press (browser autoplay rule).
 *
 *   /?sandbox=audio&throttle=0.8&speed=60&cam=left
 *
 * Parameters: throttle (0..1), speed (m/s), alt (ship altitude, m), g (g-load),
 * cam=near|far|left|right (listener position; it always faces the bow), jet=1 (a jet circling
 * the ship), muted=1, paused=1, scene=idle (menu ambience instead of flight).
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import AudioManager from '../../audio/AudioManager';
import { ONE_SHOT_KINDS } from '../../audio/oneShots';
import { debugFlags } from '../../config/debugFlags';
import { PHYS } from '../../config/physicsConfig';
import { emitEvent } from '../../state/events';
import { sim, updateDerived } from '../../state/sim';
import type { JetSim } from '../../state/types';
import { useGameStore } from '../../state/useGameStore';
import { clamp, damp } from '../../utils/math';
import { Quaternion, Vector3 } from 'three';

type CamPreset = 'near' | 'far' | 'left' | 'right';

/** Listener position relative to the ship (carrier axes; the ship heads north, bow toward -Z). */
const CAMERAS: Record<CamPreset, [number, number, number]> = {
  near: [0, 30, 60],
  far: [0, 150, 900],
  left: [-220, 20, 0],
  right: [220, 20, 0],
};

function numberParam(name: string, fallback: number): number {
  const raw = debugFlags.params.get(name);
  const value = raw === null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function camParam(): CamPreset {
  const raw = debugFlags.params.get('cam');
  return raw === 'far' || raw === 'left' || raw === 'right' ? raw : 'near';
}

/** What the driver reads every frame. Mutated by the inputs; never triggers a render itself. */
const controls = {
  throttle: clamp(numberParam('throttle', 0.55), 0, 1),
  speed: clamp(numberParam('speed', 0), 0, 150),
  altitude: clamp(numberParam('alt', 420), 5, 1500),
  gLoad: clamp(numberParam('g', 1), -1, 4),
  cam: camParam(),
  jet: debugFlags.params.get('jet') === '1',
  jetPower: 0.8,
};

const fakeJet: JetSim = {
  id: 99,
  phase: 'pattern',
  position: new Vector3(),
  quaternion: new Quaternion(),
  speed: 70,
  power: 0.8,
  gearDown: false,
};

/** Advance the fake flight by `dt` seconds of wall time (0 while paused). */
function stepSandbox(dt: number): void {
  const paused = useGameStore.getState().paused;
  sim.dt = paused ? 0 : dt;
  sim.time += sim.dt;

  const carrier = sim.carrier;
  carrier.position.set(0, controls.altitude, 0);
  carrier.quaternion.identity();
  carrier.velocity.set(0, 0, -controls.speed);
  sim.env.wind.set(0, 0, 0);
  for (const turbine of sim.turbines) {
    turbine.throttleCmd = turbine.enabled ? controls.throttle : 0;
    const rate = turbine.throttleCmd > turbine.throttle ? PHYS.spoolUpRate : PHYS.spoolDownRate;
    turbine.throttle = damp(turbine.throttle, turbine.throttleCmd, rate * 2, sim.dt);
    turbine.tilt = 0;
  }
  updateDerived(0);
  carrier.gLoad = controls.gLoad;

  const cam = CAMERAS[controls.cam];
  sim.camera.position.set(cam[0], controls.altitude + cam[1], cam[2]);
  sim.camera.quaternion.identity();

  if (controls.jet) {
    // a 400 m circle around the ship at 70 m/s: passes the listener, so the Doppler shift is audible
    const angle = sim.time * (fakeJet.speed / 400);
    fakeJet.position.set(Math.cos(angle) * 400, controls.altitude + 60, Math.sin(angle) * 400);
    fakeJet.power = controls.jetPower;
    if (sim.jets.length === 0) sim.jets.push(fakeJet);
  } else if (sim.jets.length > 0) {
    sim.jets.length = 0;
  }
}

/** Level (linear) -> bar length 0..1 on a -60..0 dB scale. */
function meter(level: number): number {
  if (level <= 1e-6) return 0;
  return clamp(1 + (20 * Math.log10(level)) / 60, 0, 1);
}

function drawMeters(canvas: HTMLCanvasElement): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const { width, height } = canvas;
  g.fillStyle = '#0c141d';
  g.fillRect(0, 0, width, height);
  const handle = window.__FAC_AUDIO__;
  const levels = handle?.getLevels();
  const rows: [string, number][] = [
    ['L', levels?.left ?? 0],
    ['R', levels?.right ?? 0],
    ['PEAK', levels?.peak ?? 0],
  ];
  const barX = 56;
  const barW = width - barX - 64;
  g.font = '12px ui-monospace, monospace';
  g.textBaseline = 'middle';
  rows.forEach(([label, value], i) => {
    const y = 12 + i * 26;
    g.fillStyle = '#9fb4c8';
    g.fillText(label, 10, y + 9);
    g.fillStyle = '#1b2a38';
    g.fillRect(barX, y, barW, 18);
    const m = meter(value);
    g.fillStyle = value >= 0.98 ? '#ff5a4d' : m > 0.8 ? '#f2c14e' : '#4fd18b';
    g.fillRect(barX, y, barW * m, 18);
    g.fillStyle = '#d7e3ee';
    g.fillText(value.toFixed(3), barX + barW + 8, y + 9);
  });
}

function statusText(): string {
  const handle = window.__FAC_AUDIO__;
  if (!handle) return 'Audio is off. Click anywhere or press a key to start it.';
  const s = handle.snapshot();
  const t = s.turbines
    .map((v) => `${v.roar.toFixed(3)}@${Math.round(v.whineHz)}Hz pan ${v.pan.toFixed(2)}`)
    .join('  |  ');
  return [
    `context: ${handle.state()}   nodes: ${handle.nodeCount()}   gate: ${s.gate}`,
    `master ${s.master.toFixed(2)}  engines ${s.engines.toFixed(2)}  effects ${s.effects.toFixed(2)}`,
    `turbines: ${t}`,
    `wind ${s.wind.toFixed(3)}  sea ${s.sea.toFixed(3)}  spray ${s.spray.toFixed(3)}  jet ${s.jets[0].level.toFixed(3)} @ ${Math.round(s.jets[0].pitch)} Hz`,
  ].join('\n');
}

const page: CSSProperties = {
  position: 'fixed',
  inset: 0,
  overflow: 'auto',
  padding: 20,
  background: '#0f1924',
  color: '#d7e3ee',
  font: '13px/1.5 system-ui, sans-serif',
  userSelect: 'none',
};
const panel: CSSProperties = {
  background: '#16232f',
  border: '1px solid #26394a',
  borderRadius: 8,
  padding: '12px 14px',
};
const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(300px, 1fr) minmax(300px, 1fr)',
  gap: 14,
  maxWidth: 920,
};
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, minHeight: 28 };
const button: CSSProperties = {
  background: '#22384b',
  color: '#d7e3ee',
  border: '1px solid #35536c',
  borderRadius: 5,
  padding: '4px 9px',
  font: 'inherit',
  cursor: 'pointer',
};

interface SliderProps {
  label: string;
  testId: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  onChange: (value: number) => void;
}

function Slider({ label, testId, min, max, step, value, unit = '', onChange }: SliderProps) {
  return (
    <label style={row}>
      <span style={{ width: 92 }}>{label}</span>
      <input
        data-testid={testId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ flex: 1 }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span style={{ width: 64, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {value.toFixed(step < 1 ? 2 : 0)}
        {unit}
      </span>
    </label>
  );
}

export default function AudioSandbox() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef<HTMLPreElement>(null);
  // re-render after an input changed `controls` or the sim switches
  const [, setRevision] = useState(0);
  const refresh = () => setRevision((n) => n + 1);
  const settings = useGameStore((s) => s.settings);
  const paused = useGameStore((s) => s.paused);
  const store = useGameStore.getState();

  useEffect(() => {
    const s = useGameStore.getState();
    if (debugFlags.params.get('scene') !== 'idle') s.setScreen('flight');
    if (debugFlags.params.get('muted') === '1') s.updateSettings({ muted: true });
    if (debugFlags.params.get('paused') === '1') s.setPaused(true);
    for (const turbine of sim.turbines) turbine.throttle = controls.throttle;

    let raf = 0;
    let last = performance.now();
    let statusAt = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      stepSandbox(clamp((now - last) / 1000, 0, 0.1));
      last = now;
      if (canvasRef.current) drawMeters(canvasRef.current);
      if (now - statusAt > 200 && statusRef.current) {
        statusAt = now;
        statusRef.current.textContent = statusText();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const set = <K extends keyof typeof controls>(key: K, value: (typeof controls)[K]) => {
    controls[key] = value;
    refresh();
  };
  const toggleEngine = (index: number) => {
    const turbine = sim.turbines[index];
    turbine.enabled = !turbine.enabled;
    // the flight driver announces switch changes; here the sandbox is the driver
    emitEvent('engineToggled', { index, enabled: turbine.enabled });
    refresh();
  };
  const fire = (kind: (typeof ONE_SHOT_KINDS)[number]) => {
    switch (kind) {
      case 'catapultHook':
        return emitEvent('jetCatapult', { jetId: 99, catapult: 0 });
      case 'catapultLaunch':
        return emitEvent('jetLaunch', { jetId: 99, catapult: 0 });
      case 'trap':
        return emitEvent('jetTrap', { jetId: 99, points: 100, grade: 'OK' });
      case 'waveOff':
        return emitEvent('jetWaveOff', { jetId: 99 });
      case 'liftOff':
        return emitEvent('liftOff');
      case 'splashdown':
        return emitEvent('splashdown', { sinkRate: 8 });
      case 'engineOn':
        return emitEvent('engineToggled', { index: 1, enabled: true });
      case 'engineOff':
        return emitEvent('engineToggled', { index: 1, enabled: false });
      case 'assistOn':
        return emitEvent('assistChanged', { enabled: true });
      case 'assistOff':
        return emitEvent('assistChanged', { enabled: false });
    }
  };

  return (
    <div style={page}>
      <AudioManager />
      <h1 style={{ font: '600 18px system-ui', margin: '0 0 12px' }}>Audio sandbox</h1>
      <div style={grid}>
        <section style={panel}>
          <Slider
            label="Throttle"
            testId="audio-throttle"
            min={0}
            max={1}
            step={0.01}
            value={controls.throttle}
            onChange={(v) => set('throttle', v)}
          />
          <Slider
            label="Airspeed"
            testId="audio-speed"
            min={0}
            max={150}
            step={1}
            value={controls.speed}
            unit=" m/s"
            onChange={(v) => set('speed', v)}
          />
          <Slider
            label="Altitude"
            testId="audio-altitude"
            min={5}
            max={1500}
            step={5}
            value={controls.altitude}
            unit=" m"
            onChange={(v) => set('altitude', v)}
          />
          <Slider
            label="g-load"
            testId="audio-g"
            min={-1}
            max={4}
            step={0.05}
            value={controls.gLoad}
            unit=" g"
            onChange={(v) => set('gLoad', v)}
          />
          <div style={row}>
            <span style={{ width: 92 }}>Listener</span>
            {(Object.keys(CAMERAS) as CamPreset[]).map((cam) => (
              <button
                key={cam}
                data-testid={`audio-cam-${cam}`}
                style={{ ...button, background: controls.cam === cam ? '#2f6f9f' : '#22384b' }}
                onClick={() => set('cam', cam)}
              >
                {cam}
              </button>
            ))}
          </div>
          <div style={row}>
            <span style={{ width: 92 }}>Engines</span>
            {sim.turbines.map((turbine, i) => (
              <label key={i} style={{ display: 'flex', gap: 4 }}>
                <input type="checkbox" checked={turbine.enabled} onChange={() => toggleEngine(i)} />
                {i + 1}
              </label>
            ))}
          </div>
          <div style={row}>
            <label style={{ display: 'flex', gap: 4, width: 92 }}>
              <input
                data-testid="audio-jet"
                type="checkbox"
                checked={controls.jet}
                onChange={(e) => set('jet', e.target.checked)}
              />
              Jet
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={controls.jetPower}
              style={{ flex: 1 }}
              onChange={(e) => set('jetPower', Number(e.target.value))}
            />
            <span style={{ width: 64, textAlign: 'right' }}>{controls.jetPower.toFixed(2)}</span>
          </div>
        </section>

        <section style={panel}>
          <Slider
            label="Master"
            testId="audio-master"
            min={0}
            max={1}
            step={0.01}
            value={settings.masterVolume}
            onChange={(v) => store.updateSettings({ masterVolume: v })}
          />
          <Slider
            label="Engines"
            testId="audio-engines"
            min={0}
            max={1}
            step={0.01}
            value={settings.engineVolume}
            onChange={(v) => store.updateSettings({ engineVolume: v })}
          />
          <Slider
            label="Effects"
            testId="audio-effects"
            min={0}
            max={1}
            step={0.01}
            value={settings.effectsVolume}
            onChange={(v) => store.updateSettings({ effectsVolume: v })}
          />
          <div style={row}>
            <label style={{ display: 'flex', gap: 4 }}>
              <input
                data-testid="audio-muted"
                type="checkbox"
                checked={settings.muted}
                onChange={(e) => store.updateSettings({ muted: e.target.checked })}
              />
              Muted
            </label>
            <label style={{ display: 'flex', gap: 4 }}>
              <input
                data-testid="audio-paused"
                type="checkbox"
                checked={paused}
                onChange={(e) => store.setPaused(e.target.checked)}
              />
              Paused
            </label>
          </div>
          <canvas
            ref={canvasRef}
            data-testid="audio-meters"
            width={400}
            height={90}
            style={{ width: '100%', borderRadius: 5, marginTop: 6 }}
          />
        </section>

        <section style={{ ...panel, gridColumn: '1 / -1' }}>
          <div style={{ ...row, flexWrap: 'wrap' }}>
            <span style={{ width: 92 }}>One-shots</span>
            {ONE_SHOT_KINDS.map((kind) => (
              <button
                key={kind}
                data-testid={`audio-shot-${kind}`}
                style={button}
                onClick={() => fire(kind)}
              >
                {kind}
              </button>
            ))}
          </div>
          <pre
            ref={statusRef}
            data-testid="audio-status"
            style={{
              margin: '10px 0 0',
              font: '12px/1.6 ui-monospace, monospace',
              color: '#9fb4c8',
              whiteSpace: 'pre-wrap',
            }}
          />
        </section>
      </div>
    </div>
  );
}
