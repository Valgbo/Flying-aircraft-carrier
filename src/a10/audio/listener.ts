/**
 * The listener is the camera: the world camera's pose that RenderPipeline publishes every frame
 * (view/listener.ts). Here it becomes what the voices need: position and velocity (a camera cut
 * is not a velocity), whether we are in the cockpit, and pan and distance of any world point.
 */
import { Quaternion, Vector3 } from 'three';
import { offsetToPan } from '../../engine';
import type { ListenerPose } from '../view/listener';
import type { MovingPoint } from './propagation';

/** Faster than this between two frames is a camera cut, not motion, m/s. */
const MAX_SPEED = 400;

const _v = new Vector3();

export class AudioListener implements MovingPoint {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  inCockpit = true;
  private readonly inverse = new Quaternion();
  private readonly last = new Vector3();
  private hasLast = false;

  /**
   * Take the camera pose. Its velocity is measured here over the SIMULATED time `simDt` that
   * passed between this pose and the previous one, not over real time: arrival times and Doppler
   * are sim-time quantities, and a slow frame (the sim capped at five steps) must not read as a
   * slow camera. While the sim stands still the last velocity is kept; a jump faster than
   * 400 m/s is a camera cut, not motion.
   */
  update(pose: ListenerPose, simDt: number): void {
    const p = pose.position;
    if (this.hasLast && simDt > 0) {
      const vx = (p.x - this.last.x) / simDt;
      const vy = (p.y - this.last.y) / simDt;
      const vz = (p.z - this.last.z) / simDt;
      const speed = Math.hypot(vx, vy, vz);
      if (Number.isFinite(speed) && speed <= MAX_SPEED) {
        this.vx = vx;
        this.vy = vy;
        this.vz = vz;
      } else {
        this.vx = this.vy = this.vz = 0;
      }
    }
    this.last.copy(p);
    this.hasLast = true;
    this.x = p.x;
    this.y = p.y;
    this.z = p.z;
    this.inverse.copy(pose.quaternion).invert();
    this.inCockpit = pose.inCockpit;
  }

  /** Forget the previous pose (a new flight). */
  reset(): void {
    this.hasLast = false;
    this.vx = this.vy = this.vz = 0;
  }

  /** Set directly (sandbox, tests): position, velocity, and the camera looking along `yaw` (rad, 0 = north). */
  set(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    yaw: number,
    inCockpit: boolean,
  ): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    // a camera with the identity rotation looks along −Z (north); heading turns it clockwise
    this.inverse.setFromAxisAngle(_v.set(0, 1, 0), -yaw).invert();
    this.inCockpit = inCockpit;
  }

  distanceTo(x: number, y: number, z: number): number {
    return Math.hypot(x - this.x, y - this.y, z - this.z);
  }

  /** Stereo pan of a world point (-1 left … +1 right), from where the camera looks. */
  panOf(x: number, y: number, z: number): number {
    _v.set(x - this.x, y - this.y, z - this.z).applyQuaternion(this.inverse);
    return offsetToPan(_v.x, _v.y, _v.z);
  }
}
