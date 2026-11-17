/**
 * Camera rig: places R3F's world camera for every view and, in the cockpit view, the cockpit
 * camera at the pilot's head (useFrame priority A10_PRIORITY.camera, before every visual).
 * OWNED BY THE COCKPIT MODULE (docs/a10/ARCHITECTURE.md §6 "Cameras").
 *
 * Cockpit view: the head (headPose.ts) looks around with the mouse, keys and sticks (±155° of
 * heading like FlightGear's A-10, leaning out to look back), zooms (settings.fov down to 20°
 * while the zoom is held or by wheel steps), looks at the SPI while that key is held, centres
 * on request, moves a little under g and shakes as view/shake.ts asks (jolts, the gun's 65 Hz
 * buzz) and with the airframe's buffet. The head pose goes into cockpitCamera (body frame);
 * the world camera is the aircraft's DRAWN pose (drawPose: interpolated within the last 120 Hz
 * step, ARCHITECTURE §6) composed with it, near plane 1 m — never the last step's pose, which
 * would make the world judder whenever a frame takes 0 or 2 steps (cameraPose.ts).
 *
 * Outside views (outsideViews.ts): chase, flyby, orbit, weapon, target; near plane 0.5 m.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { Quaternion, Vector3, type PerspectiveCamera } from 'three';
import { hudAnglesFromBodyDir, worldToBody } from '../../core/frames';
import type { Sim } from '../../core/types';
import { A10_GEOMETRY } from '../../data/geometry';
import { consumeLook, consumeZoom, viewInput } from '../../input/viewInput';
import { getSim } from '../../state/runtime';
import { useA10Store } from '../../state/store';
import { A10_PRIORITY, drawPose, frameInfo, onSimFrame } from '../frame';
import { shakeState } from '../shake';
import { cockpitWorldCamera } from './cameraPose';
import {
  cockpitCamera,
  cockpitViewState,
  WORLD_NEAR_COCKPIT,
  WORLD_NEAR_OUTSIDE,
} from './cockpitCamera';
import {
  createHeadInput,
  createHeadState,
  headPose,
  resetHead,
  sampleShake,
  stepHead,
  type HeadState,
} from './headPose';
import {
  OutsideCameras,
  type CameraPose,
  type OutsideInput,
  type OutsideView,
} from './outsideViews';

const _look = { x: 0, y: 0 };
const _pos = new Vector3();
const _quat = new Quaternion();
const _eyeW = new Vector3();
const _dir = new Vector3();
/** The aircraft's drawn pose this frame (interpolated within the last step). */
const _acPos = new Vector3();
const _acQuat = new Quaternion();
const _angles = { az: 0, el: 0 };
const _lookAt = { az: 0, el: 0 };
const _pose: CameraPose = { position: new Vector3(), quaternion: new Quaternion(), fov: 50 };

/** The rig's state, for the sandbox, screenshots and tests (window.__A10_COCKPIT__ in dev). */
export interface CameraRigHandle {
  head: HeadState;
  outside: OutsideCameras;
  /** The view the outside cameras actually showed last frame (weapon/target may fall back). */
  shownView: string;
  /** Look somewhere (degrees, + right / + up) at once. */
  setLook(azDeg: number, elDeg: number): void;
  /** A field of view (degrees) that replaces the head's zoom while set (sandbox, screenshots). */
  fovOverride: number | null;
}

export const cameraRigHandle: { current: CameraRigHandle | null } = { current: null };

function setPerspective(cam: PerspectiveCamera, fov: number, near: number, aspect?: number): void {
  let dirty = false;
  if (Math.abs(cam.fov - fov) > 1e-6) {
    cam.fov = fov;
    dirty = true;
  }
  if (cam.near !== near) {
    cam.near = near;
    dirty = true;
  }
  if (aspect !== undefined && Math.abs(cam.aspect - aspect) > 1e-9) {
    cam.aspect = aspect;
    dirty = true;
  }
  if (dirty) cam.updateProjectionMatrix();
}

/** The direction to look at for look-at-SPI: the SPI, else the active steerpoint. */
function lookAtTarget(sim: Sim): Vector3 | null {
  const av = sim.avionics;
  if (av.spi.valid) return av.spi.position;
  const sp = av.steerpoints[av.activeSteerpoint];
  return sp ? sp.position : null;
}

/**
 * Drive R3F's camera and the cockpit camera from `source` (the live flight, or a sandbox's).
 * Mount once per canvas.
 */
