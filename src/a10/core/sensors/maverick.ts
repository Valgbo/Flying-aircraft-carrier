/**
 * The AGM-65 Maverick seekers before launch (PLAN §6.4, §8; ARCHITECTURE §12.5).
 *
 * One seeker per missile on the stations (`sensors.mavericks`, the selected one first), in each
 * station's release order: the weapons module releases a station's first store first, so only a
 * station's first missile can be the selected one, and the seeker that locked is the missile that
 * leaves. Each seeker looks out of its missile's nose on the launcher rail it was loaded on. The avionics decides which station launches next (`selectedStation` for a Maverick
 * profile); without one the selection stays where it was, or moves to the next missile of the
 * same type (another station first) after a launch, which takes over the line of sight ("the next
 * missile can be slaved to the same line of sight").
 *
 * Power (the MAV page's PWR, avionics' `mavPower`) runs every seeker's gyro and, for the infrared
 * ones, the detector cooler: MAVERICK.alignTime after power-on there is video; switching off
 * loses the alignment. At the air start the missiles are aligned.
 *
 * Only the selected seeker is uncaged (the others look along their missile's axis). Its modes:
 * BORESIGHT (caged), STAB (held on a ground point, after a slew, a broken lock or a hand-over),
 * SLAVE (on the SPI, following it) and TRACK (locked). With the MAV page as the sensor of
 * interest: TMS forward short locks, TMS aft short breaks the lock (or cages), China hat forward
 * short toggles WIDE / NARROW (DMS up / down selects NARROW / WIDE), the picture key or DMS left /
 * right toggles an infrared seeker's polarity, the slew moves the line of sight (rate ∝ field of
 * view), China hat long (or the page's SLV) slaves it to the SPI. The gimbal stops the line of
 * sight MAVERICK.gimbalLimit from the missile's axis.
 *
 * Lock (`track.ts`): a vehicle in the tracking gate (MAVERICK.gateFraction of the field of view;
 * realism.largeGate × 2.5; realism.snapLock: anywhere in the picture), at least
 * MAVERICK.minLockPixels resolution cells across (a tank: ≈3 nmi in WIDE, ≈6.5 nmi in NARROW),
 * contrast above MAVERICK.contrastThreshold in the seeker's band (IR for D/G, TV for H/K: heat,
 * time of day, haze, smoke, daylight) and in plain view (terrain and trees). A held lock breaks
 * when any of these fails (with 25 % hysteresis on size and contrast) or the target leaves the
 * gimbal; an infrared lock jumps to a burning object in its gate whose heat signature is
 * MAVERICK.captureRatio times the target's. `inZone`: locked, within the launch ranges and
 * MAVERICK.launchGimbalMargin inside the gimbal limit.
 */
import { Vector3 } from 'three';
import { MAVERICK, MAVERICK_BAND } from '../../data/sensors';
import { SIM_HZ } from '../constants';
import { worldToBody } from '../frames';
import { findVehicle } from '../targets';
import type { Vehicle } from '../targets/types';
import type { Sim } from '../types';
import type { StationState, StoreType } from '../weapons/types';
import type { TerrainHit } from '../world/types';
import { createContrastDetail, vehicleContrast } from './contrast';
import {
  angularSize,
  bodyToWorldPoint,
  clampToCone,
  pictureAxes,
  seekerHeadBody,
  storeAxisBody,
  vehicleCentre,
} from './geometry';
import { firstMount } from './loads';
import { cockpitSwitches } from './tgp';
import { checkVehicle, createTrackCheck, searchGate, type TrackRules } from './track';
import type { MaverickSeekerState, SeekerMode, SensorsState } from './types';

const _v = new Vector3();
const _c = new Vector3();
const _body = new Vector3();
const _axis = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _fwd = new Vector3();
const _hit: TerrainHit = {
  point: new Vector3(),
  normal: new Vector3(),
  distance: 0,
  t: 0,
  surface: 'grass',
};
const _check = createTrackCheck();
const _probe = createTrackCheck();
const _detail = createContrastDetail();
const _rules: TrackRules = { band: 'IR', minSize: 0, minContrast: 0 };

/** Hand-over of the line of sight from a launched missile to the next one. */
const handoff = { valid: false, mode: 'STAB' as SeekerMode, aim: new Vector3(), aimValid: false };

