/**
 * FC-4 (wave-1 review): the HUD must agree with the interpolated camera. The simulation steps at
 * 120 Hz and the views draw the aircraft at drawPose() (view/frame.ts), up to one step behind the
 * last step. The HUD's world-referenced symbols (pipper, velocity vector, horizon, SPI, sensor
 * marks) must be projected from that drawn pose, or they slide against the drawn world by up to
 * ≈1.5 mrad per 10°/s of rotation.
 *
 * Each case builds a real flight state that rotates between the start and the end of one step,
 * draws the frame at alpha 0.5 through a world camera placed at drawPose() ∘ head (as the camera
 * rig composes it, ARCHITECTURE §6) and the HUD camera (head orientation, collimated), and
 * compares where each symbol lands on the screen with where its world point lands.
 */
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeGunSolution,
  createFireControlGround,
  hudAnglesOfPoint,
  updateFireControlGround,
} from '../../../src/a10/core/avionics';
import { SIM_DT } from '../../../src/a10/core/constants';
import {
  attitudeFromQuaternion,
  bodyDirFromHudAngles,
  omegaFromRates,
  quaternionFromAttitude,
} from '../../../src/a10/core/frames';
import { createSim } from '../../../src/a10/core/sim';
import type { Sim } from '../../../src/a10/core/types';
import { KT } from '../../../src/a10/core/units';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { A10_GEOMETRY } from '../../../src/a10/data/geometry';
import { drawPose, frameInfo } from '../../../src/a10/view/frame';
import { aircraftPoseFromView, syncHudCamera } from '../../../src/a10/view/hud/HudRenderer';
import { computeHudLayout } from '../../../src/a10/view/hud/hudLayout';
import { DEG, planeFromAngles } from '../../../src/a10/view/hud/hudMath';
import type { SegmentSink } from '../../../src/a10/view/hud/strokeFont';
import { HudSymbology, type HudDrawState } from '../../../src/a10/view/hud/symbology';

const EYE = A10_GEOMETRY.eye;

class Recorder implements SegmentSink {
  segs: number[][] = [];
  seg(x0: number, y0: number, x1: number, y1: number, w: number, i: number): void {
    this.segs.push([x0, y0, x1, y1, w, i]);
  }
}

afterEach(() => {
  frameInfo.alpha = 0;
});

/**
 * A dive (30° by default) at 300 kn over flat ground, 700 m up, turning between the previous and
 * the current step with body rates p, q (rad/s): the previous step's state is the current one
 * run back by SIM_DT. The gun sight is computed at the current (end of step) state, as
 * stepSim does.
 */
function rotatingDive(p: number, q: number, pitchDeg = -30): Sim {
  const sim = createSim({
    terrain: createFlatTerrain(0),
    scenario: 'empty',
    seed: 5,
    start: { x: 0, z: 0, agl: 700, heading: 0, speed: 300 * KT },
  });
  const ac = sim.aircraft;
  quaternionFromAttitude(40 * DEG, pitchDeg * DEG, 25 * DEG, ac.orientation);
  ac.heading = 40 * DEG;
  ac.position.set(150, 700, -80);
  const v = bodyDirFromHudAngles(0.6 * DEG, -2.5 * DEG, new Vector3());
  ac.velocity.copy(v.applyQuaternion(ac.orientation)).multiplyScalar(300 * KT);
  omegaFromRates(p, q, 0, ac.angularVelocity);
  // One step back: q_prev = q_cur ⊗ exp(−ω dt), position and velocity back along the motion.
  const w = ac.angularVelocity;
  const back = new Quaternion().setFromAxisAngle(
    w.clone().normalize(),
    -w.length() * SIM_DT,
  );
  ac.prevOrientation.copy(ac.orientation).multiply(back);
  ac.prevVelocity.copy(ac.velocity).add(new Vector3(0, 9.81 * SIM_DT, 0));
  ac.prevPosition.copy(ac.position).addScaledVector(ac.velocity, -SIM_DT);
  ac.ias = 300 * KT;
  ac.altitude = 700;
  ac.agl = 700;
  const av = sim.avionics;
  av.masterMode = 'GUNS';
  av.sight = 'GUN';
  av.masterArm = 'ARM';
  av.gunPac = 'ARM';
  // The gun sight at the end of the step (the wave-1 fire control, against the terrain).
  const ground = createFireControlGround();
  updateFireControlGround(sim, 'DELTA', ground);
  computeGunSolution(sim, ground);
  return sim;
}