export function useCameraRig(source: () => Sim | null): void {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const rig = useMemo(() => {
    const head = createHeadState(useA10Store.getState().settings.fov);
    const outside = new OutsideCameras();
    const input = createHeadInput();
    const outsideInput: OutsideInput = {
      dt: 0,
      simDt: 0,
      lookDX: 0,
      lookDY: 0,
      lookRateX: 0,
      lookRateY: 0,
      zoomSteps: 0,
    };
    const handle: CameraRigHandle = {
      head,
      outside,
      shownView: 'cockpit',
      fovOverride: null,
      setLook(azDeg, elDeg) {
        head.az = (azDeg * Math.PI) / 180;
        head.el = (elDeg * Math.PI) / 180;
        head.centering = false;
        head.restoring = false;
      },
    };
    const state = { head, outside, input, outsideInput, handle, sim: null as Sim | null, groundAt };
    /** Ground height under a point (the flight's terrain), for the outside cameras. */
    function groundAt(x: number, z: number): number {
      return state.sim ? state.sim.world.terrain.heightAt(x, z) : -Infinity;
    }
    return state;
  }, []);

  useEffect(() => {
    cameraRigHandle.current = rig.handle;
    if (import.meta.env.DEV && typeof window !== 'undefined')
      (window as unknown as { __A10_COCKPIT__?: CameraRigHandle }).__A10_COCKPIT__ = rig.handle;
    const off = onSimFrame((events, sim) => {
      if (sim === source()) rig.outside.noteEvents(events, sim);
    });
    return () => {
      off();
      if (cameraRigHandle.current === rig.handle) cameraRigHandle.current = null;
    };
  }, [rig, source]);

  useFrame((_state, delta) => {
    const sim = source();
    const settings = useA10Store.getState().settings;
    if (!sim) {
      cockpitViewState.active = false;
      return;
    }
    if (sim !== rig.sim) {
      rig.sim = sim;
      resetHead(rig.head, settings.fov);
      rig.outside.reset();
    }
    const view = useA10Store.getState().view;
    const ac = sim.aircraft;
    const dt = Math.min(0.1, Math.max(0, delta));
    consumeLook(_look);
    const zoom = consumeZoom();

    if (view === 'cockpit') {
      cockpitViewState.active = true;
      const inp = rig.input;
      inp.dt = dt;
      inp.simDt = frameInfo.simDt;
      inp.lookDX = viewInput.cursorFree ? 0 : _look.x;
      inp.lookDY = viewInput.cursorFree ? 0 : _look.y;
      inp.lookRateX = viewInput.lookX;
      inp.lookRateY = viewInput.lookY;
      inp.zoomSteps = zoom;
      inp.zoomHeld = viewInput.zoomHeld;
      inp.center = viewInput.centerView;
      inp.baseFov = settings.fov;
      inp.gLoad = ac.gLoad;
      inp.lateralG = ac.lateralG;
      inp.axialG = ac.axialG;
      inp.buffet = ac.buffet;
      inp.lookAt = null;
      const target = viewInput.lookAtSpi ? lookAtTarget(sim) : null;
      if (target) {
        // from the eye (as last placed, on the drawn pose) to the SPI, in body HUD angles
        drawPose(sim, _acPos, _acQuat);
        _eyeW.copy(cockpitCamera.position).applyQuaternion(_acQuat).add(_acPos);
        worldToBody(_acQuat, _dir.subVectors(target, _eyeW), _dir);
        hudAnglesFromBodyDir(_dir, _angles);
        _lookAt.az = _angles.az;
        _lookAt.el = _angles.el;
        inp.lookAt = _lookAt;
      }
      stepHead(rig.head, inp);
      if (rig.handle.fovOverride !== null) rig.head.fov = rig.handle.fovOverride;
      sampleShake(rig.head, shakeState, ac.buffet, sim.time, frameInfo.simDt);
      headPose(rig.head, A10_GEOMETRY.eye, _pos, _quat);

      cockpitCamera.position.copy(_pos);
      cockpitCamera.quaternion.copy(_quat);
      setPerspective(cockpitCamera, rig.head.fov, cockpitCamera.near, camera.aspect);
      cockpitCamera.updateMatrixWorld();

      // world camera = the aircraft's drawn pose ∘ head pose
      cockpitWorldCamera(sim, _pos, _quat, camera.position, camera.quaternion);
      setPerspective(camera, rig.head.fov, WORLD_NEAR_COCKPIT);
      rig.outside.leave();
      rig.handle.shownView = 'cockpit';
    } else {
      cockpitViewState.active = false;
      // the shake requests are the cockpit's: consume them so they do not pile up
      shakeState.vibration = 0;
      shakeState.impulse *= Math.exp(-frameInfo.simDt / 0.35);
      const o = rig.outsideInput;
      o.dt = dt;
      o.simDt = frameInfo.simDt;
      o.lookDX = viewInput.cursorFree ? 0 : _look.x;
      o.lookDY = viewInput.cursorFree ? 0 : _look.y;
      o.lookRateX = viewInput.lookX;
      o.lookRateY = viewInput.lookY;
      o.zoomSteps = zoom;
      rig.handle.shownView = rig.outside.update(view as OutsideView, sim, o, rig.groundAt, _pose);
      camera.position.copy(_pose.position);
      camera.quaternion.copy(_pose.quaternion);
      setPerspective(camera, _pose.fov, WORLD_NEAR_OUTSIDE);
    }
    camera.updateMatrixWorld();
  }, A10_PRIORITY.camera);
}

export default function CameraRig() {
  useCameraRig(getSim);
  return null;
}
