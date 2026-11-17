/**
 * The pilot's head in the cockpit: where it looks (mouse, keys, sticks, look-at-SPI, centre),
 * the zoom view, the small head movement under g, and the shake requested through view/shake.ts.
 * OWNED BY THE COCKPIT MODULE. Pure math on plain state (three.js math classes only), so it is
 * unit-tested (tests/unit/a10/cockpitHead.test.ts); the camera rig feeds it every frame.
 *
 * Frames: everything here is in the BODY frame (+X right, +Y up, −Z nose), relative to the
 * design eye point (data/geometry.ts). Look angles follow the HUD convention: azimuth + right,
 * elevation + up, of the look direction relative to the boresight.
 */
import { Euler, Quaternion, Vector3 } from 'three';
import type { ShakeState } from '../shake';

const DEG = Math.PI / 180;

/** Tunables of the head (FlightGear's A-10 view: heading ±155°, 0.29 m lean when looking back). */
export const HEAD = {
  /** Look limits, rad. */
  azLimit: 155 * DEG,
  elMin: -75 * DEG,
  elMax: 89 * DEG,
  /** The view the head returns to on "centre": straight ahead, a little down at the panel. */
  defaultAz: 0,
  defaultEl: -9 * DEG,
  /** Mouse look, rad per pixel at the base field of view (finer when zoomed). */
  mouseRadPerPx: 0.11 * DEG,
  /** Key / stick look rate at full deflection, rad/s at the base field of view. */
  lookRate: 140 * DEG,
  /** Narrowest field of view (hold-to-zoom goes straight there), degrees. */
  minFov: 20,
  /** Each zoom step multiplies the field of view by this. */
  zoomStep: 0.84,
  /** Field-of-view smoothing, s. */
  zoomTau: 0.09,
  /** Centre and look-at-SPI slews: exponential time constant (s) and maximum rate (rad/s). */
  slewTau: 0.09,
  slewRate: 320 * DEG,
  /**
   * The eyes turn about the neck, not about themselves: the eye point sits this far above and
   * in front of the pivot (m), so looking around moves the eyes a little, as it does.
   */
  neckToEye: new Vector3(0, 0.1, -0.075),
  /**
   * The neck turns the head this far; beyond it the shoulders twist (the lean below), so the
   * eyes never swing back into the headrest when looking behind.
   */
  neckYawLimit: 60 * DEG,
  /** …and pitches it this far up and down; looking further, the back and shoulders move. */
  neckPitchUp: 40 * DEG,
  neckPitchDown: -60 * DEG,
  /** Lean when looking far back (from 60° to 150° of azimuth): sideways, up, forward (m). */
  leanSide: 0.2,
  leanUp: 0.05,
  leanForward: 0.07,
  /** Lean forward and down when looking down at the consoles (from −20° to −70°), m. */
  leanDownForward: 0.08,
  leanDownDrop: 0.035,
} as const;

/** How the head moves under load (body frame, m per g; clamps in m). */
export const HEAD_G = {
  /** Pushed down by normal load above 1 g, up below it. */
  downPerG: 0.009,
  maxDown: 0.06,
  maxUp: 0.03,
  /** Pushed opposite the lateral specific force (sideways in slips and skids). */
  sidePerG: 0.07,
  maxSide: 0.05,
  /** Pushed aft by forward acceleration (+axialG = pressed into the seat), forward when slowing. */
  aftPerG: 0.025,
  maxAft: 0.03,
  /** The head droops a little under g, rad per g above 1. */
  droopPerG: 0.3 * DEG,
  maxDroop: 2 * DEG,
  /** Neck spring: natural frequency (rad/s) and damping ratio. */
  omega: 9,
  zeta: 0.65,
} as const;

/** Shake amplitudes at full request (rad and m). */
export const HEAD_SHAKE = {
  /** A jolt (addShake 1): broadband 5–13 Hz. */
  joltRot: 0.012,
  joltPos: 0.012,
  /** Impulse decay time constant, s. */
  joltTau: 0.35,
  /** The gun's 65 Hz vibration at request 1: a fine buzz (random each frame). */
  buzzRot: 0.0016,
  buzzPos: 0.003,
  /** Buffet at aircraft.buffet = 1. */
  buffetRot: 0.0045,
  buffetPos: 0.004,
} as const;

