/**
 * The outside views: chase, fly-by, orbit, weapon camera and a camera at the target.
 * OWNED BY THE COCKPIT MODULE. Plain math on the simulation state (no scene, no DOM), so it is
 * unit-tested (tests/unit/a10/cockpitCameras.test.ts); the camera rig calls `update` every frame
 * and places R3F's world camera at the returned pose.
 *
 *   chase   behind and above the aircraft; the camera's frame follows the aircraft's attitude
 *           through a lag, so turns and rolls show, and it never lags in position
 *   flyby   a fixed point ahead of the flight path, slightly to the side; re-placed once the
 *           aircraft has passed it; the lens zooms to keep the aircraft a sensible size
 *   orbit   a free orbit around the aircraft (mouse drag / look keys; zoom steps = distance),
 *           relative to its heading so it does not spin when the aircraft rolls
 *   weapon  follows the most recent store in flight (sim.projectiles.bodies), watches its
 *           impact point for a few seconds, then falls back to chase
 *   target  a fixed camera near the most recently hit or attacked vehicle, looking at the
 *           aircraft: from here the impacts are heard before the gun (the audio module listens
 *           at the world camera)
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Sim, SimEvent } from '../../core/types';

export type OutsideView = 'chase' | 'flyby' | 'orbit' | 'weapon' | 'target';

export interface CameraPose {
  position: Vector3;
  quaternion: Quaternion;
  /** Vertical field of view, degrees. */
  fov: number;
}

export interface OutsideInput {
  /** Real seconds since the last frame. */
  dt: number;
  /** Mouse look, pixels (+ right, + down); look rates −1..1 (+ right, + up); zoom steps (+ in). */
  lookDX: number;
  lookDY: number;
  lookRateX: number;
  lookRateY: number;
  zoomSteps: number;
}

export const OUTSIDE = {
  chase: { back: 20, up: 4.2, aimAhead: 4, aimUp: 0.8, lagTau: 0.45, rollFollow: 0.5, fov: 55 },
  flyby: { leadTime: 5, side: 28, up: 7, passBy: 220, maxDistance: 2600, halfSize: 14, fov: 50 },
  orbit: { distance: 26, minDistance: 7, maxDistance: 400, el: 0.18, radPerPx: 0.006, rate: 1.6, fov: 50 },
  weapon: { back: 9, up: 1.8, aimAhead: 30, hold: 3, fov: 45 },
  target: { back: 24, side: 10, up: 3.5, attackRadius: 250, fov: 55 },
  /** Lowest camera height above the ground, m. */
  groundClearance: 2.5,
} as const;

const WORLD_UP = new Vector3(0, 1, 0);
const _m = new Matrix4();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _up = new Vector3();
const _q = new Quaternion();

/** Point a pose's quaternion from its position toward `target` with an up hint. */
export function lookAtQuaternion(eye: Vector3, target: Vector3, up: Vector3, out: Quaternion): Quaternion {
  if (eye.distanceToSquared(target) < 1e-8) return out;
  _m.lookAt(eye, target, up);
  return out.setFromRotationMatrix(_m);
}

export class OutsideCameras {
  // chase
  readonly chaseQ = new Quaternion();
  chaseValid = false;
  // flyby
  readonly flybyPos = new Vector3();
  flybyValid = false;
  flybySide = 1;
  // orbit
  orbitAz = 0;
  orbitEl: number = OUTSIDE.orbit.el;
  orbitDist: number = OUTSIDE.orbit.distance;
  // weapon
  weaponId = -1;
  readonly weaponCam = new Vector3();
  readonly weaponLast = new Vector3();
  weaponHold = 0;
  // target
  targetVehicle = -1;
  placedVehicle = -1;
  readonly targetCam = new Vector3();
  readonly targetFrom = new Vector3();
  /** The view shown last frame (switching re-initialises the new one). */
  lastView: OutsideView | 'cockpit' | null = null;