/** The Mavericks types. */
export function isMaverickType(s: StoreType | null | undefined): s is StoreType {
  return s !== null && s !== undefined && MAVERICK_BAND[s] !== undefined;
}

const TYPE_CODE: Partial<Record<StoreType, number>> = {
  'AGM-65D': 1,
  'AGM-65G': 2,
  'AGM-65H': 3,
  'AGM-65K': 4,
};

function stationKey(st: StationState): number {
  let n = 0;
  let code = 0;
  for (const s of st.stores) {
    if (!isMaverickType(s)) continue;
    if (n === 0) code = TYPE_CODE[s] ?? 0;
    n++;
  }
  return n * 16 + code;
}

function fovAngle(fov: 'WIDE' | 'NARROW'): number {
  return fov === 'WIDE' ? MAVERICK.fovWide : MAVERICK.fovNarrow;
}

function createSeeker(
  sensors: SensorsState,
  station: number,
  type: StoreType,
  aligned: boolean,
): MaverickSeekerState {
  const band = MAVERICK_BAND[type] ?? 'IR';
  return {
    station,
    powered: sensors.mavPower,
    align: aligned ? 0 : MAVERICK.alignTime,
    los: new Vector3(0, 0, -1),
    fov: 'WIDE',
    locked: false,
    lockedVehicle: -1,
    lockPoint: new Vector3(),
    inZone: false,
    gimbalAz: 0,
    gimbalEl: 0,
    contrast: 0,
    id: sensors.internal.nextSeekerId++,
    type,
    band,
    rail: 0,
    selected: false,
    mode: 'BORESIGHT',
    fovAngle: MAVERICK.fovWide,
    picture: band === 'IR' ? 'WHOT' : 'CCD',
    offAxis: 0,
    atLimit: false,
    range: 0,
    lockFailure: '',
    head: new Vector3(),
    internal: {
      aim: new Vector3(),
      aimValid: false,
      aimDir: new Vector3(0, 0, -1),
      checkCountdown: 0,
    },
  };
}

function lockEvent(sim: Sim, on: boolean): void {
  sim.events.push({ type: 'lock', t: sim.time, sensor: 'MAV', on });
}

/** Leave TRACK (event) for another mode. */
function unlock(sim: Sim, s: MaverickSeekerState, mode: SeekerMode): void {
  if (s.locked) lockEvent(sim, false);
  s.locked = false;
  s.lockedVehicle = -1;
  s.inZone = false;
  s.mode = mode;
}

/**
 * Bring the seeker list in line with the stations: launched missiles leave (from the front of
 * their station's list), new ones (a rearm) join, unaligned unless this is the first set-up.
 */
function syncSeekers(sim: Sim, first: boolean): boolean {
  const sensors = sim.sensors;
  const internal = sensors.internal;
  let changed = false;
  for (const st of sim.stores.stations) {
    const s = st.station;
    if (s <= 0 || s >= internal.stationKeys.length) continue;
    const key = stationKey(st);
    if (key === internal.stationKeys[s] && !first) continue;
    internal.stationKeys[s] = key;
    changed = true;
    const list = internal.byStation[s];
    const types: StoreType[] = [];
    for (const x of st.stores) if (isMaverickType(x)) types.push(x);
    // missiles gone from the front of the list (launched or jettisoned)
    while (list.length > types.length) {
      const gone = list.shift() as MaverickSeekerState;
      if (gone.selected) {
        handoff.valid = gone.mode !== 'BORESIGHT';
        handoff.mode = gone.mode === 'SLAVE' ? 'SLAVE' : 'STAB';
        if (gone.mode === 'TRACK') {
          handoff.aim.copy(gone.lockPoint);
          handoff.aimValid = true;
        } else {
          handoff.aim.copy(gone.internal.aim);
          handoff.aimValid = gone.internal.aimValid;
        }
        if (gone.locked) lockEvent(sim, false);
        gone.locked = false;
        gone.selected = false;
        internal.lastSelectedStation = s;
        internal.lastSelectedType = gone.type;
      }
    }
    // a changed type in place (a different load): replace from the first mismatch
    for (let i = 0; i < list.length; i++) {
      if (list[i].type !== types[i]) {
        list.length = i;
        break;
      }
    }
    // new missiles (a rearm, or the first set-up)
    while (list.length < types.length)
      list.push(createSeeker(sensors, s, types[list.length], first));
    // each missile keeps the rail it was loaded on when the ones before it leave (loads.ts)
    const mount = firstMount(sim, s);
    for (let i = 0; i < list.length; i++) list[i].rail = mount + i;
  }
  return changed;
}

