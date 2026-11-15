/**
 * CameraRigController — the whole camera rig as one object with one `update()` per frame.
 *
 * Structure of a frame:
 *   1. work out which view is active (screen + camera mode) and start a blend if it changed;
 *   2. drain pointer / stick input into this frame's drag, stick and zoom amounts;
 *   3. compute the pose of the active view (each view keeps its own smoothing state);
 *   4. blend from the pose the camera had when the view changed (eased, slerp);
 *   5. enforce the constraints (above the sea, outside the ship);
 *   6. hand the clean pose to the shake stage, which writes the camera.
 *
 * Everything is advanced with `sim.dt`, so the rig freezes on pause. With `?fixedTime` the
 * clock never advances; the rig then settles instantly on its targets so that every frame of
 * a deterministic screenshot is identical. The rig never allocates per frame.
 */
import { Euler, Matrix4, Quaternion, Vector3, type PerspectiveCamera } from 'three';
import { debugFlags } from '../../config/debugFlags';
import type { HotspotId } from '../../config/layout';
import { waveHeightAt } from '../../config/waves';
import { input } from '../../controls/input';
import { sim } from '../../state/sim';
import { carrierLocalToWorld, worldToCarrierLocal } from '../../state/simHelpers';
import { useGameStore } from '../../state/useGameStore';
import { DEG2RAD, clamp, lerp, smoothstep, wrapAngle } from '../../utils/math';
import {
  blendPose,
  easeInOutCubic,
  makeSpring,
  portraitFit,
  resetSpring,
  sphericalOffset,
  springAngleTo,
  springTo,
  yawBehind,
  type Spring,
} from './cameraMath';
import {
  BRIDGE_VIEW,
  CHASE,
  DECK_VIEW,
  DRAG_RADIANS,
  FLIGHT_ORBIT,
  FOV,
  HANGAR,
  HANGAR_FOCUS,
  HOTSPOT_FRAMING,
  LOOK_SMOOTH_TIME,
  MENU,
  SEA_CLEARANCE,
  STICK_RATE,
  TRANSITION_TIME,
  TURBINE_VIEW,
  turbineView,
  type FirstPersonView,
} from './framing';
import type { CameraPointerInput, PointerDeltas } from './pointerInput';
import { applyShake } from './shake';
import { clearOrbitDistance, pushOutOfShip } from './shipVolumes';
import { isExteriorView, resolveView, sharesOrbit, type ViewKind } from './views';

const WORLD_UP = new Vector3(0, 1, 0);
/** Smallest field-of-view change worth a projection-matrix update, degrees. */
const FOV_EPSILON = 0.01;
/** How quickly an orbit camera that was pushed out of the ship settles back in, s. */
const CLEARANCE_RELEASE_TIME = 0.5;
const ZOOM_SMOOTH_TIME = 0.3;

const TURBINE_VIEWS = [0, 1, 2, 3].map(turbineView);

// scratch objects — the rig never allocates per frame
const _deltas: PointerDeltas = { dx: 0, dy: 0, zoom: 1 };
const _pos = new Vector3();
const _quat = new Quaternion();
const _focus = new Vector3();
const _dir = new Vector3();
const _up = new Vector3();
const _from = new Vector3();
const _forward = new Vector3();
const _local = new Vector3();
const _localDir = new Vector3();
const _inverse = new Quaternion();
const _twist = new Quaternion();
const _matrix = new Matrix4();
const _euler = new Euler(0, 0, 0, 'YXZ');

function clampAboveSea(p: Vector3): void {
  const floor = waveHeightAt(p.x, p.z, sim.time) + SEA_CLEARANCE;
  if (p.y < floor) p.y = floor;
}

export class CameraRigController {
  private initialised = false;
  private view: ViewKind = 'menu';
  private turbineIndex = 0;

  // ---- this frame ----
  private dt = 0;
  /** When true, smoothing is bypassed and every spring lands on its target. */
  private settle = true;
  private dragX = 0;
  private dragY = 0;
  private stickX = 0;
  private stickY = 0;
  private zoom = 1;
  private inputActive = false;

