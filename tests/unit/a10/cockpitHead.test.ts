/**
 * The pilot's head (src/a10/view/cockpit/headPose.ts): look limits, mouse and rate look, zoom,
 * centring, look-at-SPI and its return, head movement under g, leaning to look back, and the
 * shake requests being consumed.
 */
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { bodyDirFromHudAngles, hudAnglesFromBodyDir } from '../../../src/a10/core/frames';
import {
  createHeadInput,
  createHeadState,
  HEAD,
  HEAD_G,
  headPose,
  lookQuaternion,
  maxZoomLevel,
  sampleShake,
  stepHead,
  zoomTarget,
  type HeadInput,
  type HeadState,
} from '../../../src/a10/view/cockpit/headPose';
import type { ShakeState } from '../../../src/a10/view/shake';

const DEG = Math.PI / 180;
const EYE = { x: 0, y: 1.2, z: -4.45 };

function run(h: HeadState, patch: Partial<HeadInput>, seconds: number, dt = 1 / 60): HeadInput {
  const inp = { ...createHeadInput(), baseFov: 50, dt, simDt: dt, ...patch };
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) stepHead(h, inp);
  return inp;
}

describe('head look', () => {
  it('starts at the default view: straight ahead, a little down', () => {
    const h = createHeadState(50);
    expect(h.az).toBe(0);
    expect(h.el).toBeCloseTo(HEAD.defaultEl, 9);
    expect(h.el).toBeLessThan(0);
  });

  it('turns with the mouse (pixels) and the look keys (rates), right and up positive', () => {
    const h = createHeadState(50);
    run(h, { lookDX: 100 }, 1 / 60, 1 / 60);
    expect(h.az).toBeCloseTo(100 * HEAD.mouseRadPerPx, 6);
    const el0 = h.el;
    run(h, { lookDY: -50 }, 1 / 60, 1 / 60); // mouse up
    expect(h.el).toBeCloseTo(el0 + 50 * HEAD.mouseRadPerPx, 6);
    const az0 = h.az;
    run(h, { lookRateX: -1 }, 0.5);
    expect(h.az).toBeCloseTo(az0 - 0.5 * HEAD.lookRate, 3);
  });

  it('stops at ±155° of heading and at the pitch limits', () => {
    const h = createHeadState(50);
    run(h, { lookRateX: 1 }, 5);
    expect(h.az).toBeCloseTo(155 * DEG, 6);
    run(h, { lookRateX: -1 }, 10);
    expect(h.az).toBeCloseTo(-155 * DEG, 6);
    run(h, { lookRateY: 1 }, 5);
    expect(h.el).toBeCloseTo(HEAD.elMax, 6);
    run(h, { lookRateY: -1 }, 5);
    expect(h.el).toBeCloseTo(HEAD.elMin, 6);
  });

  it('looks finer when zoomed (gain follows the field of view)', () => {
    const wide = createHeadState(50);
    run(wide, { lookDX: 100 }, 1 / 60, 1 / 60);
    const zoomed = createHeadState(50);
    run(zoomed, { zoomHeld: true }, 2);
    expect(zoomed.fov).toBeCloseTo(HEAD.minFov, 3);
    const az0 = zoomed.az;
    run(zoomed, { zoomHeld: true, lookDX: 100 }, 1 / 60, 1 / 60);
    expect(zoomed.az - az0).toBeCloseTo((wide.az * HEAD.minFov) / 50, 4);
  });

  it('centres smoothly on the one-frame centre pulse', () => {
    const h = createHeadState(50);
    run(h, { lookRateX: 1, lookRateY: 1 }, 0.6);
    expect(Math.abs(h.az)).toBeGreaterThan(1);
    run(h, { center: true }, 1 / 60, 1 / 60);
    run(h, {}, 1.5);
    expect(h.az).toBeCloseTo(HEAD.defaultAz, 4);
    expect(h.el).toBeCloseTo(HEAD.defaultEl, 4);
  });
});

