/**
 * FC-4 (wave-1 review): every view places the world camera from the DRAWN aircraft pose —
 * `drawPose`, interpolated by frameInfo.alpha between the start and the end of the last 120 Hz
 * step (ARCHITECTURE §6 "Interpolation") — never from the last step's pose, so the world does
 * not judder when a frame takes 0, 1 or 2 steps (75–165 Hz displays, frame-time jitter).
 *
 * The frame loop below replicates SimDriver's accumulator exactly (whole SIM_DT steps, at most
 * MAX_STEPS_PER_FRAME per frame, alpha = what is left / SIM_DT).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { MAX_STEPS_PER_FRAME, SIM_DT } from '../../../src/a10/core/constants';
import { quaternionFromAttitude } from '../../../src/a10/core/frames';
import { createSim, stepSim } from '../../../src/a10/core/sim';
import type { Sim } from '../../../src/a10/core/types';
import { DEG, KT } from '../../../src/a10/core/units';
import type { StoreBody } from '../../../src/a10/core/weapons/types';
import type { Vehicle } from '../../../src/a10/core/targets/types';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import { frameInfo } from '../../../src/a10/view/frame';
import { cockpitWorldCamera } from '../../../src/a10/view/cockpit/cameraPose';
import {
  OUTSIDE,
  OutsideCameras,
  type CameraPose,
  type OutsideInput,
  type OutsideView,
} from '../../../src/a10/view/cockpit/outsideViews';

const SPEED = 250 * KT;
const EYE = new Vector3(A10_GEOMETRY.eye.x, A10_GEOMETRY.eye.y, A10_GEOMETRY.eye.z);
const HEAD_Q = new Quaternion(); // looking straight ahead
const ground = () => 0;
const input = (dt = 1 / 144): OutsideInput => ({
  dt,
  simDt: dt,
  lookDX: 0,
  lookDY: 0,
  lookRateX: 0,
  lookRateY: 0,
  zoomSteps: 0,
});
const pose = (): CameraPose => ({ position: new Vector3(), quaternion: new Quaternion(), fov: 50 });

afterEach(() => {
  frameInfo.alpha = 0;
});

/** A flight that only moves kinematically: straight and level north at 250 kn, 1,500 m. */
function kinematicSim(): Sim {
  const s = createSim({
    terrain: createFlatTerrain(0),
    scenario: 'empty',
    seed: 5,
    start: { x: 0, z: 0, agl: 1500, heading: 0, speed: SPEED },
  });
  const ac = s.aircraft;
  quaternionFromAttitude(0, 0, 0, ac.orientation);
  ac.heading = 0;
  ac.position.set(0, 1500, 0);
  ac.velocity.set(0, 0, -SPEED);
  ac.prevPosition.copy(ac.position);
  ac.prevOrientation.copy(ac.orientation);
  return s;
}

/** One 120 Hz step of the kinematic flight (what stepFlight does with prev*). */
function kinematicStep(s: Sim): void {
  const ac = s.aircraft;
  ac.prevPosition.copy(ac.position);
  ac.prevOrientation.copy(ac.orientation);
  ac.position.addScaledVector(ac.velocity, SIM_DT);
  s.time += SIM_DT;
}

/**
 * SimDriver's frame loop over the given frame times: steps, then alpha; calls `frame` after each
 * frame's steps with the real frame time.
 */
function runFrames(
  frameTimes: readonly number[],
  step: () => void,
  frame: (realDt: number, index: number) => void,
): void {
  let accumulator = 0;
  for (let f = 0; f < frameTimes.length; f++) {
    const delta = frameTimes[f];
    const realDt = Math.min(delta, 0.25);
    accumulator += realDt;
    let n = 0;
    while (accumulator >= SIM_DT && n < MAX_STEPS_PER_FRAME) {
      step();
      accumulator -= SIM_DT;
      n++;
    }
    if (n === MAX_STEPS_PER_FRAME && accumulator >= SIM_DT) accumulator = 0;
    frameInfo.steps = n;
    frameInfo.simDt = n * SIM_DT;
    frameInfo.realDt = realDt;
    frameInfo.alpha = accumulator / SIM_DT;
    frame(realDt, f);
  }
}

/**
 * Frames compared from this one on: the very first drawn instant (one step behind real time)
 * falls before the flight's first step and is held at the start pose — a start-up frame, not
 * judder.
 */
const WARMUP = 2;

/** Deterministic frame-time jitter (a small LCG; tests never use Math.random). */
function jittered(hz: number, jitterS: number, n: number): number[] {
  let x = 12345;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(1 / hz + (x / 2147483648 - 0.5) * 2 * jitterS);
  }
  return out;
}

function angleBetween(a: Quaternion, b: Quaternion): number {
  return a.angleTo(b);
}

