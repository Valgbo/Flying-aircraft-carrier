/**
 * The pickle button and every release decision (ARCHITECTURE §12.1: avionics decides, weapons
 * executes; PLAN_A10.md §6.4–6.7). Runs every step after the solutions (stepFireControl, step 9).
 *
 * Time. The solutions are for the aircraft state at fire-control time T = sim.time + dt (step 9
 * runs after the flight step, before the clock advances). A request carries an exact time in
 * [T, T + dt): the weapons module executes it in the NEXT step at that instant, the pose
 * interpolated between `prev*` and the new state. A request is never queued in the past.
 *
 * A press of the pickle (rising edge of `input.weaponRelease`):
 *   Master Arm SAFE   nothing leaves (message). TRAIN: the same decisions, but no request: a
 *                     simulated WeaponRecord (`simulated: true`) goes to the debrief.
 *   Maverick profile  (any master mode) the selected seeker must be powered, aligned, locked and
 *                     in zone, and the guided module's `maverickCanLaunch` must agree; the button
 *                     is held RELEASE.mavHoldTime, then one missile leaves (delivery 'MAV', aim =
 *                     the lock point, the locked vehicle). Afterwards the next missile is the
 *                     selected station and its seeker is slaved to the SPI (a sensor request).
 *   CCIP              the pipper visible: the release is immediate (rockets always). The pipper
 *                     below the glass: CONSENT — the press designates the ground point under the
 *                     delay cue, and the computer releases when the predicted impact reaches it,
 *                     while the button is held.
 *   CCRP              the computer releases when the computed release time reaches 0, while the
 *                     button is held.
 *   Letting go of the button cancels a consent or CCRP release, a Maverick hold and the rest of a
 *   ripple.
 * Series. SGL one store per pulse, PRS a pair (one per wing: stations.ts), RIP SGL / RIP PRS
 * `rippleQty` pulses at interval = spacing / ground speed (at least the rack's or launcher's
 * minimum). A computed release (CCRP, consent) centres the stick on the target: the first pulse
 * leaves (n − 1)/2 intervals before the solution, pulse k aims (k − (n − 1)/2) spacings along the
 * track from the target. An immediate CCIP release starts at the press and each pulse aims at the
 * pipper of its own release. Pulses are decided one step ahead, from the station the release
 * order gives at that moment (stations.ts).
 */
import { Vector3 } from 'three';
import { FIRE_CONTROL, HIGH_DRAG_STORES, RELEASE } from '../../data/avionics';
import { STORES } from '../../data/munitions';
import type { WeaponRecord } from '../debrief/types';
import type { MaverickSeekerState } from '../sensors/types';
import type { Sim } from '../types';
import { maverickCanLaunch } from '../weapons/guided';
import type { ReleaseDelivery, ReleaseRequest, StoreType } from '../weapons/types';
import type { FireControlGround } from './ground';
import { notify } from './notify';
import { createImpactPrediction } from './predict';
import { profileAvailable, profileById, selectedProfile } from './profiles';
import {
  flyStore,
  modelFor,
  predictReleaseAt,
  refineReleaseTime,
  solveDesignated,
  storeReleaseState,
} from './release';
import { isRocketPod, nextStation, pulseStations, stationSide } from './stations';
import type { DeliveryState, WeaponProfile } from './types';

export function createDeliveryState(): DeliveryState {
  return {
    pickle: false,
    phase: 'IDLE',
    pressTime: -1,
    profile: '',
    store: '',
    delivery: 'CCIP',
    simulated: false,
    perPulse: 1,
    pulses: 0,
    pulseIndex: 0,
    nextTime: 0,
    interval: 0,
    spacing: 0,
    aim: new Vector3(),
    aimValid: false,
    aimPerPulse: true,
    trackX: 0,
    trackZ: -1,
    used: new Array<number>(12).fill(0),
    lastSide: 0,
    mavSlaveAfter: -1,
    lastReleaseTime: -1,
    lastImpactTime: -1,
  };
}

/** The store is an AGM-65 (launched from the MAV page, not by CCIP / CCRP). */
export function isMaverick(store: string): boolean {
  return STORES[store as StoreType]?.kind === 'missile';
}

/** Back to IDLE (the button was let go, a rearm, a jettison): nothing pending. */
export function cancelDelivery(d: DeliveryState): void {
  d.phase = 'IDLE';
  d.aimValid = false;
  d.pulses = 0;
  d.pulseIndex = 0;
}

