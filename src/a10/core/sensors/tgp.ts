/**
 * The AN/AAQ-28 Litening targeting pod and its laser (PLAN §6.6, §7, §8; ARCHITECTURE §12.5).
 *
 * Where it looks. The pod hangs on the station that carries 'AN/AAQ-28' (station 10 in every
 * preset); its optical head sits at the pod's nose (data/sensors.ts TGP.headOffset). The pod
 * holds an AIM: a ground point, or a world direction when the line of sight meets no ground. The
 * line of sight runs from the head to the aim; in the aircraft's body frame it gives `gimbalAz` /
 * `gimbalEl`. The head reaches every direction within 150° of the pod's axis (pitch +45/−150°,
 * roll ±400°); beyond, the line of sight stops at the limit ('GIMBAL'). Along it the pod may see
 * its own aircraft (`mask.ts`: wing, fuselage, gear pods, nacelles, tail, the next stations'
 * stores) ('AIRFRAME'). Either way `masked` is set: no picture of the target, no track, no laser.
 *
 * Tracks (HOTAS with the TGP page as the sensor of interest, routed by the avionics as sensor
 * requests; the same actions as setters for the page's OSBs):
 *   INR    inertial: the aim is held on a ground point by navigation alone (the aircraft's own
 *          motion is taken out exactly: an EGI-aided INS drifts by centimetres over a pass);
 *   AREA   area (scene) track: holds a ground point from the picture. Needs a picture: masked →
 *          INR. When terrain comes between, the tracker latches onto what is now under the
 *          cross (the ridge along the line of sight);
 *   POINT  point (centroid) track on a vehicle: follows it while it is visible, large enough
 *          and contrasting in the picture's band; lost, it coasts on the target's last motion
 *          for TGP.coastTime, re-acquires if the target reappears in the gate, else falls back
 *          to AREA at the coasted point (INR if the pod was masked).
 *   TMS fwd short: POINT on the vehicle under the cross (gate TGP.pointGateFraction · FOV;
 *   realism.largeGate widens it, realism.snapLock takes the nearest vehicle in the picture), or
 *   AREA if there is none. TMS aft short: POINT → AREA, AREA ↔ INR. China hat fwd short: WIDE ↔
 *   NARROW. DMS up / down: zoom in / out. DMS left / right and the picture key: WHOT → BHOT → CCD.
 *   China hat long (avionics' slaveRequest, 'ALL' or 'TGP'): INR on the SPI.
 * Slew (input.slewX/Y while the TGP page is the SOI): the line of sight turns in the picture's
 * axes at TGP.slewFovPerSecond fields of view per second × |deflection|^expo, accelerating while
 * held at full deflection; a point track breaks to AREA; AREA and INR move their point.
 *
 * Laser: fires when laserArm is ARM (TRAIN: the eye-safe ranger only, no designation spot), the
 * pod is ready, unmasked and tracking (AREA or POINT), and input.laser is held or the laser is
 * latched (the TGP page's LTCH option: avionics' `laserLatch`, copied into `latched`). The code
 * is the cockpit's (avionics' `laserCode`). Each pulse (LASER.pulseHz) traces the beam to the first
 * vehicle armour, tree canopy or ground: `laserRange`, and with ARM `spot`/`spotValid`. `laser
 * {on}` events mark the start and end of lasing.
 */
import { Vector3 } from 'three';
import { LASER, TGP } from '../../data/sensors';
import { SIM_HZ } from '../constants';
import { worldToBody } from '../frames';
import { findVehicle, segmentHitVehicle } from '../targets';
import type { VehicleHit } from '../targets/types';
import type { Sim } from '../types';
import type { TerrainHit } from '../world/types';
import {
  angleBetween,
  bodyToWorldPoint,
  clampToCone,
  pictureAxes,
  podHeadBody,
  storeAxisBody,
  vehicleCentre,
} from './geometry';
import { airframeMasked, buildMask, maskStale } from './mask';
import { checkVehicle, createTrackCheck, searchGate, type TrackRules } from './track';
import type { SensorPicture, TgpState, TrackMode } from './types';