/** The seeker to select now (the avionics' station, the current one, or the next after a launch). */
function chooseSelected(sim: Sim): MaverickSeekerState | null {
  const internal = sim.sensors.internal;
  const byStation = internal.byStation;
  const sw = cockpitSwitches(sim);
  const want = sw.selectedStation;
  if (typeof want === 'number' && want > 0 && want < byStation.length && byStation[want].length > 0)
    return byStation[want][0];
  const cur =
    sim.sensors.selectedMaverick >= 0 ? sim.sensors.mavericks[sim.sensors.selectedMaverick] : null;
  if (cur && byStation[cur.station]?.[0] === cur) return cur;
  // after a launch: the same type on another station first, then any
  const type = internal.lastSelectedType;
  const last = internal.lastSelectedStation;
  let best: MaverickSeekerState | null = null;
  let bestScore = -1;
  for (let s = 1; s < byStation.length; s++) {
    const head = byStation[s][0];
    if (!head) continue;
    const score = (head.type === type ? 2 : 0) + (s !== last ? 1 : 0);
    if (score > bestScore) {
      best = head;
      bestScore = score;
    }
  }
  return best;
}

/** Rebuild the public list: the selected seeker first, then the others in station order. */
function publish(sim: Sim, selected: MaverickSeekerState | null): void {
  const sensors = sim.sensors;
  const out = sensors.mavericks;
  out.length = 0;
  if (selected) out.push(selected);
  const byStation = sensors.internal.byStation;
  for (let s = 1; s < byStation.length; s++) {
    for (const m of byStation[s]) {
      m.selected = m === selected;
      if (m !== selected) out.push(m);
    }
  }
  sensors.selectedMaverick = selected ? 0 : -1;
}

// ---- commands -------------------------------------------------------------------------------------

function selectedSeeker(sim: Sim): MaverickSeekerState | null {
  const s = sim.sensors;
  return s.selectedMaverick >= 0 ? (s.mavericks[s.selectedMaverick] ?? null) : null;
}

function ready(s: MaverickSeekerState): boolean {
  return s.powered && s.align <= 0;
}

function lockRules(s: MaverickSeekerState, hold: number): TrackRules {
  _rules.band = s.band;
  _rules.minSize = ((MAVERICK.minLockPixels * s.fovAngle) / MAVERICK.imagePixels) * hold;
  _rules.minContrast = MAVERICK.contrastThreshold * hold;
  return _rules;
}

function gateOf(sim: Sim, s: MaverickSeekerState): number {
  const r = sim.options.realism;
  if (r.snapLock) return s.fovAngle * 0.5;
  return MAVERICK.gateFraction * s.fovAngle * (r.largeGate ? MAVERICK.largeGateFactor : 1);
}

/** Command a lock on what is in the gate (TMS forward short). Returns true on a lock. */
export function maverickLock(sim: Sim): boolean {
  const s = selectedSeeker(sim);
  if (!s) return false;
  if (!ready(s)) {
    s.lockFailure = 'NOT READY';
    return false;
  }
  if (s.locked) return true;
  if (!searchGate(sim, s.head, s.los, gateOf(sim, s), lockRules(s, 1), _check)) {
    s.lockFailure = _check.failure || 'NO TARGET';
    return false;
  }
  const v = findVehicle(sim, _check.vehicleId);
  if (!v) {
    s.lockFailure = 'NO TARGET';
    return false;
  }
  // the target must be inside the gimbal
  vehicleCentre(v, _c);
  _v.subVectors(_c, s.head).normalize();
  worldToBody(sim.aircraft.orientation, _v, _body);
  storeAxisBody(s.station, _axis);
  if (_body.angleTo(_axis) > MAVERICK.gimbalLimit) {
    s.lockFailure = 'GIMBAL LIMIT';
    return false;
  }
  s.locked = true;
  s.lockedVehicle = v.id;
  s.mode = 'TRACK';
  s.lockFailure = '';
  s.contrast = _check.contrast;
  s.internal.checkCountdown = Math.max(1, Math.round(SIM_HZ / MAVERICK.lockCheckHz));
  lockEvent(sim, true);
  return true;
}

