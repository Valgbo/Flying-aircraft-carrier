/**
 * Camera shake. Consumes the shared shake energy (`sim.camera.shake`, fed by
 * `addCameraShake`), adds a continuous engine rumble and g-load buffet, and turns the total
 * into small rotational / positional offsets from smooth noise driven by `sim.time`.
 *
 * The offsets are applied on top of the finished camera pose and written straight to the
 * camera object — the rig's own pose and smoothing state never see them, so shake cannot
 * accumulate or drift.
 */
import { Euler, Quaternion, Vector3, type Camera } from 'three';
import { TURBINE_MOUNTS } from '../../config/layout';
import { sim } from '../../state/sim';
import { carrierLocalToWorld } from '../../state/simHelpers';
import { clamp01, smoothstep } from '../../utils/math';
import { decayTrauma, shakeNoise, traumaLevel } from './noise';

/** Shake energy lost per second. */
export const SHAKE_DECAY = 1.5;

/** Impacts (trauma): slow, large. Angles in rad, shift in m, rate in Hz. */
const IMPACT = { rate: 9, angle: 0.02, roll: 0.028, shift: 0.8 } as const;
/** Engine rumble and buffet: faster, small. */
const RUMBLE = { rate: 16, angle: 0.0034, roll: 0.004, shift: 0.12 } as const;

/** Distance from the nearest turbine at which the rumble is at full / background strength, m. */
const RUMBLE_NEAR = 60;
const RUMBLE_FAR = 700;
/** Share of the rumble that remains far from the turbines. */
const RUMBLE_BACKGROUND = 0.2;
/** g-load deviation from 1 where buffet starts / saturates. */
const BUFFET_START = 0.12;
const BUFFET_FULL = 0.9;
const BUFFET_GAIN = 0.8;

const _mount = new Vector3();
const _offset = new Vector3();
const _euler = new Euler();
const _twist = new Quaternion();

/**
 * Write `position` / `quaternion` (the rig's clean pose) to the camera, plus shake when
 * `enabled`. The shared shake energy is consumed and decayed either way, so it cannot pile up
 * while shake is switched off.
 */
export function applyShake(
  camera: Camera,
  position: Vector3,
  quaternion: Quaternion,
  enabled: boolean,
): void {
  const trauma = sim.camera.shake;
  sim.camera.shake = decayTrauma(trauma, SHAKE_DECAY, sim.dt);

  camera.position.copy(position);
  camera.quaternion.copy(quaternion);
  if (!enabled) return;

  let throttle = 0;
  let nearestSq = Infinity;
  for (let i = 0; i < TURBINE_MOUNTS.length; i++) {
    throttle += sim.turbines[i].throttle;
    nearestSq = Math.min(
      nearestSq,
      carrierLocalToWorld(TURBINE_MOUNTS[i], _mount).distanceToSquared(position),
    );
  }
  throttle /= TURBINE_MOUNTS.length;
  const proximity = 1 - smoothstep(RUMBLE_NEAR, RUMBLE_FAR, Math.sqrt(nearestSq));
  const engine =
    Math.pow(throttle, 1.5) * (RUMBLE_BACKGROUND + (1 - RUMBLE_BACKGROUND) * proximity);
  const buffet =
    BUFFET_GAIN * smoothstep(BUFFET_START, BUFFET_FULL, Math.abs(sim.carrier.gLoad - 1));
  const rumble = clamp01(engine + buffet);
  const impact = traumaLevel(trauma);
  if (impact < 1e-4 && rumble < 1e-4) return;

  const a = sim.time * IMPACT.rate;
  const b = sim.time * RUMBLE.rate;
  _euler.set(
    impact * IMPACT.angle * shakeNoise(a, 1) + rumble * RUMBLE.angle * shakeNoise(b, 4),
    impact * IMPACT.angle * shakeNoise(a, 2) + rumble * RUMBLE.angle * shakeNoise(b, 5),
    impact * IMPACT.roll * shakeNoise(a, 3) + rumble * RUMBLE.roll * shakeNoise(b, 6),
  );
  camera.quaternion.multiply(_twist.setFromEuler(_euler));
  _offset
    .set(
      impact * IMPACT.shift * shakeNoise(a, 7) + rumble * RUMBLE.shift * shakeNoise(b, 10),
      impact * IMPACT.shift * shakeNoise(a, 8) + rumble * RUMBLE.shift * shakeNoise(b, 11),
      impact * IMPACT.shift * shakeNoise(a, 9) + rumble * RUMBLE.shift * shakeNoise(b, 12),
    )
    .applyQuaternion(quaternion);
  camera.position.add(_offset);
}