/**
 * The station the selected profile's next release leaves from (av.selectedStation). For a
 * Maverick profile it is the missile the sensors module has selected (the one the MAV page
 * shows) when that is the profile's type; otherwise the release order picks it, and the sensors
 * module selects the seeker on it.
 */
export function updateSelectedStation(sim: Sim): void {
  const av = sim.avionics;
  const d = av.delivery;
  const p = selectedProfile(sim);
  if (!p) {
    av.selectedStation = 0;
    return;
  }
  if (isMaverick(p.store)) {
    const seeker = selectedSeeker(sim);
    if (seeker && maverickOn(sim, seeker.station) === p.store) {
      av.selectedStation = seeker.station;
      return;
    }
  }
  av.selectedStation = nextStation(
    sim,
    p.store,
    d.phase === 'SERIES' && d.simulated ? d.used : null,
    d.lastSide,
  );
}

/**
 * The pickle, every step after the release solution: start, continue or end the run, and push
 * the release requests (or simulated records) that fall due before the next step ends.
 */
export function stepDelivery(sim: Sim, ground: FireControlGround, dt: number): void {
  const av = sim.avionics;
  const d = av.delivery;
  const now = sim.time + dt;
  const held = sim.input.weaponRelease;
  const pressed = held && !d.pickle;
  d.pickle = held;
  if (!held) {
    if (d.phase !== 'IDLE') cancelDelivery(d);
    av.release.armed = false;
    av.release.pulsesLeft = 0;
    if (av.release.designatedValid && av.sight === 'CCIP') av.release.designatedValid = false;
    return;
  }
  if (pressed) startRun(sim, ground, now, dt);
  else continueRun(sim, ground, now, dt);
  av.release.armed = d.phase === 'CONSENT' || d.phase === 'CCRP';
  av.release.pulsesLeft = d.phase === 'SERIES' ? Math.max(0, d.pulses - d.pulseIndex) : 0;
}

/** Profile name for messages. */
function nameOf(p: WeaponProfile): string {
  return p.name ?? p.id;
}

function startRun(sim: Sim, ground: FireControlGround, now: number, dt: number): void {
  const av = sim.avionics;
  const d = av.delivery;
  d.phase = 'DONE';
  d.pressTime = now;
  d.pulses = 0;
  d.pulseIndex = 0;
  d.aimValid = false;
  d.used.fill(0);
  const p = selectedProfile(sim);
  if (av.masterArm === 'SAFE') {
    notify(sim, 'MASTER ARM SAFE', 'info');
    return;
  }
  d.simulated = av.masterArm === 'TRAIN';
  if (!p) {
    notify(sim, 'NO STORE SELECTED', 'info');
    return;
  }
  d.profile = p.id;
  d.store = p.store;
  if (isMaverick(p.store)) {
    startMaverick(sim, now);
    return;
  }
  if (!profileAvailable(sim, p)) {
    notify(sim, `NO ${p.store}`, 'info');
    return;
  }
  const mode = av.masterMode;
  if (mode !== 'CCIP' && mode !== 'CCRP') {
    notify(sim, `${nameOf(p)}: SELECT CCIP OR CCRP`, 'info');
    return;
  }
  const rel = av.release;
  if (av.sight !== mode || !rel.valid) {
    notify(sim, `${mode} INVALID`, 'warn');
    return;
  }
  const rocket = isRocketPod(p.store);
  d.delivery = rocket ? 'ROCKET' : mode;
  d.perPulse = p.release === 'PRS' || p.release === 'RIP_PRS' ? 2 : 1;
  d.pulses = p.release === 'RIP_SGL' || p.release === 'RIP_PRS' ? Math.max(1, p.rippleQty) : 1;
  d.spacing = p.rippleSpacing;
  setTrackAndInterval(sim, d, rocket);
  if (mode === 'CCRP') {
    if (rel.timeToRelease < 0) {
      notify(sim, 'RELEASE POINT PASSED', 'info');
      return;
    }
    d.phase = 'CCRP';
    d.aim.copy(av.spi.position);
    d.aimValid = true;
    d.aimPerPulse = false;
    checkComputed(sim, ground, now, dt);
    return;
  }
  if (!rocket && rel.belowGlass) {
    // Consent: designate the ground point under the delay cue.
    if (!rel.delayCueValid) {
      notify(sim, 'CCIP INVALID', 'warn');
      return;
    }
    d.phase = 'CONSENT';
    d.aim.copy(rel.delayCue);
    d.aimValid = true;
    d.aimPerPulse = false;
    rel.designated.copy(d.aim);
    rel.designatedValid = true;
    // Countdown and steering from the press step on (the point may already be due).
    if (!solveDesignated(sim, ground, d.aim)) rel.timeToRelease = 0;
    checkComputed(sim, ground, now, dt);
    return;
  }
  // Immediate CCIP release: the stick starts at the pipper.
  d.phase = 'SERIES';
  d.aimPerPulse = true;
  d.nextTime = now;
  firePulses(sim, ground, now, dt);
}