/** Break the lock and hold the last point (TMS aft short); unlocked, cage to boresight. */
export function maverickBreak(sim: Sim): void {
  const s = selectedSeeker(sim);
  if (!s) return;
  if (s.locked) {
    s.internal.aim.copy(s.lockPoint);
    s.internal.aimValid = true;
    unlock(sim, s, 'STAB');
  } else s.mode = 'BORESIGHT';
}

/**
 * Slave the selected seeker to the SPI (it follows the SPI until a lock, a slew or a cage). A no-op
 * when its own lock is the SPI: slaving it to itself must not break the lock.
 */
export function slaveMaverickToSpi(sim: Sim): void {
  const s = selectedSeeker(sim);
  const spi = sim.avionics.spi;
  if (!s || !spi.valid || (spi.source === 'MAV' && s.locked)) return;
  unlock(sim, s, 'SLAVE');
}

/** Field of view of the selected seeker: WIDE, NARROW or 'toggle'. */
export function setMaverickFov(sim: Sim, value: 'WIDE' | 'NARROW' | 'toggle'): void {
  const s = selectedSeeker(sim);
  if (!s) return;
  s.fov = value === 'toggle' ? (s.fov === 'WIDE' ? 'NARROW' : 'WIDE') : value;
  s.fovAngle = fovAngle(s.fov);
}

/** Polarity of an infrared seeker's picture (WHOT ↔ BHOT); a TV seeker stays CCD. */
export function toggleMaverickPicture(sim: Sim): void {
  const s = selectedSeeker(sim);
  if (!s || s.band !== 'IR') return;
  s.picture = s.picture === 'WHOT' ? 'BHOT' : 'WHOT';
}

/** Maverick power (when the avionics does not carry its own switch): on, off or 'toggle'. */
export function setMaverickPower(sim: Sim, value: boolean | 'toggle'): void {
  sim.sensors.mavPower = value === 'toggle' ? !sim.sensors.mavPower : value;
}

function handleRequests(sim: Sim): void {
  const reqs = sim.avionics.sensorRequests;
  for (let i = 0; i < reqs.length; i++) {
    const q = reqs[i];
    if (q.sensor !== 'MAV' && q.sensor !== 'ALL') continue;
    switch (q.action) {
      case 'slaveSpi':
        slaveMaverickToSpi(sim);
        break;
      case 'tms':
        if (q.dir === 'up') maverickLock(sim);
        else if (q.dir === 'down') maverickBreak(sim);
        break;
      case 'chinaHat':
        if (q.dir === 'fwd' && !q.long) setMaverickFov(sim, 'toggle');
        break;
      case 'dms':
        // the seeker's optics have two steps: DMS up / down = NARROW / WIDE; left / right = polarity
        if (q.dir === 'up' || q.dir === 'down')
          setMaverickFov(sim, q.dir === 'up' ? 'NARROW' : 'WIDE');
        else if (q.dir === 'left' || q.dir === 'right') toggleMaverickPicture(sim);
        break;
      case 'zoom':
        if (q.value !== 0) setMaverickFov(sim, q.value > 0 ? 'NARROW' : 'WIDE');
        break;
      case 'picture':
        toggleMaverickPicture(sim);
        break;
      default:
        break;
    }
  }
}

// ---- the step ---------------------------------------------------------------------------------------

/** The rack or launcher on a station (null when none). */
function stationRack(sim: Sim, station: number): StoreType | null {
  const list = sim.stores.stations;
  for (let i = 0; i < list.length; i++) if (list[i].station === station) return list[i].rack;
  return null;
}

function soiIsMav(sim: Sim): boolean {
  const av = sim.avionics;
  const page = av.soi === 'LMFD' ? av.mfd.left : av.soi === 'RMFD' ? av.mfd.right : 'HUD';
  return page === 'MAV';
}

/** Hold the ground point under the current line of sight (or its direction). */
function aimAlongLos(sim: Sim, s: MaverickSeekerState): void {
  const si = s.internal;
  if (sim.world.terrain.raycast(s.head, s.los, MAVERICK.maxLaunchRange * 2, _hit)) {
    si.aim.copy(_hit.point);
    si.aimValid = true;
  } else {
    si.aimValid = false;
    si.aimDir.copy(s.los);
  }
}