// ---- scratch ----------------------------------------------------------------------------------------

const _headBody = new Vector3();
const _axisBody = new Vector3();
const _losBody = new Vector3();
const _v = new Vector3();
const _w = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _fwd = new Vector3();
const _p1 = new Vector3();
const _hit: TerrainHit = {
  point: new Vector3(),
  normal: new Vector3(),
  distance: 0,
  t: 0,
  surface: 'grass',
};
const _vhit: VehicleHit = {
  vehicleId: -1,
  t: 0,
  point: new Vector3(),
  normal: new Vector3(),
  thicknessMm: 0,
  part: 'hull',
  face: 'front',
  plate: 0,
};
const _check = createTrackCheck();
const _rules: TrackRules = { band: 'IR', minSize: 0, minContrast: 0 };

/** The order the picture key steps through. */
const PICTURES: readonly SensorPicture[] = ['WHOT', 'BHOT', 'CCD'];

/** Station that carries the targeting pod, 0 when none is loaded. */
export function podStation(sim: Sim): number {
  for (const st of sim.stores.stations) {
    if (st.rack === 'AN/AAQ-28') return st.station;
    for (const s of st.stores) if (s === 'AN/AAQ-28') return st.station;
  }
  return 0;
}

/** Full field of view for a setting and zoom, rad. */
export function tgpFov(setting: 'WIDE' | 'NARROW', zoom: number): number {
  return (setting === 'WIDE' ? TGP.fovWide : TGP.fovNarrow) / Math.max(1, zoom);
}

function band(t: TgpState) {
  return t.picture === 'CCD' ? ('TV' as const) : ('IR' as const);
}

function lockEvent(sim: Sim, on: boolean): void {
  sim.events.push({ type: 'lock', t: sim.time, sensor: 'TGP', on });
}

/** Leave point track (if in it) for `mode`, with the lock event. */
function setMode(sim: Sim, mode: TrackMode): void {
  const t = sim.sensors.tgp;
  if (t.mode === 'POINT' && mode !== 'POINT') lockEvent(sim, false);
  t.mode = mode;
  if (mode !== 'POINT') {
    t.trackedVehicle = -1;
    t.coasting = false;
  }
}

/** Hold the aim on the ground point under the current line of sight (or its direction). */
function aimAlongLos(sim: Sim): void {
  const t = sim.sensors.tgp;
  const ti = t.internal;
  if (sim.world.terrain.raycast(t.head, t.los, TGP.maxPointRange, _hit)) {
    ti.aim.copy(_hit.point);
    ti.aimValid = true;
  } else {
    ti.aimValid = false;
    ti.aimDir.copy(t.los);
  }
}

// ---- setters (avionics OSBs and HOTAS) --------------------------------------------------------------

/** Picture: WHOT, BHOT or CCD, or 'cycle' (WHOT → BHOT → CCD), or 'previous'. */
export function setTgpPicture(sim: Sim, value: SensorPicture | 'cycle' | 'previous'): void {
  const t = sim.sensors.tgp;
  if (value === 'cycle' || value === 'previous') {
    const i = PICTURES.indexOf(t.picture);
    const n = PICTURES.length;
    t.picture = PICTURES[(((i + (value === 'cycle' ? 1 : -1)) % n) + n) % n];
  } else t.picture = value;
}

/** Field of view: WIDE, NARROW or 'toggle'. */
export function setTgpFov(sim: Sim, value: 'WIDE' | 'NARROW' | 'toggle'): void {
  const t = sim.sensors.tgp;
  t.fovSetting = value === 'toggle' ? (t.fovSetting === 'WIDE' ? 'NARROW' : 'WIDE') : value;
  t.fov = tgpFov(t.fovSetting, t.zoom);
}

