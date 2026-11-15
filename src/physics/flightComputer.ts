/**
 * Flight control laws: turns pilot input into throttle and tilt commands for the four turbines.
 * Pure and allocation-free; shared by the Rapier driver and the test integrator.
 *
 * FLIGHT ASSIST ON — the flight computer:
 *   collective → target altitude; a cascade (altitude error → vertical speed → acceleration)
 *                plus a feed-forward of everything it knows (weight, drag, buoyancy, nacelle
 *                tilt, deck attitude, air density) gives the collective thrust
 *   tilt       → tilt lever for all nacelles, held back when the lift budget runs out; the
 *                lever does not travel past that budget and pauses in a stop at neutral
 *   yaw        → yaw-rate command through differential tilt (port pair vs. starboard pair);
 *                the heading is captured and held once the input is released
 *   strafe     → a small commanded bank that slides the ship sideways; level on release
 *   attitude   → differential throttle keeps the deck at the commanded attitude
 * Thrust is allocated in terms of the deck-normal force of each turbine. When the fans
 * saturate, attitude keeps its authority and the climb gives way. With one engine out the
 * allocation falls back on the diagonal pair that can still lift without a net moment (the
 * turbine opposite the dead one only helps with attitude); with less than that it cuts thrust
 * rather than flip the ship.
 *
 * FLIGHT ASSIST OFF — manual: the axes move the per-turbine manual throttle / tilt values
 * (collective, tilt) or add a momentary differential (yaw → tilt, strafe → throttle). Nothing
 * is stabilised.
 *
 * Switching is bumpless: while the computer flies, the manual values mirror the real turbine
 * state; while the pilot flies, the target altitude and the tilt lever mirror the ship.
 */
import { Quaternion, Vector3 } from 'three';
import {
  turbineThrustFactor,
  yawDampingCoefficient,
  type RigidState,
} from '../carrier/carrierPhysics';
import { FLOATING_ALTITUDE, TURBINE_MOUNTS } from '../config/layout';
import { FLIGHT, PHYS, WEIGHT } from '../config/physicsConfig';
import type { FlightControls, Quad, TurbineSim } from '../state/types';
import { clamp, clamp01, wrapAngle } from '../utils/math';

/** The four flight axes of the pilot input, each in [-1, 1]. `InputAxes` satisfies it. */
export interface PilotAxes {
  collective: number;
  tilt: number;
  yaw: number;
  strafe: number;
}

/** What the flight computer measures besides the rigid-body state. */
export interface FlightSensors {
  /** World-up force from drag and water (everything except thrust and gravity), kN. */
  supportForceY: number;
  /** True while the water carries a noticeable part of the weight. */
  afloat: boolean;
  /** Keel above the local water surface, m. */
  keelClearance: number;
}

export interface FlightComputerState {
  /** Control mode during the previous step ('fresh' before the first one). */
  mode: 'fresh' | 'assist' | 'manual';
  /** Engines held at idle because the ship is afloat with nothing to climb to. */
  idle: boolean;
  /** Altitude-hold trim, m/s². */
  altitudeIntegral: number;
  /** Attitude-hold trims, rad/s². */
  pitchIntegral: number;
  rollIntegral: number;
  /** Bank the computer is currently asking for, rad (positive = starboard down). */
  bankCommand: number;
  /** Compass heading being held, rad. Valid while `headingHold`. */
  headingTarget: number;
  headingHold: boolean;
  /** Low-passed `supportForceY`, kN. */
  supportEstimate: number;
  /** How far the nacelles are currently pulled back because the fans ran out of lift, rad. */
  tiltRelief: number;
  /**
   * Seconds the tilt lever still waits in its neutral stop, signed like the tilt input that ran
   * it there (0 = the lever is free).
   */
  leverHold: number;
  /** True when the last allocation had to give up climb or attitude demand. */
  saturated: boolean;
}

export function createFlightComputerState(): FlightComputerState {
  return {
    mode: 'fresh',
    idle: false,
    altitudeIntegral: 0,
    pitchIntegral: 0,
    rollIntegral: 0,
    bankCommand: 0,
    headingTarget: 0,
    headingHold: true,
    supportEstimate: 0,
    tiltRelief: 0,
    leverHold: 0,
    saturated: false,
  };
}