/** Ground track (unit) and the ripple interval from the present ground speed. */
function setTrackAndInterval(sim: Sim, d: DeliveryState, rocket: boolean): void {
  const v = sim.aircraft.velocity;
  const vg = Math.hypot(v.x, v.z);
  if (vg > 1e-3) {
    d.trackX = v.x / vg;
    d.trackZ = v.z / vg;
  }
  const min = rocket ? RELEASE.minIntervalRocket : RELEASE.minIntervalBomb;
  d.interval = Math.max(min, vg > 1 ? d.spacing / vg : 0);
}

function continueRun(sim: Sim, ground: FireControlGround, now: number, dt: number): void {
  const av = sim.avionics;
  const d = av.delivery;
  if (d.phase === 'IDLE' || d.phase === 'DONE') return;
  if (av.masterArm === 'SAFE') {
    // Master Arm to SAFE stops everything.
    d.phase = 'DONE';
    return;
  }
  if (d.phase === 'MAV') {
    continueMaverick(sim, now);
    return;
  }
  if (av.selectedProfile !== d.profile) {
    d.phase = 'DONE';
    return;
  }
  if (d.phase === 'CONSENT' || d.phase === 'CCRP') checkComputed(sim, ground, now, dt);
  else if (d.phase === 'SERIES') firePulses(sim, ground, now, dt);
}

/**
 * A consent or CCRP run: when the first pulse of the stick (the solution, minus half the stick
 * for a ripple) falls before the next step ends, refine the solution and start the series.
 */
function checkComputed(sim: Sim, ground: FireControlGround, now: number, dt: number): void {
  const av = sim.avionics;
  const d = av.delivery;
  const rel = av.release;
  const mode = d.phase === 'CCRP' ? 'CCRP' : 'CCIP';
  if (av.masterMode !== mode || !rel.valid || !rel.designatedValid) return;
  if (d.phase === 'CCRP') d.aim.copy(av.spi.position);
  const p = profileById(av, d.profile);
  const model = p ? modelFor(p) : null;
  if (!p || !model) return;
  setTrackAndInterval(sim, d, false);
  const lead = 0.5 * (d.pulses - 1) * d.interval;
  let tau = rel.timeToRelease;
  if (tau - lead >= dt) return;
  // Due before the next step ends: solve it exactly.
  const refined = refineReleaseTime(sim, model, av.selectedStation, d.aim, ground);
  if (!Number.isNaN(refined)) tau = refined;
  if (tau - lead >= dt) return;
  if (tau < -dt && d.pulses === 1) {
    notify(sim, 'RELEASE POINT PASSED', 'info');
    d.phase = 'DONE';
    return;
  }
  d.phase = 'SERIES';
  d.nextTime = now + Math.max(0, tau - lead);
  firePulses(sim, ground, now, dt);
}

const _stations = [0, 0];

/** Release the pulses that fall due before the next step ends. */
function firePulses(sim: Sim, ground: FireControlGround, now: number, dt: number): void {
  const av = sim.avionics;
  const d = av.delivery;
  while (d.pulseIndex < d.pulses && d.nextTime < now + dt - 1e-9) {
    const t = Math.max(d.nextTime, now);
    const train = av.masterArm === 'TRAIN';
    const n = pulseStations(sim, d.store, d.perPulse === 2, train ? d.used : null, d.lastSide, _stations);
    if (n === 0) {
      if (d.pulseIndex === 0) notify(sim, `NO ${d.store}`, 'info');
      d.phase = 'DONE';
      return;
    }
    for (let k = 0; k < n; k++) releaseOne(sim, ground, _stations[k], t, now, train);
    d.lastSide = stationSide(_stations[0]);
    d.pulseIndex++;
    d.nextTime += d.interval;
  }
  if (d.pulseIndex >= d.pulses) d.phase = 'DONE';
}

const _aim = new Vector3();
const _o = new Vector3();
const _v = new Vector3();
const _fly = createImpactPrediction();