  // ---- orbit (menu, hangar, flying orbit) ----
  private readonly orbitYaw = makeSpring();
  private readonly orbitPitch = makeSpring();
  private readonly orbitDistance = makeSpring(HANGAR.distance);
  private orbitYawTarget = 0;
  private orbitPitchTarget = 0;
  private orbitDistanceTarget: number = HANGAR.distance;
  private readonly focusX = makeSpring();
  private readonly focusY = makeSpring();
  private readonly focusZ = makeSpring();
  private readonly focusTarget = new Vector3();
  private menuYawBias = 0;
  private hotspot: HotspotId | null = null;
  private wholeShipDistance: number = HANGAR.distance;
  private idleTime = 0;
  private easeTime = 0;

  // ---- chase ----
  private readonly chaseYaw = makeSpring();
  private readonly chaseDragYaw = makeSpring();
  private readonly chaseDragPitch = makeSpring();
  private chaseDragYawTarget = 0;
  private chaseDragPitchTarget = 0;
  private readonly chaseDistance = makeSpring(CHASE.distance);
  private chaseDistanceTarget: number = CHASE.distance;
  private readonly chaseSpeed = makeSpring();
  private sinceDrag = 0;
  private returning = false;

  // ---- deck / bridge look-around ----
  private readonly lookYaw = makeSpring();
  private readonly lookPitch = makeSpring();
  private lookYawTarget = 0;
  private lookPitchTarget = 0;

  // ---- turbine close-up ----
  private readonly turbineYaw = makeSpring();
  private readonly turbinePitch = makeSpring();
  private turbineYawTarget = 0;
  private turbinePitchTarget = 0;
  private readonly turbineDistance = makeSpring(TURBINE_VIEW.distance);
  private turbineDistanceTarget: number = TURBINE_VIEW.distance;

  // ---- shared by the orbiting views ----
  private readonly clearance = makeSpring();
  private lastShipYaw = 0;

  // ---- transition ----
  private blend = 1;
  private blendExterior = false;
  private readonly fromOffset = new Vector3();
  private readonly fromQuaternion = new Quaternion();
  private fromFov: number = FOV.exterior;

  // ---- clean pose (before shake) ----
  private readonly position = new Vector3();
  private readonly quaternion = new Quaternion();
  private fov: number = FOV.exterior;
  /** Clean position relative to the ship: survives the ship being teleported by a sim reset. */
  private readonly offset = new Vector3();

  /** Advance the rig by one frame and write the camera (pose, fov, `sim.camera`). */
  update(camera: PerspectiveCamera, pointer: CameraPointerInput): void {
    const store = useGameStore.getState();
    const view = resolveView(store.screen, store.cameraMode);
    const first = !this.initialised;
    const frozenClock = debugFlags.fixedTime !== null;
    const instant = first || frozenClock;
    const aspect = camera.aspect > 0 ? camera.aspect : 1;
    this.dt = frozenClock ? 0 : sim.dt;
    this.settle = instant;

    this.readInput(pointer, view, frozenClock);

    const turbineChanged = view === 'turbine' && store.cameraTurbine !== this.turbineIndex;
    if (first || view !== this.view || turbineChanged) {
      const previous = first ? null : this.view;
      if (!first) {
        this.fromOffset.copy(this.offset);
        this.fromQuaternion.copy(this.quaternion);
        this.fromFov = this.fov;
        this.blend = 0;
        this.blendExterior = isExteriorView(this.view) && isExteriorView(view);
      }
      this.enterView(view, previous, aspect);
      this.view = view;
      this.turbineIndex = store.cameraTurbine;
      this.initialised = true;
    }

    let fov: number;
    switch (view) {
      case 'chase':
        fov = this.chasePose();
        break;
      case 'deck':
        fov = this.firstPersonPose(DECK_VIEW);
        break;
      case 'bridge':
        fov = this.firstPersonPose(BRIDGE_VIEW);
        break;
      case 'turbine':
        fov = this.turbinePose();
        break;
      default:
        fov = this.orbitPose(view, store.hangar.selectedHotspot, aspect);
    }

    if (this.blend < 1) {
      this.blend = instant ? 1 : Math.min(1, this.blend + this.dt / TRANSITION_TIME);
    }
    if (this.blend < 1) {
      const eased = easeInOutCubic(this.blend);
      _from.copy(sim.carrier.position).add(this.fromOffset);
      blendPose(_from, this.fromQuaternion, _pos, _quat, eased, this.position, this.quaternion);
      this.fov = lerp(this.fromFov, fov, eased);
      if (this.blendExterior) {
        // slide around the ship instead of cutting through it
        worldToCarrierLocal(this.position, _local);
        if (pushOutOfShip(_local)) carrierLocalToWorld(_local, this.position);
      }
    } else {
      this.position.copy(_pos);
      this.quaternion.copy(_quat);
      this.fov = fov;
    }

    const exterior = isExteriorView(view);
    if (exterior) clampAboveSea(this.position);
    this.offset.copy(this.position).sub(sim.carrier.position);

    applyShake(camera, this.position, this.quaternion, store.settings.cameraShake);
    if (exterior) clampAboveSea(camera.position);

    if (Math.abs(camera.fov - this.fov) > FOV_EPSILON) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    sim.camera.position.copy(camera.position);
    sim.camera.quaternion.copy(camera.quaternion);
    this.settle = false;
  }

