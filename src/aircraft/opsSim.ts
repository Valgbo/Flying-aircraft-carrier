/**
 * FlightOpsSim — the air wing as pure logic (no React, no store, no global sim): a state
 * machine per jet that is stepped with the current ship state and writes world-space poses.
 *
 * Frames. Every jet keeps its position in SHIP-SHAPED LOCAL coordinates (x starboard, y up,
 * -z toward the bow, origin at the carrier origin) and is placed in the world through a
 * blend of two frames that share that origin:
 *   deck frame    — the ship's true attitude. Deck phases use it alone (coupling = 1), so a
 *                   jet stays glued to the deck however the ship pitches, rolls and turns.
 *   pattern frame — level, yawed to the low-passed ship heading. Airborne jets fly their
 *                   rails in it (coupling = 0), so the pattern follows the ship smoothly.
 * On final the coupling rises from 0 to 1 over the last kilometre: the jet ends up flying
 * relative to the deck itself and always arrives at the wire. After a launch or a wave-off
 * it fades back to 0.
 *
 * Deck traffic and recoveries share the landing area, so they are interlocked: no jet
 * leaves its spot while another is about to land or is taxiing back, landings are spaced by
 * a landing interval (jets extend downwind or fly another circuit), and a jet that finds
 * the landing area fouled at the ramp goes around.
 */
import { Euler, Quaternion, Vector3 } from 'three';
import { DECK } from '../config/layout';
import type { JetPhase, JetSim, MessageLevel, RecoveryResult } from '../state/types';
import { clamp, damp, moveToward, remap, smoothstep, wrapAngle } from '../utils/math';
import { parkPath, parkingPose, taxiInPath, taxiOutPath } from './deckRoutes';
import { CATAPULT_TRACKS, LaunchSystem, strokeAt, type StrokeState } from './LaunchSystem';
import { OPS } from './opsConfig';
import {
  PATTERN_Y,
  STRIP,
  approachTargetY,
  holdPatternPath,
  inLandingArea,
  joinPatternPath,
} from './pattern';
import { makePathSample, pathSpeedLimit, type RailPath } from './railPath';
import { RecoverySystem, arrestAt, rampDecision, type ArrestState } from './RecoverySystem';
import {
  deckMotionOf,
  makeDeckMotion,
  recoveryResult,
  smoothSteadiness,
  steadinessOf,
  type DeckMotion,
  type ShipState,
} from './steadiness';

export interface OpsHooks {
  /** A jet is hooked to catapult `catapult` (display number) and spooling up. */
  catapult?: (jetId: number, catapult: number) => void;
  /** A jet left the deck. */
  launch?: (jetId: number, catapult: number) => void;
  /** A jet caught a wire. */
  trap?: (result: RecoveryResult) => void;
  /** A jet abandoned its approach. */
  waveOff?: (jetId: number) => void;
  toast?: (text: string, level: MessageLevel) => void;
  shake?: (amount: number) => void;
}

/** Internal stage of a jet — finer than the public JetPhase. */
export type JetStage =
  | 'parked'
  | 'taxiOut'
  | 'spool'
  | 'stroke'
  | 'join'
  | 'hold'
  | 'approach'
  | 'arrest'
  | 'rolloutPause'
  | 'taxiIn'
  | 'parkReverse';

const GRAVITY = 9.81;
const SUBSTEP = 1 / 30;
const MAX_SUBSTEPS = 60;
const UP = new Vector3(0, 1, 0);
const HOLD_PATH = holdPatternPath();

function shipHeading(ship: ShipState): number {
  _forward.set(0, 0, -1).applyQuaternion(ship.quaternion);
  return Math.atan2(_forward.x, -_forward.z);
}

const _forward = new Vector3();
const _levelPos = new Vector3();
const _frameQuat = new Quaternion();
const _blendQuat = new Quaternion();
const _localQuat = new Quaternion();
const _euler = new Euler(0, 0, 0, 'YXZ');
const _sample = makePathSample();
const _lead = makePathSample();
const _stroke: StrokeState = { distance: 0, speed: 0 };
const _arrest: ArrestState = { distance: 0, speed: 0, done: false };

