/**
 * HUD sandbox: the flight HUD (and the turbine panel with ?panel=1) over a plain sky-to-sea
 * gradient, fed by a small fake flight that writes `sim` every animation frame. No 3D.
 *
 *   /?sandbox=hud&state=hover|climb|cruise|bank|afloat|engineout|manual|low|ceiling
 *
 * Extra parameters: panel=1 (open the turbine panel), screen=ops, freeze=1 (no wobble, for
 * exact readings), and overrides hdg / roll / pitch (degrees), alt (m), vs (m/s), kts.
 * The usual flags apply too (?touch=1 forces the touch layout).
 *
 * The fake flight honours the contract the real driver follows: in assist mode the turbine
 * state is mirrored into the manual levers, in manual mode the levers command the turbines
 * (with spool and slew lag) and the ship climbs or sinks with the resulting thrust.
 */
import { useEffect } from 'react';
import { Euler } from 'three';
import { debugFlags } from '../../config/debugFlags';
import { FLOATING_ALTITUDE } from '../../config/layout';
import { HOVER_THROTTLE, PHYS, WEIGHT } from '../../config/physicsConfig';
import { sim, updateDerived } from '../../state/sim';
import { publishTelemetry } from '../../state/telemetry';
import { useGameStore } from '../../state/useGameStore';
import { DEG2RAD, clamp, clamp01, damp, moveToward } from '../../utils/math';
import HUD from '../../ui/HUD';
import TurbinePanel from '../../ui/TurbinePanel';
import '../../styles/global.css';

interface Scenario {
  altitude: number;
  headingDeg: number;
  /** Heading change, degrees per second. */
  turnRate: number;
  rollDeg: number;
  pitchDeg: number;
  verticalSpeed: number;
  speedKts: number;
  throttle: number;
  tiltDeg: number;
  /** Target altitude relative to the ship, m. */
  targetLead: number;
  /** Index of a disabled turbine, or -1. */
  engineOut: number;
  manual: boolean;
}

const BASE: Scenario = {
  altitude: 420,
  headingDeg: 90,
  turnRate: 0,
  rollDeg: 0,
  pitchDeg: 0,
  verticalSpeed: 0,
  speedKts: 0,
  throttle: HOVER_THROTTLE,
  tiltDeg: 0,
  targetLead: 0,
  engineOut: -1,
  manual: false,
};

const SCENARIOS: Record<string, Scenario> = {
  hover: BASE,
  climb: {
    ...BASE,
    altitude: 180,
    headingDeg: 45,
    pitchDeg: 3,
    verticalSpeed: 12,
    throttle: 0.86,
    targetLead: 90,
  },
  cruise: {
    ...BASE,
    altitude: 1200,
    headingDeg: 352,
    turnRate: 2.5,
    rollDeg: 4,
    pitchDeg: -1.5,
    speedKts: 112,
    throttle: 0.82,
    tiltDeg: 44,
  },
  bank: {
    ...BASE,
    altitude: 330,
    headingDeg: 200,
    turnRate: 4,
    rollDeg: 24,
    pitchDeg: 17,
    verticalSpeed: -18,
    speedKts: 60,
    throttle: 0.5,
    tiltDeg: 20,
    targetLead: -60,
  },
  afloat: {
    ...BASE,
    altitude: FLOATING_ALTITUDE,
    headingDeg: 270,
    throttle: 0,
  },
  engineout: {
    ...BASE,
    altitude: 500,
    headingDeg: 135,
    rollDeg: 6,
    verticalSpeed: -2.5,
    throttle: 0.97,
    engineOut: 1,
    targetLead: 20,
  },
  manual: { ...BASE, altitude: 300, headingDeg: 20, manual: true },
  low: {
    ...BASE,
    altitude: 44,
    headingDeg: 300,
    verticalSpeed: -3,
    throttle: 0.55,
    targetLead: -20,
  },
  ceiling: { ...BASE, altitude: 3340, headingDeg: 180, verticalSpeed: 1.5, throttle: 0.9 },
};

