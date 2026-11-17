/**
 * Maverick seekers before launch (PLAN_A10.md §6.4 "it can go wrong", §16 Maverick row;
 * ARCHITECTURE §12.5): alignment, slaving, the lock rules (size in the gate, contrast in the
 * seeker's band, line of sight, range), lock breaks, infrared capture by a burning wreck, the
 * launch zone and the selection. Kinematic test bed: only the sensors step runs.
 */
import { Vector3 } from 'three';
import { afterAll, describe, expect, it } from 'vitest';
import { targetContrast } from '../../../src/a10/core/sensors';
import { cockpitSwitches } from '../../../src/a10/core/sensors/tgp';
import {
  addVehicle,
  aircraftPose,
  createSensorTestbed,
  driveVehicles,
  queueRequest,
  ridgeTerrain,
  runSensorTestbed,
  setVehicleHeat,
  stepSensorTestbed,
  type SensorTestbedOptions,
} from '../../../src/a10/core/sensors/testbed';
import type { MaverickSeekerState } from '../../../src/a10/core/sensors/types';
import type { Vehicle } from '../../../src/a10/core/targets/types';
import type { Sim, SimEvent } from '../../../src/a10/core/types';
import { DEG, NM } from '../../../src/a10/core/units';
import { MAVERICK } from '../../../src/a10/data/sensors';

const report: Array<[string, string]> = [];
afterAll(() => {
  console.log('\n| Maverick measure | value |\n|---|---|');
  for (const [k, v] of report) console.log(`| ${k} | ${v} |`);
});

const ALT = 1500;

/** A test bed with the seeker on `station` selected (tank hunter: D on 3, H on 9). */
function bed(station: number, opts: SensorTestbedOptions = {}): Sim {
  const sim = createSensorTestbed({ altitude: ALT, speed: 0, ...opts });
  cockpitSwitches(sim).selectedStation = station;
  stepSensorTestbed(sim);
  return sim;
}

function seeker(sim: Sim): MaverickSeekerState {
  return sim.sensors.mavericks[sim.sensors.selectedMaverick];
}

/** Ground distance ahead for a slant range from ALT. */
function groundRange(slant: number): number {
  return Math.sqrt(Math.max(0, slant * slant - ALT * ALT));
}

/** Slave the selected seeker to a ground point (through the SPI), then try to lock. */
function aimAndLock(sim: Sim, point: Vector3): boolean {
  const spi = sim.avionics.spi;
  spi.valid = true;
  spi.source = 'STPT';
  spi.position.copy(point);
  queueRequest(sim, 'MAV', 'slaveSpi', '', true);
  stepSensorTestbed(sim);
  queueRequest(sim, 'MAV', 'tms', 'up');
  stepSensorTestbed(sim);
  return seeker(sim).locked;
}

function lockEvents(sim: Sim): string[] {
  return sim.events
    .filter(
      (e): e is Extract<SimEvent, { type: 'lock' }> => e.type === 'lock' && e.sensor === 'MAV',
    )
    .map((e) => (e.on ? 'on' : 'off'));
}

/** A tank broadside (heading east) `slant` metres ahead of the aircraft. */
function tankAhead(sim: Sim, slant: number, heat: 'cold' | 'idle' | 'running' = 'idle'): Vehicle {
  return addVehicle(sim, 'mbt', 0, -groundRange(slant), Math.PI / 2, { heat });
}