describe('zoom', () => {
  it('holds to 20° and steps in by wheel notches, never below 20°', () => {
    expect(zoomTarget(62, 0, false)).toBe(62);
    expect(zoomTarget(62, 0, true)).toBe(HEAD.minFov);
    expect(zoomTarget(62, 1, false)).toBeCloseTo(62 * HEAD.zoomStep, 9);
    expect(zoomTarget(62, 50, false)).toBe(HEAD.minFov);
    const h = createHeadState(60);
    const base = { baseFov: 60 };
    run(h, { ...base, zoomSteps: 3 }, 1 / 60, 1 / 60);
    expect(h.zoomLevel).toBe(3);
    run(h, base, 1.5);
    expect(h.fov).toBeCloseTo(60 * Math.pow(HEAD.zoomStep, 3), 2);
    run(h, { ...base, zoomSteps: 100 }, 1 / 60, 1 / 60);
    expect(h.zoomLevel).toBe(maxZoomLevel(60));
    run(h, base, 1.5);
    expect(h.fov).toBeGreaterThanOrEqual(HEAD.minFov - 1e-6);
    run(h, { ...base, zoomSteps: -100 }, 1.5);
    expect(h.zoomLevel).toBe(0);
    expect(h.fov).toBeCloseTo(60, 2);
  });

  it('follows a new base field of view from the settings', () => {
    const h = createHeadState(62);
    run(h, { baseFov: 45 }, 1.5);
    expect(h.fov).toBeCloseTo(45, 2);
  });
});

describe('look at the SPI', () => {
  it('turns the head to the SPI while held and back where it was when released', () => {
    const h = createHeadState(50);
    run(h, { lookDX: 200 }, 1 / 60, 1 / 60);
    const az0 = h.az;
    const el0 = h.el;
    const target = { az: -40 * DEG, el: -25 * DEG };
    run(h, { lookAt: target }, 1.5);
    expect(h.az).toBeCloseTo(target.az, 3);
    expect(h.el).toBeCloseTo(target.el, 3);
    run(h, { lookAt: null }, 1.5);
    expect(h.az).toBeCloseTo(az0, 3);
    expect(h.el).toBeCloseTo(el0, 3);
  });

  it('respects the look limits for a target behind', () => {
    const h = createHeadState(50);
    run(h, { lookAt: { az: 175 * DEG, el: 0 } }, 3);
    expect(h.az).toBeCloseTo(155 * DEG, 4);
  });

  it('slews at a bounded rate (no snap)', () => {
    const h = createHeadState(50);
    stepHead(h, {
      ...createHeadInput(),
      baseFov: 50,
      dt: 1 / 60,
      simDt: 1 / 60,
      lookAt: { az: 90 * DEG, el: 0 },
    });
    expect(h.az).toBeLessThanOrEqual(HEAD.slewRate / 60 + 1e-9);
  });
});

describe('head under g', () => {
  it('is pushed down at high g and up a little at negative g, with a spring lag', () => {
    const h = createHeadState(50);
    run(h, { gLoad: 6 }, 0.05);
    const early = h.g.y;
    run(h, { gLoad: 6 }, 2);
    expect(h.g.y).toBeCloseTo(-5 * HEAD_G.downPerG, 3);
    expect(Math.abs(early)).toBeLessThan(Math.abs(h.g.y));
    run(h, { gLoad: -2 }, 2);
    expect(h.g.y).toBeGreaterThan(0);
    expect(h.g.y).toBeLessThanOrEqual(HEAD_G.maxUp + 1e-6);
    run(h, { gLoad: 15 }, 2);
    expect(h.g.y).toBeGreaterThanOrEqual(-HEAD_G.maxDown - 1e-3);
  });

  it('moves opposite the lateral specific force (sideways in slips)', () => {
    const h = createHeadState(50);
    run(h, { lateralG: 0.3 }, 2);
    expect(h.g.x).toBeLessThan(-0.01);
    run(h, { lateralG: -0.3 }, 2);
    expect(h.g.x).toBeGreaterThan(0.01);
  });

  it('freezes while paused (no sim time)', () => {
    const h = createHeadState(50);
    run(h, { gLoad: 5, simDt: 0 }, 1);
    expect(h.g.y).toBe(0);
  });
});

