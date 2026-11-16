/**
 * Flight sandbox (/a10/?sandbox=flight, dev server): the six-degree-of-freedom flight model
 * flown alone (core/flight/testbed.ts) with the keyboard, no 3D. Strip charts of indicated
 * airspeed, altitude, angle of attack and load factor over the last minute, and a panel of the
 * aircraft state, engines, controls and warnings. OWNED BY THE FLIGHT MODULE.
 *
 * Keys: arrows stick · Z / X rudder · PageUp / PageDown throttle · B / V speed brakes out / in ·
 * F flaps · G gear · Ctrl + arrows trim · P autopilot · O autopilot mode · 1 / 2 / 3 realism
 * preset · T turbulence · R restart · Space pause.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { MAX_STEPS_PER_FRAME, SIM_DT } from '../../core/constants';
import { autopilotCommand, setFlapHandle, setGear } from '../../core/flight';
import { createTestbed, stepFlightOnly } from '../../core/flight/testbed';
import type { RealismPreset, Sim } from '../../core/types';
import { msToFpm, msToKt, mToFt, radToDeg } from '../../core/units';

const PAGE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 360px',
  gap: 16,
  padding: 16,
  background: 'var(--fac-bg, #0d1014)',
  color: 'var(--fac-text, #d8dee6)',
  fontFamily: 'var(--fac-mono, ui-monospace, monospace)',
  fontSize: 12,
  userSelect: 'none',
};

/** Samples kept per chart (60 s at 20 Hz). */
const SAMPLES = 1200;
const SAMPLE_EVERY = 6; // steps (120 Hz / 6 = 20 Hz)
const KEYS_HELP =
  'arrows stick · Z/X rudder · PgUp/PgDn throttle · B/V speed brake · F flaps · G gear · ' +
  'Ctrl+arrows trim · P autopilot · O AP mode · 1/2/3 preset · T turbulence · R restart · Space pause';

interface Chart {
  label: string;
  unit: string;
  data: Float32Array;
  min: number;
  max: number;
  /** Reference lines (limits). */
  lines: number[];
}

function makeCharts(): Chart[] {
  return [
    {
      label: 'IAS',
      unit: 'kn',
      data: new Float32Array(SAMPLES),
      min: 0,
      max: 500,
      lines: [120, 450],
    },
    { label: 'ALT', unit: 'ft', data: new Float32Array(SAMPLES), min: NaN, max: NaN, lines: [] },
    { label: 'AOA', unit: '°', data: new Float32Array(SAMPLES), min: -5, max: 30, lines: [0] },
    {
      label: 'G',
      unit: 'g',
      data: new Float32Array(SAMPLES),
      min: -3,
      max: 8,
      lines: [1, 7.33, -3],
    },
  ];
}

function newFlight(preset: RealismPreset, turbulence: number): Sim {
  return createTestbed({
    altitude: 8000 * 0.3048,
    ias: 250 * 0.514444,
    groundHeight: 150,
    turbulence,
    realism: preset,
  });
}

function drawCharts(canvas: HTMLCanvasElement, charts: Chart[], count: number, head: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const rowH = h / charts.length;
  ctx.font = '12px ui-monospace, monospace';
  charts.forEach((c, row) => {
    const top = row * rowH + 6;
    const height = rowH - 18;
    let lo = c.min;
    let hi = c.max;
    if (Number.isNaN(lo)) {
      lo = Infinity;
      hi = -Infinity;
      for (let i = 0; i < count; i++) {
        const v = c.data[(head - count + i + SAMPLES) % SAMPLES];
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      if (!Number.isFinite(lo)) {
        lo = 0;
        hi = 1;
      }
      const pad = Math.max(50, (hi - lo) * 0.1);
      lo -= pad;
      hi += pad;
    }
    const y = (v: number) => top + height - ((v - lo) / (hi - lo)) * height;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.strokeRect(48, top, w - 56, height);
    ctx.fillStyle = 'rgba(216,222,230,0.7)';
    ctx.fillText(`${c.label} (${c.unit})`, 4, top + 12);
    ctx.fillText(hi.toFixed(0), 4, top + 26);
    ctx.fillText(lo.toFixed(0), 4, top + height);
    ctx.strokeStyle = 'rgba(255,170,60,0.5)';
    for (const l of c.lines) {
      if (l < lo || l > hi) continue;
      ctx.beginPath();
      ctx.moveTo(48, y(l));
      ctx.lineTo(w - 8, y(l));
      ctx.stroke();
    }
    ctx.strokeStyle = '#7fd4ff';
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const v = c.data[(head - count + i + SAMPLES) % SAMPLES];
      const x = 48 + ((w - 56) * (SAMPLES - count + i)) / (SAMPLES - 1);
      if (i === 0) ctx.moveTo(x, y(v));
      else ctx.lineTo(x, y(v));
    }
    ctx.stroke();
  });
}