describe('the cockpit world camera follows the drawn (interpolated) pose', () => {
  it('sits halfway between the previous and the current pose at alpha 0.5', () => {
    const s = kinematicSim();
    const ac = s.aircraft;
    // the last step: moved 1.07 m north and a little up, turned 2° right and rolled 3°
    ac.prevPosition.set(100, 1500, -200);
    quaternionFromAttitude(0, 0, 0, ac.prevOrientation);
    ac.position.set(100.02, 1500.2, -201.07);
    quaternionFromAttitude(2 * DEG, 0, 3 * DEG, ac.orientation);

    const pos = new Vector3();
    const quat = new Quaternion();
    for (const a of [0, 0.5, 1]) {
      frameInfo.alpha = a;
      cockpitWorldCamera(s, EYE, HEAD_Q, pos, quat);
      const q = new Quaternion().slerpQuaternions(ac.prevOrientation, ac.orientation, a);
      const p = new Vector3().lerpVectors(ac.prevPosition, ac.position, a);
      const expected = EYE.clone().applyQuaternion(q).add(p);
      expect(pos.distanceTo(expected), `alpha ${a}`).toBeLessThan(1e-9);
      expect(angleBetween(quat, q), `alpha ${a}`).toBeLessThan(1e-9);
    }
    // halfway in rotation too
    frameInfo.alpha = 0.5;
    cockpitWorldCamera(s, EYE, HEAD_Q, pos, quat);
    expect(angleBetween(quat, ac.prevOrientation)).toBeCloseTo(
      angleBetween(ac.prevOrientation, ac.orientation) / 2,
      9,
    );
  });

  it('moves every frame at 144 Hz, by the distance flown in that frame', () => {
    const s = kinematicSim();
    const pos = new Vector3();
    const prev = new Vector3();
    const quat = new Quaternion();
    const travel: number[] = [];
    const expected: number[] = [];
    runFrames(
      new Array(288).fill(1 / 144),
      () => kinematicStep(s),
      (realDt, f) => {
        cockpitWorldCamera(s, EYE, HEAD_Q, pos, quat);
        if (f >= WARMUP) {
          travel.push(pos.distanceTo(prev));
          expected.push(SPEED * realDt);
        }
        prev.copy(pos);
      },
    );
    expect(travel.length).toBe(288 - WARMUP);
    // 1/6 of the frames take no step at 144 Hz: none of them may freeze the camera
    for (let i = 0; i < travel.length; i++)
      expect(Math.abs(travel[i] - expected[i]), `frame ${i}`).toBeLessThan(1e-6);
  });

  it('moves evenly at 75, 90, 100 and 165 Hz and with ±1.5 ms of jitter at 60 Hz', () => {
    const cases: [string, number[]][] = [
      ['75 Hz', new Array(150).fill(1 / 75)],
      ['90 Hz', new Array(180).fill(1 / 90)],
      ['100 Hz', new Array(200).fill(1 / 100)],
      ['165 Hz', new Array(330).fill(1 / 165)],
      ['60 Hz ± 1.5 ms', jittered(60, 0.0015, 240)],
    ];
    for (const [name, frames] of cases) {
      const s = kinematicSim();
      const pos = new Vector3();
      const prev = new Vector3();
      const quat = new Quaternion();
      let worst = 0;
      runFrames(
        frames,
        () => kinematicStep(s),
        (realDt, f) => {
          cockpitWorldCamera(s, EYE, HEAD_Q, pos, quat);
          if (f >= WARMUP) worst = Math.max(worst, Math.abs(pos.distanceTo(prev) - SPEED * realDt));
          prev.copy(pos);
        },
      );
      expect(worst, name).toBeLessThan(1e-6);
    }
  });

  it('moves smoothly with the real flight model stepping at 144 Hz', () => {
    const s = createSim({
      terrain: createFlatTerrain(0),
      scenario: 'empty',
      seed: 7,
      start: { x: 0, z: 0, agl: 2400, heading: 0, speed: SPEED },
    });
    const pos = new Vector3();
    const prev = new Vector3();
    const quat = new Quaternion();
    const ratio: number[] = [];
    runFrames(
      new Array(288).fill(1 / 144),
      () => stepSim(s),
      (realDt, f) => {
        cockpitWorldCamera(s, EYE, HEAD_Q, pos, quat);
        if (f >= WARMUP) ratio.push(pos.distanceTo(prev) / (s.aircraft.velocity.length() * realDt));
        prev.copy(pos);
      },
    );
    // without interpolation one frame in six would not move at all (ratio 0) and the next
    // would move twice as far; interpolated, every frame moves what the aircraft flew
    expect(Math.min(...ratio)).toBeGreaterThan(0.97);
    expect(Math.max(...ratio)).toBeLessThan(1.03);
  });
});