function numberParam(name: string): number | null {
  const raw = debugFlags.params.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function resolveScenario(): Scenario {
  const name = debugFlags.params.get('state') ?? 'hover';
  const scenario = { ...(SCENARIOS[name] ?? BASE) };
  scenario.headingDeg = numberParam('hdg') ?? scenario.headingDeg;
  scenario.rollDeg = numberParam('roll') ?? scenario.rollDeg;
  scenario.pitchDeg = numberParam('pitch') ?? scenario.pitchDeg;
  scenario.altitude = numberParam('alt') ?? scenario.altitude;
  scenario.verticalSpeed = numberParam('vs') ?? scenario.verticalSpeed;
  scenario.speedKts = numberParam('kts') ?? scenario.speedKts;
  return scenario;
}

const STEP = 1 / 60;
const KTS_TO_MS = 0.514444;
const _euler = new Euler(0, 0, 0, 'YXZ');

/** Advance the fake flight by one fixed step and publish it. Allocation-free. */
function stepFakeFlight(scenario: Scenario, wobble: number, dt: number): void {
  const store = useGameStore.getState();
  const assist = store.assistEnabled;
  const c = sim.carrier;
  sim.time += dt;
  sim.dt = dt;
  const time = sim.time;

  // --- turbines: commands from the fake computer (assist) or the manual levers ---
  for (let i = 0; i < 4; i++) {
    const t = sim.turbines[i];
    if (assist) {
      const trim = wobble * 0.03 * Math.sin(time * 0.9 + i * 1.7);
      t.throttleCmd = clamp01(scenario.throttle + trim);
      t.tiltCmd = clamp(
        scenario.tiltDeg * DEG2RAD + wobble * 0.02 * Math.sin(time * 0.6 + i),
        PHYS.tiltMin,
        PHYS.tiltMax,
      );
    } else {
      t.throttleCmd = clamp01(sim.controls.manualThrottle[i]);
      t.tiltCmd = clamp(sim.controls.manualTilt[i], PHYS.tiltMin, PHYS.tiltMax);
    }
    if (!t.enabled) t.throttleCmd = 0;
    const rate = t.throttleCmd > t.throttle ? PHYS.spoolUpRate : PHYS.spoolDownRate;
    t.throttle = damp(t.throttle, t.throttleCmd, rate * 2.5, dt);
    t.tilt = moveToward(t.tilt, t.tiltCmd, PHYS.tiltRate * dt);
    t.thrust = t.throttle * PHYS.maxThrust * Math.exp(-c.position.y / PHYS.densityScaleHeight);
    if (assist) {
      sim.controls.manualThrottle[i] = t.throttle;
      sim.controls.manualTilt[i] = t.tilt;
    }
  }

  // --- ship motion ---
  let verticalSpeed = scenario.verticalSpeed + wobble * 0.4 * Math.sin(time * 0.7);
  if (!assist) {
    // manual: the ship rises or sinks with the vertical thrust it is given
    let lift = 0;
    for (let i = 0; i < 4; i++) lift += sim.turbines[i].thrust * Math.cos(sim.turbines[i].tilt);
    const afloat = c.position.y <= FLOATING_ALTITUDE;
    const accel = (lift - WEIGHT) / PHYS.mass - c.velocity.y * 0.25;
    verticalSpeed = afloat && accel < 0 ? 0 : c.velocity.y + accel * dt;
    c.position.y = Math.max(FLOATING_ALTITUDE, c.position.y + verticalSpeed * dt);
  }
  const heading = scenario.headingDeg + scenario.turnRate * time;
  const roll = scenario.rollDeg + wobble * 1.2 * Math.sin(time * 0.8);
  const pitch = scenario.pitchDeg + wobble * 0.8 * Math.sin(time * 0.55 + 1);
  // heading is clockwise from north, a positive rotation about +Y turns to port;
  // roll > 0 puts the starboard side down, i.e. a negative rotation about the bow axis
  _euler.set(pitch * DEG2RAD, -heading * DEG2RAD, -roll * DEG2RAD, 'YXZ');
  c.quaternion.setFromEuler(_euler);
  const speed = scenario.speedKts * KTS_TO_MS;
  c.velocity.set(
    Math.sin(heading * DEG2RAD) * speed,
    verticalSpeed,
    -Math.cos(heading * DEG2RAD) * speed,
  );
  if (assist) {
    sim.controls.targetAltitude = c.position.y + scenario.targetLead;
    sim.controls.tiltLever = scenario.tiltDeg * DEG2RAD;
  }

  updateDerived(dt);
  publishTelemetry();
}

export default function HudSandbox() {
  const screen = useGameStore((s) => s.screen);

  useEffect(() => {
    const scenario = resolveScenario();
    const wobble = debugFlags.params.get('freeze') === '1' ? 0 : 1;
    const store = useGameStore.getState();

    // setScreen resets the sim, so the scenario is applied after it
    store.setScreen(debugFlags.params.get('screen') === 'ops' ? 'ops' : 'flight');
    sim.carrier.position.set(0, scenario.altitude, 0);
    for (let i = 0; i < 4; i++) {
      const t = sim.turbines[i];
      t.enabled = i !== scenario.engineOut;
      t.throttle = t.enabled ? scenario.throttle : 0;
      t.throttleCmd = t.throttle;
      t.tilt = scenario.tiltDeg * DEG2RAD;
      t.tiltCmd = t.tilt;
      sim.controls.manualThrottle[i] = scenario.throttle;
      sim.controls.manualTilt[i] = t.tilt;
    }
    if (scenario.manual) useGameStore.getState().setAssistEnabled(false);
    if (debugFlags.params.get('panel') === '1') useGameStore.getState().setTurbinePanelOpen(true);

    let frame = 0;
    const tick = (): void => {
      stepFakeFlight(scenario, wobble, useGameStore.getState().paused ? 0 : STEP);
      frame = requestAnimationFrame(tick);
    };
    stepFakeFlight(scenario, wobble, 0);
    publishTelemetry(true);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  if (screen !== 'flight' && screen !== 'ops') return null;
  return (
    <div
      className="app"
      style={{
        background:
          'linear-gradient(180deg, #2f6fb4 0%, #8fc0e8 52%, #d6e8f2 58%, #1c5a85 59%, #0b2e4b 100%)',
      }}
    >
      <div className="ui-root">
        <HUD />
        <TurbinePanel />
      </div>
    </div>
  );
}