/** Electronic zoom: step through TGP.zoomLevels (+1 in, −1 out). */
export function stepTgpZoom(sim: Sim, dir: number): void {
  const t = sim.sensors.tgp;
  const levels = TGP.zoomLevels;
  let i = levels.indexOf(t.zoom);
  if (i < 0) i = 0;
  i = Math.min(levels.length - 1, Math.max(0, i + Math.sign(dir)));
  t.zoom = levels[i];
  t.fov = tgpFov(t.fovSetting, t.zoom);
}

/** Is `code` a valid four-digit PRF laser code (first digit 1–2, the others 1–8)? */
export function validLaserCode(code: number): boolean {
  if (!Number.isInteger(code) || code < 1000 || code > 9999) return false;
  let c = code;
  for (let i = 3; i >= 0; i--) {
    const d = c % 10;
    c = Math.floor(c / 10);
    if (d < LASER.codeDigitMin[i] || d > LASER.codeDigitMax[i]) return false;
  }
  return true;
}

/**
 * The cockpit's switch states the sensors read (avionics wave 2: the TGP page's LTCH and CODE, the
 * MAV page's PWR, the DSMS's selected station). Read through this view so the module works with
 * an avionics state that does not carry one of them (each then keeps the sensors' own value).
 */
export interface CockpitSwitches {
  laserLatch?: boolean;
  laserCode?: number;
  mavPower?: boolean;
  selectedStation?: number;
}

export function cockpitSwitches(sim: Sim): CockpitSwitches {
  return sim.avionics as unknown as CockpitSwitches;
}

/** Slave the pod to the SPI: INR on the SPI's ground point (no-op when the pod is the SPI). */
export function slaveTgpToSpi(sim: Sim): void {
  const spi = sim.avionics.spi;
  const t = sim.sensors.tgp;
  if (!spi.valid || spi.source === 'TGP' || t.station === 0) return;
  setMode(sim, 'INR');
  t.internal.aim.copy(spi.position);
  t.internal.aimValid = true;
}

/**
 * Command a track mode: 'POINT' tries a point track on the vehicle under the cross (AREA when
 * there is none), 'AREA' area-tracks the point under the cross, 'INR' holds it inertially.
 */
export function setTgpTrack(sim: Sim, mode: TrackMode): void {
  const t = sim.sensors.tgp;
  if (!t.ready) return;
  if (mode === 'POINT') {
    if (t.mode === 'POINT' && !t.coasting) return;
    if (!t.masked && tryPointTrack(sim)) return;
    if (t.mode !== 'POINT') setMode(sim, t.masked ? 'INR' : 'AREA');
    return;
  }
  if (mode === 'AREA' && t.masked) {
    setMode(sim, 'INR');
    return;
  }
  if (t.mode === 'POINT') {
    // keep the track's current point: the vehicle's ground position
    t.internal.aim.copy(t.point);
    t.internal.aimValid = t.pointValid;
  }
  setMode(sim, mode);
}

function rulesFor(sim: Sim, hold: number): TrackRules {
  const t = sim.sensors.tgp;
  _rules.band = band(t);
  _rules.minSize = ((TGP.minTrackPixels * t.fov) / TGP.imagePixels) * hold;
  _rules.minContrast = TGP.contrastThreshold * hold;
  return _rules;
}

/** Point track on the best vehicle in the gate (or the picture with realism.snapLock). */
function tryPointTrack(sim: Sim): boolean {
  const t = sim.sensors.tgp;
  const r = sim.options.realism;
  let gate = TGP.pointGateFraction * t.fov;
  if (r.largeGate) gate *= 2.5;
  if (r.snapLock) gate = t.fov * 0.5;
  if (!searchGate(sim, t.head, t.los, gate, rulesFor(sim, 1), _check)) return false;
  const v = findVehicle(sim, _check.vehicleId);
  if (!v) return false;
  const wasPoint = t.mode === 'POINT';
  t.mode = 'POINT';
  t.trackedVehicle = v.id;
  t.coasting = false;
  vehicleCentre(v, t.internal.lastSeen);
  setVelocity(v.speed, v.heading, t.internal.lastVelocity);
  if (!wasPoint) lockEvent(sim, true);
  return true;
}