  /** Turn accumulated pointer deltas and the look stick into this frame's angles and zoom. */
  private readInput(pointer: CameraPointerInput, view: ViewKind, frozenClock: boolean): void {
    pointer.setInteractive(view !== 'menu');
    pointer.consume(_deltas);
    // while paused nothing moves; the menu orbit is purely cinematic
    const live = (frozenClock || sim.dt > 0) && view !== 'menu';
    if (!live) {
      this.dragX = 0;
      this.dragY = 0;
      this.stickX = 0;
      this.stickY = 0;
      this.zoom = 1;
      this.inputActive = false;
      return;
    }
    const radiansPerPixel = DRAG_RADIANS / pointer.height;
    this.dragX = _deltas.dx * radiansPerPixel;
    this.dragY = _deltas.dy * radiansPerPixel;
    this.zoom = _deltas.zoom;
    this.stickX = input.lookX * STICK_RATE * this.dt;
    this.stickY = input.lookY * STICK_RATE * this.dt;
    this.inputActive =
      pointer.dragging ||
      this.dragX !== 0 ||
      this.dragY !== 0 ||
      this.zoom !== 1 ||
      this.stickX !== 0 ||
      this.stickY !== 0;
  }

  /** Initialise the state of the view being entered. The blend hides the hand-over. */
  private enterView(view: ViewKind, previous: ViewKind | null, aspect: number): void {
    const continuous = sharesOrbit(previous, view);
    if (!continuous) this.settle = true;
    const shipYaw = this.shipYaw();
    switch (view) {
      case 'menu':
        // keep turning from wherever the hangar orbit left the camera
        this.menuYawBias = continuous
          ? this.orbitYaw.value - (MENU.yaw0 + sim.time * MENU.yawRate)
          : 0;
        this.focusTarget.set(HANGAR_FOCUS[0], HANGAR_FOCUS[1], HANGAR_FOCUS[2]);
        break;
      case 'hangar':
        this.orbitYawTarget = continuous ? this.orbitYaw.value : shipYaw + HANGAR.yaw0;
        this.orbitPitchTarget = HANGAR.pitch;
        this.orbitDistanceTarget = HANGAR.distance * portraitFit(aspect);
        this.wholeShipDistance = this.orbitDistanceTarget;
        this.focusTarget.set(HANGAR_FOCUS[0], HANGAR_FOCUS[1], HANGAR_FOCUS[2]);
        this.hotspot = null;
        this.idleTime = HANGAR.autoDelay + HANGAR.autoRamp;
        this.easeTime = 0;
        break;
      case 'orbit':
        this.orbitYawTarget = shipYaw + FLIGHT_ORBIT.yawOffset;
        this.orbitPitchTarget = FLIGHT_ORBIT.pitch;
        this.orbitDistanceTarget = FLIGHT_ORBIT.distance;
        this.focusTarget.set(FLIGHT_ORBIT.focus[0], FLIGHT_ORBIT.focus[1], FLIGHT_ORBIT.focus[2]);
        break;
      case 'chase':
        resetSpring(this.chaseYaw, shipYaw);
        this.chaseDragYawTarget = 0;
        this.chaseDragPitchTarget = 0;
        this.sinceDrag = 0;
        this.returning = false;
        break;
      case 'deck':
      case 'bridge':
        this.lookYawTarget = 0;
        this.lookPitchTarget = 0;
        break;
      case 'turbine':
        this.turbineYawTarget = 0;
        this.turbinePitchTarget = 0;
        this.turbineDistanceTarget = TURBINE_VIEW.distance;
        break;
    }
    resetSpring(this.clearance, 0);
  }

