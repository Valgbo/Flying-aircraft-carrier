/**
 * Targeting pod and laser acceptance tests (PLAN_A10.md §6.6, §8, §16; ARCHITECTURE §12.5), on the
 * sensors' kinematic test bed (core/sensors/testbed.ts): the aircraft and the vehicles move
 * kinematically and only the sensors step runs, so these measure the sensors module alone.
 */
import { Vector3 } from 'three';
import { afterAll, describe, expect, it } from 'vitest';
import { applyCommands } from '../../../src/a10/core/avionics';
import { bodyDirFromHudAngles, worldToBody } from '../../../src/a10/core/frames';
import { stepSensors } from '../../../src/a10/core/sensors';
import { cockpitSwitches, tgpFov } from '../../../src/a10/core/sensors/tgp';
import {
  addVehicle,
  aimPodAt,
  aircraftPose,
  createSensorTestbed,
  driveVehicles,
  queueRequest,
  ridgeTerrain,
  runSensorTestbed,
  stepSensorTestbed,
  withForest,
} from '../../../src/a10/core/sensors/testbed';
import { pushCommand } from '../../../src/a10/core/sim';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { DEG } from '../../../src/a10/core/units';
import { createFlatTerrain } from '../../../src/a10/core/world';
import { TGP } from '../../../src/a10/data/sensors';
import { vehicleCentre } from '../../../src/a10/core/sensors/geometry';
import type { Vehicle } from '../../../src/a10/core/targets/types';

const report: Array<[string, string]> = [];
afterAll(() => {
  console.log('\n| TGP / laser measure | value |\n|---|---|');
  for (const [k, v] of report) console.log(`| ${k} | ${v} |`);
});

const _d = new Vector3();
/** Distance from point p to the ray o + s·d (unit d, s ≥ 0), m. */
function rayMiss(o: Vector3, d: Vector3, p: Vector3): number {
  _d.subVectors(p, o);
  const s = Math.max(0, _d.dot(d));
  return _d.addScaledVector(d, -s).length();
}

/** Hold the pod's line of sight on a BODY-frame direction (HUD angles) via its inertial aim. */
function lookBody(sim: Sim, az: number, el: number): void {
  const t = sim.sensors.tgp;
  const d = bodyDirFromHudAngles(az, el, new Vector3()).applyQuaternion(sim.aircraft.orientation);
  t.mode = 'INR';
  t.internal.aimValid = false;
  t.internal.aimDir.copy(d);
  stepSensorTestbed(sim);
}

function centre(v: Vehicle): Vector3 {
  return vehicleCentre(v, new Vector3());
}

function events(sim: Sim, type: SimEvent['type']): SimEvent[] {
  return sim.events.filter((e) => e.type === type);
}

function soiTgp(sim: Sim): void {
  sim.avionics.soi = 'RMFD';
  sim.avionics.mfd.right = 'TGP';
}