function slew(sim: Sim, s: MaverickSeekerState, dt: number): void {
  const sx = sim.input.slewX;
  const sy = sim.input.slewY;
  if (Math.max(Math.abs(sx), Math.abs(sy)) <= 0.02) return;
  const rate = s.fovAngle * MAVERICK.slewFovPerSecond;
  const ax = Math.sign(sx) * Math.pow(Math.abs(sx), MAVERICK.slewExpo) * rate * dt;
  const ay = Math.sign(sy) * Math.pow(Math.abs(sy), MAVERICK.slewExpo) * rate * dt;
  if (s.mode === 'TRACK') unlock(sim, s, 'STAB');
  s.mode = 'STAB';
  _fwd.set(0, 0, -1).applyQuaternion(sim.aircraft.orientation);
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-9) _fwd.set(0, 0, -1);
  _fwd.normalize();
  pictureAxes(s.los, _fwd, _right, _up);
  s.los.addScaledVector(_right, ax).addScaledVector(_up, ay).normalize();
  aimAlongLos(sim, s);
}

/** Line of sight from the mode's aim, limited by the gimbal. */
function point(sim: Sim, s: MaverickSeekerState): void {
  const q = sim.aircraft.orientation;
  const si = s.internal;
  storeAxisBody(s.station, _axis);
  if (s.mode === 'BORESIGHT') _body.copy(_axis);
  else {
    if (si.aimValid) _v.subVectors(si.aim, s.head).normalize();
    else _v.copy(si.aimDir);
    worldToBody(q, _v, _body);
  }
  s.atLimit = clampToCone(_body, _axis, MAVERICK.gimbalLimit);
  s.offAxis = _body.angleTo(_axis);
  s.los.copy(_body).applyQuaternion(q);
  s.gimbalAz = Math.atan2(_body.x, -_body.z);
  s.gimbalEl = Math.atan2(_body.y, Math.hypot(_body.x, _body.z));
}

/** Hold or break the lock of the selected seeker; IR capture by a burning object. */
function updateTrack(sim: Sim, s: MaverickSeekerState, v: Vehicle | null, check: boolean): void {
  if (!v) {
    s.lockFailure = 'NO TARGET';
    unlock(sim, s, 'STAB');
    return;
  }
  if (s.atLimit) {
    s.lockFailure = 'GIMBAL LIMIT';
    s.internal.aim.copy(s.lockPoint);
    unlock(sim, s, 'STAB');
    return;
  }
  vehicleCentre(v, _c);
  _v.subVectors(_c, s.head);
  const range = _v.length();
  _v.multiplyScalar(1 / Math.max(1e-9, range));
  const hold = lockRules(s, MAVERICK.lockHoldFraction);
  if (angularSize(v, _v, range) < hold.minSize) {
    s.lockFailure = 'TOO SMALL';
    s.internal.aim.copy(s.lockPoint);
    unlock(sim, s, 'STAB');
    return;
  }
  if (!check) return;
  if (!checkVehicle(sim, v, s.head, hold, _check)) {
    s.lockFailure = _check.failure;
    s.internal.aim.copy(s.lockPoint);
    unlock(sim, s, 'STAB');
    return;
  }
  s.contrast = _check.contrast;
  if (s.band === 'IR') capture(sim, s, v, _check.detail.apparent, range);
}

/**
 * An infrared seeker is captured by a burning object in its track gate that is much hotter than
 * its target (PLAN §6.4: "an infrared seeker can be captured by a burning wreck beside the live
 * tank"). The gate is the tracking gate, or 1.5 × the target's angular radius if that is larger.
 */
function capture(
  sim: Sim,
  s: MaverickSeekerState,
  target: Vehicle,
  targetK: number,
  range: number,
): void {
  const list = sim.targets.vehicles;
  const radius = 0.5 * angularSize(target, _v, range);
  const gate = Math.max(gateOf(sim, s), MAVERICK.trackGateTargetFactor * radius);
  const cosGate = Math.cos(gate);
  let best: Vehicle | null = null;
  let bestK = Math.abs(targetK) * MAVERICK.captureRatio;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o === target || o.fire <= 0) continue;
    vehicleCentre(o, _c);
    _c.sub(s.head);
    const d = _c.length();
    if (d < 1 || _c.dot(s.los) / d < cosGate) continue;
    const c = vehicleContrast(sim, o, 'IR', s.head, _detail);
    if (c <= 0 || Math.abs(_detail.apparent) <= bestK) continue;
    if (!checkVehicle(sim, o, s.head, lockRules(s, MAVERICK.lockHoldFraction), _probe)) continue;
    best = o;
    bestK = Math.abs(_detail.apparent);
  }
  if (best) {
    s.lockedVehicle = best.id;
    s.contrast = _probe.contrast;
  }
}