  private follow(spring: Spring, target: number, smoothTime: number): number {
    if (this.settle) {
      resetSpring(spring, target);
      return target;
    }
    return springTo(spring, target, smoothTime, this.dt);
  }

  private followAngle(spring: Spring, target: number, smoothTime: number): number {
    if (this.settle) {
      resetSpring(spring, target);
      return target;
    }
    return springAngleTo(spring, target, smoothTime, this.dt);
  }

  /** Orbit azimuth of the point dead astern of the ship (its heading, as a camera yaw). */
  private shipYaw(): number {
    _forward.set(0, 0, -1).applyQuaternion(sim.carrier.quaternion);
    // keep the last good value while the bow points almost straight up or down
    if (_forward.x * _forward.x + _forward.z * _forward.z > 0.01) {
      this.lastShipYaw = yawBehind(_forward.x, _forward.z);
    }
    return this.lastShipYaw;
  }

  /**
   * Place the camera `distance` from `focus` along the unit direction `dir` (both world
   * space), pushed outward if that spot is inside the ship and lifted if it is under the
   * sea, looking at the focus with `up` as its vertical. Writes `_pos` / `_quat`.
   */
  private placeOrbit(focus: Vector3, dir: Vector3, distance: number, up: Vector3): void {
    worldToCarrierLocal(focus, _local);
    _localDir.copy(dir).applyQuaternion(_inverse.copy(sim.carrier.quaternion).invert());
    const needed = clearOrbitDistance(_local, _localDir, distance) - distance;
    // out at once, back in gently
    if (needed >= this.clearance.value) resetSpring(this.clearance, needed);
    else this.follow(this.clearance, needed, CLEARANCE_RELEASE_TIME);
    const clear = clearOrbitDistance(_local, _localDir, distance + this.clearance.value);
    _pos.copy(focus).addScaledVector(dir, clear);
    clampAboveSea(_pos);
    _quat.setFromRotationMatrix(_matrix.lookAt(_pos, focus, up));
  }

  private orbitPose(
    view: 'menu' | 'hangar' | 'orbit',
    hotspot: HotspotId | null,
    aspect: number,
  ): number {
    const c = sim.carrier;
    const fit = portraitFit(aspect);
    let angleSmoothTime: number = HANGAR.userSmoothTime;

    if (view === 'menu') {
      const t = sim.time;
      this.orbitYawTarget = MENU.yaw0 + t * MENU.yawRate + this.menuYawBias;
      this.orbitPitchTarget = MENU.pitch + MENU.pitchSwing * Math.sin(t * MENU.pitchRate);
      this.orbitDistanceTarget =
        (MENU.distance + MENU.distanceSwing * Math.sin(t * MENU.distanceRate)) * fit;
      angleSmoothTime = MENU.smoothTime;
    } else {
      const limits = view === 'hangar' ? HANGAR : FLIGHT_ORBIT;
      if (view === 'hangar') angleSmoothTime = this.updateHangar(hotspot, fit);
      this.orbitYawTarget -= this.dragX + this.stickX;
      this.orbitPitchTarget = clamp(
        this.orbitPitchTarget + this.dragY - this.stickY,
        limits.minPitch,
        limits.maxPitch,
      );
      this.orbitDistanceTarget = clamp(
        this.orbitDistanceTarget * this.zoom,
        limits.minDistance,
        limits.maxDistance * fit,
      );
    }

    const yaw = this.follow(this.orbitYaw, this.orbitYawTarget, angleSmoothTime);
    const pitch = this.follow(this.orbitPitch, this.orbitPitchTarget, angleSmoothTime);
    const distance = this.follow(
      this.orbitDistance,
      this.orbitDistanceTarget,
      HANGAR.distanceSmoothTime,
    );
    _focus
      .set(
        this.follow(this.focusX, this.focusTarget.x, HANGAR.focusSmoothTime),
        this.follow(this.focusY, this.focusTarget.y, HANGAR.focusSmoothTime),
        this.follow(this.focusZ, this.focusTarget.z, HANGAR.focusSmoothTime),
      )
      .applyQuaternion(c.quaternion)
      .add(c.position);
    sphericalOffset(yaw, pitch, 1, _dir);
    this.placeOrbit(_focus, _dir, distance, WORLD_UP);

    if (view === 'menu') {
      // turn the camera to the left so the ship sits right of centre, clear of the menu panel
      const shift =
        MENU.shipNdcX * smoothstep(MENU.shiftAspectMin, MENU.shiftAspectMax, aspect) * aspect;
      const angle = Math.atan(shift * Math.tan((FOV.exterior * DEG2RAD) / 2));
      _quat.premultiply(_twist.setFromAxisAngle(WORLD_UP, angle));
    }
    return FOV.exterior;
  }