export interface HeadState {
  /** Look direction, rad (+ right / + up). */
  az: number;
  el: number;
  /** Field of view now and its target, degrees (vertical). */
  fov: number;
  /** Zoom steps in (0 = the base field of view). */
  zoomLevel: number;
  /** Centring in progress. */
  centering: boolean;
  /** Look-at-SPI: held last frame, and the pose to return to when released. */
  spiHeld: boolean;
  restoring: boolean;
  restAz: number;
  restEl: number;
  /** g-induced head offset (spring-damper state), m and m/s, and the droop (rad, rad/s). */
  g: Vector3;
  gVel: Vector3;
  droop: number;
  droopVel: number;
  /** Shake output this frame: rotation (x pitch, y yaw, z roll, rad) and translation (m). */
  shakeRot: Vector3;
  shakePos: Vector3;
  /** Phases of the jolt noise (re-drawn on a new jolt). */
  phase: Float64Array;
}

export function createHeadState(baseFov = 50): HeadState {
  return {
    az: HEAD.defaultAz,
    el: HEAD.defaultEl,
    fov: baseFov,
    zoomLevel: 0,
    centering: false,
    spiHeld: false,
    restoring: false,
    restAz: HEAD.defaultAz,
    restEl: HEAD.defaultEl,
    g: new Vector3(),
    gVel: new Vector3(),
    droop: 0,
    droopVel: 0,
    shakeRot: new Vector3(),
    shakePos: new Vector3(),
    phase: Float64Array.from([0.3, 1.9, 4.1, 2.6, 0.8, 5.2, 3.3, 1.2, 4.7]),
  };
}

/** Back to the default view at once (a new flight). */
export function resetHead(h: HeadState, baseFov: number): void {
  h.az = HEAD.defaultAz;
  h.el = HEAD.defaultEl;
  h.fov = baseFov;
  h.zoomLevel = 0;
  h.centering = false;
  h.spiHeld = false;
  h.restoring = false;
  h.g.set(0, 0, 0);
  h.gVel.set(0, 0, 0);
  h.droop = 0;
  h.droopVel = 0;
  h.shakeRot.set(0, 0, 0);
  h.shakePos.set(0, 0, 0);
}

export interface HeadInput {
  /** Real seconds since the last frame (look and zoom: they work while paused for screenshots). */
  dt: number;
  /** Simulated seconds this frame (g motion and shake: frozen while paused). */
  simDt: number;
  /** Mouse look, pixels (+ right, + down). */
  lookDX: number;
  lookDY: number;
  /** Look rates −1..1 (+ right, + up). */
  lookRateX: number;
  lookRateY: number;
  /** Zoom steps (+ in) since the last frame. */
  zoomSteps: number;
  zoomHeld: boolean;
  /** Centre the view (one-frame pulse). */
  center: boolean;
  /** The field of view of the settings, degrees (vertical). */
  baseFov: number;
  /** Look-at-SPI held and the SPI's direction (body HUD angles), or null. */
  lookAt: { az: number; el: number } | null;
  /** Load factors (aircraft.gLoad, lateralG, axialG) and buffet 0..1. */
  gLoad: number;
  lateralG: number;
  axialG: number;
  buffet: number;
}