/** One store leaves `station` at time `t` (≥ now): a release request, or a TRAIN record. */
function releaseOne(
  sim: Sim,
  ground: FireControlGround,
  station: number,
  t: number,
  now: number,
  train: boolean,
): void {
  const av = sim.avionics;
  const d = av.delivery;
  const p = profileById(av, d.profile);
  if (!p) return;
  const model = modelFor(p);
  const tau = t - now;
  let aimValid = d.aimValid;
  let tof = NaN;
  if (model) tof = predictReleaseAt(sim, model, station, tau, ground, _aim);
  if (d.aimPerPulse) {
    // Immediate CCIP: the pipper of this store's own release.
    aimValid = !Number.isNaN(tof);
    if (!aimValid) _aim.copy(av.release.impact);
  } else {
    const off = (d.pulseIndex - 0.5 * (d.pulses - 1)) * d.spacing;
    _aim.set(d.aim.x + off * d.trackX, d.aim.y, d.aim.z + off * d.trackZ);
  }
  const laserCode = p.laserCode ?? (p.store === 'GBU-12' ? RELEASE.laserCode : 0);
  const highDrag = p.drag === 'HD' && HIGH_DRAG_STORES.includes(p.store);
  if (train) {
    if (d.used.length > station) d.used[station]++;
    simulatedRecord(sim, p, station, t, now, d.delivery, _aim, aimValid, model ? tau : NaN);
  } else {
    const req: ReleaseRequest = {
      time: t,
      station,
      store: p.store as StoreType,
      profile: p.id,
      delivery: d.delivery,
      aim: { x: _aim.x, y: _aim.y, z: _aim.z },
      aimValid,
      fuze: p.fuze,
      armingTime: p.armingTime,
      highDrag,
      laserCode,
      lockVehicle: -1,
    };
    sim.stores.releaseQueue.push(req);
  }
  d.lastReleaseTime = t;
  d.lastImpactTime = Number.isNaN(tof) ? -1 : t + tof;
  av.release.releaseNow = true;
}

// ---------------------------------------------------------------------------------------------
// Master Arm TRAIN: simulated records for the debrief (ARCHITECTURE §12.6)
// ---------------------------------------------------------------------------------------------

/**
 * Append a simulated WeaponRecord: the release conditions, the aim, and where the store would
 * have landed — an unguided store flown in full (the wind at the body, the real terrain:
 * flyStore); a guided one (GBU-12, Maverick) assumed to reach its aim. Simulated records have
 * negative ids (−1, −2, …) so they never collide with a store body's id, and `bodyId` 0.
 */
function simulatedRecord(
  sim: Sim,
  p: WeaponProfile,
  station: number,
  t: number,
  now: number,
  delivery: ReleaseDelivery,
  aim: Vector3,
  aimValid: boolean,
  tau: number,
): void {
  const ac = sim.aircraft;
  const guided = delivery === 'MAV' || p.store === 'GBU-12';
  let ix = aim.x;
  let iy = aim.y;
  let iz = aim.z;
  let fall = NaN;
  const model = modelFor(p);
  if (!guided && model && !Number.isNaN(tau)) {
    storeReleaseState(sim, model, station, tau, _o, _v);
    if (flyStore(sim, model, _o, _v, FIRE_CONTROL.storeMaxTimeOfFall, _fly)) {
      ix = _fly.point.x;
      iy = _fly.point.y;
      iz = _fly.point.z;
      fall = _fly.time;
    }
  }
  const v = ac.velocity;
  const speed = v.length();
  const vg = Math.hypot(v.x, v.z);
  const ux = vg > 1e-3 ? v.x / vg : 0;
  const uz = vg > 1e-3 ? v.z / vg : -1;
  const dx = ix - aim.x;
  const dz = iz - aim.z;
  const miss = Math.hypot(dx, dz);
  const fuzeEffects = sim.options.realism.fuzeEffects;
  let nSim = 0;
  for (const r of sim.debrief.weapons) if (r.simulated) nSim++;
  const rec: WeaponRecord = {
    id: -(nSim + 1),
    weapon: p.store,
    release: {
      time: t,
      dive: speed > 0 ? -Math.asin(Math.max(-1, Math.min(1, v.y / speed))) : 0,
      speed: ac.tas,
      // The release is less than a step after the present state: its height is the present one
      // moved along the flight path.
      agl: ac.agl + v.y * (t - now),
      slantRange: aimValid
        ? Math.hypot(aim.x - ac.position.x, aim.y - ac.position.y, aim.z - ac.position.z)
        : 0,
      gLoad: ac.gLoad,
      bank: ac.bank,
    },
    impactTime: Number.isNaN(fall) ? NaN : t + fall,
    missDistance: aimValid ? miss : NaN,
    missClock: aimValid ? missClock(dx, dz, ux, uz) : 0,
    dud: fuzeEffects && !Number.isNaN(fall) && fall < p.armingTime,
    fragmentWarning: fuzeEffects && ac.position.y - iy < p.minAltitude,
    store: p.store,
    station,
    delivery,
    aim: { x: aim.x, y: aim.y, z: aim.z },
    aimValid,
    impact: { x: ix, y: iy, z: iz },
    simulated: true,
    bodyId: 0,
  };
  sim.debrief.weapons.push(rec);
}

