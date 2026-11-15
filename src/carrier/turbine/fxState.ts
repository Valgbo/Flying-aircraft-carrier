/**
 * Per-turbine effect state derived from `sim` once per frame and shared by the nacelle
 * (Turbine.tsx) and the exhaust (TurbineExhaust.tsx), whichever of the two runs first.
 * Plain module state: no React, no allocations after start-up.
 */
import { Color, Quaternion, Vector3 } from 'three';
import { PALETTE } from '../../config/palette';
import { sim } from '../../state/sim';
import { getQuality } from '../../state/useQuality';
import { damp } from '../../utils/math';
import {
  carrierToNacelle,
  compressGlow,
  coreIntensity,
  driveLevel,
  glowIntensity,
  glowWhiteness,
} from './model';

export interface TurbineFx {
  /** Renderer frame this state was computed for (-1 = never). */
  frame: number;
  /** 1 = burning, 0 = shut down; eases toward the engine master switch. */
  lit: number;
  /** Engine drive 0..1 behind glow and exhaust (see driveLevel). */
  drive: number;
  /** Emissive multiplier of the combustion glow, flicker included. */
  glow: number;
  /** Emissive multiplier of the hot core. */
  core: number;
  glowColor: Color;
  /** Velocity of the ship relative to the air, in the tilting nacelle frame, m/s (clamped). */
  relVel: Vector3;
}

/** Light arriving from the environment, refreshed once per frame for all turbines. */
export const fxEnv = {
  frame: -1,
  /** Diffuse light on an upward-facing surface (for the unlit blur disc). */
  light: new Color(1, 1, 1),
  /** Colour of steam, haze and sea spray lit by sky and sun. */
  mist: new Color(1, 1, 1),
};

/** How fast the idle flame lights up / dies when the engine switch is thrown, 1/s. */
const LIGHT_RATE = 1.6;
/** Cap on the relative airspeed used for trailing effects, m/s. */
const MAX_REL_SPEED = 70;

const COOL = new Color(PALETTE.glowCool);
const WHITE = new Color(1, 1, 1);
const _q = new Quaternion();
const _v = new Vector3();

const states: TurbineFx[] = [0, 1, 2, 3].map(() => ({
  frame: -1,
  lit: 1,
  drive: 0,
  glow: 0,
  core: 0,
  glowColor: new Color(PALETTE.glowCool),
  relVel: new Vector3(),
}));

function syncEnv(frame: number): void {
  if (fxEnv.frame === frame) return;
  fxEnv.frame = frame;
  const { zenithColor: zenith, horizonColor: horizon, sunColor, sunDirection } = sim.env;
  const sun = Math.max(0, sunDirection.y);
  const direct = 0.25 * sun;
  fxEnv.light.setRGB(
    0.5 * zenith.r + 0.3 * horizon.r + direct * sunColor.r,
    0.5 * zenith.g + 0.3 * horizon.g + direct * sunColor.g,
    0.5 * zenith.b + 0.3 * horizon.b + direct * sunColor.b,
  );
  const lit = 0.3 * (0.35 + 0.65 * sun);
  fxEnv.mist.setRGB(
    Math.min(1, 0.55 * horizon.r + lit * sunColor.r),
    Math.min(1, 0.55 * horizon.g + lit * sunColor.g),
    Math.min(1, 0.55 * horizon.b + lit * sunColor.b),
  );
}

/**
 * Effect state of turbine `index` for the renderer frame `frame`
 * (`state.gl.info.render.frame` inside useFrame). Idempotent within a frame.
 */
export function syncTurbineFx(index: number, frame: number): TurbineFx {
  const fx = states[index];
  if (fx.frame === frame) return fx;
  const first = fx.frame < 0;
  fx.frame = frame;
  syncEnv(frame);

  const turbine = sim.turbines[index];
  const target = turbine.enabled ? 1 : 0;
  fx.lit = first ? target : damp(fx.lit, target, LIGHT_RATE, sim.dt);
  fx.drive = driveLevel(turbine.throttle, fx.lit);

  // a slight flame flicker, stronger the harder the engine burns
  const t = sim.time;
  const flicker =
    1 +
    (0.3 + 0.7 * fx.drive) *
      (0.035 * Math.sin(t * 41 + index * 1.9) + 0.025 * Math.sin(t * 67.3 + index * 4.1));
  const bloom = getQuality().bloom;
  const glow = glowIntensity(fx.drive) * flicker;
  const core = coreIntensity(fx.drive) * flicker;
  fx.glow = bloom ? glow : compressGlow(glow);
  fx.core = bloom ? core : compressGlow(core);
  fx.glowColor.copy(COOL).lerp(WHITE, glowWhiteness(fx.drive));

  // airflow past the nacelle: world → carrier-local → tilting frame
  _v.copy(sim.carrier.velocity).sub(sim.env.wind);
  _v.applyQuaternion(_q.copy(sim.carrier.quaternion).invert());
  carrierToNacelle(_v, turbine.tilt, fx.relVel).clampLength(0, MAX_REL_SPEED);
  return fx;
}