/** Deck attitude in the conventions of docs/ARCHITECTURE.md. */
export interface Attitude {
  /** Compass heading of the bow, rad in (-π, π] (0 = north, +π/2 = east). */
  heading: number;
  /** rad, positive = bow up. */
  pitch: number;
  /** rad, positive = starboard side down. */
  roll: number;
  /** World-up component of the deck normal (1 = level). */
  upY: number;
  /** World-up component of the bow direction. */
  forwardY: number;
}

const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();

export function readAttitude(quaternion: Quaternion, out: Attitude): Attitude {
  _fwd.set(0, 0, -1).applyQuaternion(quaternion);
  _right.set(1, 0, 0).applyQuaternion(quaternion);
  _up.set(0, 1, 0).applyQuaternion(quaternion);
  out.heading = Math.atan2(_fwd.x, -_fwd.z);
  out.pitch = Math.asin(clamp(_fwd.y, -1, 1));
  out.roll = Math.atan2(-_right.y, _up.y);
  out.upY = _up.y;
  out.forwardY = _fwd.y;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Geometry of the four turbines as the allocation sees it
// ---------------------------------------------------------------------------------------------

/** Lever arms of the turbines about the roll axis (x) and the pitch axis (z), m. */
const ARM_X = Math.abs(TURBINE_MOUNTS[1][0]);
const ARM_Z = Math.abs(TURBINE_MOUNTS[0][2]);
/** +1 for the forward pair: more lift there raises the bow. */
const PITCH_SIGN: Quad<number> = [0, 1, 2, 3].map(
  (i) => -Math.sign(TURBINE_MOUNTS[i][2]),
) as Quad<number>;
/** +1 for the starboard pair: more lift there raises the starboard side. */
const ROLL_SIGN: Quad<number> = [0, 1, 2, 3].map((i) =>
  Math.sign(TURBINE_MOUNTS[i][0]),
) as Quad<number>;
/** The diagonal pattern that produces neither lift nor a moment — used to carry a dead engine. */
const TWIST_SIGN: Quad<number> = [1, -1, -1, 1];
/** +1 for the port pair: tilting it forward turns the bow to starboard. */
const YAW_SIGN: Quad<number> = ROLL_SIGN.map((s) => -s) as Quad<number>;

/** Water must carry the ship and the target must be within this of the floating altitude to idle, m. */
const IDLE_BAND = 0.5;
/** The altitude trim only integrates this close to the target, m. */
const INTEGRAL_BAND = 6;
/** Low-pass rate of the support-force estimate, 1/s. */
const SUPPORT_FILTER_RATE = 5;
/** Lowest value used for the lift-per-thrust factor (deck badly tilted). */
const MIN_LIFT_FACTOR = 0.35;
/** Largest attitude acceleration the computer asks for, rad/s². */
const ATTITUDE_ACCEL_LIMIT = 0.35;
/** Below this share of the weight in total thrust, differential tilt has nothing to work with. */
const YAW_MIN_THRUST = 0.2;
/** Inputs smaller than this count as released. */
const AXIS_DEADBAND = 0.02;

const _att: Attitude = { heading: 0, pitch: 0, roll: 0, upY: 1, forwardY: 0 };
const _qInv = new Quaternion();
const _wBody = new Vector3();

// allocation scratch
const _alpha: Quad<number> = [0, 0, 0, 0];
const _attitudePart: Quad<number> = [0, 0, 0, 0];
const _fixedPart: Quad<number> = [0, 0, 0, 0];
const _limit: Quad<number> = [0, 0, 0, 0];
const _factor: Quad<number> = [0, 0, 0, 0];
const _actual: Quad<number> = [0, 0, 0, 0];
const _force: Quad<number> = [0, 0, 0, 0];
const _range = { low: 0, high: 0 };
/** What the last allocation had to give up. */
const _cut = { attitude: false, climb: false, descent: false };

function axis(value: number): number {
  return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

const _profile = { speed: 0, slope: 0 };

/**
 * Vertical speed to fly for an altitude error (`_profile.speed`, m/s) and how fast that speed
 * changes per metre travelled (`_profile.slope`, 1/s): proportional close to the target,
 * constant deceleration further out, limited to the climb / sink rates, and flared so that
 * the ship never descends onto the sea faster than a soft touchdown.
 */
function approachProfile(error: number, keelClearance: number): void {
  const k = FLIGHT.altitudeGain;
  const knee = FLIGHT.approachDecel / (k * k);
  const magnitude = Math.abs(error);
  let speed: number = k * magnitude;
  let slope: number = k;
  if (magnitude > knee) {
    speed = Math.sqrt(2 * FLIGHT.approachDecel * (magnitude - knee / 2));
    slope = FLIGHT.approachDecel / speed;
  }
  const limit = error > 0 ? FLIGHT.climbRateMax : FLIGHT.sinkRateMax;
  if (speed > limit) {
    speed = limit;
    slope = 0;
  }
  if (error < 0) {
    const flare = FLIGHT.touchdownSinkRate + FLIGHT.flareGain * Math.max(0, keelClearance);
    if (speed > flare) {
      speed = flare;
      slope = keelClearance > 0 ? FLIGHT.flareGain : 0;
    }
  }
  _profile.speed = Math.sign(error) * speed;
  _profile.slope = slope;
}

/** Range of collective force for which every lifting turbine stays inside its limits. */
function collectiveRange(scale: number): void {
  let low = -Infinity;
  let high = Infinity;
  for (let i = 0; i < 4; i++) {
    if (_alpha[i] <= 0) continue;
    const offset = scale * _attitudePart[i] + _fixedPart[i];
    low = Math.max(low, -offset / _alpha[i]);
    high = Math.min(high, (_limit[i] - offset) / _alpha[i]);
  }
  _range.low = low;
  _range.high = high;
}

/**
 * Distribute a collective deck-normal force and normalised pitch / roll demands
 * (`pitch` = Σ PITCH_SIGN·u, `roll` = Σ ROLL_SIGN·u, kN) over the turbines, writing the
 * deck-normal force of each into `_force`. `_limit` holds the most each can give (0 for a
 * disabled engine) and `_actual` what each is producing right now.
 * Records in `_cut` which demands could not be met.
 */
function allocate(
  turbines: Quad<TurbineSim>,
  collective: number,
  pitch: number,
  roll: number,
): void {
  _cut.attitude = false;
  _cut.climb = false;
  _cut.descent = false;
  let enabledCount = 0;
  let dead = -1;
  for (let i = 0; i < 4; i++) {
    if (turbines[i].enabled) enabledCount++;
    else dead = i;
  }

  if (enabledCount === 4) {
    for (let i = 0; i < 4; i++) {
      _alpha[i] = 0.25;
      _attitudePart[i] = (PITCH_SIGN[i] * pitch + ROLL_SIGN[i] * roll) / 4;
      _fixedPart[i] = 0;
    }
  } else if (enabledCount === 3) {
    // The twist pattern absorbs whatever the dead engine still produces while it spools down.
    // The turbine diagonally opposite gets no share of the lift: its force is fixed by the
    // attitude demand alone and can only push, so the demand is first projected onto what it
    // can deliver.
    const residual = _actual[dead];
    const opposite = 3 - dead;
    const demand = PITCH_SIGN[dead] * pitch + ROLL_SIGN[dead] * roll;
    const feasible = clamp(demand, 2 * (residual - _limit[opposite]), 2 * residual);
    if (feasible !== demand) {
      pitch -= (PITCH_SIGN[dead] * (demand - feasible)) / 2;
      roll -= (ROLL_SIGN[dead] * (demand - feasible)) / 2;
      _cut.attitude = true;
    }
    for (let i = 0; i < 4; i++) {
      const c = TWIST_SIGN[i] * TWIST_SIGN[dead];
      _alpha[i] = (1 - c) / 4;
      _attitudePart[i] =
        (pitch * (PITCH_SIGN[i] - c * PITCH_SIGN[dead]) +
          roll * (ROLL_SIGN[i] - c * ROLL_SIGN[dead])) /
        4;
      _fixedPart[i] = c * residual;
    }
  } else if (enabledCount === 2 && turbines[0].enabled === turbines[3].enabled) {
    // A diagonal pair is left: it can lift, and steer about the one axis it straddles.
    const a = turbines[0].enabled ? 0 : 1;
    const along = (PITCH_SIGN[a] * pitch + ROLL_SIGN[a] * roll) / 4;
    for (let i = 0; i < 4; i++) {
      const alive = turbines[i].enabled;
      _alpha[i] = alive ? 0.5 : 0;
      _attitudePart[i] = alive ? (i === a ? along : -along) : 0;
      _fixedPart[i] = 0;
    }
  } else {
    // Whatever is left can only lift one end or one side: thrust would flip the ship.
    for (let i = 0; i < 4; i++) _force[i] = 0;
    _cut.attitude = true;
    _cut.climb = true;
    return;
  }

  // Attitude first: shrink the attitude demand until some collective fits, then fit the collective.
  let scale = 1;
  collectiveRange(scale);
  if (_range.low > _range.high) {
    _cut.attitude = true;
    let feasible = 0;
    let infeasible = 1;
    for (let iteration = 0; iteration < 14; iteration++) {
      const mid = (feasible + infeasible) / 2;
      collectiveRange(mid);
      if (_range.low <= _range.high) feasible = mid;
      else infeasible = mid;
    }
    scale = feasible;
    collectiveRange(scale);
  }
  const fitted =
    _range.low <= _range.high ? clamp(collective, _range.low, _range.high) : _range.high;
  _cut.climb = fitted < collective;
  _cut.descent = fitted > collective;
  for (let i = 0; i < 4; i++) {
    _force[i] = clamp(_alpha[i] * fitted + scale * _attitudePart[i] + _fixedPart[i], 0, _limit[i]);
  }
}

function resetHolds(fc: FlightComputerState, heading: number): void {
  fc.tiltRelief = 0;
  fc.altitudeIntegral = 0;
  fc.pitchIntegral = 0;
  fc.rollIntegral = 0;
  fc.headingTarget = heading;
}

/**
 * Where the pilot's tilt input (-1..1) takes the tilt lever in one step, rad.
 *
 * The lever only travels where the nacelles can follow: up to what the lift budget allows plus
 * a small overrun that tells the pilot he is pushing against the limit. Pushing on does not
 * wind it up, and pulling back starts from that limit even when the budget shrank under a
 * lever set earlier — so the nacelles answer at once and never move later for travel the pilot
 * could not see. A lever that reaches neutral stops there: it waits `leverNeutralHold` seconds
 * of continued input before it moves on, and letting go in that time leaves it at exactly 0.
 */
function moveTiltLever(
  fc: FlightComputerState,
  lever: number,
  input: number,
  tiltBudget: number,
  dt: number,
): number {
  // Releasing or reversing the input lets go of the neutral stop.
  if (input * fc.leverHold <= 0) fc.leverHold = 0;
  if (input === 0) return lever;
  if (fc.leverHold !== 0) {
    fc.leverHold = Math.sign(input) * Math.max(0, Math.abs(fc.leverHold) - dt);
    return lever;
  }
  const upper = Math.min(PHYS.tiltMax, tiltBudget + FLIGHT.leverOverrun);
  const lower = Math.max(PHYS.tiltMin, -tiltBudget - FLIGHT.leverOverrun);
  const step = input * FLIGHT.leverRate * dt;
  const from = input > 0 ? Math.max(lever, lower) : Math.min(lever, upper);
  const next =
    input > 0
      ? Math.min(from + step, Math.max(from, upper))
      : Math.max(from + step, Math.min(from, lower));
  if (from * next < 0 || (from !== 0 && next === 0)) {
    fc.leverHold = Math.sign(input) * FLIGHT.leverNeutralHold;
    return 0;
  }
  return next;
}

function stepAssist(
  fc: FlightComputerState,
  body: RigidState,
  turbines: Quad<TurbineSim>,
  controls: FlightControls,
  axes: PilotAxes,
  sensors: FlightSensors,
  dt: number,
): void {
  readAttitude(body.quaternion, _att);
  const altitude = body.position.y;
  const support = finiteOr(sensors.supportForceY, 0);

  if (fc.mode === 'manual') {
    // Taking over from the pilot: start from where the ship is, not from stale set-points.
    controls.targetAltitude = altitude;
    controls.tiltLever =
      (turbines[0].tilt + turbines[1].tilt + turbines[2].tilt + turbines[3].tilt) / 4;
    resetHolds(fc, _att.heading);
    fc.leverHold = 0;
    fc.headingHold = false;
    fc.bankCommand = clamp(_att.roll, -FLIGHT.maxBank, FLIGHT.maxBank);
    fc.supportEstimate = support;
  } else if (fc.mode === 'fresh') {
    resetHolds(fc, _att.heading);
    fc.headingHold = true;
    fc.bankCommand = 0;
    fc.supportEstimate = support;
  }
  fc.mode = 'assist';

  // ---- pilot → set-points -------------------------------------------------------------------
  const collectiveInput = axis(axes.collective);
  let target = finiteOr(controls.targetAltitude, altitude);
  if (collectiveInput > 0) {
    target = Math.min(
      target + collectiveInput * FLIGHT.targetRate * dt,
      Math.max(target, altitude + FLIGHT.targetLead),
    );
  } else if (collectiveInput < 0) {
    target = Math.max(
      target + collectiveInput * FLIGHT.targetRate * dt,
      Math.min(target, altitude - FLIGHT.targetLead),
    );
  }
  target = clamp(target, FLOATING_ALTITUDE, FLIGHT.maxTargetAltitude);
  controls.targetAltitude = target;
  for (let i = 0; i < 4; i++) {
    controls.manualThrottle[i] = turbines[i].throttle;
    controls.manualTilt[i] = turbines[i].tilt;
  }

  // ---- what the turbines can do right now ---------------------------------------------------
  let enabledCount = 0;
  let factorSum = 0;
  let tiltSum = 0;
  let portForce = 0;
  let starboardForce = 0;
  for (let i = 0; i < 4; i++) {
    const t = turbines[i];
    const cosTilt = Math.cos(t.tilt);
    _factor[i] = PHYS.maxThrust * turbineThrustFactor(body, i) * cosTilt;
    _actual[i] = _factor[i] * t.throttle;
    _limit[i] = t.enabled ? _factor[i] : 0;
    factorSum += _factor[i] / cosTilt;
    if (t.enabled) {
      enabledCount++;
      tiltSum += t.tilt;
    }
    if (YAW_SIGN[i] > 0) portForce += _actual[i];
    else starboardForce += _actual[i];
  }
  const meanTilt = enabledCount > 0 ? tiltSum / enabledCount : 0;

  // The nacelles may only lean as far as the lift budget allows; on fewer than four engines
  // every bit of thrust is needed for lift.
  const hoverThrottle = WEIGHT / factorSum;
  const cosLimit = hoverThrottle / FLIGHT.tiltThrottleBudget;
  const tiltBudget = enabledCount === 4 && cosLimit < 1 ? Math.acos(cosLimit) : 0;
  controls.tiltLever = clamp(
    moveTiltLever(fc, finiteOr(controls.tiltLever, 0), axis(axes.tilt), tiltBudget, dt),
    PHYS.tiltMin,
    PHYS.tiltMax,
  );
  const tiltLimit = Math.max(0, tiltBudget - fc.tiltRelief);
  const tiltBase = clamp(
    clamp(controls.tiltLever, -tiltLimit, tiltLimit),
    PHYS.tiltMin,
    PHYS.tiltMax,
  );

  // ---- afloat with nowhere to go: engines idle ----------------------------------------------
  fc.idle = sensors.afloat && target <= FLOATING_ALTITUDE + IDLE_BAND;
  if (fc.idle) {
    for (let i = 0; i < 4; i++) {
      turbines[i].throttleCmd = 0;
      turbines[i].tiltCmd = tiltBase;
    }
    resetHolds(fc, _att.heading);
    fc.headingHold = true;
    fc.bankCommand = 0;
    fc.supportEstimate = support;
    fc.saturated = false;
    return;
  }

  // ---- altitude hold → collective -----------------------------------------------------------
  fc.supportEstimate += (support - fc.supportEstimate) * (1 - Math.exp(-SUPPORT_FILTER_RATE * dt));
  const altitudeError = target - altitude;
  const verticalSpeed = body.velocity.y;
  // The commanded speed changes as the ship moves along the approach profile; feeding that
  // rate forward lets the ship follow the profile instead of lagging behind it.
  approachProfile(altitudeError, finiteOr(sensors.keelClearance, Infinity));
  const accel = clamp(
    FLIGHT.verticalSpeedGain * (_profile.speed - verticalSpeed) -
      _profile.slope * verticalSpeed +
      fc.altitudeIntegral,
    -FLIGHT.verticalAccelLimit,
    FLIGHT.verticalAccelLimit,
  );
  const liftNeeded = PHYS.mass * (PHYS.gravity + accel) - fc.supportEstimate;
  const liftFactor = Math.max(MIN_LIFT_FACTOR, _att.upY + Math.tan(meanTilt) * _att.forwardY);
  let collective = Math.max(0, liftNeeded / liftFactor);
  if (!sensors.afloat) collective = Math.max(collective, FLIGHT.minCollective * WEIGHT);

  // ---- attitude hold → pitch / roll demands -------------------------------------------------
  _qInv.copy(body.quaternion).invert();
  _wBody.copy(body.angularVelocity).applyQuaternion(_qInv);
  const pitchRate = _wBody.x;
  const previousBank = fc.bankCommand;
  fc.bankCommand =
    previousBank +
    clamp(
      (axis(axes.strafe) * FLIGHT.maxBank - previousBank) * FLIGHT.bankResponse,
      -FLIGHT.bankRate,
      FLIGHT.bankRate,
    ) *
      dt;
  // follow the moving bank command with its own rate, so the roll neither lags nor overshoots
  const rollRate = -_wBody.z - (dt > 0 ? (fc.bankCommand - previousBank) / dt : 0);
  const pitchError = -_att.pitch;
  const rollError = wrapAngle(fc.bankCommand - _att.roll);
  const zeta2 = 2 * FLIGHT.attitudeDamping;
  const pitchAccel = clamp(
    FLIGHT.pitchFrequency * (FLIGHT.pitchFrequency * pitchError - zeta2 * pitchRate) +
      fc.pitchIntegral,
    -ATTITUDE_ACCEL_LIMIT,
    ATTITUDE_ACCEL_LIMIT,
  );
  const rollAccel = clamp(
    FLIGHT.rollFrequency * (FLIGHT.rollFrequency * rollError - zeta2 * rollRate) + fc.rollIntegral,
    -ATTITUDE_ACCEL_LIMIT,
    ATTITUDE_ACCEL_LIMIT,
  );
  const pitchDemand = (PHYS.inertia[0] * pitchAccel) / ARM_Z;
  const rollDemand = (-PHYS.inertia[2] * rollAccel) / ARM_X;

  // ---- thrust allocation and throttle commands ----------------------------------------------
  allocate(turbines, collective, pitchDemand, rollDemand);
  fc.saturated = _cut.attitude || _cut.climb || _cut.descent;
  for (let i = 0; i < 4; i++) {
    const t = turbines[i];
    const wanted = t.enabled && _factor[i] > 0 ? clamp01(_force[i] / _factor[i]) : 0;
    t.throttleCmd = clamp01(wanted + FLIGHT.throttleLead * (wanted - t.throttle));
  }

  // Lift before speed: while the fans cannot deliver the lift asked for, lean the nacelles back.
  if (_cut.climb && Math.abs(tiltBase) > 0) {
    fc.tiltRelief = Math.min(fc.tiltRelief + FLIGHT.tiltReliefRate * dt, tiltBudget);
  } else {
    fc.tiltRelief = Math.max(0, fc.tiltRelief - FLIGHT.tiltRecoverRate * dt);
  }

  // Trims only integrate while the fans can still follow them (anti-windup).
  if (!fc.saturated && Math.abs(altitudeError) < INTEGRAL_BAND) {
    fc.altitudeIntegral = clamp(
      fc.altitudeIntegral + FLIGHT.altitudeIntegralGain * altitudeError * dt,
      -FLIGHT.altitudeIntegralLimit,
      FLIGHT.altitudeIntegralLimit,
    );
  }
  if (!_cut.attitude) {
    fc.pitchIntegral = clamp(
      fc.pitchIntegral + FLIGHT.attitudeIntegralGain * pitchError * dt,
      -FLIGHT.attitudeIntegralLimit,
      FLIGHT.attitudeIntegralLimit,
    );
    fc.rollIntegral = clamp(
      fc.rollIntegral + FLIGHT.attitudeIntegralGain * rollError * dt,
      -FLIGHT.attitudeIntegralLimit,
      FLIGHT.attitudeIntegralLimit,
    );
  }

  // ---- yaw: rate command or heading hold → differential tilt --------------------------------
  const yawInput = axis(axes.yaw);
  const yawRate = -body.angularVelocity.y;
  let rateCommand = 0;
  if (Math.abs(yawInput) > AXIS_DEADBAND) {
    rateCommand = yawInput * FLIGHT.yawRateMax;
    fc.headingHold = false;
  } else if (!fc.headingHold && Math.abs(yawRate) < FLIGHT.headingCaptureRate) {
    fc.headingHold = true;
    fc.headingTarget = _att.heading;
  }
  if (fc.headingHold) {
    rateCommand = clamp(
      FLIGHT.headingGain * wrapAngle(fc.headingTarget - _att.heading),
      -FLIGHT.yawRateMax,
      FLIGHT.yawRateMax,
    );
  }
  const totalForce = portForce + starboardForce;
  let differential = 0;
  if (totalForce > YAW_MIN_THRUST * WEIGHT) {
    // rate loop, plus the moment that turning at the commanded rate costs against the air
    const yawMoment =
      PHYS.inertia[1] * FLIGHT.yawRateGain * (rateCommand - yawRate) +
      yawDampingCoefficient(altitude, body.velocity.length()) * rateCommand;
    const imbalance = ARM_X * (portForce - starboardForce) * Math.tan(tiltBase);
    const cosBase = Math.cos(tiltBase);
    differential = clamp(
      ((yawMoment - imbalance) * cosBase * cosBase) / (ARM_X * totalForce),
      -FLIGHT.yawTiltMax,
      FLIGHT.yawTiltMax,
    );
  }
  const spread = Math.abs(differential);
  const tiltCentre = clamp(tiltBase, PHYS.tiltMin + spread, PHYS.tiltMax - spread);
  for (let i = 0; i < 4; i++) {
    turbines[i].tiltCmd = tiltCentre + YAW_SIGN[i] * differential;
  }
}

function stepManual(
  fc: FlightComputerState,
  body: RigidState,
  turbines: Quad<TurbineSim>,
  controls: FlightControls,
  axes: PilotAxes,
  dt: number,
): void {
  if (fc.mode === 'assist') {
    // Taking over from the computer: the levers start exactly where the turbines are.
    for (let i = 0; i < 4; i++) {
      controls.manualThrottle[i] = turbines[i].throttle;
      controls.manualTilt[i] = turbines[i].tilt;
    }
  }
  fc.mode = 'manual';
  fc.idle = false;
  fc.saturated = false;

  const throttleStep = axis(axes.collective) * FLIGHT.manualThrottleRate * dt;
  const tiltStep = axis(axes.tilt) * FLIGHT.manualTiltRate * dt;
  const yawTilt = axis(axes.yaw) * FLIGHT.manualYawTilt;
  const strafeThrottle = axis(axes.strafe) * FLIGHT.manualStrafeThrottle;
  let tiltSum = 0;
  for (let i = 0; i < 4; i++) {
    const throttle = clamp01(finiteOr(controls.manualThrottle[i], 0) + throttleStep);
    const tilt = clamp(finiteOr(controls.manualTilt[i], 0) + tiltStep, PHYS.tiltMin, PHYS.tiltMax);
    controls.manualThrottle[i] = throttle;
    controls.manualTilt[i] = tilt;
    tiltSum += tilt;
    // port pair forward / up for a turn or a slide to starboard
    turbines[i].throttleCmd = clamp01(throttle + YAW_SIGN[i] * strafeThrottle);
    turbines[i].tiltCmd = clamp(tilt + YAW_SIGN[i] * yawTilt, PHYS.tiltMin, PHYS.tiltMax);
  }
  // keep the computer's set-points on the ship so handing back is smooth
  controls.targetAltitude = clamp(
    finiteOr(body.position.y, FLOATING_ALTITUDE),
    FLOATING_ALTITUDE,
    FLIGHT.maxTargetAltitude,
  );
  controls.tiltLever = tiltSum / 4;
}

/**
 * One control step: read the pilot axes and write `throttleCmd` / `tiltCmd` of every turbine
 * (and the control set-points in `controls`). Call before the actuators and the force model.
 */
export function stepFlightComputer(
  fc: FlightComputerState,
  body: RigidState,
  turbines: Quad<TurbineSim>,
  controls: FlightControls,
  axes: PilotAxes,
  sensors: FlightSensors,
  assist: boolean,
  dt: number,
): void {
  if (assist) stepAssist(fc, body, turbines, controls, axes, sensors, dt);
  else stepManual(fc, body, turbines, controls, axes, dt);
}