/** A ground point (flat ground at y = 0) seen at HUD angles az/el from the current eye. */
function groundPointAt(sim: Sim, azDeg: number, elDeg: number): Vector3 {
  const ac = sim.aircraft;
  const eye = new Vector3(EYE.x, EYE.y, EYE.z).applyQuaternion(ac.orientation).add(ac.position);
  const d = bodyDirFromHudAngles(azDeg * DEG, elDeg * DEG, new Vector3()).applyQuaternion(
    ac.orientation,
  );
  return eye.addScaledVector(d, -eye.y / d.y);
}

interface Frame {
  pose: HudDrawState;
  world: PerspectiveCamera;
  hud: PerspectiveCamera;
}

/** The frame at `alpha`: the drawn state and the two cameras, the head turned a little. */
function frameAt(sim: Sim, alpha: number): Frame {
  frameInfo.alpha = alpha;
  const position = new Vector3();
  const orientation = new Quaternion();
  drawPose(sim, position, orientation);
  const ac = sim.aircraft;
  const velocity = new Vector3().lerpVectors(ac.prevVelocity, ac.velocity, alpha);
  const headQ = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -6 * DEG);
  const head = new PerspectiveCamera(50, 16 / 9, 0.03, 40);
  head.position.set(EYE.x, EYE.y, EYE.z);
  head.quaternion.copy(headQ);
  head.updateMatrixWorld();
  const world = new PerspectiveCamera(50, 16 / 9, 1, 90000);
  world.position.copy(head.position).applyQuaternion(orientation).add(position);
  world.quaternion.multiplyQuaternions(orientation, headQ);
  world.updateMatrixWorld();
  const hud = new PerspectiveCamera();
  syncHudCamera(hud, head, headQ);
  return { pose: { position, orientation, velocity }, world, hud };
}

/** Angle between where a HUD-plane point and a world point land on the screen, rad. */
function screenMiss(f: Frame, hx: number, hy: number, worldPoint: Vector3): number {
  const a = new Vector3(hx, hy, -1).project(f.hud);
  const b = worldPoint.clone().project(f.world);
  // Back to world directions through the drawn camera, and the angle between them.
  const da = a.unproject(f.world).sub(f.world.position).normalize();
  const db = b.unproject(f.world).sub(f.world.position).normalize();
  return Math.acos(Math.min(1, da.dot(db)));
}

function build(sim: Sim, pose?: HudDrawState) {
  const hud = new HudSymbology(computeHudLayout());
  const rec = new Recorder();
  const info = { ...hud.build(sim, EYE, rec, undefined, pose) };
  return { info, rec };
}

const MRAD = 1e-3;

