import { Euler, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  ARREST_STOP_DISTANCE,
  parkPath,
  parkingPose,
  taxiInPath,
  taxiOutPath,
} from '../../src/aircraft/deckRoutes';
import {
  CATAPULT_TRACKS,
  LaunchSystem,
  strokeAcceleration,
  strokeAt,
  strokeDuration,
} from '../../src/aircraft/LaunchSystem';
import { JET_DIMS, OPS } from '../../src/aircraft/opsConfig';
import { FlightOpsSim, type OpsHooks } from '../../src/aircraft/opsSim';
import {
  DECISION_POINT,
  PATTERN_Y,
  STRIP,
  approachLinePoint,
  approachPath,
  approachTargetY,
  holdPatternPath,
  inLandingArea,
  joinPatternPath,
  stripPoint,
} from '../../src/aircraft/pattern';
import {
  buildPath,
  makePathSample,
  pathSpeedLimit,
  type RailPath,
} from '../../src/aircraft/railPath';
import {
  RecoverySystem,
  arrestAt,
  arrestDeceleration,
  rampDecision,
} from '../../src/aircraft/RecoverySystem';
import {
  deckMotionOf,
  makeDeckMotion,
  recoveryGrade,
  recoveryPoints,
  shipSteadiness,
  smoothSteadiness,
  steadinessOf,
  type ShipState,
} from '../../src/aircraft/steadiness';
import {
  CATAPULTS,
  DECK,
  ELEVATOR,
  ISLAND,
  LANDING_STRIP,
  PARKING_SPOTS,
} from '../../src/config/layout';
import type { JetPhase, RecoveryResult } from '../../src/state/types';
import { DEG2RAD, RAD2DEG, wrapAngle } from '../../src/utils/math';

const DT = 1 / 60;

interface ShipOptions {
  headingDeg?: number;
  pitch?: number;
  roll?: number;
  position?: [number, number, number];
  verticalSpeed?: number;
  gLoad?: number;
  angularVelocity?: [number, number, number];
}

const _euler = new Euler(0, 0, 0, 'YXZ');

function setShip(ship: ShipState, o: ShipOptions): ShipState {
  const heading = (o.headingDeg ?? 0) * DEG2RAD;
  ship.pitch = o.pitch ?? 0;
  ship.roll = o.roll ?? 0;
  ship.quaternion.setFromEuler(_euler.set(ship.pitch, -heading, -ship.roll));
  if (o.position) ship.position.set(...o.position);
  ship.verticalSpeed = o.verticalSpeed ?? 0;
  ship.gLoad = o.gLoad ?? 1;
  ship.angularVelocity.set(...(o.angularVelocity ?? [0, 0, 0]));
  return ship;
}

function makeShip(o: ShipOptions = {}): ShipState {
  return setShip(
    {
      position: new Vector3(0, 600, 0),
      quaternion: new Quaternion(),
      angularVelocity: new Vector3(),
      pitch: 0,
      roll: 0,
      verticalSpeed: 0,
      gLoad: 1,
    },
    o,
  );
}

/** World point → carrier-local point for a test ship. */
function toLocal(ship: ShipState, world: Vector3): Vector3 {
  return world.clone().sub(ship.position).applyQuaternion(ship.quaternion.clone().invert());
}

interface Recorder {
  hooks: OpsHooks;
  events: string[];
  toasts: string[];
  traps: RecoveryResult[];
  shakes: number[];
}

function recorder(): Recorder {
  const r: Recorder = { hooks: {}, events: [], toasts: [], traps: [], shakes: [] };
  r.hooks = {
    catapult: (id, cat) => r.events.push(`catapult ${id} ${cat}`),
    launch: (id, cat) => r.events.push(`launch ${id} ${cat}`),
    trap: (result) => {
      r.events.push(`trap ${result.jetId}`);
      r.traps.push(result);
    },
    waveOff: (id) => r.events.push(`waveoff ${id}`),
    toast: (text) => r.toasts.push(text),
    shake: (amount) => r.shakes.push(amount),
  };
  return r;
}

function expectFinite(ops: FlightOpsSim): void {
  for (const jet of ops.jets) {
    const { position: p, quaternion: q } = jet.out;
    const sum = p.x + p.y + p.z + q.x + q.y + q.z + q.w + jet.out.speed + jet.out.power;
    if (!Number.isFinite(sum)) throw new Error(`jet ${jet.id} is not finite in ${jet.stage}`);
  }
}