  /** Hangar extras: hotspot framing and the idle auto-rotation. Returns the angle smoothing to use. */
  private updateHangar(hotspot: HotspotId | null, fit: number): number {
    if (hotspot !== this.hotspot) {
      if (hotspot) {
        if (!this.hotspot) this.wholeShipDistance = this.orbitDistanceTarget;
        const framing = HOTSPOT_FRAMING[hotspot];
        this.focusTarget.set(framing.anchor[0], framing.anchor[1], framing.anchor[2]);
        this.orbitDistanceTarget = framing.distance * fit;
        // swing the short way round to the side the hotspot is best seen from
        this.orbitYawTarget =
          this.orbitYaw.value + wrapAngle(framing.yaw + this.shipYaw() - this.orbitYaw.value);
        this.orbitPitchTarget = framing.pitch;
      } else {
        this.focusTarget.set(HANGAR_FOCUS[0], HANGAR_FOCUS[1], HANGAR_FOCUS[2]);
        this.orbitDistanceTarget = this.wholeShipDistance;
      }
      this.hotspot = hotspot;
      this.idleTime = 0;
      this.easeTime = HANGAR.easeDuration;
    }

    if (this.inputActive) {
      this.idleTime = 0;
      this.easeTime = 0;
    } else {
      this.idleTime += this.dt;
      this.easeTime = Math.max(0, this.easeTime - this.dt);
    }
    if (!hotspot && this.idleTime >= HANGAR.autoDelay) {
      const ramp = smoothstep(HANGAR.autoDelay, HANGAR.autoDelay + HANGAR.autoRamp, this.idleTime);
      this.orbitYawTarget += HANGAR.autoRate * ramp * this.dt;
    }
    return this.easeTime > 0 ? HANGAR.easeSmoothTime : HANGAR.userSmoothTime;
  }