export class OpsJet {
  /** World-space pose and public state — the object that goes into `sim.jets`. */
  readonly out: JetSim;
  stage: JetStage = 'parked';
  /** Position in ship-shaped local coordinates (see the file header). */
  readonly local = new Vector3();
  /** Deck heading, rad: 0 = toward the bow, +π/2 = toward starboard. */
  heading = 0;
  /** Body pitch (nose up positive) and bank (starboard wing down positive), rad. */
  pitch = 0;
  bank = 0;
  /** Flight-path angle, rad. */
  gamma = 0;
  speed = 0;
  power = 0;
  gearDown = true;
  /** 1 = placed in the deck frame, 0 = in the level pattern frame. */
  coupling = 1;
  path: RailPath | null = null;
  /** Arc length travelled along `path`. */
  s = 0;
  /** Seconds in the current stage (where the stage needs a clock). */
  timer = 0;
  /** Index of the catapult assigned to this jet, or -1. */
  catapult = -1;
  /** The catapult shot is being held for an unsteady deck. */
  held = false;
  /** The join path was entered from a wave-off rather than from the catapult. */
  wavedOff = false;
  /** The call at the ramp has been made on this approach. */
  decided = false;
  onFinal = false;
  /** Speed at which the hook caught the wire. */
  entrySpeed = 0;

  constructor(
    readonly id: number,
    readonly spot: number,
  ) {
    this.out = {
      id,
      phase: 'parked',
      position: new Vector3(),
      quaternion: new Quaternion(),
      speed: 0,
      power: 0,
      gearDown: true,
    };
  }
}

export class FlightOpsSim {
  readonly jets: OpsJet[] = [];
  readonly launch = new LaunchSystem();
  readonly recovery = new RecoverySystem();
  active = false;
  /** Seconds simulated since the last reset. */
  time = 0;
  /** Smoothed deck steadiness 0..1. */
  steadiness = 1;
  readonly motion: DeckMotion = makeDeckMotion();
  score = 0;
  launches = 0;
  recoveries = 0;
  waveOffs = 0;
  status = '';
  lastRecovery: RecoveryResult | null = null;
  /** Bumped whenever something the HUD shows discretely changed (status, tallies, a phase). */
  revision = 0;

  private frameYaw = 0;
  private frameReady = false;

  constructor(private readonly hooks: OpsHooks = {}) {
    for (let i = 0; i < OPS.jetCount; i++) this.jets.push(new OpsJet(i + 1, i));
    this.reset(false);
  }

  /** Put all jets back on their spots and clear the score. */
  reset(active: boolean): void {
    this.active = active;
    this.time = 0;
    this.steadiness = 1;
    this.score = 0;
    this.launches = 0;
    this.recoveries = 0;
    this.waveOffs = 0;
    this.lastRecovery = null;
    this.frameReady = false;
    this.launch.reset();
    this.recovery.reset();
    for (const jet of this.jets) this.park(jet);
    this.status = active ? this.readyStatus() : '';
    this.revision++;
  }

  /**
   * The player's launch command. Returns false when it cannot be accepted (ops inactive, or
   * every jet on deck is already spoken for).
   */
  requestLaunch(): boolean {
    if (!this.active) return false;
    let parked = 0;
    for (const jet of this.jets) if (jet.stage === 'parked') parked++;
    if (parked - this.launch.pending <= 0) {
      this.hooks.toast?.('NO AIRCRAFT READY ON DECK', 'info');
      return false;
    }
    this.launch.pending++;
    this.dispatchLaunches();
    if (this.launch.pending > 0) this.setStatus('LAUNCH QUEUED — DECK BUSY');
    return true;
  }