/** Clock direction (1–12) of a miss (dx, dz) from the aim, 12 = along the track (ux, uz). */
export function missClock(dx: number, dz: number, ux: number, uz: number): number {
  if (Math.hypot(dx, dz) < 1e-6) return 12;
  const ahead = dx * ux + dz * uz;
  const right = -dx * uz + dz * ux;
  const hours = Math.round(Math.atan2(right, ahead) / (Math.PI / 6));
  const c = ((hours % 12) + 12) % 12;
  return c === 0 ? 12 : c;
}

// ---------------------------------------------------------------------------------------------
// Maverick launch
// ---------------------------------------------------------------------------------------------

/** The seeker the MAV page shows (the sensors module's selected one), or null. */
export function selectedSeeker(sim: Sim): MaverickSeekerState | null {
  const s = sim.sensors;
  const i = s.selectedMaverick;
  return i >= 0 && i < s.mavericks.length ? s.mavericks[i] : null;
}

/** The Maverick type hanging on a station (first in release order), or null. */
function maverickOn(sim: Sim, station: number): StoreType | null {
  const st = sim.stores.stations[station - 1];
  if (!st || st.station !== station) return null;
  for (const s of st.stores) if (isMaverick(s)) return s;
  return null;
}

/** Why a Maverick cannot be launched now (the message), or null when it can. */
export function maverickLaunchRefusal(sim: Sim, seeker: MaverickSeekerState | null): string | null {
  if (!seeker || !maverickOn(sim, seeker.station)) return 'NO MAV SELECTED';
  if (!seeker.powered || seeker.align > 0) return 'MAV NOT READY';
  const reason = maverickCanLaunch(sim, seeker);
  if (reason) return reason;
  if (!seeker.locked) return 'MAV NOT LOCKED';
  if (!seeker.inZone) return 'MAV OUT OF ZONE';
  return null;
}

function startMaverick(sim: Sim, now: number): void {
  const d = sim.avionics.delivery;
  const reason = maverickLaunchRefusal(sim, selectedSeeker(sim));
  if (reason) {
    notify(sim, reason, 'warn');
    return;
  }
  d.phase = 'MAV';
  d.delivery = 'MAV';
  d.pressTime = now;
}

function continueMaverick(sim: Sim, now: number): void {
  const av = sim.avionics;
  const d = av.delivery;
  if (now - d.pressTime + 1e-9 < RELEASE.mavHoldTime) return;
  d.phase = 'DONE';
  const seeker = selectedSeeker(sim);
  const reason = maverickLaunchRefusal(sim, seeker);
  const p = profileById(av, d.profile);
  if (reason || !seeker || !p) {
    notify(sim, reason ?? 'NO MAV SELECTED', 'warn');
    return;
  }
  const station = seeker.station;
  const store = maverickOn(sim, station) as StoreType;
  const lock = seeker.lockPoint;
  if (av.masterArm === 'TRAIN') {
    _aim.copy(lock);
    simulatedRecord(sim, p, station, now, now, 'MAV', _aim, true, NaN);
  } else {
    sim.stores.releaseQueue.push({
      time: now,
      station,
      store,
      profile: p.id,
      delivery: 'MAV',
      aim: { x: lock.x, y: lock.y, z: lock.z },
      aimValid: true,
      fuze: p.fuze,
      armingTime: p.armingTime,
      highDrag: false,
      laserCode: 0,
      lockVehicle: seeker.lockedVehicle,
    });
  }
  d.lastSide = stationSide(station);
  d.lastReleaseTime = now;
  d.lastImpactTime = -1;
  // The next missile's seeker is slaved to the SPI once this one has left the rail.
  d.mavSlaveAfter = now;
  av.release.releaseNow = true;
}
