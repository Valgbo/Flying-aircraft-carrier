/**
 * Input sandbox (/a10/?sandbox=input, dev server): the controls panel beside a live monitor of
 * what the input layer produces — stick, pedals, levers, trigger detent, held switches, the
 * commands it queues and the view input. A stand-in aircraft applies the switch commands so the
 * two-way keys can be seen working. OWNED BY THE INPUT MODULE.
 */
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Switch } from '../../../engine';
import { createPilotInput, realismFlags } from '../../core/sim';
import type { Command, Sim } from '../../core/types';
import ControlsPanel from '../../input/ControlsPanel';
import type { EngineOutput } from '../../input/engine';
import { attachInputRuntime, type RuntimeStatus } from '../../input/runtime';
import { viewInput } from '../../input/viewInput';
import { useA10Store } from '../../state/store';
import '../../input/input.css';

const PAGE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 660px) minmax(0, 1fr)',
  gap: 16,
  padding: 16,
  overflow: 'hidden',
  background: 'var(--fac-bg)',
  color: 'var(--fac-text)',
  userSelect: 'none',
};
const COLUMN: CSSProperties = { minHeight: 0, overflowY: 'auto', padding: '0 16px 16px' };
const MONO: CSSProperties = { fontFamily: 'var(--fac-mono)', fontSize: 12 };

/** The panel does not re-render with the monitor (20 Hz). */
const Panel = memo(ControlsPanel);

interface Snapshot {
  out: EngineOutput;
  status: RuntimeStatus;
  view: typeof viewInput;
  log: string[];
  switches: string;
}

/** A stand-in aircraft: just the state the input layer reads, and the switch logic. */
function standInSim(twoStage: boolean): Sim {
  return {
    options: {
      seed: 1,
      scenario: 'empty',
      realism: { ...realismFlags('authentic'), twoStageTrigger: twoStage },
      loadoutId: '',
    },
    time: 0,
    stepCount: 0,
    input: createPilotInput(),
    commands: [],
    avionics: { masterArm: 'SAFE', laserArm: 'SAFE', soi: 'HUD', gunPac: 'ARM', masterMode: 'NAV' },
    aircraft: { flapHandle: 0, altitudeAlert: 0, speedBrakeCmd: 0 },
    gun: { firing: false, spin: 0 },
    events: [],
  } as unknown as Sim;
}

function describeCommand(c: Command): string {
  const { type, ...rest } = c;
  const args = Object.entries(rest)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
  return `${type} ${args}`.trim();
}

function apply(sim: Sim, c: Command): void {
  const av = sim.avionics as unknown as Record<string, string>;
  const ac = sim.aircraft as unknown as Record<string, number>;
  const cycle = (list: string[], cur: string) => list[(list.indexOf(cur) + 1) % list.length];
  switch (c.type) {
    case 'masterArm':
      av.masterArm = c.value === 'cycle' ? cycle(['SAFE', 'TRAIN', 'ARM'], av.masterArm) : c.value;
      break;
    case 'laserArm':
      av.laserArm = c.value === 'cycle' ? cycle(['SAFE', 'TRAIN', 'ARM'], av.laserArm) : c.value;
      break;
    case 'gunPac':
      av.gunPac = cycle(['SAFE', 'GUNARM', 'ARM'], av.gunPac);
      break;
    case 'masterMode':
      av.masterMode = cycle(['NAV', 'GUNS', 'CCIP', 'CCRP'], av.masterMode);
      break;
    case 'soi':
      av.soi = c.value;
      break;
    case 'flaps':
      ac.flapHandle =
        c.value === 'up'
          ? Math.max(0, ac.flapHandle - 1)
          : c.value === 'down'
            ? Math.min(2, ac.flapHandle + 1)
            : c.value;
      break;
    case 'altitudeAlert':
      ac.altitudeAlert = c.value;
      break;
    default:
      break;
  }
}

function Bar({
  label,
  value,
  centred = true,
}: {
  label: string;
  value: number;
  centred?: boolean;
}) {
  const v = Math.max(centred ? -1 : 0, Math.min(1, value));
  const left = centred ? (v < 0 ? 50 + v * 50 : 50) : 0;
  const width = centred ? Math.abs(v) * 50 : v * 100;
  return (
    <div className="a10in-axis" style={{ gridTemplateColumns: '84px minmax(0, 1fr) 48px' }}>
      <span>{label}</span>
      <div className="a10in-bar" data-centred={centred ? '' : undefined}>
        <div className="a10in-bar__fill" style={{ left: `${left}%`, width: `${width}%` }} />
      </div>
      <span className="a10in-axis__value">{value.toFixed(2)}</span>
    </div>
  );
}