function statusText(sim: Sim, paused: boolean, preset: RealismPreset): string {
  const ac = sim.aircraft;
  const e = ac.engines;
  const warnings = (Object.keys(ac.warnings) as (keyof typeof ac.warnings)[])
    .filter((k) => ac.warnings[k])
    .join(' ');
  const ap = ac.autopilot;
  const f = (v: number, d = 0) => v.toFixed(d);
  return [
    `${paused ? 'PAUSED  ' : ''}t ${f(sim.time, 1)} s   preset ${preset}   turbulence ${f(sim.world.turbulence, 2)}`,
    '',
    `IAS ${f(msToKt(ac.ias))} kn   TAS ${f(msToKt(ac.tas))} kn   M ${f(ac.mach, 2)}`,
    `ALT ${f(mToFt(ac.altitude))} ft   AGL ${f(mToFt(ac.agl))} ft   VS ${f(msToFpm(ac.verticalSpeed))} fpm`,
    `HDG ${f(radToDeg(ac.heading))}°   PITCH ${f(radToDeg(ac.pitch), 1)}°   BANK ${f(radToDeg(ac.bank), 1)}°`,
    `γ ${f(radToDeg(ac.flightPathAngle), 1)}°   TRK ${f(radToDeg(ac.track))}°`,
    `α ${f(radToDeg(ac.alpha), 1)}° (stall ${f(radToDeg(ac.stallAlpha), 1)}°)   β ${f(radToDeg(ac.beta), 1)}°`,
    `g ${f(ac.gLoad, 2)}   max ${f(ac.maxG, 2)}   min ${f(ac.minG, 2)}   limit +${f(ac.gLimitPositive, 2)}`,
    `CL ${f(ac.liftCoefficient, 3)}   CD ${f(ac.dragCoefficient, 4)}   flow ${f(ac.fcs.flowAttachment, 2)}   buffet ${f(ac.buffet, 2)}`,
    '',
    `ENG  lever ${f(e[0].lever, 2)} / ${f(e[1].lever, 2)}`,
    `     N1 ${f(e[0].n1 * 100)} %  N2 ${f(e[0].n2 * 100)} %  ITT ${f(e[0].itt)} °C`,
    `     thrust ${f(e[0].thrust / 1000, 1)} + ${f(e[1].thrust / 1000, 1)} kN   fuel flow ${f((e[0].fuelFlow + e[1].fuelFlow) * 7936.6)} lb/h`,
    `MASS ${f(ac.mass)} kg   fuel ${f(ac.fuel)} kg   CG z ${f(ac.cgBody.z, 2)} m`,
    '',
    `SURF elev ${f(ac.surfaces.elevator, 2)}  ail ${f(ac.surfaces.aileron, 2)}  rud ${f(ac.surfaces.rudder, 2)}`,
    `     flaps ${f(radToDeg(ac.surfaces.flaps), 1)}° (handle ${ac.flapHandle})  slats ${f(ac.surfaces.slats, 1)}  speed brake ${f(ac.surfaces.speedBrake * 100)} %  gear ${f(ac.gearPosition, 2)}`,
    `TRIM pitch ${f(ac.trim.pitch, 2)}  roll ${f(ac.trim.roll, 2)}  yaw ${f(ac.trim.yaw, 2)}`,
    `AP   ${ap.engaged ? 'ENGAGED' : 'off'} ${ap.mode}`,
    '',
    `WARN ${warnings || '—'}`,
    ac.crashed ? 'CRASHED — R to restart' : '',
  ].join('\n');
}