describe('targeting pod: where it hangs and where it looks', () => {
  it('hangs on station 10 of the tank-hunter load and looks where it is slaved', () => {
    const sim = createSensorTestbed({ altitude: 2000, speed: 0 });
    const target = new Vector3(800, 0, -8000);
    aimPodAt(sim, target);
    runSensorTestbed(sim, 0.25);
    const t = sim.sensors.tgp;
    expect(t.station).toBe(10);
    expect(t.powered && t.ready).toBe(true);
    expect(t.mode).toBe('INR');
    // head under the right outer wing, ahead of the leading edge
    const local = worldToBody(sim.aircraft.orientation, t.head.clone().sub(sim.aircraft.position), new Vector3());
    expect(local.x).toBeCloseTo(4.85, 1);
    expect(local.y).toBeLessThan(-0.7);
    expect(rayMiss(t.head, t.los, target)).toBeLessThan(0.05);
    expect(t.pointValid).toBe(true);
    expect(t.point.distanceTo(target)).toBeLessThan(1e-6);
    expect(t.pointRange).toBeCloseTo(t.head.distanceTo(target), 6);
  });

  it('gimbal limits and self-masking: straight back and up are masked, under the nose is clear', () => {
    const sim = createSensorTestbed({ altitude: 3000, speed: 0 });
    stepSensorTestbed(sim);
    const t = sim.sensors.tgp;
    const axis = new Vector3(0, Math.sin(-0.0527), -Math.cos(-0.0527)).applyQuaternion(
      sim.aircraft.orientation,
    );
    lookBody(sim, Math.PI, 0); // straight back: inside the 30° blind cone
    expect(t.maskReason).toBe('GIMBAL');
    expect(t.masked).toBe(true);
    expect(t.los.angleTo(axis) / DEG).toBeCloseTo(TGP.gimbalMaxOffAxis / DEG, 1);
    lookBody(sim, 0, 89.9 * DEG); // straight up: the pod's own pylon
    expect(t.maskReason).toBe('AIRFRAME');
    lookBody(sim, Math.PI, 45 * DEG); // up and aft: the wing
    expect(t.maskReason).toBe('AIRFRAME');
    lookBody(sim, -Math.PI / 2, -10 * DEG); // across the belly: gear pod, stores, fuselage
    expect(t.maskReason).toBe('AIRFRAME');
    for (const [az, el] of [
      [0, -45], // under the nose
      [0, -89], // straight down
      [Math.PI / 2 / DEG, -10], // right, outboard
      [-20, -30], // ahead and left, below
      [150, -60], // behind and below
    ]) {
      lookBody(sim, az * DEG, el * DEG);
      expect(t.maskReason, `az ${az} el ${el}`).toBe('NONE');
    }
    // how much of the sky above 20° the aircraft hides
    let n = 0;
    let masked = 0;
    for (let el = 20; el <= 85; el += 5)
      for (let az = -180; az < 180; az += 10) {
        lookBody(sim, az * DEG, el * DEG);
        n++;
        if (t.masked) masked++;
      }
    report.push(['upper hemisphere (el ≥ 20°) masked', `${((100 * masked) / n).toFixed(0)} %`]);
    expect(masked / n).toBeGreaterThan(0.4);
  });

  it('a masked pod drops its area track to INR and cannot lase', () => {
    const sim = createSensorTestbed({ altitude: 3000, speed: 0 });
    const t = sim.sensors.tgp;
    const point = new Vector3(3000, 0, 2500); // right and behind, below the wing when level
    aimPodAt(sim, point);
    stepSensorTestbed(sim);
    queueRequest(sim, 'TGP', 'tms', 'down'); // INR → AREA
    stepSensorTestbed(sim);
    expect(t.mode).toBe('AREA');
    sim.avionics.laserArm = 'ARM';
    sim.input.laser = true;
    stepSensorTestbed(sim);
    expect(t.lasing).toBe(true);
    // roll left past the vertical: the point is now above and behind the right wing
    aircraftPose(sim).bank = -110 * DEG;
    stepSensorTestbed(sim);
    expect(t.maskReason).toBe('AIRFRAME');
    expect(t.mode).toBe('INR');
    expect(t.lasing).toBe(false);
    expect(t.spotValid).toBe(false);
    // the inertial point is still held: roll back and the pod looks at it again
    aircraftPose(sim).bank = 0;
    stepSensorTestbed(sim);
    expect(t.masked).toBe(false);
    expect(rayMiss(t.head, t.los, point)).toBeLessThan(0.05);
  });
});