describe('Maverick seekers: power, alignment, selection', () => {
  it('one seeker per missile, aligned at the air start, the selected one first', () => {
    const sim = bed(3);
    const list = sim.sensors.mavericks;
    expect(list.map((m) => `${m.station}/${m.type}/${m.rail}`)).toEqual([
      '3/AGM-65D/0',
      '3/AGM-65D/1',
      '9/AGM-65H/0',
      '9/AGM-65H/1',
    ]);
    expect(sim.sensors.selectedMaverick).toBe(0);
    expect(list.every((m) => m.powered && m.align === 0)).toBe(true);
    expect(list[0].band).toBe('IR');
    expect(list[2].band).toBe('TV');
    cockpitSwitches(sim).selectedStation = 9;
    stepSensorTestbed(sim);
    expect(seeker(sim).station).toBe(9);
    expect(seeker(sim).type).toBe('AGM-65H');
    expect(seeker(sim).picture).toBe('CCD');
  });

  it(`needs ${MAVERICK.alignTime} s of alignment after power-on before it can lock`, () => {
    const sim = bed(3);
    const tank = tankAhead(sim, 3 * NM);
    cockpitSwitches(sim).mavPower = false;
    stepSensorTestbed(sim);
    expect(seeker(sim).powered).toBe(false);
    expect(seeker(sim).align).toBe(MAVERICK.alignTime);
    cockpitSwitches(sim).mavPower = true;
    const on = sim.time;
    let alignedAt = -1;
    runSensorTestbed(sim, MAVERICK.alignTime + 1, (s) => {
      if (alignedAt < 0 && seeker(s).align <= 0) alignedAt = s.time;
    });
    expect(alignedAt - on).toBeGreaterThan(MAVERICK.alignTime - 0.05);
    expect(alignedAt - on).toBeLessThan(MAVERICK.alignTime + 0.05);
    report.push(['alignment after power-on', `${(alignedAt - on).toFixed(2)} s`]);
    // before alignment the lock is refused, after it the same target locks
    cockpitSwitches(sim).mavPower = false;
    stepSensorTestbed(sim);
    cockpitSwitches(sim).mavPower = true;
    runSensorTestbed(sim, 60);
    expect(aimAndLock(sim, tank.position)).toBe(false);
    expect(seeker(sim).lockFailure).toBe('NOT READY');
    runSensorTestbed(sim, MAVERICK.alignTime - 60);
    expect(aimAndLock(sim, tank.position)).toBe(true);
  });

  it('slaves to the SPI and follows it (China hat long through the avionics slave request)', () => {
    const sim = bed(9);
    const s = seeker(sim);
    const spi = sim.avionics.spi;
    spi.valid = true;
    spi.source = 'STPT';
    spi.position.set(300, 0, -5000);
    sim.avionics.slaveRequest.sensors = 'ALL';
    sim.avionics.slaveRequest.time = sim.time; // the request list is empty: the fallback acts
    stepSensorTestbed(sim);
    expect(s.mode).toBe('SLAVE');
    const dir = spi.position.clone().sub(s.head).normalize();
    expect(s.los.angleTo(dir)).toBeLessThan(1e-4);
    expect(sim.sensors.tgp.mode).toBe('INR'); // 'ALL': the pod too
    spi.position.set(350, 0, -5050);
    stepSensorTestbed(sim);
    expect(s.los.angleTo(spi.position.clone().sub(s.head).normalize())).toBeLessThan(1e-4);
    // TMS aft cages it
    queueRequest(sim, 'MAV', 'tms', 'down');
    stepSensorTestbed(sim);
    expect(s.mode).toBe('BORESIGHT');
    expect(s.offAxis).toBeLessThan(1e-9);
  });

  it('DMS up / down select the narrow / wide field of view, DMS left / right the IR polarity', () => {
    const sim = bed(3);
    const s = seeker(sim);
    queueRequest(sim, 'MAV', 'dms', 'up');
    stepSensorTestbed(sim);
    expect(s.fov).toBe('NARROW');
    expect(s.fovAngle).toBeCloseTo(MAVERICK.fovNarrow, 12);
    queueRequest(sim, 'MAV', 'dms', 'down');
    stepSensorTestbed(sim);
    expect(s.fov).toBe('WIDE');
    expect(s.fovAngle).toBeCloseTo(MAVERICK.fovWide, 12);
    queueRequest(sim, 'MAV', 'dms', 'right');
    stepSensorTestbed(sim);
    expect(s.picture).toBe('BHOT');
    queueRequest(sim, 'MAV', 'chinaHat', 'fwd'); // China hat forward short toggles
    stepSensorTestbed(sim);
    expect(s.fov).toBe('NARROW');
    // a pod request leaves the seeker alone; a television seeker has one picture
    queueRequest(sim, 'TGP', 'dms', 'down');
    stepSensorTestbed(sim);
    expect(s.fov).toBe('NARROW');
    cockpitSwitches(sim).selectedStation = 9;
    stepSensorTestbed(sim);
    queueRequest(sim, 'MAV', 'dms', 'left');
    stepSensorTestbed(sim);
    expect(seeker(sim).picture).toBe('CCD');
  });
});