function pointInPolygon(x: number, z: number, polygon: readonly (readonly number[])[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function samplePath(path: RailPath, step: number) {
  const out = [];
  for (let s = 0; s <= path.length; s += step) out.push({ s, ...path.sample(s, makePathSample()) });
  out.push({ s: path.length, ...path.sample(path.length, makePathSample()) });
  return out;
}

describe('deck steadiness', () => {
  it('is 1 for a level, still deck and lower for any disturbance', () => {
    expect(shipSteadiness(makeShip())).toBe(1);
    const level = shipSteadiness(makeShip({ headingDeg: 135, position: [900, 1500, -400] }));
    expect(level).toBeCloseTo(1, 9);
    expect(shipSteadiness(makeShip({ roll: 2 * DEG2RAD }))).toBeLessThan(0.75);
    expect(shipSteadiness(makeShip({ pitch: -2 * DEG2RAD }))).toBeLessThan(0.75);
    expect(shipSteadiness(makeShip({ verticalSpeed: -3 }))).toBeLessThan(0.6);
    expect(shipSteadiness(makeShip({ gLoad: 1.2 }))).toBeLessThan(0.6);
    expect(shipSteadiness(makeShip({ angularVelocity: [0, 3 * DEG2RAD, 0] }))).toBeLessThan(0.6);
    expect(shipSteadiness(makeShip({ angularVelocity: [0.05, 0, 0.05] }))).toBeLessThan(0.3);
    expect(shipSteadiness(makeShip({ roll: 8 * DEG2RAD }))).toBe(0);
  });

  it('falls monotonically with tilt, heave and their combination', () => {
    let previous = 1.0001;
    for (let deg = 0; deg <= 7; deg += 0.25) {
      const value = shipSteadiness(makeShip({ roll: deg * DEG2RAD, pitch: deg * 0.3 * DEG2RAD }));
      expect(value).toBeLessThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(0);
      previous = value;
    }
    previous = 1.0001;
    for (let heave = 0; heave <= 8; heave += 0.5) {
      const value = shipSteadiness(makeShip({ verticalSpeed: heave, roll: 0.01 }));
      expect(value).toBeLessThan(previous);
      previous = Math.max(value, 1e-9);
    }
    const motion = deckMotionOf(makeShip({ roll: 0.03, pitch: 0.04 }), makeDeckMotion());
    expect(motion.tilt).toBeCloseTo(0.05, 3);
    expect(steadinessOf(motion)).toBeCloseTo(1 - motion.tilt / OPS.tiltLimit, 6);
  });

  it('is smoothed over about one second', () => {
    let s = 1;
    for (let i = 0; i < 60; i++) s = smoothSteadiness(s, 0, DT);
    expect(s).toBeGreaterThan(0.25);
    expect(s).toBeLessThan(0.45);
    for (let i = 0; i < 600; i++) s = smoothSteadiness(s, 0, DT);
    expect(s).toBeLessThan(0.001);
    expect(smoothSteadiness(0.5, 0.9, 0)).toBe(0.5);
  });
});

describe('scoring', () => {
  it('awards 100..1000 points rising with steadiness', () => {
    expect(recoveryPoints(0)).toBe(100);
    expect(recoveryPoints(1)).toBe(1000);
    expect(recoveryPoints(2)).toBe(1000);
    expect(recoveryPoints(0.5)).toBe(550);
    let previous = 0;
    for (let s = 0; s <= 1; s += 0.05) {
      const points = recoveryPoints(s);
      expect(points).toBeGreaterThanOrEqual(previous);
      expect(points % 10).toBe(0);
      previous = points;
    }
  });

  it('grades PERFECT / GOOD / FAIR / ROUGH', () => {
    expect(recoveryGrade(1)).toBe('PERFECT');
    expect(recoveryGrade(OPS.gradePerfect)).toBe('PERFECT');
    expect(recoveryGrade(0.8)).toBe('GOOD');
    expect(recoveryGrade(0.6)).toBe('FAIR');
    expect(recoveryGrade(0.45)).toBe('ROUGH');
    expect(rampDecision(0.45, false)).toBe('trap');
    expect(rampDecision(OPS.minSteadiness - 0.01, false)).toBe('waveoff');
    expect(rampDecision(1, true)).toBe('waveoff');
  });
});

describe('catapult and arrestment kinematics', () => {
  it('reaches the end speed exactly at the end of the track at about 2.8 g', () => {
    for (const track of CATAPULT_TRACKS) {
      expect(track.length).toBeCloseTo(102, 6);
      expect(track.heading).toBeCloseTo(0, 9);
      const duration = strokeDuration(track.length);
      const end = strokeAt(track.length, duration, { distance: 0, speed: 0 });
      expect(end.distance).toBeCloseTo(track.length, 6);
      expect(end.speed).toBeCloseTo(OPS.catapultEndSpeed, 6);
      expect(duration).toBeGreaterThan(2.5);
      expect(duration).toBeLessThan(3);
      const g = strokeAcceleration(track.length) / 9.81;
      expect(g).toBeGreaterThan(2.6);
      expect(g).toBeLessThan(3);
      const half = strokeAt(track.length, duration / 2, { distance: 0, speed: 0 });
      expect(half.distance).toBeCloseTo(track.length / 4, 6);
    }
  });

  it('stops an arrested jet within the arrest distance', () => {
    const v0 = OPS.approachSpeed;
    const a = arrestDeceleration(v0);
    const state = { distance: 0, speed: 0, done: false };
    arrestAt(v0, 0, state);
    expect(state.distance).toBe(0);
    expect(state.speed).toBe(v0);
    let previous = 0;
    for (let t = 0; t < v0 / a; t += 0.1) {
      arrestAt(v0, t, state);
      expect(state.distance).toBeGreaterThanOrEqual(previous);
      expect(state.done).toBe(false);
      previous = state.distance;
    }
    arrestAt(v0, v0 / a + 0.01, state);
    expect(state.done).toBe(true);
    expect(state.speed).toBe(0);
    expect(state.distance).toBeCloseTo(OPS.arrestDistance, 6);
    expect(a / 9.81).toBeLessThan(3.5);
  });

  it('tracks catapult occupancy, the launch interval and holds', () => {
    const launch = new LaunchSystem();
    expect(launch.freeCatapult()).toBe(0);
    launch.assign(0, 3);
    expect(launch.freeCatapult()).toBe(1);
    launch.assign(1, 4);
    expect(launch.freeCatapult()).toBe(-1);
    launch.release(0);
    expect(launch.freeCatapult()).toBe(0);
    expect(launch.intervalClear(10)).toBe(true);
    launch.fired(10);
    expect(launch.intervalClear(10 + OPS.launchInterval - 0.1)).toBe(false);
    expect(launch.intervalClear(10 + OPS.launchInterval)).toBe(true);
    launch.hold(40);
    expect(launch.intervalClear(39)).toBe(false);
    expect(launch.deckSteady(OPS.minSteadiness, false)).toBe(true);
    expect(launch.deckSteady(OPS.minSteadiness, true)).toBe(false);
    launch.reset();
    expect(launch.freeCatapult()).toBe(0);
    expect(launch.intervalClear(0)).toBe(true);
  });
});

describe('rail paths and taxi routes', () => {
  it('rounds corners with continuous position and heading', () => {
    const path = buildPath(
      [
        [0, 0],
        [0, -50],
        [40, -50],
        [40, 20],
      ],
      10,
    );
    expect(path.length).toBeCloseTo(50 + 40 + 70 - 4 * 10 + Math.PI * 10, 6);
    const samples = samplePath(path, 0.05);
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThanOrEqual(b.s - a.s + 1e-9);
      expect(Math.abs(wrapAngle(b.heading - a.heading))).toBeLessThan(0.006);
    }
    const end = samples[samples.length - 1];
    expect(end.x).toBeCloseTo(40, 6);
    expect(end.z).toBeCloseTo(20, 6);
    expect(end.heading).toBeCloseTo(Math.PI, 6);
    // both turns are to starboard
    expect(path.sample(45, makePathSample()).curvature).toBeCloseTo(0.1, 9);
    // beyond the end the path continues straight
    const beyond = path.sample(path.length + 5, makePathSample());
    expect(beyond.z).toBeCloseTo(25, 6);
    // an oversized radius is reduced to fit
    const tight = buildPath(
      [
        [0, 0],
        [0, -4],
        [4, -4],
      ],
      50,
    );
    expect(tight.elements.some((e) => e.radius > 0 && e.radius <= 4 + 1e-9)).toBe(true);
  });

  it('limits taxi speed for the turns ahead and stops at the end', () => {
    const path = taxiOutPath(3, 0);
    expect(pathSpeedLimit(path, path.length, OPS.taxiSpeed, OPS.taxiTurnRate, OPS.taxiBrake)).toBe(
      0,
    );
    for (const e of path.elements) {
      if (e.radius === 0) continue;
      const inTurn = pathSpeedLimit(path, e.s0 + 0.1, 99, OPS.taxiTurnRate, OPS.taxiBrake);
      expect(inTurn).toBeLessThanOrEqual(OPS.taxiTurnRate * e.radius + 1e-9);
    }
    const mid = path.elements.find((e) => e.radius === 0 && e.length > 40)!;
    expect(
      pathSpeedLimit(path, mid.s0 + mid.length / 2, OPS.taxiSpeed, OPS.taxiTurnRate, OPS.taxiBrake),
    ).toBe(OPS.taxiSpeed);
  });

  const obstacleFree = (x: number, z: number, self: number): void => {
    const wing = JET_DIMS.halfSpan;
    expect(pointInPolygon(x, z, DECK.outline)).toBe(true);
    const islandMinX = ISLAND.centerX - ISLAND.width / 2;
    const inIsland =
      x + wing > islandMinX &&
      z > ISLAND.centerZ - ISLAND.length / 2 - wing &&
      z < ISLAND.centerZ + ISLAND.length / 2 + wing;
    expect(inIsland).toBe(false);
    const inElevator =
      x + wing > ELEVATOR.minX && z > ELEVATOR.minZ - wing && z < ELEVATOR.maxZ + wing;
    expect(inElevator).toBe(false);
    PARKING_SPOTS.forEach((spot, i) => {
      if (i === self) return;
      const d = Math.hypot(x - spot.position[0], z - spot.position[2]);
      expect(d).toBeGreaterThan(JET_DIMS.nose + wing);
    });
  };

  it('taxis from every spot to every catapult clear of the island, elevator and parked jets', () => {
    for (let spot = 0; spot < PARKING_SPOTS.length; spot++) {
      for (let cat = 0; cat < CATAPULTS.length; cat++) {
        const path = taxiOutPath(spot, cat);
        const samples = samplePath(path, 0.5);
        const pose = parkingPose(spot);
        expect(samples[0].x).toBeCloseTo(pose.x, 6);
        expect(samples[0].z).toBeCloseTo(pose.z, 6);
        expect(samples[0].heading).toBeCloseTo(PARKING_SPOTS[spot].headingDeg * DEG2RAD, 6);
        const end = samples[samples.length - 1];
        expect(end.x).toBeCloseTo(CATAPULTS[cat].start[0], 6);
        expect(end.z).toBeCloseTo(CATAPULTS[cat].start[2], 6);
        expect(end.heading).toBeCloseTo(0, 6);
        // lined up on the catapult centreline before the shuttle
        const aligned = path.sample(path.length - 8, makePathSample());
        expect(aligned.x).toBeCloseTo(CATAPULTS[cat].start[0], 6);
        for (const p of samples) obstacleFree(p.x, p.z, spot);
        for (const e of path.elements) if (e.radius > 0) expect(e.radius).toBeGreaterThan(7);
      }
    }
  });

  it('taxis back from the arrestment and backs into the own spot', () => {
    const stop = stripPoint(ARREST_STOP_DISTANCE);
    for (let spot = 0; spot < PARKING_SPOTS.length; spot++) {
      const inbound = taxiInPath(spot);
      const samples = samplePath(inbound, 0.5);
      expect(samples[0].x).toBeCloseTo(stop[0], 6);
      expect(samples[0].z).toBeCloseTo(stop[1], 6);
      expect(samples[0].heading).toBeCloseTo(STRIP.heading, 6);
      for (const p of samples) obstacleFree(p.x, p.z, -1);
      const laneEnd = samples[samples.length - 1];
      expect(laneEnd.x).toBeCloseTo(OPS.laneX, 6);
      expect(Math.abs(wrapAngle(laneEnd.heading - Math.PI))).toBeLessThan(1e-6);

      const park = parkPath(spot);
      const first = park.sample(0, makePathSample());
      const last = park.sample(park.length, makePathSample());
      expect(first.x).toBeCloseTo(laneEnd.x, 6);
      expect(first.z).toBeCloseTo(laneEnd.z, 6);
      // driven tail first: the jet's heading is the path tangent turned by 180°
      expect(Math.abs(wrapAngle(first.heading + Math.PI - laneEnd.heading))).toBeLessThan(1e-6);
      const pose = parkingPose(spot);
      expect(last.x).toBeCloseTo(pose.x, 6);
      expect(last.z).toBeCloseTo(pose.z, 6);
      expect(Math.abs(wrapAngle(last.heading + Math.PI - pose.heading))).toBeLessThan(1e-6);
      for (const p of samplePath(park, 0.5)) obstacleFree(p.x, p.z, spot);
    }
  });

  it('knows the landing area', () => {
    expect(inLandingArea(STRIP.touchdownX, STRIP.touchdownZ)).toBe(true);
    const stop = stripPoint(ARREST_STOP_DISTANCE);
    expect(inLandingArea(stop[0], stop[1])).toBe(true);
    for (const spot of PARKING_SPOTS) {
      expect(inLandingArea(spot.position[0], spot.position[2])).toBe(false);
    }
    for (const cat of CATAPULTS) expect(inLandingArea(cat.start[0], cat.start[2])).toBe(false);
    expect(inLandingArea(OPS.laneX, 20)).toBe(false);
  });
});

describe('pattern and approach geometry (ship frame)', () => {
  it('puts the touchdown point on the target wire and the approach line along the strip', () => {
    const [tx, , tz] = LANDING_STRIP.threshold;
    const [ex, , ez] = LANDING_STRIP.end;
    const wire = LANDING_STRIP.wireDistances[LANDING_STRIP.targetWire];
    expect(Math.hypot(STRIP.touchdownX - tx, STRIP.touchdownZ - tz)).toBeCloseTo(wire, 6);
    expect(STRIP.heading * RAD2DEG).toBeCloseTo(-8.81, 1);
    expect(STRIP.rampDistance).toBeGreaterThan(wire);
    expect(STRIP.rampDistance).toBeLessThan(wire + 15);
    // every point of the approach line is collinear with the strip, astern of the touchdown
    const stripLength = Math.hypot(ex - tx, ez - tz);
    for (const d of [0, 100, 800, 3000]) {
      const [x, z] = approachLinePoint(d);
      const cross = ((x - tx) * (ez - tz) - (z - tz) * (ex - tx)) / stripLength;
      expect(cross).toBeCloseTo(0, 6);
      const along = ((x - tx) * (ex - tx) + (z - tz) * (ez - tz)) / stripLength;
      expect(along).toBeCloseTo(wire - d, 6);
    }
    expect(approachLinePoint(0)).toEqual([STRIP.touchdownX, STRIP.touchdownZ]);
  });

  it('flies a 3.5° glide path to the deck from pattern height', () => {
    expect(approachTargetY(0)).toBe(DECK.y);
    const slope = (approachTargetY(1000) - approachTargetY(0)) / 1000;
    expect(Math.atan(slope) * RAD2DEG).toBeCloseTo(3.5, 6);
    expect(approachTargetY(20000)).toBe(PATTERN_Y);
    expect(PATTERN_Y - DECK.y).toBe(250);
  });

  it('approaches through a left-hand base turn onto a straight final ending at the wire', () => {
    for (const extension of [0, 800, OPS.maxDownwindExtension]) {
      const path = approachPath(extension);
      const start = path.sample(0, makePathSample());
      expect(start.x).toBeCloseTo(DECISION_POINT[0], 6);
      expect(start.z).toBeCloseTo(DECISION_POINT[1], 6);
      expect(Math.abs(wrapAngle(start.heading - Math.PI))).toBeLessThan(1e-9);
      const end = path.sample(path.length, makePathSample());
      expect(end.x).toBeCloseTo(STRIP.touchdownX, 6);
      expect(end.z).toBeCloseTo(STRIP.touchdownZ, 6);
      expect(end.heading).toBeCloseTo(STRIP.heading, 9);
      const arcs = path.elements.filter((e) => e.radius > 0);
      expect(arcs.length).toBe(2);
      for (const arc of arcs) {
        expect(arc.turn).toBe(-1);
        const bank = Math.atan((OPS.patternSpeed ** 2 / arc.radius) / 9.81);
        expect(bank).toBeLessThan(OPS.maxBank);
      }
      const final = path.elements[path.elements.length - 1];
      expect(final.radius).toBe(0);
      expect(final.length).toBeGreaterThan(OPS.finalLength - 1);
      // the whole final lies on the approach line
      for (let s = final.s0; s <= path.length; s += 100) {
        const p = path.sample(s, makePathSample());
        const [lx, lz] = approachLinePoint(path.length - s);
        expect(Math.hypot(p.x - lx, p.z - lz)).toBeLessThan(1e-6);
      }
      if (extension === 0) expect(final.length).toBeCloseTo(OPS.finalLength, 4);
    }
    expect(approachPath(800).length).toBeGreaterThan(approachPath(0).length + 1600);
  });

  it('joins a downwind leg 1.5 km abeam to port from the catapults and from a wave-off', () => {
    const starts: [number, number, number][] = [
      [CATAPULTS[0].end[0], CATAPULTS[0].end[2], 0],
      [CATAPULTS[1].end[0], CATAPULTS[1].end[2], 0],
      [...approachLinePoint(STRIP.rampDistance), STRIP.heading],
    ];
    for (const [x, z, heading] of starts) {
      const path = joinPatternPath(x, z, heading);
      const first = path.sample(0, makePathSample());
      expect(first.x).toBeCloseTo(x, 6);
      expect(first.z).toBeCloseTo(z, 6);
      expect(first.heading).toBeCloseTo(heading, 9);
      const end = path.sample(path.length, makePathSample());
      expect(end.x).toBeCloseTo(DECISION_POINT[0], 6);
      expect(end.z).toBeCloseTo(DECISION_POINT[1], 6);
      const downwind = path.elements[path.elements.length - 1];
      expect(downwind.x).toBeCloseTo(-OPS.abeamDistance, 6);
      expect(Math.abs(wrapAngle(downwind.heading - Math.PI))).toBeLessThan(1e-9);
      expect(downwind.length).toBeGreaterThan(1500);
      for (const arc of path.elements.filter((e) => e.radius > 0)) {
        expect(arc.turn).toBe(-1);
        expect(arc.radius).toBeGreaterThan(560);
      }
      // the upwind leg leaves well ahead of the bow
      expect(path.elements[0].length).toBeGreaterThan(700);
    }
    const hold = holdPatternPath();
    const a = hold.sample(0, makePathSample());
    const b = hold.sample(hold.length, makePathSample());
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1e-6);
    expect(Math.abs(wrapAngle(a.heading - b.heading))).toBeLessThan(1e-9);
    expect(hold.elements.filter((e) => e.radius > 0).every((e) => e.turn === -1)).toBe(true);
  });

  it('spaces landings by the landing interval, extending downwind or going round', () => {
    const recovery = new RecoverySystem();
    const first = recovery.plan(100)!;
    expect(first.path.length).toBeCloseTo(approachPath(0).length, 6);
    const second = recovery.plan(107)!;
    expect(second.path.length).toBeGreaterThan(first.path.length);
    expect(second.touchdownTime - first.touchdownTime).toBeGreaterThan(OPS.landingInterval - 3);
    expect(second.touchdownTime - first.touchdownTime).toBeLessThan(OPS.landingInterval + 6);
    expect(recovery.plan(114)).toBeNull();
    const later = recovery.plan(second.touchdownTime + 30)!;
    expect(later.path.length).toBeCloseTo(first.path.length, 6);
    recovery.reset();
    expect(recovery.plan(0)!.path.length).toBeCloseTo(first.path.length, 6);
  });
});