function setVelocity(speed: number, heading: number, out: Vector3): void {
  out.set(Math.sin(heading) * speed, 0, -Math.cos(heading) * speed);
}

// ---- requests -----------------------------------------------------------------------------------

function handleRequests(sim: Sim): void {
  const t = sim.sensors.tgp;
  const reqs = sim.avionics.sensorRequests;
  for (let i = 0; i < reqs.length; i++) {
    const q = reqs[i];
    if (q.sensor !== 'TGP' && q.sensor !== 'ALL') continue;
    switch (q.action) {
      case 'slaveSpi':
        slaveTgpToSpi(sim);
        break;
      case 'tms':
        if (q.dir === 'up') setTgpTrack(sim, 'POINT');
        else if (q.dir === 'down') {
          if (t.mode === 'POINT') setTgpTrack(sim, 'AREA');
          else setTgpTrack(sim, t.mode === 'AREA' ? 'INR' : 'AREA');
        }
        break;
      case 'dms':
        if (q.dir === 'up' || q.dir === 'down') stepTgpZoom(sim, q.dir === 'up' ? 1 : -1);
        else if (q.dir === 'left' || q.dir === 'right')
          setTgpPicture(sim, q.dir === 'right' ? 'cycle' : 'previous');
        break;
      case 'chinaHat':
        if (q.dir === 'fwd' && !q.long) setTgpFov(sim, 'toggle');
        break;
      case 'picture':
        setTgpPicture(sim, 'cycle');
        break;
      case 'zoom':
        stepTgpZoom(sim, q.value);
        break;
      default:
        break;
    }
  }
}

// ---- the step ---------------------------------------------------------------------------------------

function soiIsTgp(sim: Sim): boolean {
  const av = sim.avionics;
  const page = av.soi === 'LMFD' ? av.mfd.left : av.soi === 'RMFD' ? av.mfd.right : 'HUD';
  return page === 'TGP';
}

/** Turn the line of sight by the slew input (picture axes), and re-aim along it. */
function slew(sim: Sim, dt: number): void {
  const t = sim.sensors.tgp;
  const ti = t.internal;
  const sx = sim.input.slewX;
  const sy = sim.input.slewY;
  const mag = Math.max(Math.abs(sx), Math.abs(sy));
  t.slewing = mag > 0.02;
  if (!t.slewing) {
    ti.slewHeld = 0;
    return;
  }
  ti.slewHeld = mag >= TGP.slewAccelThreshold ? ti.slewHeld + dt : 0;
  const accel = 1 + (TGP.slewAccelMax - 1) * Math.min(1, ti.slewHeld / TGP.slewAccelTime);
  const rate = t.fov * TGP.slewFovPerSecond * accel;
  const ax = Math.sign(sx) * Math.pow(Math.abs(sx), TGP.slewExpo) * rate * dt;
  const ay = Math.sign(sy) * Math.pow(Math.abs(sy), TGP.slewExpo) * rate * dt;
  if (t.mode === 'POINT') setTgpTrack(sim, 'AREA');
  _fwd.set(0, 0, -1).applyQuaternion(sim.aircraft.orientation);
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-9) _fwd.set(0, 0, -1);
  _fwd.normalize();
  pictureAxes(t.los, _fwd, _right, _up);
  t.los.addScaledVector(_right, ax).addScaledVector(_up, ay).normalize();
  aimAlongLos(sim);
}

/** Line of sight from the aim, the gimbal limit and the airframe mask. */
function pointHead(sim: Sim): void {
  const t = sim.sensors.tgp;
  const ti = t.internal;
  const q = sim.aircraft.orientation;
  if (ti.aimValid) _v.subVectors(ti.aim, t.head).normalize();
  else _v.copy(ti.aimDir);
  if (!(_v.lengthSq() > 0.5)) _v.copy(t.los);
  worldToBody(q, _v, _losBody);
  storeAxisBody(t.station, _axisBody);
  if (clampToCone(_losBody, _axisBody, TGP.gimbalMaxOffAxis)) t.maskReason = 'GIMBAL';
  else if (
    airframeMasked(
      sim,
      _headBody.x,
      _headBody.y,
      _headBody.z,
      _losBody.x,
      _losBody.y,
      _losBody.z,
      40,
    )
  )
    t.maskReason = 'AIRFRAME';
  else t.maskReason = 'NONE';
  t.masked = t.maskReason !== 'NONE';
  t.los.copy(_losBody).applyQuaternion(q);
  t.gimbalAz = Math.atan2(_losBody.x, -_losBody.z);
  t.gimbalEl = Math.atan2(_losBody.y, Math.hypot(_losBody.x, _losBody.z));
}