describe('targeting pod: slew, fields of view and zoom', () => {
  function slewRate(setting: 'WIDE' | 'NARROW', zoom: number, deflection: number, seconds = 1) {
    const sim = createSensorTestbed({ altitude: 3000, speed: 0 });
    aimPodAt(sim, new Vector3(0, 0, -6000));
    stepSensorTestbed(sim);
    const t = sim.sensors.tgp;
    t.fovSetting = setting;
    t.zoom = zoom;
    soiTgp(sim);
    const before = t.los.clone();
    sim.input.slewX = deflection;
    runSensorTestbed(sim, seconds);
    sim.input.slewX = 0;
    return { rate: before.angleTo(t.los) / seconds, fov: tgpFov(setting, zoom), sim };
  }

  it('slews at a rate proportional to the field of view', () => {
    const wide = slewRate('WIDE', 1, 0.8);
    const narrow = slewRate('NARROW', 1, 0.8);
    const zoomed = slewRate('NARROW', 8, 0.8);
    // below the acceleration threshold: rate = FOV × slewFovPerSecond × deflection^expo
    const expected = (fov: number) => fov * TGP.slewFovPerSecond * 0.8 ** TGP.slewExpo;
    expect(wide.rate / expected(wide.fov)).toBeCloseTo(1, 1);
    expect(narrow.rate / expected(narrow.fov)).toBeCloseTo(1, 1);
    expect(zoomed.rate / expected(zoomed.fov)).toBeCloseTo(1, 1);
    expect(wide.rate / narrow.rate).toBeCloseTo(4, 1);
    expect(narrow.rate / zoomed.rate).toBeCloseTo(8, 1);
    report.push([
      'slew rate at 0.8 deflection: WIDE / NARROW / NARROW ×8',
      `${(wide.rate / DEG).toFixed(3)} / ${(narrow.rate / DEG).toFixed(3)} / ${(zoomed.rate / DEG).toFixed(4)} °/s`,
    ]);
  });

  it('accelerates while held at full deflection', () => {
    const sim = createSensorTestbed({ altitude: 3000, speed: 0 });
    aimPodAt(sim, new Vector3(0, 0, -6000));
    stepSensorTestbed(sim);
    soiTgp(sim);
    const t = sim.sensors.tgp;
    sim.input.slewY = -1; // down: toward the aircraft, the line of sight stays on the ground
    const a = t.los.clone();
    runSensorTestbed(sim, 0.1);
    const early = a.angleTo(t.los) / 0.1;
    runSensorTestbed(sim, TGP.slewAccelTime);
    const b = t.los.clone();
    runSensorTestbed(sim, 0.1);
    const late = b.angleTo(t.los) / 0.1;
    expect(early / (t.fov * TGP.slewFovPerSecond)).toBeLessThan(1.3);
    expect(late / early).toBeGreaterThan(TGP.slewAccelMax * 0.8);
    report.push(['slew acceleration after 1.5 s at full deflection', `× ${(late / early).toFixed(2)}`]);
  });

  it('FOV, zoom and picture follow the HOTAS / page requests', () => {
    const sim = createSensorTestbed({ speed: 0 });
    const t = sim.sensors.tgp;
    stepSensorTestbed(sim);
    expect(t.fov).toBeCloseTo(4 * DEG, 9);
    queueRequest(sim, 'TGP', 'chinaHat', 'fwd');
    stepSensorTestbed(sim);
    expect(t.fovSetting).toBe('NARROW');
    expect(t.fov).toBeCloseTo(1 * DEG, 9);
    queueRequest(sim, 'TGP', 'zoom', '', false, 1);
    queueRequest(sim, 'TGP', 'zoom', '', false, 1);
    stepSensorTestbed(sim);
    expect(t.zoom).toBe(4);
    for (let i = 0; i < 5; i++) queueRequest(sim, 'TGP', 'zoom', '', false, 1);
    stepSensorTestbed(sim);
    expect(t.zoom).toBe(8);
    expect(t.fov).toBeCloseTo((1 * DEG) / 8, 9);
    expect(t.picture).toBe('WHOT');
    queueRequest(sim, 'TGP', 'picture');
    stepSensorTestbed(sim);
    expect(t.picture).toBe('BHOT');
    queueRequest(sim, 'TGP', 'picture');
    stepSensorTestbed(sim);
    expect(t.picture).toBe('CCD');
  });
});