/** Contrast of what is in the gate of an unlocked, ready seeker (the page's contrast cue). */
function gateContrast(sim: Sim, s: MaverickSeekerState): void {
  _rules.band = s.band;
  _rules.minSize = 0;
  _rules.minContrast = 0;
  s.contrast = searchGate(sim, s.head, s.los, gateOf(sim, s), _rules, _probe) ? _probe.contrast : 0;
}

/** Every Maverick seeker's step (stepSensors, step 8). */
export function stepMavericks(sim: Sim, dt: number): void {
  const sensors = sim.sensors;
  const first = !sensors.initialized;
  const sw = cockpitSwitches(sim);
  if (typeof sw.mavPower === 'boolean') sensors.mavPower = sw.mavPower;
  const changed = syncSeekers(sim, first);
  const before = selectedSeeker(sim);
  const sel = chooseSelected(sim);
  if (changed || sel !== before || (sel && !sel.selected)) {
    if (before && before !== sel) {
      // the old selection is caged (a launched missile is already gone from the lists)
      if (before.locked) unlock(sim, before, 'BORESIGHT');
      before.mode = 'BORESIGHT';
    }
    publish(sim, sel);
    if (sel && handoff.valid && sel !== before) {
      sel.mode = handoff.mode;
      sel.internal.aim.copy(handoff.aim);
      sel.internal.aimValid = handoff.aimValid;
      if (!handoff.aimValid) sel.mode = 'BORESIGHT';
    }
    handoff.valid = false;
  }

  // power and alignment
  const ac = sim.aircraft;
  for (let i = 0; i < sensors.mavericks.length; i++) {
    const m = sensors.mavericks[i];
    m.powered = sensors.mavPower;
    if (m.powered) m.align = Math.max(0, m.align - dt);
    else {
      m.align = MAVERICK.alignTime;
      if (m.locked) unlock(sim, m, 'BORESIGHT');
      m.mode = 'BORESIGHT';
    }
    seekerHeadBody(m.station, stationRack(sim, m.station), m.rail, _body);
    bodyToWorldPoint(ac.position, ac.orientation, _body, m.head);
    m.fovAngle = fovAngle(m.fov);
    if (!m.selected) {
      if (m.locked) unlock(sim, m, 'BORESIGHT');
      m.mode = 'BORESIGHT';
      point(sim, m);
      m.contrast = 0;
      m.inZone = false;
      m.range = 0;
    }
  }

  const s = selectedSeeker(sim);
  if (!s) return;
  const live = ready(s);
  // requests always (a lock before alignment is refused with 'NOT READY'); the slew needs video
  handleRequests(sim);
  if (live && soiIsMav(sim)) slew(sim, s, dt);
  // the aim of the mode
  const si = s.internal;
  let target: Vehicle | null = null;
  if (s.mode === 'TRACK') {
    target = findVehicle(sim, s.lockedVehicle);
    if (target) {
      vehicleCentre(target, si.aim);
      si.aimValid = true;
      s.lockPoint.copy(target.position);
    }
  } else if (s.mode === 'SLAVE') {
    const spi = sim.avionics.spi;
    if (spi.valid) {
      si.aim.copy(spi.position);
      si.aimValid = true;
    } else s.mode = 'STAB';
  }
  point(sim, s);
  const check = --si.checkCountdown <= 0;
  if (check) si.checkCountdown = Math.max(1, Math.round(SIM_HZ / MAVERICK.lockCheckHz));
  if (s.mode === 'TRACK') updateTrack(sim, s, target, check);
  else if (check && live) gateContrast(sim, s);
  else if (!live) s.contrast = 0;

  // range and launch zone
  if (s.locked && target) {
    vehicleCentre(target, _c);
    s.range = _c.distanceTo(s.head);
  } else s.range = si.aimValid && s.mode !== 'BORESIGHT' ? si.aim.distanceTo(s.head) : 0;
  s.inZone =
    s.locked &&
    s.range >= MAVERICK.minLaunchRange &&
    s.range <= MAVERICK.maxLaunchRange &&
    s.offAxis <= MAVERICK.gimbalLimit - MAVERICK.launchGimbalMargin;
}