function Lamp({ on, children }: { on: boolean; children: string }) {
  return (
    <span className="a10in-btn" data-on={on ? '' : undefined} style={{ padding: '0 8px' }}>
      {children}
    </span>
  );
}

export default function InputSandbox() {
  const viewRef = useRef<HTMLDivElement>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [twoStage, setTwoStage] = useState(true);
  const paused = useA10Store((s) => s.paused);
  const view = useA10Store((s) => s.view);
  const mouseStick = useA10Store((s) => s.settings.mouseStick);
  const twoStageRef = useRef(twoStage);
  twoStageRef.current = twoStage;

  useEffect(() => {
    useA10Store.setState({ screen: 'flight', paused: false, settingsOpen: false });
    const sim = standInSim(true);
    const log: string[] = [];
    const runtime = attachInputRuntime({ target: () => viewRef.current });
    let raf = 0;
    let last = performance.now();
    let publish = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      (sim.options.realism as { twoStageTrigger: boolean }).twoStageTrigger = twoStageRef.current;
      const out = runtime.frame(dt, sim);
      for (const c of sim.commands) {
        apply(sim, c);
        log.unshift(describeCommand(c));
      }
      sim.commands.length = 0;
      for (const p of out.presses) if (!p.long && p.origin) log.unshift(`press ${p.id}`);
      log.length = Math.min(log.length, 14);
      const ac = sim.aircraft as unknown as Record<string, number>;
      ac.speedBrakeCmd = Math.max(
        0,
        Math.min(1, ac.speedBrakeCmd + sim.input.speedBrake * dt * 0.6),
      );
      (sim.gun as unknown as Record<string, unknown>).firing = sim.input.trigger === 2;
      viewInput.lookDeltaX = 0; // nobody consumes them here
      viewInput.lookDeltaY = 0;
      publish += dt;
      if (publish > 1 / 20) {
        publish = 0;
        const av = sim.avionics as unknown as Record<string, string>;
        setSnap({
          out: { ...out, throttle: [out.throttle[0], out.throttle[1]], presses: [] },
          status: runtime.status(),
          view: { ...viewInput },
          log: [...log],
          switches: `MASTER ARM ${av.masterArm} · GUN/PAC ${av.gunPac} · LASER ${av.laserArm} · MODE ${av.masterMode} · SOI ${av.soi} · FLAPS ${['UP', 'MVR', 'DN'][ac.flapHandle]} · ALT ALERT ${Math.round(ac.altitudeAlert / 0.3048)} ft · SPEED BRAKE ${Math.round(ac.speedBrakeCmd * 100)} %`,
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      runtime.detach();
    };
  }, []);

  const o = snap?.out;
  const stage = o?.trigger ?? 0;
  return (
    <div style={PAGE}>
      <div
        className="settings fac-panel"
        style={{ display: 'flex', flexDirection: 'column', minHeight: 0, width: '100%' }}
      >
        <div className="settings-head">
          <h2 className="settings-title">Controls</h2>
        </div>
        <div style={COLUMN}>
          <Panel />
        </div>
      </div>
      <div style={{ ...COLUMN, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div
          ref={viewRef}
          data-testid="sandbox-view"
          style={{
            position: 'relative',
            height: 150,
            flex: 'none',
            border: '1px solid var(--fac-border)',
            borderRadius: 10,
            background: 'radial-gradient(circle at 50% 40%, #1d3a24, #0b1208 70%)',
            display: 'grid',
            placeItems: 'center',
            textAlign: 'center',
            fontSize: 12,
            color: 'var(--fac-text-dim)',
            cursor: snap?.status.cursorFree ? 'crosshair' : 'pointer',
          }}
        >
          <span style={{ maxWidth: 360 }}>
            {snap?.status.pointerLocked
              ? `Pointer locked: ${mouseStick ? 'the mouse flies the stick' : 'mouse look'}. Esc pauses, Left Alt frees the cursor.`
              : snap?.status.cursorFree
                ? `Cursor free: click here → click at ${snap.view.click ? `${snap.view.click.x.toFixed(2)}, ${snap.view.click.y.toFixed(2)}` : '—'}`
                : 'Flight view stand-in: click to lock the pointer (mouse look or mouse stick).'}
          </span>
          {mouseStick && o && (
            <div
              className="a10in-stick"
              style={{ width: 90, height: 90, margin: '-45px 0 0 -45px' }}
            >
              <div
                className="a10in-stick__dot"
                style={{ transform: `translate(${o.mouseStickX * 45}px, ${o.mouseStickY * 45}px)` }}
              />
            </div>
          )}
        </div>

        <div className="fac-panel" style={{ padding: 12 }}>
          <div
            style={{
              display: 'flex',
              gap: 16,
              alignItems: 'center',
              flexWrap: 'wrap',
              fontSize: 12,
            }}
          >
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span id="sbx-pause">Paused</span>
              <Switch
                checked={paused}
                onChange={(p) => useA10Store.getState().setPaused(p)}
                labelledBy="sbx-pause"
              />
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span id="sbx-two">Two-stage trigger</span>
              <Switch checked={twoStage} onChange={setTwoStage} labelledBy="sbx-two" />
            </label>
            <span style={MONO}>VIEW {view.toUpperCase()}</span>
            <span style={MONO}>{snap?.status.live ? 'LIVE' : 'NOT LIVE'}</span>
          </div>
        </div>

        <div
          className="fac-panel"
          style={{ padding: 12, display: 'grid', gap: 5 }}
          data-testid="sandbox-monitor"
        >
          <h4 className="a10in-group__title" style={{ margin: '0 0 4px' }}>
            Stick, pedals, trim
          </h4>
          <Bar label="Pitch" value={o?.pitch ?? 0} />
          <Bar label="Roll" value={o?.roll ?? 0} />
          <Bar label="Rudder" value={o?.rudder ?? 0} />
          <Bar label="Trim pitch" value={o?.trimPitch ?? 0} />
          <Bar label="Trim roll" value={o?.trimRoll ?? 0} />
          <Bar label="Trim yaw" value={o?.trimYaw ?? 0} />
          <h4 className="a10in-group__title" style={{ margin: '8px 0 4px' }}>
            Throttle and slew
          </h4>
          <Bar label="Throttle L" value={o?.throttle[0] ?? 0} centred={false} />
          <Bar label="Throttle R" value={o?.throttle[1] ?? 0} centred={false} />
          <Bar label="Slew X" value={o?.slewX ?? 0} />
          <Bar label="Slew Y" value={o?.slewY ?? 0} />
          <Bar label="Look X" value={o?.lookX ?? 0} />
          <Bar label="Look Y" value={o?.lookY ?? 0} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            <Lamp on={stage >= 1}>
              {stage >= 1 ? (stage === 2 ? 'TRIGGER 2 · FIRE' : 'TRIGGER 1 · PAC') : 'TRIGGER 0'}
            </Lamp>
            <Lamp on={!!o?.weaponRelease}>RELEASE</Lamp>
            <Lamp on={!!o?.laser}>LASER</Lamp>
            <Lamp on={(o?.speedBrake ?? 0) !== 0}>{`SPD BRK ${o?.speedBrake ?? 0}`}</Lamp>
            <Lamp on={!!o?.zoomHeld}>ZOOM</Lamp>
            <Lamp on={!!o?.lookAtSpi}>LOOK SPI</Lamp>
            <Lamp on={!!snap?.status.cursorFree}>CURSOR</Lamp>
          </div>
          <p style={{ ...MONO, margin: '8px 0 0', color: 'var(--fac-text-dim)' }}>
            {snap?.switches}
          </p>
        </div>

        <div className="fac-panel" style={{ padding: 12 }}>
          <h4 className="a10in-group__title" style={{ margin: '0 0 6px' }}>
            Commands and presses (newest first)
          </h4>
          <div
            style={{ ...MONO, display: 'grid', alignContent: 'start', gap: 2, minHeight: 60 }}
            data-testid="sandbox-log"
          >
            {(snap?.log ?? []).map((l, i) => (
              <span key={i} style={{ opacity: 1 - i * 0.06 }}>
                {l}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