describe('targeting pod: INR, AREA and POINT tracks', () => {
  function holdError(mode: 'INR' | 'AREA') {
    const sim = createSensorTestbed({ altitude: 3000, speed: 150, heading: 0 });
    const point = new Vector3(3000, 0, -9500); // ≈10.4 km, right and ahead
    aimPodAt(sim, point);
    stepSensorTestbed(sim);
    if (mode === 'AREA') queueRequest(sim, 'TGP', 'tms', 'down');
    stepSensorTestbed(sim);
    const t = sim.sensors.tgp;
    expect(t.mode).toBe(mode);
    let worst = 0;
    let steps = 0;
    const pose = aircraftPose(sim);
    runSensorTestbed(sim, 30, (s) => {
      // rolling reversals in a right turn, nose up and down
      const time = s.time;
      pose.bank = (20 + 15 * Math.sin(0.6 * time)) * DEG;
      pose.pitch = 5 * DEG * Math.sin(0.3 * time);
      if (!t.masked) {
        worst = Math.max(worst, rayMiss(t.head, t.los, point));
        steps++;
      }
    });
    expect(t.mode).toBe(mode);
    expect(steps).toBeGreaterThan(3000);
    expect(t.point.distanceTo(point)).toBeLessThan(0.01);
    return worst;
  }

  it('INR holds its ground point while the aircraft manoeuvres (< 3 m at 10 km)', () => {
    const e = holdError('INR');
    report.push(['INR hold error at ≈10 km, 30 s of rolling turns', `${e.toFixed(4)} m`]);
    expect(e).toBeLessThan(3);
  });

  it('AREA holds its ground point while the aircraft manoeuvres (< 3 m at 10 km)', () => {
    const e = holdError('AREA');
    report.push(['AREA hold error at ≈10 km, 30 s of rolling turns', `${e.toFixed(4)} m`]);
    expect(e).toBeLessThan(3);
  });

  /** Track a tank driving north at 40 km/h toward cover; returns what happened. */
  function trackIntoCover(terrainKind: 'ridge' | 'trees') {
    const terrain =
      terrainKind === 'ridge'
        ? ridgeTerrain({ z: -10000, height: 250, width: 300 })
        : withForest(createFlatTerrain(0), { x0: -300, x1: 300, z0: -9300, z1: -9100, height: 20 });
    const sim = createSensorTestbed({ terrain, altitude: 1500, speed: 0 });
    const speed = 40 / 3.6;
    const v = addVehicle(sim, 'mbt', 0, -9000, 0, { speed });
    v.position.y = terrain.heightAt(0, -9000);
    aimPodAt(sim, v.position);
    stepSensorTestbed(sim);
    queueRequest(sim, 'TGP', 'tms', 'up');
    stepSensorTestbed(sim);
    const t = sim.sensors.tgp;
    expect(t.mode).toBe('POINT');
    expect(t.trackedVehicle).toBe(v.id);
    let worst = 0;
    let tracked = 0;
    let lostAt = -1;
    let areaAt = -1;
    const start = sim.time;
    runSensorTestbed(sim, 120, (s) => {
      driveVehicles(s);
      if (t.mode === 'POINT' && !t.coasting) {
        worst = Math.max(worst, rayMiss(t.head, t.los, centre(v)));
        tracked = s.time - start;
      }
      if (t.coasting && lostAt < 0) lostAt = s.time;
      if (t.mode === 'AREA' && areaAt < 0) areaAt = s.time;
    });
    return { sim, v, worst, tracked, lostAt, areaAt };
  }

  it('POINT holds a tank driving at 40 km/h and falls back to AREA behind a ridge', () => {
    const r = trackIntoCover('ridge');
    const t = r.sim.sensors.tgp;
    expect(r.worst).toBeLessThan(0.5);
    expect(r.tracked).toBeGreaterThan(60); // it climbs the near slope in view
    expect(r.lostAt).toBeGreaterThan(0);
    expect(r.areaAt - r.lostAt).toBeCloseTo(TGP.coastTime, 1);
    expect(t.mode).toBe('AREA');
    expect(t.trackedVehicle).toBe(-1);
    // the tank drove on behind the crest; the area track holds where it went out of sight
    expect(r.v.position.z).toBeLessThan(-10000);
    const locks = events(r.sim, 'lock') as Extract<SimEvent, { type: 'lock' }>[];
    expect(locks.map((e) => `${e.sensor}:${e.on}`)).toEqual(['TGP:true', 'TGP:false']);
    report.push([
      'POINT track, tank at 40 km/h toward a ridge',
      `held ${r.tracked.toFixed(1)} s (line of sight within ${r.worst.toFixed(3)} m of its centre), lost at ${r.lostAt.toFixed(1)} s, AREA ${(r.areaAt - r.lostAt).toFixed(2)} s later`,
    ]);
  });

  it('POINT holds a tank driving at 40 km/h and falls back to AREA under trees', () => {
    const r = trackIntoCover('trees');
    expect(r.worst).toBeLessThan(0.5);
    expect(r.lostAt).toBeGreaterThan(0);
    expect(r.sim.sensors.tgp.mode).toBe('AREA');
    // it went out of sight entering the strip (z −9,100), not before
    expect(r.tracked).toBeGreaterThan(7);
    report.push([
      'POINT track, tank at 40 km/h into a forest strip',
      `held ${r.tracked.toFixed(1)} s, AREA ${(r.areaAt - r.lostAt).toFixed(2)} s after the loss`,
    ]);
  });

  it('TMS forward with no vehicle under the cross area-tracks; TMS aft steps POINT → AREA → INR', () => {
    const sim = createSensorTestbed({ altitude: 2000, speed: 0 });
    const v = addVehicle(sim, 'mbt', 0, -6000, Math.PI / 2);
    const t = sim.sensors.tgp;
    aimPodAt(sim, new Vector3(400, 0, -6000)); // 400 m beside the tank: outside the WIDE gate
    stepSensorTestbed(sim);
    queueRequest(sim, 'TGP', 'tms', 'up');
    stepSensorTestbed(sim);
    expect(t.mode).toBe('AREA');
    aimPodAt(sim, v.position);
    stepSensorTestbed(sim);
    queueRequest(sim, 'TGP', 'tms', 'up');
    stepSensorTestbed(sim);
    expect(t.mode).toBe('POINT');
    queueRequest(sim, 'TGP', 'tms', 'down');
    stepSensorTestbed(sim);
    expect(t.mode).toBe('AREA');
    expect(t.point.distanceTo(v.position)).toBeLessThan(0.01);
    queueRequest(sim, 'TGP', 'tms', 'down');
    stepSensorTestbed(sim);
    expect(t.mode).toBe('INR');
  });

  it('TMS forward through the avionics HOTAS routing starts a point track (integration)', () => {
    const sim = createSensorTestbed({ altitude: 2000, speed: 0 });
    const v = addVehicle(sim, 'mbt', 0, -6000, Math.PI / 2);
    aimPodAt(sim, v.position);
    stepSensorTestbed(sim);
    soiTgp(sim);
    pushCommand(sim, { type: 'tms', dir: 'up', long: false });
    applyCommands(sim);
    stepSensors(sim, 1 / 120);
    expect(sim.sensors.tgp.mode).toBe('POINT');
  });
});