export function createHeadInput(): HeadInput {
  return {
    dt: 0,
    simDt: 0,
    lookDX: 0,
    lookDY: 0,
    lookRateX: 0,
    lookRateY: 0,
    zoomSteps: 0,
    zoomHeld: false,
    center: false,
    baseFov: 50,
    lookAt: null,
    gLoad: 1,
    lateralG: 0,
    axialG: 0,
    buffet: 0,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapPi(a: number): number {
  const TAU = Math.PI * 2;
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

/** Move `cur` toward `target`: exponential approach, rate-limited. */
function slew(cur: number, target: number, dt: number): number {
  const d = target - cur;
  let move = d * (1 - Math.exp(-dt / HEAD.slewTau));
  const lim = HEAD.slewRate * dt;
  if (move > lim) move = lim;
  else if (move < -lim) move = -lim;
  if (Math.abs(d) < 1e-4) return target;
  return cur + move;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** The field of view the zoom asks for, degrees. */
export function zoomTarget(baseFov: number, zoomLevel: number, held: boolean): number {
  const min = Math.min(HEAD.minFov, baseFov);
  if (held) return min;
  return Math.max(min, baseFov * Math.pow(HEAD.zoomStep, zoomLevel));
}

/** The largest useful number of zoom steps for a base field of view. */
export function maxZoomLevel(baseFov: number): number {
  const min = Math.min(HEAD.minFov, baseFov);
  return Math.max(0, Math.ceil(Math.log(min / baseFov) / Math.log(HEAD.zoomStep)));
}

/** Advance the head one frame. */
export function stepHead(h: HeadState, inp: HeadInput): void {
  const dt = Math.max(0, Math.min(0.25, inp.dt));
  const base = clamp(inp.baseFov, 10, 120);

  // ---- zoom ----
  if (inp.center) h.zoomLevel = 0;
  if (inp.zoomSteps !== 0) h.zoomLevel = clamp(h.zoomLevel + inp.zoomSteps, 0, maxZoomLevel(base));
  const target = zoomTarget(base, h.zoomLevel, inp.zoomHeld);
  if (!(h.fov > 0)) h.fov = target;
  const k = 1 - Math.exp(-dt / HEAD.zoomTau);
  h.fov = Math.exp(Math.log(h.fov) + (Math.log(target) - Math.log(h.fov)) * k);
  if (Math.abs(h.fov - target) < 1e-3) h.fov = target;
  /** Look gains scale with the field of view, so a zoomed view is as steady as the full one. */
  const scale = h.fov / base;

  // ---- look ----
  const manual = inp.lookDX !== 0 || inp.lookDY !== 0 || inp.lookRateX !== 0 || inp.lookRateY !== 0;
  if (inp.lookAt) {
    if (!h.spiHeld) {
      h.restAz = h.az;
      h.restEl = h.el;
      h.spiHeld = true;
    }
    h.restoring = false;
    h.centering = false;
    const tAz = clamp(wrapPi(inp.lookAt.az), -HEAD.azLimit, HEAD.azLimit);
    const tEl = clamp(inp.lookAt.el, HEAD.elMin, HEAD.elMax);
    h.az = slew(h.az, tAz, dt);
    h.el = slew(h.el, tEl, dt);
    return finishStep(h, inp);
  }
  if (h.spiHeld) {
    // released: go back to where the pilot was looking
    h.spiHeld = false;
    h.restoring = true;
  }
  if (inp.center) {
    h.centering = true;
    h.restoring = false;
  }
  if (manual) {
    h.centering = false;
    h.restoring = false;
    h.az += (inp.lookDX * HEAD.mouseRadPerPx + inp.lookRateX * HEAD.lookRate * dt) * scale;
    h.el += (-inp.lookDY * HEAD.mouseRadPerPx + inp.lookRateY * HEAD.lookRate * dt) * scale;
  } else if (h.centering || h.restoring) {
    const tAz = h.centering ? HEAD.defaultAz : h.restAz;
    const tEl = h.centering ? HEAD.defaultEl : h.restEl;
    h.az = slew(h.az, tAz, dt);
    h.el = slew(h.el, tEl, dt);
    if (h.az === tAz && h.el === tEl) {
      h.centering = false;
      h.restoring = false;
    }
  }
  h.az = clamp(h.az, -HEAD.azLimit, HEAD.azLimit);
  h.el = clamp(h.el, HEAD.elMin, HEAD.elMax);
  finishStep(h, inp);
}

function finishStep(h: HeadState, inp: HeadInput): void {
  // ---- head movement under g: a damped spring toward the load's push ----
  const sdt = Math.max(0, Math.min(0.1, inp.simDt));
  if (sdt > 0) {
    const g = Number.isFinite(inp.gLoad) ? inp.gLoad : 1;
    const tx = clamp(-inp.lateralG * HEAD_G.sidePerG, -HEAD_G.maxSide, HEAD_G.maxSide);
    const ty = clamp(-(g - 1) * HEAD_G.downPerG, -HEAD_G.maxDown, HEAD_G.maxUp);
    const tz = clamp(inp.axialG * HEAD_G.aftPerG, -HEAD_G.maxAft, HEAD_G.maxAft);
    const tp = clamp(-(g - 1) * HEAD_G.droopPerG, -HEAD_G.maxDroop, HEAD_G.maxDroop / 2);
    const w = HEAD_G.omega;
    const c = 2 * HEAD_G.zeta * w;
    // semi-implicit Euler in sub-steps of ≤ 1/120 s (stable for the neck spring)
    const n = Math.max(1, Math.ceil(sdt * 120));
    const s = sdt / n;
    for (let i = 0; i < n; i++) {
      h.gVel.x += (w * w * (tx - h.g.x) - c * h.gVel.x) * s;
      h.gVel.y += (w * w * (ty - h.g.y) - c * h.gVel.y) * s;
      h.gVel.z += (w * w * (tz - h.g.z) - c * h.gVel.z) * s;
      h.droopVel += (w * w * (tp - h.droop) - c * h.droopVel) * s;
      h.g.addScaledVector(h.gVel, s);
      h.droop += h.droopVel * s;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Shake (view/shake.ts requests, plus the airframe's buffet)
// ---------------------------------------------------------------------------------------------

/**
 * Sample and consume the shake requests for this frame into h.shakeRot / h.shakePos: impulse
 * jolts (decaying), the continuous vibration of the frame (the gun's 65 Hz: a fine random buzz
 * that reads the same at any frame rate; cleared after sampling, as shake.ts says) and buffet.
 * `time` is sim time. While paused (simDt 0) the last offsets hold. `rand` is cosmetic noise.
 */
export function sampleShake(
  h: HeadState,
  shake: ShakeState,
  buffet: number,
  time: number,
  simDt: number,
  rand: () => number = Math.random,
): void {
  const vib = shake.vibration;
  shake.vibration = 0;
  shake.vibrationHz = 0;
  if (simDt <= 0) return;
  const jolt = shake.impulse;
  shake.impulse *= Math.exp(-simDt / HEAD_SHAKE.joltTau);
  if (shake.impulse < 1e-4) shake.impulse = 0;
  const b = clamp(buffet, 0, 1);
  const p = h.phase;
  const t = time * Math.PI * 2;
  const jr = HEAD_SHAKE.joltRot * jolt;
  const jp = HEAD_SHAKE.joltPos * jolt;
  const br = HEAD_SHAKE.buffetRot * b;
  const bp = HEAD_SHAKE.buffetPos * b;
  const vr = HEAD_SHAKE.buzzRot * vib;
  const vp = HEAD_SHAKE.buzzPos * vib;
  h.shakeRot.set(
    joltNoise(t, p, 0, jr) + br * Math.sin(t * 7.5 + 0.4) + vr * (rand() * 2 - 1),
    joltNoise(t, p, 3, jr * 0.7) + br * 0.6 * Math.sin(t * 10.9 + 2.1) + vr * (rand() * 2 - 1),
    joltNoise(t, p, 6, jr * 0.8) + br * 0.5 * Math.sin(t * 9.2 + 4.4) + vr * 0.6 * (rand() * 2 - 1),
  );
  h.shakePos.set(
    joltNoise(t, p, 1, jp * 0.6) + bp * 0.5 * Math.sin(t * 8.1 + 1.7) + vp * (rand() * 2 - 1),
    joltNoise(t, p, 4, jp) + bp * Math.sin(t * 6.8 + 3.0) + vp * (rand() * 2 - 1),
    joltNoise(t, p, 7, jp * 0.5) +
      bp * 0.4 * Math.sin(t * 11.7 + 5.1) +
      vp * 0.5 * (rand() * 2 - 1),
  );
}

/** Broadband jolt noise: three incommensurate sines (5–13 Hz), amplitude ≈ a. */
function joltNoise(t: number, p: Float64Array, o: number, a: number): number {
  if (a === 0) return 0;
  return (
    ((Math.sin(t * 5.3 + p[o % 9]) +
      0.7 * Math.sin(t * 8.7 + p[(o + 1) % 9]) +
      0.45 * Math.sin(t * 13.1 + p[(o + 2) % 9])) /
      2.15) *
    a
  );
}

// ---------------------------------------------------------------------------------------------
// The pose
// ---------------------------------------------------------------------------------------------

const _e = new Euler(0, 0, 0, 'YXZ');
const _q = new Quaternion();
const _v = new Vector3();

/** Head orientation relative to the body for look angles (yaw about +Y, then pitch). */
export function lookQuaternion(az: number, el: number, roll: number, out: Quaternion): Quaternion {
  _e.set(el, -az, roll, 'YXZ');
  return out.setFromEuler(_e);
}

/**
 * The head pose in the BODY frame: `eye` is the design eye point. The eyes turn about the neck,
 * lean out when looking far back and forward when looking down, ride the g spring and shake.
 */
export function headPose(
  h: HeadState,
  eye: { x: number; y: number; z: number },
  outPos: Vector3,
  outQuat: Quaternion,
): void {
  const az = h.az;
  const el = h.el;
  // neck pivot: eye = pivot + R(look) · neckToEye, with the pivot fixed at eye − neckToEye
  lookQuaternion(
    clamp(az, -HEAD.neckYawLimit, HEAD.neckYawLimit),
    clamp(el, HEAD.neckPitchDown, HEAD.neckPitchUp),
    0,
    _q,
  );
  _v.copy(HEAD.neckToEye).applyQuaternion(_q).sub(HEAD.neckToEye);
  outPos.set(eye.x, eye.y, eye.z).add(_v);
  // lean out to look back, forward to look down
  const back = smoothstep(60 * DEG, 150 * DEG, Math.abs(az));
  const down = smoothstep(-20 * DEG, -70 * DEG, el);
  outPos.x += Math.sign(az) * HEAD.leanSide * back;
  outPos.y += HEAD.leanUp * back - HEAD.leanDownDrop * down;
  outPos.z += -HEAD.leanForward * back - HEAD.leanDownForward * down;
  // g and shake
  outPos.add(h.g).add(h.shakePos);
  lookQuaternion(az + h.shakeRot.y, el + h.droop + h.shakeRot.x, h.shakeRot.z, outQuat);
}