/** Point track: follow the vehicle, coast when it is lost. */
function updatePoint(sim: Sim, dt: number, check: boolean): void {
  const t = sim.sensors.tgp;
  const ti = t.internal;
  const v = findVehicle(sim, t.trackedVehicle);
  if (!t.coasting) {
    if (!v) {
      startCoast(sim, false);
    } else {
      vehicleCentre(v, ti.lastSeen);
      setVelocity(v.speed, v.heading, ti.lastVelocity);
      ti.aim.copy(ti.lastSeen);
      ti.aimValid = true;
      if (t.masked) startCoast(sim, true);
      else if (check && !checkVehicle(sim, v, t.head, rulesFor(sim, TGP.trackHoldFraction), _check))
        startCoast(sim, false);
    }
    return;
  }
  // coasting: dead-reckon the last motion; re-acquire when the target shows again
  ti.coastLeft -= dt;
  ti.lastSeen.addScaledVector(ti.lastVelocity, dt);
  ti.aim.copy(ti.lastSeen);
  ti.aimValid = true;
  if (check && v && !t.masked) {
    vehicleCentre(v, _w);
    if (
      _w.distanceTo(ti.lastSeen) < Math.max(10, ti.lastSeen.distanceTo(t.head) * t.fov * 0.25) &&
      checkVehicle(sim, v, t.head, rulesFor(sim, TGP.trackHoldFraction), _check)
    ) {
      t.coasting = false;
      ti.lastSeen.copy(_w);
      return;
    }
  }
  if (ti.coastLeft <= 0) {
    // the tracker gives up: hold the coasted point on the ground
    const g = sim.world.terrain.heightAt(ti.lastSeen.x, ti.lastSeen.z);
    ti.aim.set(ti.lastSeen.x, g, ti.lastSeen.z);
    ti.aimValid = true;
    setMode(sim, ti.coastToInr || t.masked ? 'INR' : 'AREA');
  }
}

function startCoast(sim: Sim, toInr: boolean): void {
  const t = sim.sensors.tgp;
  t.coasting = true;
  t.internal.coastLeft = TGP.coastTime;
  t.internal.coastToInr = toInr;
}

/** Area track: needs a picture; a ridge across the line of sight takes the track. */
function updateArea(sim: Sim, check: boolean): void {
  const t = sim.sensors.tgp;
  const ti = t.internal;
  if (t.masked) {
    setMode(sim, 'INR');
    return;
  }
  if (!check || !ti.aimValid) return;
  if (!sim.world.terrain.lineOfSight(t.head, ti.aim, false)) aimAlongLos(sim);
}

/** First thing the beam meets along the line of sight: vehicle, canopy or ground. */
function traceBeam(sim: Sim): boolean {
  const t = sim.sensors.tgp;
  const terrain = sim.world.terrain;
  const head = t.head;
  const los = t.los;
  let best: number = LASER.maxRange;
  let found = false;
  let vehicle = -1;
  if (terrain.raycast(head, los, LASER.maxRange, _hit)) {
    best = _hit.distance;
    found = true;
    t.spot.copy(_hit.point);
    // trees between: only when the clear line to the ground point is blocked
    if (!terrain.lineOfSight(head, _hit.point, true)) {
      const s = canopyEntry(sim, best);
      if (s < best) {
        best = s;
        t.spot.copy(head).addScaledVector(los, s);
      }
    }
  }
  _p1.copy(head).addScaledVector(los, Math.min(LASER.maxRange, best + 5));
  if (segmentHitVehicle(sim, head, _p1, _vhit)) {
    const s = _vhit.t * head.distanceTo(_p1);
    if (s <= best + 1e-6) {
      best = s;
      found = true;
      vehicle = _vhit.vehicleId;
      t.spot.copy(_vhit.point);
    }
  }
  t.spotVehicle = found ? vehicle : -1;
  t.laserRange = found ? best : 0;
  t.laserRangeTime = sim.time;
  return found;
}

