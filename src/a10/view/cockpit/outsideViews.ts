/**
 * The outside views: chase, fly-by, orbit, weapon camera and a camera at the target.
 * OWNED BY THE COCKPIT MODULE. Plain math on the simulation state (no scene, no DOM), so it is
 * unit-tested (tests/unit/a10/cockpitCameras.test.ts, cockpitInterpolation.test.ts); the camera
 * rig calls `update` every frame and places R3F's world camera at the returned pose.
 *
 * Every view reads the aircraft at its DRAWN pose (`drawPose`: interpolated within the last
 * 120 Hz step by frameInfo.alpha) and store bodies at the same instant (`bodyDrawPosition`), so
 * the picture moves evenly on any display rate (ARCHITECTURE §6 "Interpolation").
 *
 *   chase   behind and above the aircraft; the camera's frame follows the aircraft's attitude
 *           through a lag, so turns and rolls show, and it never lags in position
 *   flyby   a fixed point ahead of the flight path, slightly to the side; re-placed once the
 *           aircraft has passed it; the lens zooms to keep the aircraft a sensible size
 *   orbit   a free orbit around the aircraft (mouse drag / look keys; zoom steps = distance),
 *           relative to its heading so it does not spin when the aircraft rolls
 *   weapon  follows the newest store in flight (sim.projectiles.bodies: bomb, rocket, Maverick,
 *           GBU-12) from behind, along its flight path; when it is gone (its `detonation`, by
 *           bodyId, gives the exact impact point) the camera eases back to a vantage point above
 *           the impact and watches it for a few simulated seconds (a pause keeps it there), then
 *           falls back to chase
 *   target  a fixed camera near the vehicle under the SPI or the vehicle last attacked —
 *           whichever happened more recently — looking at the aircraft: from here the impacts
 *           are heard before the gun (the audio module listens at the world camera)
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { attitudeFromQuaternion, type Attitude } from '../../core/frames';
import type { Sim, SimEvent } from '../../core/types';
import type { StoreBody } from '../../core/weapons/types';
import { drawPose } from '../frame';
import { bodyDrawPosition } from './cameraPose';

export type OutsideView = 'chase' | 'flyby' | 'orbit' | 'weapon' | 'target';

export interface CameraPose {
  position: Vector3;
  quaternion: Quaternion;
  /** Vertical field of view, degrees. */
  fov: number;
}

export interface OutsideInput {
  /** Real seconds since the last frame (the cameras' easing and lags). */
  dt: number;
  /**
   * Simulated seconds this frame (0 while paused): the weapon camera's hold on an impact counts
   * them, so a paused impact stays in view.
   */
  simDt: number;
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
  orbit: {
    distance: 26,
    minDistance: 7,
    maxDistance: 400,
    el: 0.18,
    radPerPx: 0.006,
    rate: 1.6,
    fov: 50,
  },
  /**
   * Weapon camera: `back`/`up` behind the store while it flies, looking `aimAhead` along its
   * path; after the impact it eases (time constant `holdTau`, real s) to `holdBack` m back along
   * the last flight path and `holdUp` m up, looking at the impact point, for `hold` simulated
   * seconds.
   */
  weapon: {
    back: 9,
    up: 1.8,
    aimAhead: 30,
    hold: 3,
    holdBack: 60,
    holdUp: 18,
    holdTau: 0.45,
    fov: 45,
  },
  /**
   * Target camera: `back`/`side`/`up` from the vehicle; a burst or a release counts as an attack
   * on the vehicle nearest its aim within `attackRadius` m; a vehicle is "under the SPI" within
   * `spiRadius` m of it.
   */
  target: { back: 24, side: 10, up: 3.5, attackRadius: 250, spiRadius: 30, fov: 55 },
  /** Lowest camera height above the ground, m. */
  groundClearance: 2.5,
} as const;

const WORLD_UP = new Vector3(0, 1, 0);
const _m = new Matrix4();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _p = new Vector3();
const _up = new Vector3();
const _q = new Quaternion();
const _att: Attitude = { heading: 0, pitch: 0, bank: 0 };

/** Point a pose's quaternion from its position toward `target` with an up hint. */
export function lookAtQuaternion(
  eye: Vector3,
  target: Vector3,
  up: Vector3,
  out: Quaternion,
): Quaternion {
  if (eye.distanceToSquared(target) < 1e-8) return out;
  _m.lookAt(eye, target, up);
  return out.setFromRotationMatrix(_m);
}