  /**
   * Advance by `dt` simulated seconds (0 while paused: nothing moves, but the world poses are
   * refreshed from the ship pose) and write every jet's world pose.
   */
  step(dt: number, ship: ShipState): void {
    if (!this.frameReady) {
      this.frameYaw = shipHeading(ship);
      this.frameReady = true;
    }
    if (dt > 0) {
      const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / SUBSTEP - 1e-6)));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) this.advance(h, ship);
    }
    this.writeWorld(ship);
  }

  /** Number of jets that are not parked. */
  activeJets(): number {
    let n = 0;
    for (const jet of this.jets) if (jet.stage !== 'parked') n++;
    return n;
  }

  // ---- stepping ----------------------------------------------------------------------------

  private advance(h: number, ship: ShipState): void {
    this.time += h;
    const yawError = wrapAngle(shipHeading(ship) - this.frameYaw);
    this.frameYaw = wrapAngle(this.frameYaw + yawError * (1 - Math.exp(-h / OPS.frameHeadingTime)));
    this.steadiness = smoothSteadiness(
      this.steadiness,
      steadinessOf(deckMotionOf(ship, this.motion)),
      h,
    );
    if (!this.active) return;
    this.dispatchLaunches();
    for (const jet of this.jets) this.advanceJet(jet, h);
  }

  private advanceJet(jet: OpsJet, h: number): void {
    switch (jet.stage) {
      case 'parked':
        return;
      case 'taxiOut':
        jet.power = damp(jet.power, 0.22, 2, h);
        if (this.followDeckPath(jet, h, OPS.taxiSpeed, false)) this.hookUp(jet);
        return;
      case 'spool':
        this.advanceSpool(jet, h);
        return;
      case 'stroke':
        this.advanceStroke(jet, h);
        return;
      case 'join':
        this.advanceJoin(jet, h);
        return;
      case 'hold':
        jet.power = damp(jet.power, 0.55, 1.5, h);
        this.fly(jet, h, OPS.patternSpeed, false);
        if (jet.s >= HOLD_PATH.length) this.atDecisionPoint(jet);
        return;
      case 'approach':
        this.advanceApproach(jet, h);
        return;
      case 'arrest':
        this.advanceArrest(jet, h);
        return;
      case 'rolloutPause':
        jet.timer += h;
        jet.power = damp(jet.power, 0.2, 3, h);
        if (jet.timer >= OPS.rolloutPause && !this.anyInStage('taxiOut')) {
          jet.path = taxiInPath(jet.spot);
          jet.s = 0;
          jet.stage = 'taxiIn';
        }
        return;
      case 'taxiIn': {
        const path = jet.path!;
        const done = this.followDeckPath(jet, h, OPS.taxiSpeed, false);
        // clear of the strip once established on the taxi lane (the last straight)
        if (jet.s >= path.elements[path.elements.length - 1].s0) this.setPhase(jet, 'taxi');
        if (done) {
          jet.path = parkPath(jet.spot);
          jet.s = 0;
          jet.speed = 0;
          jet.stage = 'parkReverse';
          this.setPhase(jet, 'taxi');
        }
        return;
      }
      case 'parkReverse':
        jet.power = damp(jet.power, 0.12, 2, h);
        if (this.followDeckPath(jet, h, OPS.reverseSpeed, true)) {
          this.park(jet);
          this.setStatus(this.activeJets() === 0 ? this.readyStatus() : `JET ${jet.id} PARKED`);
        }
        return;
    }
  }

  // ---- launch ------------------------------------------------------------------------------

  /** Give waiting launch requests a jet and a catapult as soon as the deck allows. */
  private dispatchLaunches(): void {
    while (this.launch.pending > 0) {
      const jet = this.jets.find((j) => j.stage === 'parked');
      const catapult = this.launch.freeCatapult();
      if (!jet || catapult < 0 || !this.taxiOutClear()) return;
      this.launch.pending--;
      this.launch.assign(catapult, jet.id);
      jet.catapult = catapult;
      jet.path = taxiOutPath(jet.spot, catapult);
      jet.s = 0;
      jet.stage = 'taxiOut';
      this.setPhase(jet, 'taxi');
      this.setStatus(`JET ${jet.id} TAXIING TO CAT ${CATAPULT_TRACKS[catapult].id}`);
    }
  }

  /** May another jet leave its spot now? */
  private taxiOutClear(): boolean {
    for (const jet of this.jets) {
      switch (jet.stage) {
        case 'arrest':
        case 'rolloutPause':
        case 'taxiIn':
        case 'parkReverse':
          return false;
        case 'approach':
          if (jet.path!.length - jet.s < OPS.recoveryHoldDistance) return false;
          break;
        case 'taxiOut':
          if (jet.s < OPS.taxiSpacing) return false;
          break;
        default:
          break;
      }
    }
    return true;
  }

  private hookUp(jet: OpsJet): void {
    const track = CATAPULT_TRACKS[jet.catapult];
    jet.local.set(track.startX, DECK.y, track.startZ);
    jet.heading = track.heading;
    jet.speed = 0;
    jet.stage = 'spool';
    jet.timer = 0;
    jet.held = false;
    this.setPhase(jet, 'catapult');
    this.setStatus(`JET ${jet.id} ON CAT ${track.id} — SPOOLING`);
    this.hooks.catapult?.(jet.id, track.id);
  }

  private advanceSpool(jet: OpsJet, h: number): void {
    jet.timer += h;
    jet.power = damp(jet.power, 1, 2.2, h);
    if (jet.timer < OPS.spoolTime || !this.launch.intervalClear(this.time)) return;
    if (!this.launch.deckSteady(this.steadiness, jet.held)) {
      if (!jet.held) {
        jet.held = true;
        this.hooks.toast?.('DECK UNSTABLE — LAUNCH HELD', 'warn');
        this.setStatus(`CAT ${CATAPULT_TRACKS[jet.catapult].id} HELD — DECK UNSTABLE`);
      }
      return;
    }
    jet.held = false;
    jet.stage = 'stroke';
    jet.timer = 0;
    jet.power = 1;
    this.launch.fired(this.time);
    this.setPhase(jet, 'launch');
    this.setStatus(`JET ${jet.id} LAUNCHING — CAT ${CATAPULT_TRACKS[jet.catapult].id}`);
    this.hooks.shake?.(OPS.catapultShake);
  }

  private advanceStroke(jet: OpsJet, h: number): void {
    const track = CATAPULT_TRACKS[jet.catapult];
    jet.timer += h;
    strokeAt(track.length, jet.timer, _stroke);
    if (_stroke.distance < track.length) {
      jet.local.x = track.startX + track.dirX * _stroke.distance;
      jet.local.z = track.startZ + track.dirZ * _stroke.distance;
      jet.speed = _stroke.speed;
      return;
    }
    // off the end of the track: airborne, on the rail that joins the pattern
    jet.path = joinPatternPath(
      track.startX + track.dirX * track.length,
      track.startZ + track.dirZ * track.length,
      track.heading,
    );
    jet.s = _stroke.distance - track.length;
    jet.path.sample(jet.s, _sample);
    jet.local.set(_sample.x, DECK.y, _sample.z);
    jet.speed = OPS.catapultEndSpeed;
    jet.gamma = 0;
    jet.stage = 'join';
    jet.wavedOff = false;
    jet.timer = 0;
    this.launch.release(jet.catapult);
    const catapultId = track.id;
    jet.catapult = -1;
    this.launches++;
    this.score += OPS.launchPoints;
    this.setStatus(`JET ${jet.id} AIRBORNE`);
    this.revision++;
    this.hooks.launch?.(jet.id, catapultId);
  }

  // ---- flight ------------------------------------------------------------------------------

  /**
   * Fly one step along the jet's rail: speed toward `targetSpeed`, position and heading from
   * the path, bank from the turn ahead, height toward the pattern (or down the glide path on
   * an approach) through a rate-limited flight-path angle.
   */
  private fly(jet: OpsJet, h: number, targetSpeed: number, approach: boolean): void {
    const path = jet.path!;
    jet.speed =
      jet.speed < targetSpeed
        ? Math.min(targetSpeed, jet.speed + OPS.accel * h)
        : Math.max(targetSpeed, jet.speed - OPS.decel * h);
    jet.s += jet.speed * h;
    path.sample(jet.s, _sample);
    jet.local.x = _sample.x;
    jet.local.z = _sample.z;
    jet.heading = _sample.heading;

    path.sample(jet.s + jet.speed * OPS.bankLead, _lead);
    const bankTarget = clamp(
      Math.atan((jet.speed * jet.speed * _lead.curvature) / GRAVITY),
      -OPS.maxBank,
      OPS.maxBank,
    );
    jet.bank = moveToward(jet.bank, bankTarget, OPS.rollRate * h);

    const remaining = path.length - jet.s;
    const targetY = approach ? approachTargetY(remaining) : PATTERN_Y;
    const onGlidePath = approach && targetY < PATTERN_Y;
    const gammaCommand = clamp(
      (onGlidePath ? -OPS.glideSlope : 0) +
        (targetY - jet.local.y) / (Math.max(jet.speed, 1) * OPS.heightTime),
      -OPS.maxDescent,
      OPS.climbAngle,
    );
    jet.gamma = moveToward(jet.gamma, gammaCommand, OPS.gammaRate * h);
    jet.local.y += jet.speed * Math.sin(jet.gamma) * h;
    if (approach && remaining < OPS.captureFar) {
      // close in, pull the height onto the glide path exactly so the wheels meet the wire
      const rate = OPS.captureRate * (1 - smoothstep(OPS.captureNear, OPS.captureFar, remaining));
      jet.local.y += (targetY - jet.local.y) * (1 - Math.exp(-rate * h));
    }
    if (jet.local.y < DECK.y) jet.local.y = DECK.y;

    const alpha = remap(
      jet.speed,
      OPS.approachSpeed,
      OPS.patternSpeed,
      OPS.approachAlpha,
      OPS.cruiseAlpha,
    );
    jet.pitch = moveToward(jet.pitch, jet.gamma + alpha, OPS.pitchRate * h);
  }

  /** From the catapult (or a wave-off) up to pattern height and round to the decision point. */
  private advanceJoin(jet: OpsJet, h: number): void {
    const path = jet.path!;
    jet.timer += h;
    this.fly(jet, h, OPS.patternSpeed, false);
    jet.coupling = moveToward(jet.coupling, 0, OPS.couplingRate * h);
    if (jet.gearDown && jet.timer >= OPS.gearUpDelay) jet.gearDown = false;
    const level = PATTERN_Y - jet.local.y < 20;
    jet.power = damp(jet.power, level ? 0.55 : 1, 1.5, h);
    // in the pattern once level, or at the latest when the crosswind turn begins
    const established = level || jet.s >= path.elements[0].length;
    if (jet.out.phase !== 'pattern') {
      if (established) this.setPhase(jet, 'pattern');
      else if (jet.wavedOff) this.setPhase(jet, 'waveoff');
      else this.setPhase(jet, jet.timer < OPS.gearUpDelay ? 'launch' : 'climbout');
    }
    if (jet.s >= path.length) this.atDecisionPoint(jet);
  }

  /** End of the downwind leg: turn in for the approach if a landing slot is free, else go round. */
  private atDecisionPoint(jet: OpsJet): void {
    const overshoot = Math.max(0, jet.s - jet.path!.length);
    const plan = this.recovery.plan(this.time);
    jet.wavedOff = false;
    jet.s = overshoot;
    if (!plan) {
      jet.path = HOLD_PATH;
      jet.stage = 'hold';
      this.setPhase(jet, 'pattern');
      return;
    }
    jet.path = plan.path;
    jet.stage = 'approach';
    jet.timer = 0;
    jet.decided = false;
    jet.onFinal = false;
    this.setPhase(jet, 'approach');
    this.setStatus(`JET ${jet.id} INBOUND`);
  }

  // ---- recovery ----------------------------------------------------------------------------

  private advanceApproach(jet: OpsJet, h: number): void {
    const path = jet.path!;
    jet.timer += h;
    this.fly(jet, h, OPS.approachSpeed, true);
    jet.power = damp(jet.power, 0.4, 1.5, h);
    if (!jet.gearDown && jet.timer >= OPS.gearDownDelay) jet.gearDown = true;
    const remaining = path.length - jet.s;
    const couplingTarget = 1 - smoothstep(OPS.couplingNear, OPS.couplingFar, remaining);
    jet.coupling = moveToward(jet.coupling, couplingTarget, OPS.couplingRate * h);

    if (!jet.onFinal && jet.s >= path.elements[path.elements.length - 1].s0) {
      jet.onFinal = true;
      this.setStatus(`JET ${jet.id} ON FINAL`);
    }
    if (!jet.decided && remaining <= STRIP.rampDistance) {
      jet.decided = true;
      const fouled = this.landingAreaFouled(jet);
      if (rampDecision(this.steadiness, fouled) === 'waveoff') {
        this.waveOff(jet, fouled);
        return;
      }
    }
    if (remaining <= 0) this.touchDown(jet);
  }

  /** Is another jet standing or rolling in the landing area? */
  private landingAreaFouled(lander: OpsJet): boolean {
    for (const jet of this.jets) {
      if (jet === lander) continue;
      switch (jet.stage) {
        case 'arrest':
        case 'rolloutPause':
          return true;
        case 'taxiOut':
        case 'taxiIn':
        case 'parkReverse':
          if (inLandingArea(jet.local.x, jet.local.z)) return true;
          break;
        default:
          break;
      }
    }
    return false;
  }

  private waveOff(jet: OpsJet, fouled: boolean): void {
    jet.path = joinPatternPath(jet.local.x, jet.local.z, STRIP.heading);
    jet.s = 0;
    jet.stage = 'join';
    jet.wavedOff = true;
    jet.timer = 0;
    this.waveOffs++;
    this.lastRecovery = recoveryResult(jet.id, this.steadiness, this.motion, false);
    this.launch.hold(this.time + OPS.waveOffLaunchHold);
    this.setPhase(jet, 'waveoff');
    const text = `JET ${jet.id} WAVE-OFF — ${fouled ? 'FOUL DECK' : 'DECK UNSTABLE'}`;
    this.setStatus(text);
    this.revision++;
    this.hooks.toast?.(text, 'warn');
    this.hooks.waveOff?.(jet.id);
  }

  private touchDown(jet: OpsJet): void {
    jet.local.set(STRIP.touchdownX, DECK.y, STRIP.touchdownZ);
    jet.heading = STRIP.heading;
    jet.gamma = 0;
    jet.bank = 0;
    jet.coupling = 1;
    jet.gearDown = true;
    jet.entrySpeed = jet.speed;
    jet.stage = 'arrest';
    jet.timer = 0;
    const result = recoveryResult(jet.id, this.steadiness, this.motion, true);
    this.lastRecovery = result;
    this.recoveries++;
    this.score += result.points;
    this.setPhase(jet, 'trap');
    const text = `JET ${jet.id} TRAPPED — ${result.grade} +${result.points}`;
    this.setStatus(text);
    this.revision++;
    this.hooks.toast?.(text, 'info');
    this.hooks.shake?.(OPS.trapShake);
    this.hooks.trap?.(result);
  }

  private advanceArrest(jet: OpsJet, h: number): void {
    jet.timer += h;
    arrestAt(jet.entrySpeed, jet.timer, _arrest);
    jet.local.x = STRIP.touchdownX + STRIP.dirX * _arrest.distance;
    jet.local.z = STRIP.touchdownZ + STRIP.dirZ * _arrest.distance;
    jet.speed = _arrest.speed;
    // the nose comes down onto its wheel; full power for a moment in case the hook skips
    jet.pitch = moveToward(jet.pitch, 0, 0.45 * h);
    jet.power = damp(jet.power, jet.timer < 0.6 ? 1 : 0.15, 5, h);
    if (_arrest.done) {
      jet.pitch = 0;
      jet.stage = 'rolloutPause';
      jet.timer = 0;
      this.setPhase(jet, 'rollout');
    }
  }

  // ---- deck movement -----------------------------------------------------------------------

  /** Taxi one step along the jet's deck path; true when it has reached the end. */
  private followDeckPath(jet: OpsJet, h: number, cruise: number, reverse: boolean): boolean {
    const path = jet.path!;
    // never slower than a creep, so the square-root braking curve ends in finite time
    const limit = Math.max(
      0.4,
      pathSpeedLimit(path, jet.s, cruise, OPS.taxiTurnRate, OPS.taxiBrake),
    );
    jet.speed =
      jet.speed < limit
        ? Math.min(limit, jet.speed + OPS.taxiAccel * h)
        : Math.max(limit, jet.speed - OPS.taxiBrake * h);
    jet.s = Math.min(path.length, jet.s + jet.speed * h);
    path.sample(jet.s, _sample);
    jet.local.set(_sample.x, DECK.y, _sample.z);
    jet.heading = reverse ? wrapAngle(_sample.heading + Math.PI) : _sample.heading;
    return jet.s >= path.length - 1e-3;
  }

  private park(jet: OpsJet): void {
    const pose = parkingPose(jet.spot);
    jet.local.set(pose.x, DECK.y, pose.z);
    jet.heading = pose.heading;
    jet.pitch = 0;
    jet.bank = 0;
    jet.gamma = 0;
    jet.speed = 0;
    jet.power = 0;
    jet.gearDown = true;
    jet.coupling = 1;
    jet.path = null;
    jet.s = 0;
    jet.timer = 0;
    jet.catapult = -1;
    jet.held = false;
    jet.wavedOff = false;
    jet.decided = false;
    jet.onFinal = false;
    jet.stage = 'parked';
    this.setPhase(jet, 'parked');
  }

  // ---- helpers -----------------------------------------------------------------------------

  private anyInStage(stage: JetStage): boolean {
    for (const jet of this.jets) if (jet.stage === stage) return true;
    return false;
  }

  private readyStatus(): string {
    return `CAT ${CATAPULT_TRACKS[0].id} READY`;
  }

  private setPhase(jet: OpsJet, phase: JetPhase): void {
    if (jet.out.phase === phase) return;
    jet.out.phase = phase;
    this.revision++;
  }

  private setStatus(status: string): void {
    if (this.status === status) return;
    this.status = status;
    this.revision++;
  }

  /** Local state → world pose, through the deck frame, the pattern frame or a blend of both. */
  private writeWorld(ship: ShipState): void {
    _frameQuat.setFromAxisAngle(UP, -this.frameYaw);
    for (const jet of this.jets) {
      const out = jet.out;
      _euler.set(jet.pitch, -jet.heading, -jet.bank);
      _localQuat.setFromEuler(_euler);
      out.position.copy(jet.local).applyQuaternion(ship.quaternion);
      if (jet.coupling < 1) {
        _levelPos.copy(jet.local).applyQuaternion(_frameQuat);
        out.position.lerpVectors(_levelPos, out.position, jet.coupling);
        _blendQuat.copy(_frameQuat).slerp(ship.quaternion, jet.coupling);
      } else {
        _blendQuat.copy(ship.quaternion);
      }
      out.position.add(ship.position);
      out.quaternion.copy(_blendQuat).multiply(_localQuat);
      out.speed = jet.speed;
      out.power = jet.power;
      out.gearDown = jet.gearDown;
    }
  }
}