/**
 * Distance along the line of sight where it enters the tree canopy, searched over the last metres
 * before the ground hit at `ground` (the canopy band), or by bisection on the clear line of sight
 * when something nearer blocks it. Infinity when no canopy is met.
 */
function canopyEntry(sim: Sim, ground: number): number {
  const t = sim.sensors.tgp;
  const terrain = sim.world.terrain;
  const head = t.head;
  const los = t.los;
  const down = Math.max(0.05, -los.y);
  const s0 = Math.max(0, ground - (LASER.canopyMax + 1) / down);
  _w.copy(head).addScaledVector(los, s0);
  let lo = 0;
  let hi = s0;
  if (s0 > 2 && !terrain.lineOfSight(head, _w, true)) {
    // blocked before the band (a wooded crest): bisect the clear length
    for (let i = 0; i < 14; i++) {
      const mid = 0.5 * (lo + hi);
      _w.copy(head).addScaledVector(los, mid);
      if (terrain.lineOfSight(head, _w, true)) lo = mid;
      else hi = mid;
    }
    return hi;
  }
  // march the band
  let prev = s0;
  for (let s = s0; s <= ground; s += LASER.canopyStep) {
    const x = head.x + los.x * s;
    const y = head.y + los.y * s;
    const z = head.z + los.z * s;
    const c = terrain.canopyAt(x, z);
    if (c > 0 && y < terrain.heightAt(x, z) + c) {
      // refine between the last clear sample and this one
      let a = prev;
      let b = s;
      for (let i = 0; i < 6; i++) {
        const m = 0.5 * (a + b);
        const mx = head.x + los.x * m;
        const mz = head.z + los.z * m;
        const cm = terrain.canopyAt(mx, mz);
        if (cm > 0 && head.y + los.y * m < terrain.heightAt(mx, mz) + cm) b = m;
        else a = m;
      }
      return b;
    }
    prev = s;
  }
  return Infinity;
}

/** Laser: latch and code from the cockpit, firing conditions, pulses, events. */
function stepLaser(sim: Sim): void {
  const t = sim.sensors.tgp;
  const ti = t.internal;
  const sw = cockpitSwitches(sim);
  if (typeof sw.laserLatch === 'boolean') t.latched = sw.laserLatch;
  if (typeof sw.laserCode === 'number' && validLaserCode(sw.laserCode)) t.laserCode = sw.laserCode;
  const want = t.latched || sim.input.laser;
  const arm = sim.avionics.laserArm;
  const can = t.ready && arm !== 'SAFE' && !t.masked && (t.mode === 'AREA' || t.mode === 'POINT');
  const lasing = want && can;
  if (lasing !== t.lasing) {
    t.lasing = lasing;
    sim.events.push({ type: 'laser', t: sim.time, on: lasing });
  }
  if (!lasing) {
    t.spotValid = false;
    t.spotVehicle = -1;
    ti.pulseCountdown = 0;
    return;
  }
  if (--ti.pulseCountdown > 0) return;
  ti.pulseCountdown = Math.max(1, Math.round(SIM_HZ / LASER.pulseHz));
  const hit = traceBeam(sim);
  t.spotValid = hit && arm === 'ARM';
  if (!t.spotValid) t.spotVehicle = -1;
}