  private chasePose(): number {
    const c = sim.carrier;
    const yaw = this.followAngle(this.chaseYaw, this.shipYaw(), CHASE.yawSmoothTime);

    if (this.inputActive) {
      this.sinceDrag = 0;
      this.returning = false;
      this.chaseDragYawTarget -= this.dragX + this.stickX;
      this.chaseDragPitchTarget = clamp(
        this.chaseDragPitchTarget + this.dragY - this.stickY,
        CHASE.minElevation - CHASE.elevation,
        CHASE.maxElevation - CHASE.elevation,
      );
    } else {
      this.sinceDrag += this.dt;
      if (!this.returning && this.sinceDrag >= CHASE.returnDelay) {
        // ease back behind the ship, the short way round
        this.returning = true;
        this.chaseDragYaw.value = wrapAngle(this.chaseDragYaw.value);
        this.chaseDragYawTarget = 0;
        this.chaseDragPitchTarget = 0;
      }
    }
    const dragSmoothTime = this.returning ? CHASE.returnSmoothTime : CHASE.dragSmoothTime;
    const dragYaw = this.follow(this.chaseDragYaw, this.chaseDragYawTarget, dragSmoothTime);
    const dragPitch = this.follow(this.chaseDragPitch, this.chaseDragPitchTarget, dragSmoothTime);

    this.chaseDistanceTarget = clamp(
      this.chaseDistanceTarget * this.zoom,
      CHASE.minDistance,
      CHASE.maxDistance,
    );
    const baseDistance = this.follow(
      this.chaseDistance,
      this.chaseDistanceTarget,
      ZOOM_SMOOTH_TIME,
    );
    // distance and field of view breathe with speed
    const speed = this.follow(
      this.chaseSpeed,
      smoothstep(4, CHASE.speedRef, c.speed),
      CHASE.speedSmoothTime,
    );
    const distance = baseDistance * (1 + CHASE.speedDistanceGain * speed);

    // look a little ahead of and above the centre of mass, along the smoothed heading
    _focus
      .set(-Math.sin(yaw) * CHASE.lookAhead, CHASE.lookUp, -Math.cos(yaw) * CHASE.lookAhead)
      .add(c.position);
    sphericalOffset(yaw + dragYaw, CHASE.elevation + dragPitch, 1, _dir);
    this.placeOrbit(_focus, _dir, distance, WORLD_UP);
    return FOV.exterior + FOV.chaseSpeedGain * speed;
  }

  /** Deck and bridge: an eye point fixed to the ship, with a limited look-around. */
  private firstPersonPose(view: FirstPersonView): number {
    this.lookYawTarget = clamp(
      this.lookYawTarget - this.dragX + this.stickX,
      -view.maxLookYaw,
      view.maxLookYaw,
    );
    this.lookPitchTarget = clamp(
      this.lookPitchTarget + this.dragY + this.stickY,
      view.minLookPitch,
      view.maxLookPitch,
    );
    const lookYaw = this.follow(this.lookYaw, this.lookYawTarget, LOOK_SMOOTH_TIME);
    const lookPitch = this.follow(this.lookPitch, this.lookPitchTarget, LOOK_SMOOTH_TIME);

    carrierLocalToWorld(view.eye, _pos);
    // ship-frame yaw is positive toward port, the look offset positive toward the right
    _euler.set(view.pitch + lookPitch, view.yaw - lookYaw, 0, 'YXZ');
    _quat.setFromEuler(_euler).premultiply(sim.carrier.quaternion);
    return view.fov;
  }

  /** Turbine close-up: a small orbit in the ship's frame, so it rides with the ship. */
  private turbinePose(): number {
    const c = sim.carrier;
    const view = TURBINE_VIEWS[this.turbineIndex] ?? TURBINE_VIEWS[0];
    this.turbineYawTarget = clamp(
      this.turbineYawTarget - this.dragX - this.stickX,
      -TURBINE_VIEW.maxOrbitYaw,
      TURBINE_VIEW.maxOrbitYaw,
    );
    this.turbinePitchTarget = clamp(
      this.turbinePitchTarget + this.dragY - this.stickY,
      TURBINE_VIEW.minElevation - view.pitch,
      TURBINE_VIEW.maxElevation - view.pitch,
    );
    this.turbineDistanceTarget = clamp(
      this.turbineDistanceTarget * this.zoom,
      TURBINE_VIEW.minDistance,
      TURBINE_VIEW.maxDistance,
    );
    const yaw = this.follow(this.turbineYaw, this.turbineYawTarget, TURBINE_VIEW.smoothTime);
    const pitch = this.follow(this.turbinePitch, this.turbinePitchTarget, TURBINE_VIEW.smoothTime);
    const distance = this.follow(
      this.turbineDistance,
      this.turbineDistanceTarget,
      ZOOM_SMOOTH_TIME,
    );

    carrierLocalToWorld(view.focus, _focus);
    sphericalOffset(view.yaw + yaw, view.pitch + pitch, 1, _dir).applyQuaternion(c.quaternion);
    _up.set(0, 1, 0).applyQuaternion(c.quaternion);
    this.placeOrbit(_focus, _dir, distance, _up);
    return FOV.exterior;
  }
}