  /** Forget everything (a new flight). */
  reset(): void {
    this.chaseValid = false;
    this.flybyValid = false;
    this.orbitAz = 0;
    this.orbitEl = OUTSIDE.orbit.el;
    this.orbitDist = OUTSIDE.orbit.distance;
    this.weaponId = -1;
    this.weaponHold = 0;
    this.targetVehicle = -1;
    this.placedVehicle = -1;
    this.lastView = null;
  }

  /**
   * Remember the vehicle most recently hit or attacked (for the target camera): round impacts on
   * vehicles, damage, kills and blasts at vehicles; a burst or a release aimed near a vehicle.
   */
  noteEvents(events: readonly SimEvent[], sim: Sim): void {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.type) {
        case 'roundImpact':
          if (e.target.kind === 'vehicle') this.targetVehicle = e.target.vehicleId;
          break;
        case 'vehicleDamaged':
        case 'vehicleDestroyed':
          this.targetVehicle = e.vehicleId;
          break;
        case 'detonation':
          if (e.vehicleId >= 0) this.targetVehicle = e.vehicleId;
          break;
        case 'gunStart': {
          const g = sim.avionics.gun;
          if (g.valid) {
            const id = nearestVehicle(sim, g.impact, OUTSIDE.target.attackRadius);
            if (id >= 0) this.targetVehicle = id;
          }
          break;
        }
        case 'storeReleased': {
          const r = sim.avionics.release;
          const p = r.valid ? r.impact : sim.avionics.spi.valid ? sim.avionics.spi.position : null;
          if (p) {
            const id = nearestVehicle(sim, p, OUTSIDE.target.attackRadius * 1.5);
            if (id >= 0) this.targetVehicle = id;
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Place the camera for an outside view. Returns the view actually shown (the weapon and target
   * cameras fall back to chase when they have nothing to show).
   */
  update(
    view: OutsideView,
    sim: Sim,
    inp: OutsideInput,
    groundAt: (x: number, z: number) => number,
    out: CameraPose,
  ): OutsideView {
    const entering = this.lastView !== view;
    let shown: OutsideView = view;
    switch (view) {
      case 'flyby':
        this.flyby(sim, entering, out);
        break;
      case 'orbit':
        this.orbit(sim, inp, out);
        break;
      case 'weapon':
        if (!this.weapon(sim, inp.dt, entering, out)) shown = 'chase';
        break;
      case 'target':
        if (!this.target(sim, groundAt, entering, out)) shown = 'chase';
        break;
      default:
        break;
    }
    if (shown === 'chase') this.chase(sim, inp.dt, entering || this.lastView === 'cockpit', out);
    else this.chaseValid = false;
    this.lastView = view;
    // never under the ground
    const floor = groundAt(out.position.x, out.position.z) + OUTSIDE.groundClearance;
    if (out.position.y < floor) out.position.y = floor;
    return shown;
  }

  /** Called while the cockpit view is shown (outside views re-initialise on return). */
  leave(): void {
    this.lastView = 'cockpit';
    this.chaseValid = false;
  }

  private chase(sim: Sim, dt: number, reset: boolean, out: CameraPose): void {
    const ac = sim.aircraft;
    const c = OUTSIDE.chase;
    if (reset || !this.chaseValid) {
      this.chaseQ.copy(ac.orientation);
      this.chaseValid = true;
    } else {
      this.chaseQ.slerp(ac.orientation, 1 - Math.exp(-Math.max(0, dt) / c.lagTau));
    }
    _a.set(0, c.up, c.back).applyQuaternion(this.chaseQ).add(ac.position);
    _b.set(0, c.aimUp, -c.aimAhead).applyQuaternion(this.chaseQ).add(ac.position);
    _up.set(0, 1, 0).applyQuaternion(this.chaseQ).multiplyScalar(c.rollFollow);
    _up.addScaledVector(WORLD_UP, 1 - c.rollFollow);
    if (_up.lengthSq() < 1e-6) _up.copy(WORLD_UP);
    _up.normalize();
    out.position.copy(_a);
    lookAtQuaternion(_a, _b, _up, out.quaternion);
    out.fov = c.fov;
  }

  private flyby(sim: Sim, entering: boolean, out: CameraPose): void {
    const ac = sim.aircraft;
    const f = OUTSIDE.flyby;
    velocityDirection(sim, _a);
    let replace = entering || !this.flybyValid;
    if (!replace) {
      _b.subVectors(ac.position, this.flybyPos);
      if (_b.dot(_a) > f.passBy || _b.length() > f.maxDistance) replace = true;
    }
    if (replace) {
      // ahead along the flight path, off to one side and a little above it
      const speed = Math.max(60, ac.velocity.length());
      _c.crossVectors(_a, WORLD_UP);
      if (_c.lengthSq() < 1e-6) _c.set(1, 0, 0);
      _c.normalize();
      this.flybySide = -this.flybySide;
      this.flybyPos
        .copy(ac.position)
        .addScaledVector(_a, speed * f.leadTime)
        .addScaledVector(_c, f.side * this.flybySide)
        .addScaledVector(WORLD_UP, f.up);
      this.flybyValid = true;
    }
    out.position.copy(this.flybyPos);
    lookAtQuaternion(this.flybyPos, ac.position, WORLD_UP, out.quaternion);
    // zoom so the aircraft stays a useful size
    const dist = this.flybyPos.distanceTo(ac.position);
    const fov = ((2 * Math.atan(f.halfSize / Math.max(1, dist))) / Math.PI) * 180 * 2.2;
    out.fov = Math.min(f.fov, Math.max(8, fov));
  }

  private orbit(sim: Sim, inp: OutsideInput, out: CameraPose): void {
    const o = OUTSIDE.orbit;
    const dt = Math.max(0, inp.dt);
    this.orbitAz += inp.lookDX * o.radPerPx + inp.lookRateX * o.rate * dt;
    this.orbitEl += inp.lookDY * o.radPerPx - inp.lookRateY * o.rate * dt;
    this.orbitEl = Math.max(-1.45, Math.min(1.45, this.orbitEl));
    this.orbitAz = ((this.orbitAz + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    if (inp.zoomSteps !== 0)
      this.orbitDist = Math.max(
        o.minDistance,
        Math.min(o.maxDistance, this.orbitDist * Math.pow(0.87, inp.zoomSteps)),
      );
    const ac = sim.aircraft;
    // compass direction from the aircraft to the camera: behind it at az = 0
    const a = ac.heading + Math.PI + this.orbitAz;
    const ce = Math.cos(this.orbitEl);
    _a.set(Math.sin(a) * ce, Math.sin(this.orbitEl), -Math.cos(a) * ce);
    out.position.copy(ac.position).addScaledVector(_a, this.orbitDist);
    lookAtQuaternion(out.position, ac.position, WORLD_UP, out.quaternion);
    out.fov = o.fov;
  }

  private weapon(sim: Sim, dt: number, entering: boolean, out: CameraPose): boolean {
    const w = OUTSIDE.weapon;
    const bodies = sim.projectiles.bodies;
    let best = -1;
    let bestId = -1;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.alive && b.id > bestId) {
        bestId = b.id;
        best = i;
      }
    }
    if (best >= 0) {
      const b = bodies[best];
      if (b.id !== this.weaponId || entering) this.weaponId = b.id;
      if (b.velocity.lengthSq() > 1) _a.copy(b.velocity).normalize();
      else _a.set(0, 0, -1).applyQuaternion(b.orientation);
      this.weaponCam
        .copy(b.position)
        .addScaledVector(_a, -w.back)
        .addScaledVector(WORLD_UP, w.up);
      _b.copy(b.position).addScaledVector(_a, w.aimAhead);
      this.weaponLast.copy(b.position);
      this.weaponHold = w.hold;
      out.position.copy(this.weaponCam);
      lookAtQuaternion(this.weaponCam, _b, WORLD_UP, out.quaternion);
      out.fov = w.fov;
      return true;
    }
    if (this.weaponId >= 0 && this.weaponHold > 0 && !entering) {
      // the store is gone: watch where it went for a moment
      this.weaponHold -= Math.max(0, dt);
      out.position.copy(this.weaponCam);
      lookAtQuaternion(this.weaponCam, this.weaponLast, WORLD_UP, out.quaternion);
      out.fov = w.fov;
      return true;
    }
    this.weaponId = -1;
    return false;
  }

  private target(
    sim: Sim,
    groundAt: (x: number, z: number) => number,
    entering: boolean,
    out: CameraPose,
  ): boolean {
    const t = OUTSIDE.target;
    const ac = sim.aircraft;
    let veh = findVehicle(sim, this.targetVehicle);
    if (!veh) {
      // nothing hit yet: the vehicle nearest where the gun points, else nearest ahead
      const g = sim.avionics.gun;
      _d.copy(ac.velocity).setY(0);
      if (_d.lengthSq() < 1) _d.set(0, 0, -1);
      _d.normalize().multiplyScalar(2000).add(ac.position);
      const id = nearestVehicle(sim, g.valid ? g.impact : _d, Infinity);
      veh = findVehicle(sim, id);
      if (!veh) return false;
      this.targetVehicle = id;
    }
    // horizontal direction from the vehicle to the aircraft
    _a.subVectors(ac.position, veh.position).setY(0);
    if (_a.lengthSq() < 1) _a.set(0, 0, -1);
    _a.normalize();
    const moved = this.targetFrom.dot(_a) < 0.2 && ac.position.distanceTo(veh.position) > 1500;
    if (entering || this.placedVehicle !== veh.id || moved) {
      // behind the vehicle as seen from the aircraft, a little to the side and up
      _c.crossVectors(_a, WORLD_UP).normalize();
      this.targetCam
        .copy(veh.position)
        .addScaledVector(_a, -t.back)
        .addScaledVector(_c, t.side);
      this.targetCam.y = Math.max(
        veh.position.y,
        groundAt(this.targetCam.x, this.targetCam.z),
      ) + t.up;
      this.targetFrom.copy(_a);
      this.placedVehicle = veh.id;
    }
    // look at the aircraft, leaning toward the vehicle so both stay in the picture
    _b.subVectors(ac.position, this.targetCam).normalize();
    _c.copy(veh.position).addScaledVector(WORLD_UP, 1.2).sub(this.targetCam).normalize();
    _b.multiplyScalar(0.72).addScaledVector(_c, 0.28).normalize();
    _b.add(this.targetCam);
    out.position.copy(this.targetCam);
    lookAtQuaternion(this.targetCam, _b, WORLD_UP, out.quaternion);
    out.fov = t.fov;
    return true;
  }
}

/** Unit direction of the flight path (the nose when nearly stopped). */
function velocityDirection(sim: Sim, out: Vector3): Vector3 {
  const v = sim.aircraft.velocity;
  if (v.lengthSq() > 25) return out.copy(v).normalize();
  _q.copy(sim.aircraft.orientation);
  return out.set(0, 0, -1).applyQuaternion(_q);
}

function findVehicle(sim: Sim, id: number) {
  if (id < 0) return null;
  const list = sim.targets.vehicles;
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/** Id of the vehicle nearest a point within `radius` (m), or −1. */
export function nearestVehicle(sim: Sim, p: Vector3, radius: number): number {
  const list = sim.targets.vehicles;
  let best = -1;
  let bestD = radius * radius;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    const dx = v.position.x - p.x;
    const dz = v.position.z - p.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = v.id;
    }
  }
  return best;
}