/** Power off: everything stops; the FLIR must cool down again at the next power-on. */
function powerDown(sim: Sim): void {
  const t = sim.sensors.tgp;
  if (t.lasing) sim.events.push({ type: 'laser', t: sim.time, on: false });
  if (t.mode === 'POINT') lockEvent(sim, false);
  t.lasing = false;
  t.spotValid = false;
  t.spotVehicle = -1;
  t.mode = 'INR';
  t.trackedVehicle = -1;
  t.coasting = false;
  t.slewing = false;
  t.warmup = TGP.warmupTime;
  t.ready = false;
  t.internal.wasReady = false;
}

/** Aim the pod where it starts looking: the SPI, else 30° down ahead. */
function initialAim(sim: Sim): void {
  const t = sim.sensors.tgp;
  const spi = sim.avionics.spi;
  if (spi.valid) {
    t.internal.aim.copy(spi.position);
    t.internal.aimValid = true;
  } else {
    _v.set(0, -Math.sin(Math.PI / 6), -Math.cos(Math.PI / 6)).applyQuaternion(
      sim.aircraft.orientation,
    );
    t.los.copy(_v);
    aimAlongLos(sim);
  }
}

/** The targeting pod's step (stepSensors, step 8). */
export function stepTgp(sim: Sim, dt: number): void {
  const t = sim.sensors.tgp;
  const ti = t.internal;
  const station = podStation(sim);
  // the mask follows the loadout: a new pod station, or stores gone from (or back on) a station
  if (station !== t.station || maskStale(sim, station)) {
    t.station = station;
    buildMask(sim, station);
  }
  const powered = sim.avionics.tgpPower && station > 0;
  if (!powered) {
    if (t.powered || t.warmup <= 0) powerDown(sim);
    t.powered = false;
    return;
  }
  t.powered = true;
  t.warmup = Math.max(0, t.warmup - (t.ready ? 0 : dt));
  t.ready = t.warmup <= 0;

  // where the head is now
  podHeadBody(station, _headBody);
  bodyToWorldPoint(sim.aircraft.position, sim.aircraft.orientation, _headBody, t.head);
  t.fov = tgpFov(t.fovSetting, t.zoom);

  if (t.ready && !ti.wasReady) {
    setMode(sim, 'INR');
    initialAim(sim);
  }
  ti.wasReady = t.ready;

  if (t.ready) {
    handleRequests(sim);
    if (soiIsTgp(sim)) slew(sim, dt);
    else {
      t.slewing = false;
      ti.slewHeld = 0;
    }
  } else t.slewing = false;

  // the aim of the current track, then the line of sight to it
  const check = --ti.checkCountdown <= 0;
  if (check) ti.checkCountdown = Math.max(1, Math.round(SIM_HZ / TGP.pointCheckHz));
  if (t.mode === 'POINT') {
    // follow the target before pointing (its centre moved this step)
    const v = findVehicle(sim, t.trackedVehicle);
    if (v && !t.coasting) {
      vehicleCentre(v, ti.aim);
      ti.aimValid = true;
    }
  }
  pointHead(sim);
  if (t.ready) {
    if (t.mode === 'POINT') updatePoint(sim, dt, check);
    else if (t.mode === 'AREA')
      updateArea(
        sim,
        check && sim.stepCount % Math.max(1, Math.round(TGP.pointCheckHz / TGP.areaCheckHz)) === 0,
      );
  }

  // the ground point the pod looks at (the SPI when the pod is the SPI source)
  if (t.mode === 'POINT' && !t.coasting) {
    const v = findVehicle(sim, t.trackedVehicle);
    if (v) t.point.copy(v.position);
    t.pointValid = v !== null;
  } else if (ti.aimValid) {
    t.point.copy(ti.aim);
    if (t.mode === 'POINT') t.point.y = sim.world.terrain.heightAt(t.point.x, t.point.z);
    t.pointValid = true;
  } else t.pointValid = false;
  t.pointRange = t.pointValid ? t.head.distanceTo(t.point) : 0;

  stepLaser(sim);
}

/** Angle between the pod's line of sight and a world direction (tests, HUD cues), rad. */
export function tgpAngleTo(sim: Sim, dir: Vector3): number {
  return angleBetween(sim.sensors.tgp.los, dir);
}