describe('HUD agrees with the interpolated camera (FC-4)', () => {
  it('at alpha 0.5 during a 20°/s roll the pipper drawn on the screen coincides with the impact point projected through the drawn camera', () => {
    const sim = rotatingDive(20 * DEG, 0);
    expect(sim.avionics.gun.valid).toBe(true);
    const f = frameAt(sim, 0.5);
    const { info } = build(sim, f.pose);
    expect(info.pipper).toBe(true);
    const miss = screenMiss(f, info.pipperX, info.pipperY, sim.avionics.gun.impact);
    expect(miss).toBeLessThan(0.1 * MRAD);

    // The bomb pipper of a CCIP release 14° below the boresight (far from the roll axis).
    const av = sim.avionics;
    av.masterMode = 'CCIP';
    av.sight = 'CCIP';
    av.ccipInvalid = false;
    const rel = av.release;
    rel.valid = true;
    rel.impact.copy(groundPointAt(sim, 1, -14));
    const a = hudAnglesOfPoint(sim.aircraft, rel.impact, { az: 0, el: 0 });
    rel.az = a.az;
    rel.el = a.el;
    rel.timeOfFall = 6;
    const ccip = build(sim, f.pose).info;
    expect(ccip.pipper).toBe(true);
    expect(screenMiss(f, ccip.pipperX, ccip.pipperY, rel.impact)).toBeLessThan(0.1 * MRAD);
  });

  it('during a 10°/s pull every world-referenced symbol stays on its world point', () => {
    const sim = rotatingDive(0, 10 * DEG);
    const av = sim.avionics;
    av.spi.valid = true;
    av.spi.source = 'STPT';
    av.spi.position.copy(groundPointAt(sim, 4, -9));
    const f = frameAt(sim, 0.5);
    const { info } = build(sim, f.pose);
    // Gun pipper.
    expect(screenMiss(f, info.pipperX, info.pipperY, av.gun.impact)).toBeLessThan(0.1 * MRAD);
    // Velocity vector: the drawn velocity, a point far along it from the drawn eye.
    const eyeW = new Vector3(EYE.x, EYE.y, EYE.z)
      .applyQuaternion(f.pose.orientation)
      .add(f.pose.position);
    const far = eyeW.clone().addScaledVector(f.pose.velocity.clone().normalize(), 1e6);
    expect(info.tvvLimited).toBe(false);
    expect(screenMiss(f, info.tvvX, info.tvvY, far)).toBeLessThan(0.1 * MRAD);
    // SPI diamond.
    expect(info.spi).toBe(true);
    expect(screenMiss(f, info.spiX, info.spiY, av.spi.position)).toBeLessThan(0.1 * MRAD);
  });

  it('during a 10°/s pull in level flight the horizon and the heading follow the drawn attitude', () => {
    const sim = rotatingDive(0, 10 * DEG, 2);
    const f = frameAt(sim, 0.5);
    const { info, rec } = build(sim, f.pose);
    // The horizon rung lies on the true horizon of the drawn attitude: both ends of at least
    // two strokes (its two halves) are at zero elevation within 0.05 mrad.
    const d = new Vector3();
    const elevation = (x: number, y: number) =>
      Math.asin(d.set(x, y, -1).normalize().applyQuaternion(f.pose.orientation).y);
    const flat = rec.segs.filter(
      ([x0, y0, x1, y1]) =>
        Math.hypot(x1 - x0, y1 - y0) > 1 * DEG &&
        Math.abs(elevation(x0, y0)) < 0.05 * MRAD &&
        Math.abs(elevation(x1, y1)) < 0.05 * MRAD,
    );
    expect(flat.length).toBeGreaterThanOrEqual(2);
    // Heading tape from the drawn attitude.
    const drawn = attitudeFromQuaternion(f.pose.orientation, { heading: 0, pitch: 0, bank: 0 });
    expect(info.heading).toBeCloseTo(drawn.heading, 9);
  });

  it('without a drawn state it draws the step state with the avionics angles (wave 1)', () => {
    const sim = rotatingDive(20 * DEG, 0);
    const { info } = build(sim);
    const p = planeFromAngles(sim.avionics.gun.pipperAz, sim.avionics.gun.pipperEl, {
      x: 0,
      y: 0,
    });
    expect(info.pipperX).toBeCloseTo(p.x, 12);
    expect(info.pipperY).toBeCloseTo(p.y, 12);
  });

  it('recovers the drawn aircraft pose from the world camera and the head', () => {
    const sim = rotatingDive(20 * DEG, 10 * DEG);
    const f = frameAt(sim, 0.37);
    const head = new PerspectiveCamera();
    head.position.set(EYE.x + 0.05, EYE.y - 0.02, EYE.z + 0.1);
    head.quaternion.setFromAxisAngle(new Vector3(0.3, 1, 0.1).normalize(), 20 * DEG);
    const world = new PerspectiveCamera();
    world.position.copy(head.position).applyQuaternion(f.pose.orientation).add(f.pose.position);
    world.quaternion.multiplyQuaternions(f.pose.orientation, head.quaternion);
    const p = new Vector3();
    const q = new Quaternion();
    aircraftPoseFromView(world, head, p, q);
    expect(p.distanceTo(f.pose.position)).toBeLessThan(1e-6);
    expect(Math.abs(q.dot(f.pose.orientation))).toBeCloseTo(1, 12);
  });

  it('keeps the gun solution unchanged: the drawn pipper of a still aircraft equals the avionics angles', () => {
    const sim = rotatingDive(0, 0);
    const f = frameAt(sim, 1);
    const { info } = build(sim, f.pose);
    const p = planeFromAngles(sim.avionics.gun.pipperAz, sim.avionics.gun.pipperEl, {
      x: 0,
      y: 0,
    });
    expect(info.pipperX).toBeCloseTo(p.x, 9);
    expect(info.pipperY).toBeCloseTo(p.y, 9);
  });
});