/** Step until `done()` or the time limit; returns the phases every jet went through. */
function run(
  ops: FlightOpsSim,
  ship: ShipState,
  seconds: number,
  done: () => boolean,
  each?: (t: number) => void,
  after?: () => void,
): JetPhase[][] {
  const phases: JetPhase[][] = ops.jets.map((jet) => [jet.out.phase]);
  for (let i = 0; i < seconds / DT; i++) {
    each?.(ops.time);
    ops.step(DT, ship);
    expectFinite(ops);
    after?.();
    ops.jets.forEach((jet, j) => {
      const list = phases[j];
      if (list[list.length - 1] !== jet.out.phase) list.push(jet.out.phase);
    });
    if (done()) break;
  }
  return phases;
}

describe('flight ops state machine', () => {
  it('parks four jets on their spots, glued to the deck at any ship attitude', () => {
    const ops = new FlightOpsSim();
    const ship = makeShip({
      headingDeg: 217,
      pitch: 0.08,
      roll: -0.12,
      position: [5000, 1800, -7000],
    });
    ops.step(DT, ship);
    expect(ops.jets.length).toBe(4);
    ops.jets.forEach((jet, i) => {
      expect(jet.id).toBe(i + 1);
      expect(jet.out.phase).toBe('parked');
      expect(jet.out.gearDown).toBe(true);
      const local = toLocal(ship, jet.out.position);
      const spot = PARKING_SPOTS[i];
      expect(local.x).toBeCloseTo(spot.position[0], 6);
      expect(local.y).toBeCloseTo(DECK.y, 6);
      expect(local.z).toBeCloseTo(spot.position[2], 6);
      // the nose points along the spot heading, in the deck plane
      const nose = new Vector3(0, 0, -1)
        .applyQuaternion(jet.out.quaternion)
        .applyQuaternion(ship.quaternion.clone().invert());
      const heading = spot.headingDeg * DEG2RAD;
      expect(nose.x).toBeCloseTo(Math.sin(heading), 6);
      expect(nose.y).toBeCloseTo(0, 6);
      expect(nose.z).toBeCloseTo(-Math.cos(heading), 6);
    });
    // inactive: a launch request is ignored
    expect(ops.requestLaunch()).toBe(false);
    run(ops, ship, 5, () => false);
    expect(ops.activeJets()).toBe(0);
  });

  it('flies a full sortie on a stationary level ship: trapped at the target wire, then parked', () => {
    const rec = recorder();
    const ops = new FlightOpsSim(rec.hooks);
    const ship = makeShip();
    ops.reset(true);
    expect(ops.status).toBe('CAT 1 READY');
    expect(ops.requestLaunch()).toBe(true);
    const jet = ops.jets[0];

    let launchSpeed = 0;
    let launchLocal: Vector3 | null = null;
    let trapLocal: Vector3 | null = null;
    let trapSpeed = 0;
    let downwind: Vector3 | null = null;
    let maxBank = 0;
    let finalLateral = 0;
    let finalGlideError = 0;
    let previousPitch = 0;
    let maxPitchRate = 0;
    const phases = run(
      ops,
      ship,
      600,
      () => ops.recoveries === 1 && ops.activeJets() === 0,
      () => {
        if (!launchLocal && rec.events.includes('launch 1 1')) {
          launchLocal = toLocal(ship, jet.out.position);
          launchSpeed = jet.out.speed;
        }
        if (!trapLocal && rec.events.includes('trap 1')) {
          trapLocal = toLocal(ship, jet.out.position);
          trapSpeed = jet.entrySpeed;
        }
        if (jet.stage === 'join' || jet.stage === 'approach') {
          maxBank = Math.max(maxBank, Math.abs(jet.bank));
          maxPitchRate = Math.max(maxPitchRate, Math.abs(jet.pitch - previousPitch) / DT);
          if (!downwind && Math.abs(wrapAngle(jet.heading - Math.PI)) < 0.01 && jet.local.z > 0) {
            downwind = jet.local.clone();
          }
        }
        previousPitch = jet.pitch;
        if (jet.stage === 'approach' && jet.onFinal) {
          const d = jet.path!.length - jet.s;
          const [lx, lz] = approachLinePoint(d);
          finalLateral = Math.max(finalLateral, Math.hypot(jet.local.x - lx, jet.local.z - lz));
          if (d < 150) {
            finalGlideError = Math.max(
              finalGlideError,
              Math.abs(jet.local.y - approachTargetY(d)),
            );
          }
        }
      },
    );

    expect(phases[0]).toEqual([
      'taxi',
      'catapult',
      'launch',
      'climbout',
      'pattern',
      'approach',
      'trap',
      'rollout',
      'taxi',
      'parked',
    ]);
    expect(rec.events).toEqual(['catapult 1 1', 'launch 1 1', 'trap 1']);
    expect(rec.shakes).toEqual([OPS.catapultShake, OPS.trapShake]);

    // off the bow at the end speed
    expect(launchLocal!.z).toBeLessThan(CATAPULTS[0].end[2] + 0.01);
    expect(launchLocal!.z).toBeGreaterThan(CATAPULTS[0].end[2] - 3);
    expect(launchLocal!.x).toBeCloseTo(CATAPULTS[0].end[0], 3);
    expect(launchSpeed).toBeGreaterThan(74.5);
    expect(launchSpeed).toBeLessThan(76);

    // downwind about 1.5 km abeam to port at about 250 m above the deck
    expect(downwind!.x).toBeCloseTo(-OPS.abeamDistance, 3);
    expect(Math.abs(downwind!.y - (DECK.y + 250))).toBeLessThan(5);
    expect(maxBank).toBeGreaterThan(30 * DEG2RAD);
    expect(maxBank).toBeLessThanOrEqual(OPS.maxBank + 1e-9);
    expect(maxPitchRate).toBeLessThanOrEqual(OPS.pitchRate + 1e-6);

    // on the centreline and on the glide path, touching down at the target wire
    expect(finalLateral).toBeLessThan(1e-6);
    expect(finalGlideError).toBeLessThan(0.05);
    expect(trapSpeed).toBeCloseTo(OPS.approachSpeed, 3);
    expect(Math.hypot(trapLocal!.x - STRIP.touchdownX, trapLocal!.z - STRIP.touchdownZ)).toBeLessThan(
      2,
    );
    expect(trapLocal!.y).toBeCloseTo(DECK.y, 6);

    // parked at rest on its own spot
    expect(jet.out.phase).toBe('parked');
    expect(jet.out.speed).toBe(0);
    expect(jet.out.power).toBe(0);
    const local = toLocal(ship, jet.out.position);
    expect(local.x).toBeCloseTo(PARKING_SPOTS[0].position[0], 6);
    expect(local.z).toBeCloseTo(PARKING_SPOTS[0].position[2], 6);
    expect(jet.heading).toBeCloseTo(PARKING_SPOTS[0].headingDeg * DEG2RAD, 6);

    expect(ops.launches).toBe(1);
    expect(ops.recoveries).toBe(1);
    expect(ops.waveOffs).toBe(0);
    expect(rec.traps[0]).toMatchObject({ jetId: 1, points: 1000, grade: 'PERFECT' });
    expect(ops.score).toBe(OPS.launchPoints + 1000);
    expect(ops.lastRecovery).toEqual(rec.traps[0]);
    expect(ops.status).toBe('CAT 1 READY');
    expect(rec.toasts).toContain('JET 1 TRAPPED — PERFECT +1000');
  });

  it('stays on the deck through taxi, stroke, arrestment and parking while the ship rolls and turns', () => {
    const ops = new FlightOpsSim();
    const ship = makeShip();
    ops.reset(true);
    ops.requestLaunch();
    const jet = ops.jets[0];
    let maxStrokeAccel = 0;
    let previousSpeed = 0;
    let sawGearUp = false;
    run(
      ops,
      ship,
      700,
      () => ops.recoveries === 1 && ops.activeJets() === 0,
      (t) => {
        // gentle motion: slow roll and pitch, drifting and turning
        setShip(ship, {
          headingDeg: 30 + t * 0.4,
          roll: 0.012 * Math.sin(t * 0.5),
          pitch: 0.008 * Math.sin(t * 0.37),
          position: [t * 6, 600 + 2 * Math.sin(t * 0.2), -t * 9],
          verticalSpeed: 0.4 * Math.cos(t * 0.2),
          angularVelocity: [0.004, -0.4 * DEG2RAD, 0.006],
        });
        if (jet.stage === 'stroke') {
          maxStrokeAccel = Math.max(maxStrokeAccel, (jet.speed - previousSpeed) / DT);
        }
        previousSpeed = jet.speed;
        if (!jet.gearDown) sawGearUp = true;
      },
      () => {
        if (jet.coupling === 1 && jet.stage !== 'approach' && jet.stage !== 'join') {
          const local = toLocal(ship, jet.out.position);
          expect(Math.abs(local.y - DECK.y)).toBeLessThan(1e-6);
          expect(pointInPolygon(local.x, local.z, DECK.outline)).toBe(true);
        }
      },
    );
    expect(ops.recoveries).toBe(1);
    expect(ops.waveOffs).toBe(0);
    expect(sawGearUp).toBe(true);
    expect(maxStrokeAccel / 9.81).toBeGreaterThan(2.6);
    expect(maxStrokeAccel / 9.81).toBeLessThan(3);
    expect(ops.lastRecovery!.points).toBeGreaterThan(600);
    const local = toLocal(ship, jet.out.position);
    expect(local.x).toBeCloseTo(PARKING_SPOTS[0].position[0], 5);
    expect(local.z).toBeCloseTo(PARKING_SPOTS[0].position[2], 5);
  });

  it('arrives at the wire of a moving, turning ship', () => {
    const rec = recorder();
    const ops = new FlightOpsSim(rec.hooks);
    const ship = makeShip();
    ops.reset(true);
    ops.requestLaunch();
    const jet = ops.jets[0];
    let touchdown: Vector3 | null = null;
    let previous = new Vector3();
    let maxJump = 0;
    run(
      ops,
      ship,
      400,
      () => ops.recoveries === 1,
      (t) => {
        const heading = 200 + 0.5 * t;
        const rad = heading * DEG2RAD;
        setShip(ship, {
          headingDeg: heading,
          roll: 0.01 * Math.sin(t * 0.6),
          pitch: 0.006 * Math.sin(t * 0.45),
          // 15 m/s along a slowly curving track
          position: [
            ship.position.x + Math.sin(rad) * 15 * DT,
            900,
            ship.position.z - Math.cos(rad) * 15 * DT,
          ],
          angularVelocity: [0.003, -0.5 * DEG2RAD, 0.006],
        });
        if (t > 0.1 && jet.stage !== 'parked') {
          maxJump = Math.max(maxJump, jet.out.position.distanceTo(previous));
        }
        previous = jet.out.position.clone();
      },
    );
    touchdown = toLocal(ship, jet.out.position);
    expect(ops.recoveries).toBe(1);
    expect(Math.hypot(touchdown.x - STRIP.touchdownX, touchdown.z - STRIP.touchdownZ)).toBeLessThan(
      3,
    );
    expect(touchdown.y).toBeCloseTo(DECK.y, 4);
    // continuous motion: never further in a step than flight speed plus the swing of the frame
    expect(maxJump).toBeLessThan(140 * DT);
  });

  it('waves off over a violently rocking deck and traps once it is calm again', () => {
    const rec = recorder();
    const ops = new FlightOpsSim(rec.hooks);
    const ship = makeShip();
    ops.reset(true);
    ops.requestLaunch();
    const jet = ops.jets[0];
    let rocking = false;
    let minClearance = Infinity;
    const phases = run(
      ops,
      ship,
      900,
      () => ops.recoveries === 1 && ops.activeJets() === 0,
      (t) => {
        if (jet.stage === 'approach') rocking = ops.waveOffs === 0;
        if (rocking) {
          const roll = 0.14 * Math.sin(t * 1.3);
          setShip(ship, {
            roll,
            pitch: 0.05 * Math.sin(t * 0.9),
            verticalSpeed: 3 * Math.cos(t),
            angularVelocity: [0.045 * Math.cos(t * 0.9), 0, -0.18 * Math.cos(t * 1.3)],
          });
        } else {
          setShip(ship, {});
        }
        if (jet.out.phase === 'waveoff') {
          minClearance = Math.min(minClearance, jet.local.y - DECK.y);
        }
      },
    );
    expect(ops.waveOffs).toBe(1);
    expect(rec.events).toEqual(['catapult 1 1', 'launch 1 1', 'waveoff 1', 'trap 1']);
    expect(rec.toasts).toContain('JET 1 WAVE-OFF — DECK UNSTABLE');
    expect(phases[0]).toEqual([
      'taxi',
      'catapult',
      'launch',
      'climbout',
      'pattern',
      'approach',
      'waveoff',
      'pattern',
      'approach',
      'trap',
      'rollout',
      'taxi',
      'parked',
    ]);
    // the go-around clears the deck and scores nothing
    expect(minClearance).toBeGreaterThan(1.5);
    expect(ops.recoveries).toBe(1);
    expect(ops.score).toBe(OPS.launchPoints + ops.lastRecovery!.points);
  });

  it('holds a catapult shot while the deck is unstable', () => {
    const rec = recorder();
    const ops = new FlightOpsSim(rec.hooks);
    const ship = makeShip({ roll: 0.09, angularVelocity: [0, 0, 0.05] });
    ops.reset(true);
    ops.requestLaunch();
    run(ops, ship, 60, () => false);
    expect(ops.jets[0].out.phase).toBe('catapult');
    expect(ops.launches).toBe(0);
    expect(ops.score).toBe(0);
    expect(rec.toasts.filter((t) => t === 'DECK UNSTABLE — LAUNCH HELD').length).toBe(1);
    expect(ops.steadiness).toBeLessThan(OPS.minSteadiness);
    setShip(ship, {});
    run(ops, ship, 20, () => ops.launches === 1);
    expect(ops.launches).toBe(1);
    expect(ops.score).toBe(OPS.launchPoints);
  });

  it('queues launches over two catapults and recovers the whole air wing without conflicts', () => {
    const rec = recorder();
    const ops = new FlightOpsSim(rec.hooks);
    const ship = makeShip();
    ops.reset(true);
    for (let i = 0; i < 4; i++) expect(ops.requestLaunch()).toBe(true);
    // every jet on deck is spoken for
    expect(ops.requestLaunch()).toBe(false);
    expect(rec.toasts).toContain('NO AIRCRAFT READY ON DECK');

    let maxOnCatapults = 0;
    const launchTimes: number[] = [];
    const trapTimes: number[] = [];
    let minDeckSeparation = Infinity;
    run(
      ops,
      ship,
      1500,
      () => ops.recoveries === 4 && ops.activeJets() === 0,
      (t) => {
        // in the launch sequence: taxiing to, or sitting on, an assigned catapult
        const sequence = ops.jets.filter((j) => j.catapult >= 0);
        maxOnCatapults = Math.max(maxOnCatapults, sequence.length);
        expect(new Set(sequence.map((j) => j.catapult)).size).toBe(sequence.length);
        if (ops.launches > launchTimes.length) launchTimes.push(t);
        if (ops.recoveries > trapTimes.length) trapTimes.push(t);
        for (const a of ops.jets) {
          for (const b of ops.jets) {
            if (a.id >= b.id || a.coupling < 1 || b.coupling < 1) continue;
            if (a.local.y > DECK.y + 0.5 || b.local.y > DECK.y + 0.5) continue;
            minDeckSeparation = Math.min(minDeckSeparation, a.local.distanceTo(b.local));
          }
        }
      },
    );
    expect(ops.launches).toBe(4);
    expect(ops.recoveries).toBe(4);
    expect(ops.waveOffs).toBe(0);
    expect(ops.activeJets()).toBe(0);
    expect(maxOnCatapults).toBe(2);
    expect(ops.score).toBe(4 * OPS.launchPoints + 4000);
    for (let i = 1; i < launchTimes.length; i++) {
      expect(launchTimes[i] - launchTimes[i - 1]).toBeGreaterThanOrEqual(OPS.launchInterval - DT);
    }
    for (let i = 1; i < trapTimes.length; i++) {
      expect(trapTimes[i] - trapTimes[i - 1]).toBeGreaterThan(OPS.landingInterval - 4);
    }
    // nobody on deck ever comes closer than a wingspan to anybody else
    expect(minDeckSeparation).toBeGreaterThan(2 * JET_DIMS.halfSpan);
    // launching again works once jets are back
    expect(ops.requestLaunch()).toBe(true);
  });

  it('freezes when paused and resets to four parked jets', () => {
    const ops = new FlightOpsSim();
    const ship = makeShip({ headingDeg: 80 });
    ops.reset(true);
    ops.requestLaunch();
    ops.requestLaunch();
    run(ops, ship, 40, () => ops.launches === 1);
    run(ops, ship, 3, () => false);
    const before = ops.jets.map((j) => ({
      p: j.out.position.clone(),
      q: j.out.quaternion.clone(),
      s: j.s,
      stage: j.stage,
    }));
    const time = ops.time;
    for (let i = 0; i < 30; i++) ops.step(0, ship);
    ops.step(Number.NaN, ship);
    expect(ops.time).toBe(time);
    ops.jets.forEach((j, i) => {
      expect(j.out.position.distanceTo(before[i].p)).toBe(0);
      expect(j.out.quaternion.equals(before[i].q)).toBe(true);
      expect(j.s).toBe(before[i].s);
      expect(j.stage).toBe(before[i].stage);
    });
    // a large frame step is sub-stepped and stays finite
    ops.step(0.5, ship);
    expectFinite(ops);

    ops.reset(false);
    ops.step(DT, ship);
    expect(ops.activeJets()).toBe(0);
    expect(ops.score).toBe(0);
    expect(ops.launches).toBe(0);
    expect(ops.launch.pending).toBe(0);
    expect(ops.status).toBe('');
    ops.jets.forEach((jet, i) => {
      expect(jet.out.phase).toBe('parked');
      expect(jet.out.gearDown).toBe(true);
      const local = toLocal(ship, jet.out.position);
      expect(local.x).toBeCloseTo(PARKING_SPOTS[i].position[0], 6);
      expect(local.z).toBeCloseTo(PARKING_SPOTS[i].position[2], 6);
    });
  });
});