describe('laser designator and ranger', () => {
  function lasingSetup(arm: 'ARM' | 'TRAIN') {
    const sim = createSensorTestbed({ altitude: 2000, speed: 0 });
    const tank = addVehicle(sim, 'mbt', 0, -6000, Math.PI / 2);
    sim.avionics.laserArm = arm;
    return { sim, tank, t: sim.sensors.tgp };
  }

  it('marks the vehicle the beam meets, or the ground', () => {
    const { sim, tank, t } = lasingSetup('ARM');
    aimPodAt(sim, tank.position);
    stepSensorTestbed(sim);
    queueRequest(sim, 'TGP', 'tms', 'down'); // AREA on the tank's ground point
    stepSensorTestbed(sim);
    sim.input.laser = true;
    stepSensorTestbed(sim);
    expect(t.lasing).toBe(true);
    expect(t.spotValid).toBe(true);
    expect(t.spotVehicle).toBe(tank.id);
    // on the armour, between the head and the ground point
    expect(t.spot.distanceTo(centre(tank))).toBeLessThan(4);
    expect(t.spot.y).toBeGreaterThan(0.3);
    expect(t.laserRange).toBeCloseTo(t.head.distanceTo(t.spot), 3);
    // open ground 500 m beside it
    const ground = new Vector3(500, 0, -6000);
    aimPodAt(sim, ground);
    stepSensorTestbed(sim);
    queueRequest(sim, 'TGP', 'tms', 'down');
    runSensorTestbed(sim, 0.2);
    expect(t.spotValid).toBe(true);
    expect(t.spotVehicle).toBe(-1);
    expect(t.spot.distanceTo(ground)).toBeLessThan(0.05);
    expect(t.laserRange).toBeCloseTo(t.head.distanceTo(ground), 2);
    report.push(['laser range to the tank / to the ground beside it', `${t.head.distanceTo(centre(tank)).toFixed(0)} m / ${t.laserRange.toFixed(1)} m`]);
  });

  it('TRAIN ranges but marks no spot', () => {
    const { sim, tank, t } = lasingSetup('TRAIN');
    aimPodAt(sim, tank.position);
    stepSensorTestbed(sim);
    queueRequest(sim, 'TGP', 'tms', 'up'); // point track
    stepSensorTestbed(sim);
    expect(t.mode).toBe('POINT');
    sim.input.laser = true;
    runSensorTestbed(sim, 0.3);
    expect(t.lasing).toBe(true);
    expect(t.spotValid).toBe(false);
    expect(t.laserRange).toBeGreaterThan(6000);
    expect(t.laserRangeTime).toBeGreaterThan(0.1);
  });

  it('fires only while tracking, and the latch holds it on without the button', () => {
    const { sim, tank, t } = lasingSetup('ARM');
    aimPodAt(sim, tank.position);
    sim.input.laser = true;
    runSensorTestbed(sim, 0.2);
    expect(t.mode).toBe('INR');
    expect(t.lasing).toBe(false); // INR: not tracking
    queueRequest(sim, 'TGP', 'tms', 'up');
    runSensorTestbed(sim, 0.2);
    expect(t.lasing).toBe(true);
    sim.input.laser = false;
    stepSensorTestbed(sim);
    expect(t.lasing).toBe(false);
    cockpitSwitches(sim).laserLatch = true; // the TGP page's LTCH
    runSensorTestbed(sim, 1);
    expect(t.lasing).toBe(true);
    expect(t.latched).toBe(true);
    cockpitSwitches(sim).laserLatch = false;
    stepSensorTestbed(sim);
    expect(t.lasing).toBe(false);
    sim.avionics.laserArm = 'SAFE';
    sim.input.laser = true;
    stepSensorTestbed(sim);
    expect(t.lasing).toBe(false);
    const ev = events(sim, 'laser') as Extract<SimEvent, { type: 'laser' }>[];
    expect(ev.map((e) => e.on)).toEqual([true, false, true, false]);
  });

  it('pulses at LASER.pulseHz and the spot follows a point-tracked vehicle', () => {
    const { sim, tank, t } = lasingSetup('ARM');
    tank.heading = 0;
    tank.speed = 40 / 3.6;
    aimPodAt(sim, tank.position);
    stepSensorTestbed(sim);
    queueRequest(sim, 'TGP', 'tms', 'up');
    stepSensorTestbed(sim);
    sim.input.laser = true;
    const times = new Set<number>();
    let worst = 0;
    runSensorTestbed(sim, 3, (s) => {
      driveVehicles(s);
      if (t.spotValid) {
        times.add(Math.round(t.laserRangeTime * 1000));
        worst = Math.max(worst, t.spot.distanceTo(centre(tank)));
      }
    });
    expect(t.spotVehicle).toBe(tank.id);
    expect(times.size).toBeGreaterThanOrEqual(29);
    expect(times.size).toBeLessThanOrEqual(31);
    // between pulses the tank moves ≤ 1.2 m; the spot is on its armour
    expect(worst).toBeLessThan(5);
  });

  it('the beam stops on the tree canopy over its ground point', () => {
    const terrain = withForest(createFlatTerrain(0), {
      x0: -200,
      x1: 200,
      z0: -6200,
      z1: -5800,
      height: 20,
    });
    const sim = createSensorTestbed({ terrain, altitude: 2000, speed: 0 });
    sim.avionics.laserArm = 'ARM';
    const t = sim.sensors.tgp;
    aimPodAt(sim, new Vector3(0, 0, -6000));
    stepSensorTestbed(sim);
    queueRequest(sim, 'TGP', 'tms', 'down');
    sim.input.laser = true;
    runSensorTestbed(sim, 0.2);
    expect(t.spotValid).toBe(true);
    expect(t.spot.y).toBeCloseTo(20, 0);
    expect(t.laserRange).toBeLessThan(t.head.distanceTo(new Vector3(0, 0, -6000)) - 50);
  });
});

describe('determinism', () => {
  function scripted(): string {
    const sim = createSensorTestbed({ altitude: 2500, speed: 140 });
    const v = addVehicle(sim, 'mbt', 600, -7000, 1.2, { speed: 9 });
    addVehicle(sim, 'ifv', 650, -7020, 1.2, { speed: 9 });
    aimPodAt(sim, v.position);
    soiTgp(sim);
    sim.avionics.laserArm = 'ARM';
    runSensorTestbed(sim, 20, (s) => {
      driveVehicles(s);
      const k = s.stepCount;
      aircraftPose(s).bank = 25 * DEG * Math.sin(k / 300);
      s.input.slewX = k > 200 && k < 260 ? 0.5 : 0;
      if (k === 300) queueRequest(s, 'TGP', 'tms', 'up');
      s.input.laser = k > 400;
    });
    const t = sim.sensors.tgp;
    return JSON.stringify([t.los.toArray(), t.point.toArray(), t.spot.toArray(), t.mode, t.laserRange, t.trackedVehicle]);
  }
  it('the same inputs give the same pod state', () => {
    expect(scripted()).toBe(scripted());
  });
});