describe('the outside views follow the drawn pose', () => {
  function frameAt(s: Sim, view: OutsideView, alpha: number, cam: OutsideCameras, p: CameraPose) {
    frameInfo.alpha = alpha;
    cam.update(view, s, input(), ground, p);
  }

  /** A sim whose last step moved the aircraft 10 m north (prev → current), level. */
  function movedSim(): Sim {
    const s = kinematicSim();
    s.aircraft.prevPosition.set(0, 1500, 0);
    s.aircraft.position.set(0, 1500, -10);
    return s;
  }

  it('chase and orbit cameras sit halfway between the two poses at alpha 0.5', () => {
    for (const view of ['chase', 'orbit'] as const) {
      const at: Vector3[] = [];
      for (const a of [0, 0.5, 1]) {
        const s = movedSim();
        const cam = new OutsideCameras();
        const p = pose();
        frameAt(s, view, a, cam, p);
        at.push(p.position.clone());
      }
      expect(at[1].distanceTo(new Vector3().lerpVectors(at[0], at[2], 0.5)), view).toBeLessThan(
        1e-9,
      );
      // and the whole step apart between alpha 0 and 1
      expect(at[0].distanceTo(at[2]), view).toBeCloseTo(10, 6);
    }
  });

  it('the fly-by camera tracks the drawn aircraft', () => {
    const s = movedSim();
    const cam = new OutsideCameras();
    const p = pose();
    frameAt(s, 'flyby', 0.5, cam, p);
    const mid = new Vector3(0, 1500, -5);
    const look = new Vector3(0, 0, -1).applyQuaternion(p.quaternion);
    const toMid = mid.clone().sub(p.position).normalize();
    expect(look.angleTo(toMid)).toBeLessThan(1e-6);
  });

  it('the weapon camera follows the store body interpolated within the step', () => {
    const at: Vector3[] = [];
    for (const a of [0, 0.5, 1]) {
      const s = movedSim();
      s.projectiles.bodies.push({
        id: 3,
        type: 'MK-82',
        kind: 'bomb',
        alive: true,
        station: 4,
        releaseTime: 0,
        position: new Vector3(0, 1400, -300),
        velocity: new Vector3(0, -30, -120),
        orientation: new Quaternion(),
        motorTime: 0,
        armed: true,
        data: {},
      } as unknown as StoreBody);
      const cam = new OutsideCameras();
      const p = pose();
      frameAt(s, 'weapon', a, cam, p);
      at.push(p.position.clone());
    }
    // the body moved velocity × SIM_DT during the step; the camera follows it continuously
    const stepMove = new Vector3(0, -30, -120).multiplyScalar(SIM_DT);
    expect(at[2].clone().sub(at[0]).distanceTo(stepMove)).toBeLessThan(1e-9);
    expect(at[1].distanceTo(new Vector3().lerpVectors(at[0], at[2], 0.5))).toBeLessThan(1e-9);
  });

  it('the target camera turns smoothly with the drawn aircraft', () => {
    const q: Quaternion[] = [];
    for (const a of [0, 0.5, 1]) {
      const s = movedSim();
      // a vehicle 300 m ahead and to the side: the aircraft's motion swings the camera's view
      s.targets.vehicles.push({
        id: 4,
        kind: 'mbt',
        position: new Vector3(200, 0, -300),
        heading: 0,
        condition: 'intact',
      } as unknown as Vehicle);
      const cam = new OutsideCameras();
      cam.targetVehicle = 4;
      const p = pose();
      frameAt(s, 'target', a, cam, p);
      q.push(p.quaternion.clone());
    }
    // the view direction swings continuously with alpha (about half way at 0.5: a direction
    // to a point moving in a straight line is not exactly linear in angle)
    const whole = q[0].angleTo(q[2]);
    expect(whole).toBeGreaterThan(1e-4);
    expect(q[0].angleTo(q[1]) / whole).toBeGreaterThan(0.45);
    expect(q[0].angleTo(q[1]) / whole).toBeLessThan(0.55);
    expect(q[1].angleTo(q[2]) / whole).toBeGreaterThan(0.45);
  });

  it('keeps the chase distance constant over a 144 Hz sequence (no frozen frame)', () => {
    const s = kinematicSim();
    const cam = new OutsideCameras();
    const p = pose();
    const prev = new Vector3();
    let worst = 0;
    runFrames(
      new Array(288).fill(1 / 144),
      () => kinematicStep(s),
      (realDt, f) => {
        cam.update('chase', s, input(realDt), ground, p);
        if (f >= WARMUP)
          worst = Math.max(worst, Math.abs(p.position.distanceTo(prev) - SPEED * realDt));
        prev.copy(p.position);
      },
    );
    expect(worst).toBeLessThan(1e-6);
    expect(OUTSIDE.chase.back).toBeGreaterThan(0);
  });
});