describe('head pose', () => {
  it('is the eye point and a level orientation at zero look', () => {
    const h = createHeadState(50);
    h.az = 0;
    h.el = 0;
    const p = new Vector3();
    const q = new Quaternion();
    headPose(h, EYE, p, q);
    expect(p.distanceTo(new Vector3(EYE.x, EYE.y, EYE.z))).toBeLessThan(1e-9);
    expect(q.angleTo(new Quaternion())).toBeLessThan(1e-9);
  });

  it('looks along the look angles (HUD convention)', () => {
    const h = createHeadState(50);
    h.az = 30 * DEG;
    h.el = -20 * DEG;
    const p = new Vector3();
    const q = new Quaternion();
    headPose(h, EYE, p, q);
    const fwd = new Vector3(0, 0, -1).applyQuaternion(q);
    const a = hudAnglesFromBodyDir(fwd, { az: 0, el: 0 });
    expect(a.az).toBeCloseTo(30 * DEG, 6);
    expect(a.el).toBeCloseTo(-20 * DEG, 6);
    const expected = bodyDirFromHudAngles(30 * DEG, -20 * DEG, new Vector3());
    expect(fwd.distanceTo(expected)).toBeLessThan(1e-9);
  });

  it('leans out toward the side looked at when looking far back, and forward to look down', () => {
    const h = createHeadState(50);
    const p = new Vector3();
    const q = new Quaternion();
    h.az = -150 * DEG;
    h.el = 0;
    headPose(h, EYE, p, q);
    expect(p.x).toBeLessThan(-0.15);
    h.az = 150 * DEG;
    headPose(h, EYE, p, q);
    expect(p.x).toBeGreaterThan(0.15);
    h.az = 0;
    h.el = -60 * DEG;
    headPose(h, EYE, p, q);
    expect(p.z).toBeLessThan(EYE.z - 0.05);
    expect(p.y).toBeLessThan(EYE.y);
  });

  it('never swings the eyes back into the headrest, wherever the head looks', () => {
    const h = createHeadState(50);
    const p = new Vector3();
    const q = new Quaternion();
    for (let az = -155; az <= 155; az += 5)
      for (let el = -75; el <= 89; el += 8) {
        h.az = az * DEG;
        h.el = el * DEG;
        headPose(h, EYE, p, q);
        expect(p.z, `${az},${el}`).toBeLessThan(EYE.z + 0.09);
        expect(Math.abs(p.x), `${az},${el}`).toBeLessThan(0.34);
      }
  });

  it('builds the look quaternion as yaw then pitch', () => {
    const q = lookQuaternion(90 * DEG, 0, 0, new Quaternion());
    const fwd = new Vector3(0, 0, -1).applyQuaternion(q);
    expect(fwd.x).toBeCloseTo(1, 9);
  });
});

describe('shake', () => {
  it('consumes the vibration request, decays jolts and holds while paused', () => {
    const h = createHeadState(50);
    const shake: ShakeState = { impulse: 1, vibration: 0.45, vibrationHz: 65 };
    let r = 0.9;
    const rand = () => (r = (r * 9301 + 49297) % 233280) / 233280;
    sampleShake(h, shake, 0, 1.234, 1 / 60, rand);
    expect(shake.vibration).toBe(0);
    expect(shake.impulse).toBeLessThan(1);
    expect(h.shakeRot.length()).toBeGreaterThan(0);
    const held = h.shakeRot.clone();
    shake.vibration = 0.45;
    sampleShake(h, shake, 0, 1.25, 0, rand);
    expect(h.shakeRot.equals(held)).toBe(true);
    expect(shake.vibration).toBe(0);
    for (let i = 0; i < 300; i++) sampleShake(h, shake, 0, 2 + i / 60, 1 / 60, rand);
    expect(shake.impulse).toBe(0);
    expect(h.shakeRot.length()).toBe(0);
  });

  it('keeps the gun buzz fine: well under a milliradian of rotation', () => {
    const h = createHeadState(50);
    const shake: ShakeState = { impulse: 0, vibration: 0.45, vibrationHz: 65 };
    let max = 0;
    for (let i = 0; i < 200; i++) {
      shake.vibration = 0.45;
      sampleShake(h, shake, 0, i / 60, 1 / 60);
      max = Math.max(max, Math.abs(h.shakeRot.x), Math.abs(h.shakeRot.y));
    }
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThan(0.001);
  });
});