export default function FlightSandbox() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [text, setText] = useState('');

  useEffect(() => {
    let preset: RealismPreset = 'authentic';
    let turbulence = 0.15;
    let sim = newFlight(preset, turbulence);
    let throttle = sim.input.throttle[0];
    let charts = makeCharts();
    let head = 0;
    let count = 0;
    let paused = false;
    let accumulator = 0;
    let last = performance.now();
    let textClock = 0;
    let raf = 0;
    const held = new Set<string>();
    const stick = { pitch: 0, roll: 0, rudder: 0 };

    const restart = () => {
      sim = newFlight(preset, turbulence);
      throttle = sim.input.throttle[0];
      charts = makeCharts();
      head = 0;
      count = 0;
    };
    const down = (e: KeyboardEvent) => {
      held.add(e.code);
      if (e.repeat) return;
      switch (e.code) {
        case 'KeyF':
          setFlapHandle(sim, ((sim.aircraft.flapHandle + 1) % 3) as 0 | 1 | 2);
          break;
        case 'KeyG':
          setGear(sim, !sim.aircraft.gearDown);
          break;
        case 'KeyP':
          autopilotCommand(sim, 'toggle');
          break;
        case 'KeyO':
          autopilotCommand(sim, 'mode');
          break;
        case 'KeyR':
          restart();
          break;
        case 'KeyT':
          turbulence = turbulence > 0.5 ? 0 : turbulence + 0.3;
          sim.world.turbulence = turbulence;
          break;
        case 'Space':
          paused = !paused;
          break;
        case 'Digit1':
        case 'Digit2':
        case 'Digit3':
          preset = (['authentic', 'standard', 'relaxed'] as const)[Number(e.code.slice(5)) - 1];
          restart();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => held.delete(e.code);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);

    /** Keyboard to stick: the stick moves toward the held direction and recentres. */
    const axis = (value: number, plus: boolean, minus: boolean, dt: number) => {
      const target = (plus ? 1 : 0) - (minus ? 1 : 0);
      const rate = target === 0 ? 4 : 2.5;
      const d = target - value;
      return value + Math.max(-rate * dt, Math.min(rate * dt, d));
    };

    const frame = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const ctrl = held.has('ControlLeft') || held.has('ControlRight');
      const i = sim.input;
      stick.pitch = axis(
        stick.pitch,
        !ctrl && held.has('ArrowDown'),
        !ctrl && held.has('ArrowUp'),
        dt,
      );
      stick.roll = axis(
        stick.roll,
        !ctrl && held.has('ArrowRight'),
        !ctrl && held.has('ArrowLeft'),
        dt,
      );
      stick.rudder = axis(stick.rudder, held.has('KeyX'), held.has('KeyZ'), dt);
      i.pitch = stick.pitch;
      i.roll = stick.roll;
      i.rudder = stick.rudder;
      i.trimPitch = ctrl ? (held.has('ArrowDown') ? 1 : 0) - (held.has('ArrowUp') ? 1 : 0) : 0;
      i.trimRoll = ctrl ? (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0) : 0;
      if (held.has('PageUp')) throttle = Math.min(1, throttle + dt * 0.4);
      if (held.has('PageDown')) throttle = Math.max(0, throttle - dt * 0.4);
      i.throttle[0] = throttle;
      i.throttle[1] = throttle;
      i.speedBrake = held.has('KeyB') ? 1 : held.has('KeyV') ? -1 : 0;

      if (!paused) {
        accumulator += dt;
        let n = 0;
        while (accumulator >= SIM_DT && n < MAX_STEPS_PER_FRAME) {
          stepFlightOnly(sim);
          accumulator -= SIM_DT;
          n++;
          if (sim.stepCount % SAMPLE_EVERY === 0) {
            const ac = sim.aircraft;
            charts[0].data[head] = msToKt(ac.ias);
            charts[1].data[head] = mToFt(ac.altitude);
            charts[2].data[head] = radToDeg(ac.alpha);
            charts[3].data[head] = ac.gLoad;
            head = (head + 1) % SAMPLES;
            count = Math.min(SAMPLES, count + 1);
          }
        }
        if (n === MAX_STEPS_PER_FRAME) accumulator = 0;
      }
      sim.events.length = 0;
      if (canvasRef.current) drawCharts(canvasRef.current, charts, count, head);
      textClock += dt;
      if (textClock > 0.1) {
        textClock = 0;
        setText(statusText(sim, paused, preset));
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  return (
    <div style={PAGE}>
      <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', minHeight: 0 }}>
        <div style={{ opacity: 0.7, marginBottom: 8 }}>{KEYS_HELP}</div>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', minHeight: 0 }} />
      </div>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowY: 'auto' }}>{text}</pre>
    </div>
  );
}
