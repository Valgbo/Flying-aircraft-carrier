/**
 * Keyboard pitch through the real InputEngine at 60 fps on the flight test bed (review FC-5): a
 * held key pulls to about the g limit at any speed instead of over-stressing the aircraft, and a
 * short tap is a small correction. The key authority is computed every frame the way the input
 * runtime does it (keyAuthority.ts, from the flight module's stickPerG).
 */
import { describe, expect, it } from 'vitest';
import { stickPerG } from '../../../src/a10/core/flight';
import { createTestbed, stepFlightOnly } from '../../../src/a10/core/flight/testbed';
import { defaultBindingsConfig } from '../../../src/a10/input/bindings';
import {
  InputEngine,
  createEngineOutput,
  type FrameContext,
  type KeyMods,
} from '../../../src/a10/input/engine';
import { keyPitchAuthority } from '../../../src/a10/input/keyAuthority';
import { writePilotInput } from '../../../src/a10/input/runtime';

const LONG = 60_000;
const KT = 0.514444;
const NONE: KeyMods = { ctrl: false, alt: false, shift: false, meta: false };

/** Hold (or tap) a pitch key for `ms` at `kias` near sea level; 2 flight steps per frame. */
function pressPitchKey(kias: number, key: 'ArrowDown' | 'ArrowUp', ms: number, scaled = true) {
  const sim = createTestbed({ altitude: 300, ias: kias * KT });
  const engine = new InputEngine(defaultBindingsConfig());
  const out = createEngineOutput();
  engine.resetLevers(sim.input.throttle);
  engine.setGate({ live: true, app: true });
  const authority = { pull: 1, push: 1 };
  const ctx: FrameContext = {
    dt: 1 / 60,
    gate: { live: true, app: true },
    pads: [],
    twoStageTrigger: true,
    mouseStick: false,
    invertLook: false,
    speedBrakePosition: 0,
  };
  const pitch0 = sim.aircraft.pitch;
  let gMax = -Infinity;
  let gMin = Infinity;
  let overG = false;
  const frames = Math.round((ms / 1000) * 60);
  engine.keyDown(key, NONE);
  for (let f = 0; f < Math.max(120, frames + 30); f++) {
    if (f === frames) engine.keyUp(key);
    if (scaled) {
      keyPitchAuthority(sim, authority);
      ctx.keyPitchPull = authority.pull;
      ctx.keyPitchPush = authority.push;
    }
    engine.update(ctx, out);
    writePilotInput(out, sim.input);
    for (let k = 0; k < 2; k++) {
      stepFlightOnly(sim);
      gMax = Math.max(gMax, sim.aircraft.gLoad);
      gMin = Math.min(gMin, sim.aircraft.gLoad);
      overG ||= sim.aircraft.warnings.overG;
    }
  }
  return { sim, gMax, gMin, overG, pitchChange: sim.aircraft.pitch - pitch0 };
}

describe('keyboard pitch authority (review FC-5)', () => {
  it(
    'the flight model gives the stick per g: ≈4 g at 200 kn for the whole stick, several times that at 400 kn',
    () => {
      const at = (kias: number) => 1 / stickPerG(createTestbed({ altitude: 300, ias: kias * KT }));
      expect(at(200)).toBeGreaterThan(2.5);
      expect(at(200)).toBeLessThan(6);
      expect(at(400) / at(200)).toBeGreaterThan(3);
    },
    LONG,
  );

  it(
    'a held pull key reaches most of the g limit at 300–450 kn and never over-stresses; a push key stays inside −3 g',
    () => {
      const rows: string[] = [];
      for (const kias of [300, 400, 450]) {
        const pull = pressPitchKey(kias, 'ArrowDown', 3000);
        const push = pressPitchKey(kias, 'ArrowUp', 3000);
        const before = pressPitchKey(kias, 'ArrowDown', 3000, false);
        rows.push(
          `${kias} kn: pull ${pull.gMax.toFixed(2)} g, push ${push.gMin.toFixed(2)} g (unscaled pull ${before.gMax.toFixed(2)} g)`,
        );
        const limit = pull.sim.aircraft.gLimitPositive;
        expect(pull.overG).toBe(false);
        expect(pull.gMax).toBeLessThan(limit);
        expect(pull.gMax).toBeGreaterThan(0.75 * limit);
        expect(push.overG).toBe(false);
        expect(push.gMin).toBeGreaterThan(push.sim.aircraft.gLimitNegative);
      }
      console.log(`[input] held pitch keys: ${rows.join('; ')}`);
      // At 200 kn the wing, not the key, limits the pull: the whole stick is used.
      const slow = pressPitchKey(200, 'ArrowDown', 3000);
      const slowFull = pressPitchKey(200, 'ArrowDown', 3000, false);
      expect(slow.gMax).toBeGreaterThan(0.97 * slowFull.gMax);
    },
    LONG,
  );

  it(
    'a 50 ms tap is a fine correction and a 120 ms tap a small one (they were 3 and 19 mrad)',
    () => {
      const tap50 = pressPitchKey(300, 'ArrowDown', 50);
      const tap120 = pressPitchKey(300, 'ArrowDown', 120);
      expect(Math.abs(tap50.pitchChange)).toBeLessThan(1e-3);
      expect(Math.abs(tap120.pitchChange)).toBeLessThan(5e-3);
      expect(tap120.pitchChange).toBeGreaterThan(tap50.pitchChange);
    },
    LONG,
  );
});