export class OutsideCameras {
  /** The aircraft's drawn pose this frame (interpolated within the last step). */
  readonly acPos = new Vector3();
  readonly acQuat = new Quaternion();
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
  /** The store body followed (−1 none). */
  weaponId = -1;
  readonly weaponCam = new Vector3();
  /** Last drawn position and flight direction of the followed store. */
  readonly weaponLast = new Vector3();
  readonly weaponDir = new Vector3(0, -1, 0);
  /** Its impact point, from its `detonation` event (valid once it went off). */
  readonly weaponImpact = new Vector3();
  weaponImpactValid = false;
  weaponHold = 0;
  // target
  /** The vehicle most recently hit or attacked (−1 none), and the sim time of that attack. */
  targetVehicle = -1;
  attackTime = -Infinity;
  /** The vehicle under the SPI (−1 none), and the sim time the SPI came onto it. */
  spiVehicle = -1;
  spiTime = -Infinity;
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
    this.weaponImpactValid = false;
    this.targetVehicle = -1;
    this.attackTime = -Infinity;
    this.spiVehicle = -1;
    this.spiTime = -Infinity;
    this.placedVehicle = -1;
    this.lastView = null;
  }

  /**
   * Called once per frame with the frame's events (after the simulation stepped): remembers the
   * vehicle most recently hit or attacked — round impacts on vehicles, damage, kills and blasts
   * at vehicles, a burst or a release aimed near a vehicle —, the vehicle under the SPI, and the
   * impact point of the store the weapon camera follows.
   */
  noteEvents(events: readonly SimEvent[], sim: Sim): void {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.type) {
        case 'roundImpact':
          if (e.target.kind === 'vehicle') this.attacked(e.target.vehicleId, sim);
          break;
        case 'vehicleDamaged':
        case 'vehicleDestroyed':
          this.attacked(e.vehicleId, sim);
          break;
        case 'detonation':
          if (e.vehicleId >= 0) this.attacked(e.vehicleId, sim);
          if (e.bodyId !== undefined && e.bodyId === this.weaponId) {
            this.weaponImpact.set(e.position.x, e.position.y, e.position.z);
            this.weaponImpactValid = true;
          }
          break;
        case 'gunStart': {
          const g = sim.avionics.gun;
          if (g.valid) {
            const id = nearestVehicle(sim, g.impact, OUTSIDE.target.attackRadius);
            if (id >= 0) this.attacked(id, sim);
          }
          break;
        }
        case 'storeReleased': {
          const r = sim.avionics.release;
          const p = r.valid ? r.impact : sim.avionics.spi.valid ? sim.avionics.spi.position : null;
          if (p) {
            const id = nearestVehicle(sim, p, OUTSIDE.target.attackRadius * 1.5);
            if (id >= 0) this.attacked(id, sim);
          }
          break;
        }
        default:
          break;
      }
    }
    // the vehicle under the SPI (a pod or Maverick track, a designated point on a vehicle)
    const spi = sim.avionics.spi;
    const id = spi.valid ? nearestVehicle(sim, spi.position, OUTSIDE.target.spiRadius) : -1;
    if (id !== this.spiVehicle) {
      this.spiVehicle = id;
      this.spiTime = sim.time;
    }
  }

  private attacked(id: number, sim: Sim): void {
    this.targetVehicle = id;
    this.attackTime = sim.time;
  }

  /** The vehicle the target camera watches: under the SPI or last attacked, the more recent. */
  watchedVehicle(): number {
    if (this.spiVehicle >= 0 && (this.targetVehicle < 0 || this.spiTime >= this.attackTime))
      return this.spiVehicle;
    return this.targetVehicle;
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
    drawPose(sim, this.acPos, this.acQuat);
    const entering = this.lastView !== view;
    let shown: OutsideView = view;
    switch (view) {
      case 'flyby':
        this.flyby(sim, entering, out);
        break;
      case 'orbit':
        this.orbit(inp, out);
        break;
      case 'weapon':
        if (!this.weapon(sim, inp.dt, inp.simDt, entering, out)) shown = 'chase';
        break;
      case 'target':
        if (!this.target(sim, groundAt, entering, out)) shown = 'chase';
        break;
      default:
        break;
    }
    if (shown === 'chase') this.chase(inp.dt, entering || this.lastView === 'cockpit', out);
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

  private chase(dt: number, reset: boolean, out: CameraPose): void {
    const c = OUTSIDE.chase;
    if (reset || !this.chaseValid) {
      this.chaseQ.copy(this.acQuat);
      this.chaseValid = true;
    } else {
      this.chaseQ.slerp(this.acQuat, 1 - Math.exp(-Math.max(0, dt) / c.lagTau));
    }
    _a.set(0, c.up, c.back).applyQuaternion(this.chaseQ).add(this.acPos);
    _b.set(0, c.aimUp, -c.aimAhead).applyQuaternion(this.chaseQ).add(this.acPos);
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
    velocityDirection(sim, this.acQuat, _a);
    let replace = entering || !this.flybyValid;
    if (!replace) {
      _b.subVectors(this.acPos, this.flybyPos);
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
        .copy(this.acPos)
        .addScaledVector(_a, speed * f.leadTime)
        .addScaledVector(_c, f.side * this.flybySide)
        .addScaledVector(WORLD_UP, f.up);
      this.flybyValid = true;
    }
    out.position.copy(this.flybyPos);
    lookAtQuaternion(this.flybyPos, this.acPos, WORLD_UP, out.quaternion);
    // zoom so the aircraft stays a useful size
    const dist = this.flybyPos.distanceTo(this.acPos);
    const fov = ((2 * Math.atan(f.halfSize / Math.max(1, dist))) / Math.PI) * 180 * 2.2;
    out.fov = Math.min(f.fov, Math.max(8, fov));
  }

  private orbit(inp: OutsideInput, out: CameraPose): void {
    const o = OUTSIDE.orbit;
    const dt = Math.max(0, inp.dt);
    this.orbitAz += inp.lookDX * o.radPerPx + inp.lookRateX * o.rate * dt;
    this.orbitEl += inp.lookDY * o.radPerPx - inp.lookRateY * o.rate * dt;
    this.orbitEl = Math.max(-1.45, Math.min(1.45, this.orbitEl));
    this.orbitAz =
      ((((this.orbitAz + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
    if (inp.zoomSteps !== 0)
      this.orbitDist = Math.max(
        o.minDistance,
        Math.min(o.maxDistance, this.orbitDist * Math.pow(0.87, inp.zoomSteps)),
      );
    // compass direction from the aircraft to the camera: behind it at az = 0 (the drawn heading,
    // so the orbit turns evenly with the aircraft)
    const heading = attitudeFromQuaternion(this.acQuat, _att).heading;
    const a = heading + Math.PI + this.orbitAz;
    const ce = Math.cos(this.orbitEl);
    _a.set(Math.sin(a) * ce, Math.sin(this.orbitEl), -Math.cos(a) * ce);
    out.position.copy(this.acPos).addScaledVector(_a, this.orbitDist);
    lookAtQuaternion(out.position, this.acPos, WORLD_UP, out.quaternion);
    out.fov = o.fov;
  }

  private weapon(sim: Sim, dt: number, simDt: number, entering: boolean, out: CameraPose): boolean {
    const w = OUTSIDE.weapon;
    const b = newestBody(sim);
    if (b) {
      if (b.id !== this.weaponId || entering) {
        this.weaponId = b.id;
        this.weaponImpactValid = false;
      }
      bodyDrawPosition(b, _p);
      if (b.velocity.lengthSq() > 1) _a.copy(b.velocity).normalize();
      else _a.set(0, 0, -1).applyQuaternion(b.orientation);
      this.weaponCam.copy(_p).addScaledVector(_a, -w.back).addScaledVector(WORLD_UP, w.up);
      _b.copy(_p).addScaledVector(_a, w.aimAhead);
      this.weaponLast.copy(_p);
      this.weaponDir.copy(_a);
      this.weaponHold = w.hold;
      out.position.copy(this.weaponCam);
      lookAtQuaternion(this.weaponCam, _b, upHint(_a, _up), out.quaternion);
      out.fov = w.fov;
      return true;
    }
    if (this.weaponId >= 0 && this.weaponHold > 0 && !entering) {
      // the store is gone: back off to a vantage point above its impact and watch it (the hold
      // runs on simulated time, the easing on real time)
      const t = Math.max(0, dt);
      this.weaponHold -= Math.max(0, simDt);
      const impact = this.weaponImpactValid ? this.weaponImpact : this.weaponLast;
      _a.copy(impact)
        .addScaledVector(this.weaponDir, -w.holdBack)
        .addScaledVector(WORLD_UP, w.holdUp);
      this.weaponCam.lerp(_a, 1 - Math.exp(-t / w.holdTau));
      out.position.copy(this.weaponCam);
      _c.subVectors(impact, this.weaponCam);
      lookAtQuaternion(this.weaponCam, impact, upHint(_c.normalize(), _up), out.quaternion);
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
    let veh = findVehicle(sim, this.watchedVehicle());
    if (!veh) {
      // nothing hit yet: the vehicle nearest where the gun points, else nearest ahead
      const g = sim.avionics.gun;
      _d.copy(sim.aircraft.velocity).setY(0);
      if (_d.lengthSq() < 1) _d.set(0, 0, -1);
      _d.normalize().multiplyScalar(2000).add(this.acPos);
      const id = nearestVehicle(sim, g.valid ? g.impact : _d, Infinity);
      veh = findVehicle(sim, id);
      if (!veh) return false;
      this.targetVehicle = id;
    }
    // horizontal direction from the vehicle to the aircraft
    _a.subVectors(this.acPos, veh.position).setY(0);
    if (_a.lengthSq() < 1) _a.set(0, 0, -1);
    _a.normalize();
    const moved = this.targetFrom.dot(_a) < 0.2 && this.acPos.distanceTo(veh.position) > 1500;
    if (entering || this.placedVehicle !== veh.id || moved) {
      // behind the vehicle as seen from the aircraft, a little to the side and up
      _c.crossVectors(_a, WORLD_UP).normalize();
      this.targetCam.copy(veh.position).addScaledVector(_a, -t.back).addScaledVector(_c, t.side);
      this.targetCam.y =
        Math.max(veh.position.y, groundAt(this.targetCam.x, this.targetCam.z)) + t.up;
      this.targetFrom.copy(_a);
      this.placedVehicle = veh.id;
    }
    // look at the aircraft, leaning toward the vehicle so both stay in the picture
    _b.subVectors(this.acPos, this.targetCam).normalize();
    _c.copy(veh.position).addScaledVector(WORLD_UP, 1.2).sub(this.targetCam).normalize();
    _b.multiplyScalar(0.72).addScaledVector(_c, 0.28).normalize();
    _b.add(this.targetCam);
    out.position.copy(this.targetCam);
    lookAtQuaternion(this.targetCam, _b, WORLD_UP, out.quaternion);
    out.fov = t.fov;
    return true;
  }
}

/** The newest store in flight (highest body id), or null. */
function newestBody(sim: Sim): StoreBody | null {
  const bodies = sim.projectiles.bodies;
  let best: StoreBody | null = null;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (b.alive && (!best || b.id > best.id)) best = b;
  }
  return best;
}

/**
 * An up hint for looking along `dir`: world up, unless the view looks almost straight down or
 * up (a bomb's last seconds), where the horizontal part of the path keeps the picture upright.
 */
function upHint(dir: Vector3, out: Vector3): Vector3 {
  if (Math.abs(dir.y) < 0.97) return out.copy(WORLD_UP);
  out.set(dir.x, 0, dir.z);
  if (out.lengthSq() < 1e-8) out.set(0, 0, -1);
  return out.normalize();
}

/** Unit direction of the flight path (the drawn nose when nearly stopped). */
function velocityDirection(sim: Sim, drawnQuat: Quaternion, out: Vector3): Vector3 {
  const v = sim.aircraft.velocity;
  if (v.lengthSq() > 25) return out.copy(v).normalize();
  _q.copy(drawnQuat);
  return out.set(0, 0, -1).applyQuaternion(_q);
}

function findVehicle(sim: Sim, id: number) {
  if (id < 0) return null;
  const list = sim.targets.vehicles;
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/** Id of the vehicle nearest a point within `radius` (m), or −1. */
export function nearestVehicle(
  sim: Sim,
  p: { x: number; y: number; z: number },
  radius: number,
): number {
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