describe('Maverick lock rules (PLAN §16: no lock without line of sight or below the contrast threshold)', () => {
  function locksAt(
    station: number,
    fov: 'WIDE' | 'NARROW',
    slant: number,
    opts: SensorTestbedOptions = {},
  ) {
    const sim = bed(station, opts);
    const tank = tankAhead(sim, slant);
    seeker(sim).fov = fov;
    const ok = aimAndLock(sim, tank.position);
    return { ok, s: seeker(sim), sim };
  }

  /** Largest slant range at which the tank locks (bisection), m. */
  function lockRange(station: number, fov: 'WIDE' | 'NARROW'): number {
    let lo = 2000;
    let hi = 25000;
    for (let i = 0; i < 16; i++) {
      const mid = 0.5 * (lo + hi);
      if (locksAt(station, fov, mid).ok) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  it('a tank-sized target locks inside ≈3–7 nmi and not beyond', () => {
    for (const station of [3, 9]) {
      expect(locksAt(station, 'WIDE', 2.5 * NM).ok).toBe(true);
      const far = locksAt(station, 'WIDE', 4.5 * NM);
      expect(far.ok).toBe(false);
      expect(far.s.lockFailure).toBe('TOO SMALL');
      expect(locksAt(station, 'NARROW', 6 * NM).ok).toBe(true);
      const beyond = locksAt(station, 'NARROW', 8 * NM);
      expect(beyond.ok).toBe(false);
      expect(beyond.s.lockFailure).toBe('TOO SMALL');
    }
    const wide = lockRange(3, 'WIDE');
    const narrow = lockRange(3, 'NARROW');
    const wideH = lockRange(9, 'WIDE');
    const narrowH = lockRange(9, 'NARROW');
    expect(wide / NM).toBeGreaterThan(2.7);
    expect(narrow / NM).toBeLessThan(7.5);
    report.push([
      'lock range, idling tank broadside from 1,500 m, clear day (D / H)',
      `WIDE ${(wide / NM).toFixed(2)} / ${(wideH / NM).toFixed(2)} nmi, NARROW ${(narrow / NM).toFixed(2)} / ${(narrowH / NM).toFixed(2)} nmi`,
    ]);
  });

  it('no lock without line of sight: a tank behind a ridge', () => {
    const terrain = ridgeTerrain({ z: -5000, height: 200, width: 250 });
    const sim = bed(3, { terrain });
    // 500 m beyond the crest, in the gate but hidden by it (the line passes 136 m over the
    // crest's foot… below its 200 m top)
    const hidden = addVehicle(sim, 'mbt', 0, -5500, Math.PI / 2);
    hidden.position.y = terrain.heightAt(0, -5500);
    expect(aimAndLock(sim, hidden.position)).toBe(false);
    expect(seeker(sim).lockFailure).toBe('NO LINE OF SIGHT');
    // the same tank on the near slope locks
    const seen = addVehicle(sim, 'mbt', 0, -4200, Math.PI / 2);
    seen.position.y = terrain.heightAt(0, -4200);
    expect(aimAndLock(sim, seen.position)).toBe(true);
  });

  it('IR: no lock on a cold, stopped tank at night-ish; a hot running one locks', () => {
    const night = { timeOfDay: 21 };
    const cold = bed(3, night);
    const t1 = tankAhead(cold, 3 * NM, 'cold');
    expect(aimAndLock(cold, t1.position)).toBe(false);
    expect(seeker(cold).lockFailure).toBe('LOW CONTRAST');
    const cc = targetContrast(cold, t1.id, 'IR', seeker(cold).head);
    const hot = bed(3, night);
    const t2 = tankAhead(hot, 3 * NM, 'running');
    expect(aimAndLock(hot, t2.position)).toBe(true);
    const hc = targetContrast(hot, t2.id, 'IR', seeker(hot).head);
    expect(cc).toBeLessThan(MAVERICK.contrastThreshold);
    expect(hc).toBeGreaterThan(MAVERICK.contrastThreshold);
    report.push([
      'IR contrast at 21:00, 3 nmi: cold stopped / running tank',
      `${cc.toFixed(3)} / ${hc.toFixed(3)} (threshold ${MAVERICK.contrastThreshold})`,
    ]);
  });

  it('TV: no lock in haze or at night; the same tank locks on a clear day', () => {
    const hazy = locksAt(9, 'WIDE', 2.5 * NM, { visibilityKm: 3 });
    expect(hazy.ok).toBe(false);
    expect(hazy.s.lockFailure).toBe('LOW CONTRAST');
    const night = locksAt(9, 'WIDE', 2.5 * NM, { timeOfDay: 21 });
    expect(night.ok).toBe(false);
    expect(night.s.lockFailure).toBe('LOW CONTRAST');
    const clear = locksAt(9, 'WIDE', 2.5 * NM, { visibilityKm: 30 });
    expect(clear.ok).toBe(true);
    // the IR seeker sees through the same haze
    expect(locksAt(3, 'WIDE', 2.5 * NM, { visibilityKm: 3 }).ok).toBe(true);
    const tv = (r: { s: MaverickSeekerState; sim: Sim }) =>
      targetContrast(r.sim, r.sim.targets.vehicles[0].id, 'TV', r.s.head).toFixed(3);
    report.push([
      'TV contrast at 2.5 nmi: visibility 3 km / night (21:00) / visibility 30 km',
      `${tv(hazy)} / ${tv(night)} / ${tv(clear)} (threshold ${MAVERICK.contrastThreshold})`,
    ]);
  });

  it('the lock breaks when the target drives behind a ridge', () => {
    const terrain = ridgeTerrain({ z: -5000, height: 200, width: 250 });
    const sim = bed(3, { terrain });
    const tank = addVehicle(sim, 'mbt', 0, -4600, 0, { speed: 40 / 3.6 });
    tank.position.y = terrain.heightAt(0, -4600);
    expect(aimAndLock(sim, tank.position)).toBe(true);
    let brokeAt = -1;
    runSensorTestbed(sim, 120, (s) => {
      driveVehicles(s);
      if (brokeAt < 0 && !seeker(s).locked) brokeAt = s.time;
    });
    expect(brokeAt).toBeGreaterThan(30); // up the near slope and over the crest in view
    expect(seeker(sim).lockFailure).toBe('NO LINE OF SIGHT');
    expect(seeker(sim).mode).toBe('STAB');
    expect(lockEvents(sim)).toEqual(['on', 'off']);
    expect(tank.position.z).toBeLessThan(-5000);
  });

  it('an infrared lock jumps to a burning wreck in its gate; a TV lock does not', () => {
    for (const station of [3, 9]) {
      const sim = bed(station);
      seeker(sim).fov = 'NARROW';
      const tank = tankAhead(sim, 4 * NM, 'idle');
      const wreck = addVehicle(sim, 'mbt', 6, tank.position.z - 3, 0.3, { heat: 'cold' });
      wreck.condition = 'destroyed';
      wreck.fire = 1;
      expect(aimAndLock(sim, tank.position)).toBe(true);
      expect(seeker(sim).lockedVehicle).toBe(tank.id);
      runSensorTestbed(sim, 0.5);
      expect(seeker(sim).locked).toBe(true);
      expect(seeker(sim).lockedVehicle).toBe(station === 3 ? wreck.id : tank.id);
    }
    // a wreck outside the gate does not capture
    const sim = bed(3);
    seeker(sim).fov = 'NARROW';
    const tank = tankAhead(sim, 4 * NM, 'idle');
    const far = addVehicle(sim, 'mbt', 80, tank.position.z, 0, { heat: 'cold' });
    far.fire = 1;
    expect(aimAndLock(sim, tank.position)).toBe(true);
    runSensorTestbed(sim, 0.5);
    expect(seeker(sim).lockedVehicle).toBe(tank.id);
  });

  it('a larger gate (standard) and snap lock (relaxed) widen what TMS forward catches', () => {
    for (const [realism, offset, expected] of [
      ['authentic', 25, false],
      ['standard', 25, true],
      ['standard', 80, false],
      ['relaxed', 80, true],
    ] as const) {
      const sim = bed(3, { realism });
      const tank = tankAhead(sim, 2.5 * NM, 'idle');
      const aim = tank.position.clone();
      aim.x += offset;
      expect(aimAndLock(sim, aim), `${realism} ${offset} m`).toBe(expected);
      if (expected) expect(seeker(sim).lockedVehicle).toBe(tank.id);
    }
  });
});

describe('launch zone and hand-over', () => {
  it('inZone: locked, inside the launch ranges and the gimbal; leaving the gimbal breaks the lock', () => {
    const sim = bed(3);
    const tank = tankAhead(sim, 3 * NM);
    expect(aimAndLock(sim, tank.position)).toBe(true);
    const s = seeker(sim);
    expect(s.inZone).toBe(true);
    expect(s.range).toBeCloseTo(3 * NM, -1);
    // yaw the nose away: the seeker reaches its gimbal limit and lets go
    const pose = aircraftPose(sim);
    let brokeAt = -1;
    runSensorTestbed(sim, 4, (x) => {
      pose.heading += 15 * DEG * (1 / 120);
      if (brokeAt < 0 && !seeker(x).locked) brokeAt = pose.heading;
    });
    expect(s.locked).toBe(false);
    expect(s.lockFailure).toBe('GIMBAL LIMIT');
    expect(s.inZone).toBe(false);
    report.push([
      'heading change before the gimbal breaks the lock',
      `${(brokeAt / DEG).toFixed(1)}°`,
    ]);
    // too close for a launch: 0.46 nmi slant from 300 m, inside the gimbal
    const close = createSensorTestbed({ altitude: 300, speed: 0 });
    cockpitSwitches(close).selectedStation = 3;
    stepSensorTestbed(close);
    const near = addVehicle(close, 'mbt', 0, -800, Math.PI / 2);
    expect(aimAndLock(close, near.position)).toBe(true);
    expect(seeker(close).range).toBeLessThan(MAVERICK.minLaunchRange);
    expect(seeker(close).inZone).toBe(false);
  });

  it('after a launch the next missile on the station takes over the line of sight', () => {
    const sim = bed(9);
    const tank = tankAhead(sim, 3 * NM);
    expect(aimAndLock(sim, tank.position)).toBe(true);
    const first = seeker(sim);
    expect(first.rail).toBe(0);
    const second = sim.sensors.mavericks.find((m) => m.station === 9 && m !== first);
    const secondHead = second?.head.clone();
    // the weapons module releases the station's first store
    const st = sim.stores.stations.find((x) => x.station === 9);
    st?.stores.shift();
    stepSensorTestbed(sim);
    const next = seeker(sim);
    expect(next).not.toBe(first);
    expect(next).toBe(second);
    expect(next.station).toBe(9);
    // it stays on its own rail (the LAU-88's right one): its seeker does not move
    expect(next.rail).toBe(1);
    expect(secondHead && next.head.distanceTo(secondHead)).toBeLessThan(1e-9);
    expect(sim.sensors.mavericks.length).toBe(3);
    expect(next.mode).toBe('STAB');
    expect(next.los.angleTo(tank.position.clone().sub(next.head).normalize())).toBeLessThan(2e-3);
    expect(lockEvents(sim)).toEqual(['on', 'off']);
    queueRequest(sim, 'MAV', 'tms', 'up');
    stepSensorTestbed(sim);
    expect(next.locked).toBe(true);
    expect(next.lockedVehicle).toBe(tank.id);
    // the last one gone, the selection moves to the other station (no avionics selection)
    cockpitSwitches(sim).selectedStation = 0;
    st?.stores.shift();
    stepSensorTestbed(sim);
    expect(seeker(sim).station).toBe(3);
    expect(sim.sensors.mavericks.length).toBe(2);
  });

  it('a rearm brings new, unaligned missiles', () => {
    const sim = bed(3);
    const st = sim.stores.stations.find((x) => x.station === 3);
    st?.stores.shift();
    st?.stores.shift();
    stepSensorTestbed(sim);
    expect(sim.sensors.mavericks.map((m) => m.station)).toEqual([9, 9]);
    st?.stores.push('AGM-65D', 'AGM-65D');
    stepSensorTestbed(sim);
    const fresh = sim.sensors.mavericks.filter((m) => m.station === 3);
    expect(fresh.length).toBe(2);
    expect(fresh.every((m) => m.align > MAVERICK.alignTime - 1)).toBe(true);
  });
});

describe('determinism', () => {
  function scripted(): string {
    const sim = bed(3, { speed: 120 });
    const tank = addVehicle(sim, 'mbt', 300, -6000, 1.0, { speed: 8 });
    addVehicle(sim, 'ifv', 330, -6020, 1.0, { speed: 8 });
    const spi = sim.avionics.spi;
    spi.valid = true;
    spi.position.copy(tank.position);
    runSensorTestbed(sim, 15, (s) => {
      driveVehicles(s);
      const k = s.stepCount;
      if (k === 10) queueRequest(s, 'MAV', 'slaveSpi', '', true);
      if (k === 30) queueRequest(s, 'MAV', 'tms', 'up');
      aircraftPose(s).bank = 10 * DEG * Math.sin(k / 200);
    });
    const s = seeker(sim);
    return JSON.stringify([
      s.los.toArray(),
      s.lockPoint.toArray(),
      s.locked,
      s.lockedVehicle,
      s.contrast,
    ]);
  }
  it('the same inputs give the same seeker state', () => {
    expect(scripted()).toBe(scripted());
  });
});

describe('the selected seeker with no Mavericks loaded', () => {
  it('has no seekers on a gun-only load', () => {
    const sim = createSensorTestbed({ loadoutId: 'gunOnly' });
    stepSensorTestbed(sim);
    expect(sim.sensors.mavericks.length).toBe(0);
    expect(sim.sensors.selectedMaverick).toBe(-1);
    expect(sim.sensors.tgp.station).toBe(0);
    expect(sim.sensors.tgp.powered).toBe(false);
    setVehicleHeat(addVehicle(sim, 'mbt', 0, -3000), 'idle');
    stepSensorTestbed(sim);
  });
});
